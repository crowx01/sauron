"""Adaptive Writer -> Executor -> (Reviewers) -> Judge mission pipeline.

PAL sizes the team to the mission. It first assesses the mission's TYPE
(code / recon / fileops / analysis / general) and COMPLEXITY (1-5), then:

  - complexity 1 (easy):     ONE model does the whole thing directly.
  - complexity 2-3 (moderate): WRITER -> EXECUTOR -> JUDGE.
  - complexity 4-5 (complex):  + 1-2 REVIEWER sub-agents before the judge.

Models are chosen by capability and mission type; roles get DIFFERENT models so
work is genuinely divided across accounts. Every call goes through
``dispatch.generate`` (key_pool rotation + guardrails + Headroom). Anthropic/
Claude is never selected. No database; a hard iteration cap prevents loops.
"""

from __future__ import annotations

import ast
import asyncio
import hashlib
import importlib.util
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

log = logging.getLogger(__name__)

_TYPES = ("code", "recon", "fileops", "analysis", "general")

_WRITER_SYS = (
    "You are the WRITER sub-agent of a mission. Do NOT run tools. You are shown "
    "the current content of relevant repo files under REPO CONTEXT. Given the "
    "mission, acceptance criteria and feedback, output ONLY one JSON object:\n"
    '{"files":[{"path":"...","content":"..."}],'
    '"edits":[{"path":"...","old":"exact snippet from the file","new":"replacement"}],'
    '"commands":["..."],"verify":["read-only bash check that EXITS 0 iff a '
    'criterion holds"],"rationale":"...","done_hint":false}\n'
    "For code, prefer seeded small edits to existing files over authoring from "
    "scratch. When changing a code file, prefer a WHOLE-FILE replacement in files[] "
    "so the executor can validate the complete result; files[] may create or replace "
    "a file. Keep edits[] only for tiny, unique surgical changes where a full-file "
    "replacement is unnecessary. Preserve unrelated code and existing conventions. "
    "Any new top-level function/class must have a real invocation/call-site in the "
    "resulting code or tests; acceptance checks this with a simple grep.\n"
    "commands run bash on Kali. If a prior iteration reports syntax/import/lint or "
    "missing-call-site errors, fix those errors before proposing more work.\n"
    "verify: one read-only command per acceptance criterion that a machine runs — "
    "its EXIT CODE is the proof (e.g. `test -f out.xlsx`, `grep -q foo file`, "
    "`python -m pytest -q path`). For a measurement/probe criterion, verify with a "
    "DIFFERENT tool than the one that produced the result (e.g. confirm an httpx "
    "status with curl). The mission cannot complete until every verify exits 0."
)
_REVIEWER_SYS = (
    "You are a REVIEWER sub-agent. Given the mission, the writer's plan and the "
    "executor's results, output ONLY one JSON object:\n"
    '{"issues":["..."],"corrections":"...","looks_done":false}\n'
    "List concrete defects and how to fix them; be terse."
)
_JUDGE_SYS = (
    "You are the JUDGE sub-agent. Given the mission, acceptance criteria, the "
    "executor's results and any reviewer notes, output ONLY one JSON object:\n"
    '{"decision":"COMPLETE","reason":"...","feedback":"..."}\n'
    'decision is "COMPLETE" or "CONTINUE". Say COMPLETE only when the RESULTS show '
    "real changes on disk (files_written / edits_applied / command output) AND "
    "every verify check exited 0, every code check passed, and every new callable "
    "has a grep-visible call-site. Never infer success from the writer's prose or a "
    "claim that work was done — only from the executor's recorded evidence. If "
    "nothing was written or a verify failed, CONTINUE with concrete feedback."
)


_SYNTH_SYS = (
    "You are the SYNTHESIZER — the final stage that makes many models act as ONE. "
    "Given the mission and the per-subtask results produced by DIFFERENT models, merge "
    "them into one coherent result: reconcile conflicts, drop errors, keep the best of "
    "each. Output the unified result directly (prose or the final artifact text), no JSON "
    "wrapper."
)


def _no_claude(models: list[str]) -> list[str]:
    return [m for m in models if "claude" not in m.lower() and "anthropic" not in m.lower()]


def _env_models(var: str, default: list[str]) -> list[str]:
    got = [m.strip() for m in (os.getenv(var, "") or "").split(",") if m.strip()]
    return _no_claude(got or default)


def _pick(models: list[str]) -> str | None:
    from providers.router import chat_repl

    for m in models:
        try:
            if chat_repl._is_available(m):
                return m
        except Exception:
            pass
    return models[0] if models else None


def _pick_distinct(models: list[str], used: set[str]) -> str | None:
    from providers.router import chat_repl

    for m in models:
        if m in used:
            continue
        try:
            if chat_repl._is_available(m):
                return m
        except Exception:
            pass
    return _pick([m for m in models if m not in used]) or _pick(models)


def _extract_json(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


# --- adaptive assessment ----------------------------------------------------

def _heuristic_assess(goal: str) -> dict:
    g = goal.lower()
    # Only classify as recon when it is a GENUINE security action (verb+target),
    # not when a security word is merely the object of a file/git op (e.g.
    # "create a directory called enumeration").
    try:
        from providers.router import intent as _intent

        _is_sec = _intent.classify_intent(goal).is_security
    except Exception:
        _is_sec = any(w in g for w in ("nmap", "scan", "recon", "enumerate", "subdomain", "port", "exploit", "payload", "nuclei"))
    if _is_sec:
        typ = "recon"
    elif any(w in g for w in ("code", "function", "class", "refactor", "implement", "module", "script", "api", "bug", "test")):
        typ = "code"
    elif any(w in g for w in ("analyze", "summarize", "explain", "compare", "review", "assess", "report on")):
        typ = "analysis"
    elif any(w in g for w in ("file", "create", "write", "move", "rename", "directory", ".txt", ".json", "folder")):
        typ = "fileops"
    else:
        typ = "general"
    steps = g.count(" and ") + g.count(",") + g.count(" then ") + g.count(";") + g.count(" after ")
    n = len(goal)
    if n > 300 or steps >= 5:
        complexity = 5
    elif n > 200 or steps >= 3:
        complexity = 4
    elif n > 110 or steps >= 2:
        complexity = 3
    elif n > 70 or steps >= 1:
        complexity = 2
    else:
        complexity = 1
    return {"type": typ, "complexity": complexity}


def assess_mission(goal: str, model: str | None = None) -> dict:
    """Classify mission type + complexity (1-5): a cheap model, heuristic fallback."""
    base = _heuristic_assess(goal)
    if os.getenv("PAL_MISSION_AUTO", "1").lower() in ("0", "false", "no"):
        return base
    from providers.router import dispatch

    m = model or _pick(_env_models("PAL_MISSION_ASSESS_MODELS", ["gemini-3.5-flash-lite", "qwen3"]))
    if not m:
        return base
    try:
        r = dispatch.generate(
            m,
            'Classify this mission. Output ONLY JSON {"type":"code|recon|fileops|analysis|general",'
            f'"complexity":1-5}}.\nMISSION: {goal}',
            "You are a concise mission classifier.",
            temperature=0.0, category="mission", tool="mission", max_output_tokens=80,
        )
        j = _extract_json(getattr(r, "content", "") or "")
        if j and j.get("type") in _TYPES and str(j.get("complexity", "")).strip().isdigit():
            return {"type": j["type"], "complexity": max(1, min(5, int(j["complexity"])))}
    except Exception:
        pass
    return base


def _team_for(complexity: int) -> dict:
    c = max(1, min(5, int(complexity)))
    return {"single": c <= 1, "reviewers": max(0, c - 3)}  # c4 -> 1 reviewer, c5 -> 2


def _writer_pool(mtype: str) -> list[str]:
    # gpt-oss-120b leads by default: it is the reliable structured-JSON emitter;
    # weaker writers (e.g. nemotron-3-ultra) emit empty plans headless (2026-10-08).
    default = ["openai/gpt-oss-120b", "gemini-3.5-flash-lite", "qwen3"]
    return _env_models("PAL_MISSION_WRITER_MODELS", default)


def _executor_pool(mtype: str) -> list[str]:
    default = ["qwen3", "openai/gpt-oss-120b", "gemini-3.5-flash-lite"]
    return _env_models("PAL_MISSION_EXECUTOR_MODELS", default)


# --- C9: coder/ops model tier ------------------------------------------------

def _coder_tier(mtype: str) -> list[str]:
    """Author tier: models for file writes/edits (coding). Defaults to writer pool."""
    return _env_models("PAL_MISSION_CODER_TIER", _writer_pool(mtype))


def _ops_tier(mtype: str) -> list[str]:
    """Ops/bulk tier: models for grep, listing, simple transforms. Defaults to executor pool."""
    return _env_models("PAL_MISSION_OPS_TIER", _executor_pool(mtype))


def _classify_step(plan: dict) -> str:
    """Simple keyword-based step classifier: 'author' for file writes/edits, 'ops' otherwise."""
    if not isinstance(plan, dict):
        return "ops"
    if plan.get("files") or plan.get("edits"):
        return "author"
    return "ops"


def _tier_pool(step_tag: str, mtype: str) -> list[str]:
    """Return the model pool for the given step tag, with fallback to the other tier."""
    if step_tag == "author":
        primary = _coder_tier(mtype)
        fallback = _ops_tier(mtype)
    else:
        primary = _ops_tier(mtype)
        fallback = _coder_tier(mtype)
    seen: set[str] = set()
    combined: list[str] = []
    for m in primary + fallback:
        if m not in seen:
            seen.add(m)
            combined.append(m)
    return combined


def _pick_tier(step_tag: str, mtype: str) -> str | None:
    """Pick a model from the correct tier, falling through the ordered list on unavailability."""
    return _pick(_tier_pool(step_tag, mtype))


# --- M1-M2: full-roster ensemble + capability-aware, fair-use scheduling -------

def _all_available_models() -> list[str]:
    """The FULL available roster across every configured provider (groq, gemini,
    nvidia, cohere, ollama_cloud, openrouter, …) — never a hardcoded subset, and
    never Claude. This is what lets a mission engage models sauron rarely picks."""
    from providers.registry import ModelProviderRegistry
    from providers.router import chat_repl

    try:
        names = list(ModelProviderRegistry.get_available_models(respect_restrictions=True).keys())
    except Exception:
        names = []
    out, seen = [], set()
    for m in _no_claude(names):
        if m in seen:
            continue
        seen.add(m)
        try:
            if chat_repl._is_available(m):
                out.append(m)
        except Exception:
            pass
    return out


def _model_capabilities(model: str) -> set[str]:
    """Coarse capability tags from the size cap + model id, to put each model on
    the role it is best at."""
    from providers.router import size_guard

    tags: set[str] = set()
    cap = size_guard.cap_for(model)
    if cap >= 200_000:
        tags.add("long_context")
    if cap <= 8000:
        tags.add("bulk_cheap")
    ml = model.lower()
    if any(k in ml for k in ("oss", "qwen", "codex", "coder", "code", "deepseek")):
        tags.add("code")
    if any(k in ml for k in ("flash", "lite", "nano", "20b", "fast", "haiku")):
        tags.add("bulk_cheap")
    if any(k in ml for k in ("pro", "120b", "super", "gpt-5", "o3", "grok", "command-a", "ultra", "plus")):
        tags.add("reasoning")
    if any(k in ml for k in ("flash", "gemini", "oss", "command", "qwen", "nemotron")):
        tags.add("structured")
    # permissive for offensive-security content; exclude known refusers (cohere / plain flash)
    if any(k in ml for k in ("or-free", "openrouter", "grok", "nemotron", "oss", "qwen")):
        tags.add("security_permissive")
    return tags


_ROLE_WANT = {
    "writer": {"code", "reasoning", "structured"},
    "reviewer": {"reasoning", "structured"},
    "synth": {"reasoning", "long_context"},
    "executor": {"code", "bulk_cheap"},
    "assess": {"bulk_cheap"},
}


def _rank_for_role(role: str, roster: list[str]) -> list[str]:
    """Rank a roster for a role: best capability match first, then (fair-use) the
    LEAST-used model first, so capable-but-underused models get engaged instead of
    the same few every mission. PAL_MISSION_FAIR_USE=0 disables the fairness term."""
    want = _ROLE_WANT.get(role, set())
    fair = os.getenv("PAL_MISSION_FAIR_USE", "1") not in ("0", "false", "no")

    def used_count(m: str) -> int:
        if not fair:
            return 0
        try:
            from providers.router import episode_store

            return episode_store.observed(m, "mission")[0]
        except Exception:
            return 0

    return sorted(roster, key=lambda m: (-len(_model_capabilities(m) & want), used_count(m), m))


def _repo_context(goal: str, max_bytes: int = 18000) -> str:
    """Current content of repo files relevant to the goal (headroom-compressed),
    so the writer modifies real code instead of guessing."""
    files: list[str] = []
    roots = [Path.cwd()]
    named_root = None
    named_match = re.search(r"(/[\w./\-]+?pal-mcp-server)\b", goal or "")
    if named_match and os.path.isdir(named_match.group(1)):
        named_root = Path(named_match.group(1))
        roots.extend((named_root, named_root / "core"))
    try:
        repo_root = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=os.getcwd(), capture_output=True, text=True, timeout=3,
        ).stdout.strip()
        if repo_root:
            roots.extend((Path(repo_root), Path(repo_root) / "core"))
    except Exception:
        repo_root = ""
    roots = list(dict.fromkeys(p.resolve() for p in roots if p.is_dir()))

    path_pattern = re.compile(
        r"(?<![\w./-])(?:/[\w./-]+|(?:[\w.-]+/)*[\w.-]+)"
        r"\.(?:py|json|md|txt|toml|cfg)\b"
    )
    for raw_path in path_pattern.findall(goal or ""):
        candidates = [Path(raw_path)] if os.path.isabs(raw_path) else [root / raw_path for root in roots]
        for candidate in candidates:
            try:
                resolved = candidate.resolve()
                if resolved.is_file() and str(resolved) not in files:
                    files.append(str(resolved))
                    break
            except Exception:
                pass

    # Continue to discover symbol-bearing files for named project roots and
    # normal git checkouts, but keep the search limited to source/config roots.
    root = Path(repo_root) if repo_root else named_root
    if root:
        symbols = set(re.findall(r"\b([a-z]+_[a-z_]+|[A-Za-z]+[A-Z][A-Za-z]+)\b", goal))
        for sym in list(symbols)[:8]:
            try:
                targets = []
                for base in (root, root / "core"):
                    targets.extend(
                        base / item
                        for item in ("providers", "conf", "server.py", "cli.py")
                        if (base / item).exists()
                    )
                out = subprocess.run(
                    ["grep", "-rlw", "--include=*.py", "--exclude-dir=.pal_venv",
                     "--exclude-dir=zen-mcp-server", "--exclude-dir=__pycache__",
                     "--exclude-dir=node_modules", "--exclude-dir=tests", sym,
                     *map(str, targets)],
                    capture_output=True, text=True, timeout=8,
                ).stdout
                for hit in out.split()[:2]:
                    if hit not in files:
                        files.append(hit)
            except Exception:
                pass
            if len(files) >= 6:
                break
    # Keep source readable and uncompressed so a writer can seed an accurate edit.
    parts, total = [], 0
    for fp in files[:6]:
        try:
            c = Path(fp).read_text(encoding="utf-8", errors="replace")
            if len(c) > max_bytes:
                c = c[:max_bytes] + "\n...[truncated]..."
            parts.append(f"--- FILE {fp} ---\n{c}")
            total += len(c)
            if total >= max_bytes:
                break
        except Exception:
            pass
    return "\n\n".join(parts)


def _is_protected(path: str) -> bool:
    """Never let a mission write/overwrite credentials or config."""
    if os.getenv("PAL_MISSION_ALLOW_SENSITIVE", "0") in ("1", "true", "yes"):
        return False
    p = os.path.abspath(os.path.expanduser(path or ""))
    base = os.path.basename(p)
    if base == ".env" or base.startswith(".env.") or base == "keys.json":
        return True
    if os.path.join(os.path.expanduser("~"), ".pal") in p and base.endswith(".json"):
        return True
    # Unify with the executor's credential guard: *.pem/*.key/id_rsa/credentials*/
    # secret*/engagement*/pentest-report* etc. are protected at the writer stage too.
    try:
        from providers.tooling import authz as _authz

        if _authz.scan_name(path or ""):
            return True
    except Exception:
        pass
    return False


def _python_search_roots(path: str | None = None) -> list[Path]:
    """Small set of likely source roots for import and call-site checks."""
    roots = [Path.cwd()]
    if path:
        roots.append(Path(path).resolve().parent)
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=os.getcwd(), capture_output=True, text=True, timeout=3,
        )
        repo = result.stdout.strip()
        if result.returncode == 0 and repo:
            roots.extend((Path(repo), Path(repo) / "core"))
    except Exception:
        pass
    return list(dict.fromkeys(root.resolve() for root in roots if root.is_dir()))


def _local_module_exists(module: str, roots: list[Path]) -> bool:
    parts = [part for part in module.split(".") if part]
    if not parts:
        return False
    for root in roots:
        base = root.joinpath(*parts)
        if base.with_suffix(".py").is_file() or (base / "__init__.py").is_file():
            return True
    return False


def _check_python_imports(tree: ast.AST, path: str) -> list[dict]:
    """Check imports without executing the edited module or its package code."""
    roots = _python_search_roots(path)
    checked: set[str] = set()
    issues: list[dict] = []
    stdlib = getattr(sys, "stdlib_module_names", set())

    for node in ast.walk(tree):
        modules: list[str] = []
        if isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = Path(path).resolve().parent
                for _ in range(max(0, node.level - 1)):
                    base = base.parent
                if node.module:
                    local = base.joinpath(*node.module.split("."))
                    if not (local.with_suffix(".py").is_file() or local.is_dir()):
                        issues.append({
                            "check": "import",
                            "ok": False,
                            "message": f"unresolved relative import: {node.module}",
                        })
                else:
                    init_path = base / "__init__.py"
                    try:
                        init_source = init_path.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        init_source = ""
                    for alias in node.names:
                        if alias.name == "*":
                            continue
                        local = base / alias.name
                        exported = bool(re.search(rf"\b{re.escape(alias.name)}\b", init_source))
                        if not (local.with_suffix(".py").is_file() or local.is_dir() or exported):
                            issues.append({
                                "check": "import",
                                "ok": False,
                                "message": f"unresolved relative import: {alias.name}",
                            })
                continue
            elif node.module:
                modules.append(node.module)
        for module in modules:
            if not module or module in checked:
                continue
            checked.add(module)
            top = module.split(".")[0]
            if top in stdlib or top in sys.builtin_module_names or _local_module_exists(module, roots):
                continue
            try:
                available = importlib.util.find_spec(top) is not None
            except (ImportError, ValueError, AttributeError):
                available = False
            if not available:
                issues.append({
                    "check": "import",
                    "ok": False,
                    "message": f"unresolved import: {module}",
                })
    if not issues:
        issues.append({"check": "import", "ok": True, "message": "imports resolve"})
    return issues


def _check_python_file(path: str) -> list[dict]:
    """AST/compile, non-executing import resolution, and optional Ruff validation."""
    if not path.lower().endswith(".py"):
        return []
    try:
        source = Path(path).read_text(encoding="utf-8")
    except Exception as exc:
        return [{"check": "read", "ok": False, "message": str(exc)[:300]}]

    try:
        tree = ast.parse(source, filename=path)
        compile(tree, path, "exec")
    except (SyntaxError, ValueError, TypeError) as exc:
        line = getattr(exc, "lineno", None)
        where = f" at line {line}" if line else ""
        return [{
            "check": "ast",
            "ok": False,
            "message": f"syntax/compile error{where}: {str(exc)[:300]}",
        }]

    checks = [{"check": "ast", "ok": True, "message": "AST parse and compile passed"}]
    checks.extend(_check_python_imports(tree, path))
    ruff = shutil.which("ruff")
    if ruff:
        try:
            result = subprocess.run(
                [ruff, "check", "--output-format", "concise", path],
                cwd=os.getcwd(), capture_output=True, text=True, timeout=30,
            )
            detail = (result.stdout + result.stderr).strip()[-1200:]
            checks.append({
                "check": "ruff",
                "ok": result.returncode == 0,
                "message": detail or ("ruff passed" if result.returncode == 0 else "ruff failed"),
            })
        except Exception as exc:
            checks.append({"check": "ruff", "ok": False, "message": f"ruff error: {str(exc)[:240]}"})
    else:
        checks.append({"check": "ruff", "ok": True, "message": "ruff unavailable; skipped"})
    return checks


def _new_top_level_callables(before: str, after: str) -> list[str]:
    """Callable symbols added to a Python module by this edit."""
    def names(source: str) -> set[str]:
        try:
            module = ast.parse(source or "")
        except SyntaxError:
            return set()
        return {
            node.name for node in module.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        }

    return sorted(names(after) - names(before))


def _find_symbol_calls(symbols: list[str], changed_paths: list[str]) -> set[str]:
    """Find grep-form call-sites for several symbols in one source-tree pass."""
    if not symbols:
        return set()
    alternatives = "|".join(re.escape(symbol) for symbol in sorted(set(symbols), key=len, reverse=True))
    pattern = re.compile(rf"\b(?P<symbol>{alternatives})\s*\(")
    roots = _python_search_roots(changed_paths[0] if changed_paths else None)
    files: set[Path] = set()
    for root in roots:
        for directory, dirs, names in os.walk(root):
            dirs[:] = [
                name for name in dirs
                if name not in {".git", ".venv", ".sauron_venv", ".pal_venv", "__pycache__",
                                "node_modules", "build", "dist"}
            ]
            for name in names:
                if name.endswith(".py"):
                    files.add(Path(directory) / name)
    files.update(Path(path).resolve() for path in changed_paths if path.lower().endswith(".py"))

    found: set[str] = set()
    expected = set(symbols)
    for file_path in files:
        try:
            for line in file_path.read_text(encoding="utf-8", errors="replace").splitlines():
                stripped = line.strip()
                if stripped.startswith("#") or re.match(r"^(?:async\s+)?def\s+", stripped):
                    continue
                found.update(match.group("symbol") for match in pattern.finditer(line))
                if found >= expected:
                    return found
        except OSError:
            continue
    return found


def _has_symbol_call(symbol: str, changed_paths: list[str]) -> bool:
    """Cheap grep-form call-site check; definitions and comment-only lines do not count."""
    return symbol in _find_symbol_calls([symbol], changed_paths)


def _record_code_validation(report: dict, path: str, before: str) -> None:
    checks = _check_python_file(path)
    report["code_checks"].extend({"path": path, **check} for check in checks)
    if any(not check.get("ok", False) for check in checks):
        return
    try:
        after = Path(path).read_text(encoding="utf-8")
    except Exception:
        return
    symbols = _new_top_level_callables(before, after)
    called_symbols = _find_symbol_calls(symbols, [path])
    for symbol in symbols:
        called = symbol in called_symbols
        report["symbol_checks"].append({
            "path": path,
            "symbol": symbol,
            "check": "callsite",
            "ok": called,
            "message": "call-site found" if called else "new callable has no grep-visible call-site",
        })


def _progress_fingerprint(report: dict) -> str:
    """Stable signature of observable progress/evidence for consecutive iterations."""
    def compact(value) -> str:
        return re.sub(r"\s+", " ", str(value or "")).strip()

    payload = {
        "changes": sorted(
            (compact(x.get("path")), compact(x.get("sha256")))
            for x in report.get("changes", []) or []
        ),
        "verify_failures": sorted(
            (compact(x.get("cmd")), compact(x.get("exit")), compact(x.get("output")))
            for x in report.get("verify", []) or [] if not x.get("ok")
        ),
        "code_failures": sorted(
            (compact(x.get("path")), compact(x.get("check")), compact(x.get("message")))
            for x in report.get("code_checks", []) or [] if not x.get("ok")
        ),
        "symbol_failures": sorted(
            (compact(x.get("path")), compact(x.get("symbol")))
            for x in report.get("symbol_checks", []) or [] if not x.get("ok")
        ),
        "command_results": sorted(
            (compact(x.get("cmd")), compact(x.get("answer")))
            for x in report.get("results", []) or []
        ),
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _no_progress_limit() -> int:
    stall = os.getenv("PAL_MISSION_STALL_N")
    if stall is not None:
        try:
            configured = int(stall)
        except (TypeError, ValueError):
            configured = 3
    else:
        try:
            configured = int(os.getenv("PAL_MISSION_NOPROGRESS_ITERS", "2"))
        except (TypeError, ValueError):
            configured = 2
    return 0 if configured <= 0 else max(2, configured)


def _panel_no_progress_reason(results: list[dict], threshold: int = 2) -> str:
    """Detect duplicate failed checks across panel workers that made no disk progress."""
    if threshold <= 0:
        return ""
    failures: dict[tuple[str, str, str], int] = {}
    for result in results:
        report = result.get("exec") or {}
        if report.get("changes"):
            continue
        for check in report.get("verify", []) or []:
            if check.get("ok"):
                continue
            key = (
                re.sub(r"\s+", " ", str(check.get("cmd") or "")).strip(),
                str(check.get("exit")),
                re.sub(r"\s+", " ", str(check.get("output") or "")).strip(),
            )
            failures[key] = failures.get(key, 0) + 1
    repeated = next((key for key, count in failures.items() if count >= threshold), None)
    if repeated:
        return f"repeated failing verification with no forward progress: {repeated[0]}"
    return ""


async def _panel_models(mtype: str, cap: int) -> list[str]:
    """Pick up to `cap` models for an ensemble, drawing from the WHOLE roster and
    spreading across DISTINCT providers first — so idle/rarely-used accounts get
    engaged and no single provider is overloaded. Falls back to a curated list
    only if roster discovery yields nothing."""
    from providers.registry import ModelProviderRegistry
    from providers.router import chat_repl

    roster = _all_available_models()
    if not roster:
        for m in _writer_pool(mtype) + _executor_pool(mtype) + ["command-r-08-2024", "openai/gpt-oss-20b"]:
            if m not in roster and "claude" not in m.lower() and "anthropic" not in m.lower():
                try:
                    if chat_repl._is_available(m):
                        roster.append(m)
                except Exception:
                    pass
    ranked = _rank_for_role("writer", roster)
    try:
        prov_map = ModelProviderRegistry.get_available_models(respect_restrictions=True)
    except Exception:
        prov_map = {}

    def prov_of(m: str) -> str:
        p = prov_map.get(m)
        return getattr(p, "value", str(p))

    # group ranked models by provider (rank order preserved within each group),
    # then ROUND-ROBIN across providers so no single provider (e.g. a cloud of
    # gemini aliases) can crowd out rarer ones like nvidia/cohere. This keeps real
    # provider diversity across ALL slots, not just the first of each.
    groups: dict[str, list[str]] = {}
    order: list[str] = []
    for m in ranked:
        p = prov_of(m)
        if p not in groups:
            groups[p] = []
            order.append(p)
        groups[p].append(m)
    picked: list[str] = []
    idx = 0
    while len(picked) < cap and any(groups[p] for p in order):
        p = order[idx % len(order)]
        if groups[p]:
            picked.append(groups[p].pop(0))
        idx += 1
    return picked[:cap]


async def run_panel(goal, models, judge, full):
    """Fan a mission out across MANY models in parallel (8-10): decompose into
    independent subtasks, run each on a distinct model concurrently, then judge."""
    from providers.router import dispatch

    criteria = f"The mission is accomplished and verified on disk: {goal}"
    # decompose is guarded: a dead model here must not crash the whole mission.
    try:
        dec = await asyncio.to_thread(
            dispatch.generate, models[0],
            f'Split this mission into up to {len(models)} INDEPENDENT subtasks. '
            f'Output ONLY JSON {{"subtasks":["...","..."]}}.\nMISSION: {goal}',
            "You are a terse mission decomposer.", temperature=0.2,
            category="mission", tool="mission", max_output_tokens=500,
        )
        subs = (_extract_json(getattr(dec, "content", "") or "") or {}).get("subtasks") or [goal]
    except Exception as exc:  # noqa: BLE001
        log.warning("mission: decompose failed (%s) → single subtask", str(exc)[:120])
        subs = [goal]
    subs = subs[: len(models)] or [goal]
    repo_ctx = _repo_context(goal)

    async def _do(i, sub):
        m = models[i % len(models)]
        try:
            wr = await asyncio.to_thread(
                dispatch.generate, m,
                f"REPO CONTEXT:\n{repo_ctx}\n\nSUBTASK: {sub}\nMISSION: {goal}",
                _WRITER_SYS, temperature=0.2, category="mission", tool="mission",
                max_output_tokens=int(os.getenv("PAL_TOOLS_MAX_TOKENS", "8192")),
            )
            plan = _extract_json(getattr(wr, "content", "") or "") or {}
            rep = await _execute_plan(plan, m, full, goal=goal)
            return {"subtask": sub, "model": m, "exec": rep}
        except Exception as exc:
            return {"subtask": sub, "model": m, "error": str(exc)[:120]}

    results = await asyncio.gather(*[_do(i, s) for i, s in enumerate(subs)])

    # SYNTHESIS (M5): a strong reasoning model merges every sub-result into one
    # unified output — the "many models as a whole one model" step. Prefer the
    # BIGGEST-context available model so the merge prompt doesn't trip a small
    # per-minute token cap (groq gpt-oss 8k TPM rate-limited the synth, 2026-10-08).
    from providers.router import size_guard as _sg

    synth = _pick(sorted(_rank_for_role("synth", models), key=lambda m: -_sg.cap_for(m))) or models[0]
    synthesis = ""
    try:
        sr = await asyncio.to_thread(
            dispatch.generate, synth,
            f"MISSION: {goal}\nPER-SUBTASK RESULTS (each by a different model):\n"
            f"{json.dumps(results)[:6000]}\n\nMerge into ONE unified result.",
            _SYNTH_SYS, temperature=0.2, category="mission", tool="mission",
            max_output_tokens=int(os.getenv("PAL_MISSION_SYNTH_TOKENS", "2000")),
        )
        synthesis = (getattr(sr, "content", "") or "").strip()
    except Exception as exc:  # noqa: BLE001
        synthesis = f"__SYNTH_ERROR__ {str(exc)[:120]}"

    merged = {
        "files_written": [], "edits_applied": [], "results": [], "verify": [],
        "code_checks": [], "symbol_checks": [], "changes": [],
    }
    for r in results:
        rep = r.get("exec") or {}
        for k in merged:
            merged[k].extend(rep.get(k, []) or [])
    no_progress_reason = _panel_no_progress_reason(results, _no_progress_limit())
    # judge is guarded: if the judge model is down, decide from deterministic
    # evidence so a mission whose verify already passed still COMPLETEs.
    try:
        jr = await asyncio.to_thread(
            dispatch.generate, judge,
            f"MISSION: {goal}\nACCEPTANCE: {criteria}\nSYNTHESIS: {synthesis[:2000]}\n"
            f"PANEL_RESULTS: {json.dumps(results)[:3500]}",
            _JUDGE_SYS, temperature=0.1, category="mission", tool="mission",
        )
        verdict = _extract_json(getattr(jr, "content", "") or "") or {"decision": "CONTINUE"}
    except Exception as exc:  # noqa: BLE001
        log.warning("mission: judge failed (%s) → deterministic verdict", str(exc)[:120])
        verdict = _gate_verdict(goal, merged)
    verdict = _apply_gate(goal, merged, verdict)  # deterministic override across the panel
    if no_progress_reason:
        verdict = {
            "decision": "CONTINUE",
            "reason": "panel no-progress guard",
            "feedback": no_progress_reason,
            "no_progress": True,
        }
    contributors = sorted({r.get("model") for r in results if r.get("model")} | {synth})
    return {
        "status": "COMPLETE" if str(verdict.get("decision", "")).upper() == "COMPLETE" else "INCOMPLETE",
        "mode": "panel", "team_size": len(models), "models": models,
        "subtasks": subs, "results": results, "judge": judge, "verdict": verdict,
        "synthesizer": synth, "synthesis": synthesis, "contributors": contributors,
        "no_progress": bool(no_progress_reason),
        **({"no_progress_reason": no_progress_reason} if no_progress_reason else {}),
    }


async def _execute_plan(plan: dict, executor: str, full: bool, goal: str = "") -> dict:
    from providers.router import chat_repl

    # Pin the mission GOAL's authorization boundary for the whole plan so a
    # writer-emitted command ("git add . && git push") inherits the goal's
    # explicit file scope and cannot widen it (push_scope narrows-only).
    _gtok = None
    try:
        from providers.router import intent as _intent
        from providers.tooling import authz as _authz

        if goal:
            _gtok = _authz.push_scope(_intent.scope_for_request(goal, os.getcwd()))
    except Exception:
        _gtok = None

    report: dict = {
        "files_written": [], "edits_applied": [], "edits_failed": [],
        "results": [], "verify": [], "code_checks": [], "symbol_checks": [], "changes": [],
    }

    def record_content_change(path: str, before: str) -> None:
        try:
            after = Path(path).read_text(encoding="utf-8", errors="replace")
            if after != before:
                report["changes"].append({
                    "path": os.path.abspath(path),
                    "sha256": hashlib.sha256(after.encode("utf-8")).hexdigest(),
                })
        except Exception:
            pass

    for e in plan.get("edits", []) or []:
        path, old, new = e.get("path"), e.get("old"), e.get("new")
        if path and _is_protected(path):
            report["edits_failed"].append({"path": path, "reason": "protected path (config/creds)"})
            continue
        if path and old is not None and os.path.isfile(path):
            try:
                cur = Path(path).read_text(encoding="utf-8")
                if old in cur:
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(cur.replace(old, new or "", 1))
                    report["edits_applied"].append(path)
                    record_content_change(path, cur)
                    _record_code_validation(report, path, cur)
                else:
                    report["edits_failed"].append({"path": path, "reason": "old snippet not found"})
            except Exception as exc:
                report["edits_failed"].append({"path": path, "reason": str(exc)[:80]})
    for entry in plan.get("files", []) or []:
        path, content = entry.get("path"), entry.get("content", "")
        if path and _is_protected(path):
            report["edits_failed"].append({"path": path, "reason": "protected path (config/creds)"})
            continue
        if path:
            try:
                before = Path(path).read_text(encoding="utf-8", errors="replace") if os.path.isfile(path) else ""
                os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(content if isinstance(content, str) else str(content))
                report["files_written"].append(path)
                record_content_change(path, before)
                _record_code_validation(report, path, before)
            except Exception as exc:
                report["edits_failed"].append({"path": path, "reason": str(exc)[:120]})
    for cmd in plan.get("commands", []) or []:
        answer, _tr = await chat_repl._tools_loop(
            f"Run this exact bash command and report its output: {cmd}",
            executor, os.getcwd(), max_steps=3, full=full,
        )
        report["results"].append({"cmd": cmd, "answer": (answer or "")[:600]})
    # VERIFY: machine-run read-only checks whose EXIT CODE is the proof. Run with
    # subprocess so the result is deterministic (not an LLM's claim about it).
    # PAL_MISSION_VERIFY=0 disables.
    if os.getenv("PAL_MISSION_VERIFY", "1") not in ("0", "false", "no"):
        import subprocess

        for vc in plan.get("verify", []) or []:
            if not isinstance(vc, str) or not vc.strip():
                continue
            try:
                pr = subprocess.run(
                    ["bash", "-c", vc], capture_output=True, text=True,
                    timeout=int(os.getenv("PAL_MISSION_VERIFY_TIMEOUT", "60")), cwd=os.getcwd(),
                )
                code, out = pr.returncode, (pr.stdout + pr.stderr)[-400:]
            except subprocess.TimeoutExpired:
                code, out = None, "timeout"
            except Exception as exc:  # noqa: BLE001
                code, out = None, str(exc)[:200]
            report["verify"].append({"cmd": vc, "exit": code, "ok": code == 0, "output": out})
    if _gtok is not None:
        try:
            from providers.tooling import authz as _authz

            _authz.pop_scope(_gtok)
        except Exception:
            pass
    return report


def _goal_artifacts(goal: str) -> list[str]:
    """Absolute-ish file paths the goal asks to produce, for on-disk verification."""
    return re.findall(r"(/[\w./\-]+\.[A-Za-z0-9]{1,6})", goal or "")


def _plan_is_actionable(plan: dict) -> bool:
    """True iff the writer actually proposed work (a file, an edit, or a command).
    An empty plan means the writer only talked — rotate to the next writer instead
    of burning the iteration (nemotron-3-ultra did this every round on 2026-10-08)."""
    if not isinstance(plan, dict):
        return False
    return bool(plan.get("files") or plan.get("edits") or plan.get("commands"))


def _made_changes(report: dict) -> bool:
    """True iff the executor actually did something real: wrote a file, applied an
    edit, or ran a command that produced output. An empty report means the writer
    only talked (the 2026-10-08 flash-lite 'done, 0 edits' hallucination)."""
    if report.get("files_written") or report.get("edits_applied"):
        return True
    return any((r.get("answer") or "").strip() for r in report.get("results", []) or [])


def _verify_tally(report: dict) -> tuple[int, int]:
    """(#verify checks run, #passed)."""
    v = report.get("verify") or []
    return len(v), sum(1 for x in v if x.get("ok"))


def _deterministic_gate(goal: str, report: dict) -> tuple[str | None, str]:
    """Exec-free hard checks that OVERRIDE an LLM judge's COMPLETE. Returns
    ("CONTINUE", reason) when completion must be blocked, else (None, "").

    Precedence: when the writer supplied ``verify`` checks, their EXIT CODES are
    the proof and decide the gate outright — all passing ⇒ allow, any failing ⇒
    block. Goal-text artifact matching is only a FALLBACK for missions with no
    verify, because it greedily matches INPUT source paths named in the goal and
    would otherwise false-veto a genuinely complete mission (2026-10-08)."""
    code_failures = [x for x in report.get("code_checks", []) or [] if not x.get("ok")]
    if code_failures:
        details = [x.get("message", "code validation failed") for x in code_failures[:4]]
        return "CONTINUE", f"code check failure: {details}"
    symbol_failures = [x for x in report.get("symbol_checks", []) or [] if not x.get("ok")]
    if symbol_failures:
        names = [x.get("symbol") for x in symbol_failures[:8]]
        return "CONTINUE", f"new callable(s) lack a grep-visible call-site: {names}"
    ran, passed = _verify_tally(report)
    if ran:
        if passed < ran:
            failed = [x.get("cmd") for x in report.get("verify", []) if not x.get("ok")]
            return "CONTINUE", f"verify check(s) did not exit 0: {failed}"
        return None, ""  # every verify passed → trust the machine-checked proof
    # No verify checks: fall back to artifact existence + real-change heuristics.
    artifacts = _goal_artifacts(goal)
    missing = [p for p in artifacts if not os.path.exists(p)]
    if artifacts and missing:
        return "CONTINUE", f"required artifact(s) missing on disk: {missing}"
    if not _made_changes(report):
        return "CONTINUE", "no file changes applied and no passing verify evidence"
    return None, ""


def _gate_verdict(goal: str, report: dict) -> dict:
    """A verdict derived purely from deterministic evidence — used when the LLM
    judge is unavailable, so a mission whose verify passed (or that made real
    changes with nothing failing) still COMPLETEs instead of crashing."""
    forced, why = _deterministic_gate(goal, report)
    ran, passed = _verify_tally(report)
    if forced is None and ((ran and passed == ran) or _made_changes(report)):
        return {"decision": "COMPLETE", "reason": "deterministic evidence (verify passed / changes applied)"}
    return {"decision": "CONTINUE", "feedback": why or "no verified evidence"}


def _apply_gate(goal: str, report: dict, verdict: dict) -> dict:
    """Enforce deterministic checks and feed their precise failures to the writer."""
    forced, why = _deterministic_gate(goal, report)
    if forced == "CONTINUE" and str(verdict.get("decision", "")).upper() == "COMPLETE":
        log.warning("mission: deterministic gate overrode judge COMPLETE → CONTINUE (%s)", why)
        fb = (verdict.get("feedback", "") or "").strip()
        return {"decision": "CONTINUE", "reason": verdict.get("reason", ""),
                "feedback": f"{fb} [gate: {why}]".strip(), "gate_override": True}
    if forced == "CONTINUE":
        updated = dict(verdict)
        fb = (updated.get("feedback", "") or "").strip()
        if why and why not in fb:
            updated["feedback"] = f"{fb} [gate: {why}]".strip()
        return updated
    return verdict


async def run_mission(
    goal: str,
    *,
    writer: str | None = None,
    executor: str | None = None,
    judge: str | None = None,
    max_iters: int | None = None,
    full: bool = True,
    auto: bool = True,
) -> dict:
    """Adaptive mission run. Returns a result dict with the chosen team + transcript."""
    from providers.router import chat_repl, dispatch

    assessment = assess_mission(goal) if auto else {"type": "general", "complexity": 3}
    team = _team_for(assessment["complexity"])
    mtype = assessment["type"]
    max_iters = int(max_iters or os.getenv("PAL_MISSION_MAX_ITERS", "4"))

    # ENSEMBLE (M3): use the whole roster as one synthesized team. Default "all"
    # engages the panel for EVERY mission that has at least PAL_MISSION_MIN_MODELS
    # distinct models; "auto" keeps the old complexity>=4 trigger; "off" disables.
    # When fewer than the floor are available it degrades to the writer/executor
    # team (or single) path below.
    _ensemble = os.getenv("PAL_MISSION_ENSEMBLE", "all").lower()
    _panel = os.getenv("PAL_MISSION_PANEL", "auto").lower()
    min_models = max(2, int(os.getenv("PAL_MISSION_MIN_MODELS", "3")))
    if auto and _ensemble != "off":
        want_panel = (
            _panel in ("1", "true", "yes")
            or _ensemble == "all"
            or (_panel == "auto" and assessment["complexity"] >= 4)
        )
        if want_panel:
            cap = int(os.getenv("PAL_MISSION_PANEL_MAX", "12"))
            pmodels = await _panel_models(mtype, cap)
            if len(pmodels) >= min_models:
                pjudge = (
                    judge
                    or _pick(_rank_for_role("reviewer", _all_available_models()))
                    or _pick(_env_models("PAL_MISSION_REVIEWER_MODELS", ["gemini-3.5-flash-lite"]))
                )
                res = await run_panel(goal, pmodels, pjudge, full)
                res["assessment"] = assessment
                return res

    used: set[str] = set()
    writer = writer or _pick(_writer_pool(mtype))
    if writer:
        used.add(writer)
    executor = executor or _pick_distinct(_executor_pool(mtype), used)
    if executor:
        used.add(executor)

    # EASY: one capable model does the whole thing directly via the tool loop.
    if team["single"] and auto and mtype != "code":
        solo = executor or writer
        answer, _tr = await chat_repl._tools_loop(goal, solo, os.getcwd(), max_steps=6, full=full)
        artifacts = _goal_artifacts(goal)
        if artifacts:
            # completion is decided by the artifacts existing on disk, not by
            # whether the tool loop emitted a clean final answer.
            missing = [p for p in artifacts if not os.path.exists(p)]
            ok = not missing
        else:
            ok = "__ERROR__" not in (answer or "")
            missing = []
        return {"status": "COMPLETE" if ok else "INCOMPLETE", "mode": "single", "model": solo,
                "assessment": assessment, "team_size": 1, "artifacts": artifacts,
                "missing": missing, "answer": (answer or "")[:600]}

    judge = judge or _pick_distinct(_env_models("PAL_MISSION_REVIEWER_MODELS", [writer or "qwen3"]), used) or writer
    used.add(judge)
    reviewer_models: list[str] = []
    for _ in range(team["reviewers"]):
        rm = _pick_distinct(_executor_pool(mtype) + _writer_pool(mtype), used)
        if rm:
            reviewer_models.append(rm)
            used.add(rm)

    criteria = f"The mission is accomplished and verified on disk: {goal}"
    transcript: list[dict] = []
    feedback = ""
    repo_ctx = _repo_context(goal)
    # writer failover: if the chosen writer emits an empty plan, rotate to the next
    # writer WITHIN the same iteration instead of wasting it (deterministic-first).
    writer_tries = max(1, int(os.getenv("PAL_MISSION_WRITER_TRIES", "3")))
    writer_candidates = [writer] + [m for m in _writer_pool(mtype) if m != writer]
    no_progress_limit = _no_progress_limit()
    previous_fingerprint = None
    repeated_fingerprint_count = 0
    for iteration in range(1, max_iters + 1):
        plan: dict = {}
        writer_used = writer
        wr_prompt = (
            f"REPO CONTEXT:\n{repo_ctx}\n\nMISSION: {goal}\nACCEPTANCE: {criteria}\n"
            f"FEEDBACK: {feedback or '(none)'}"
        )
        for cand in writer_candidates[:writer_tries]:
            wr = await asyncio.to_thread(
                dispatch.generate, cand, wr_prompt, _WRITER_SYS,
                temperature=0.2, category="mission", tool="mission",
                max_output_tokens=int(os.getenv("PAL_TOOLS_MAX_TOKENS", "8192")),
            )
            plan = _extract_json(getattr(wr, "content", "") or "") or {}
            writer_used = cand
            if _plan_is_actionable(plan):
                break
            log.warning("mission: writer %s emitted an empty plan → failing over to next writer", cand)
        report = await _execute_plan(plan, executor, full, goal=goal)

        review_notes = []
        for rm in reviewer_models:
            rr = await asyncio.to_thread(
                dispatch.generate, rm,
                f"MISSION: {goal}\nPLAN: {json.dumps(plan)[:2000]}\nRESULTS: {json.dumps(report)[:2000]}",
                _REVIEWER_SYS, temperature=0.2, category="mission", tool="mission", max_output_tokens=300,
            )
            review_notes.append({"model": rm, "note": _extract_json(getattr(rr, "content", "") or "") or {}})

        jr = await asyncio.to_thread(
            dispatch.generate, judge,
            f"MISSION: {goal}\nACCEPTANCE: {criteria}\nRESULTS: {json.dumps(report)[:3000]}\n"
            f"REVIEWS: {json.dumps(review_notes)[:1500]}",
            _JUDGE_SYS, temperature=0.1, category="mission", tool="mission",
        )
        verdict = _extract_json(getattr(jr, "content", "") or "") or {"decision": "CONTINUE", "feedback": "no verdict"}
        verdict = _apply_gate(goal, report, verdict)  # deterministic override of hallucinated COMPLETE
        fingerprint = _progress_fingerprint(report)
        if fingerprint == previous_fingerprint:
            repeated_fingerprint_count += 1
        else:
            repeated_fingerprint_count = 1
        previous_fingerprint = fingerprint
        transcript.append({"iteration": iteration, "writer": writer_used, "executor": executor,
                           "reviewers": reviewer_models, "judge": judge, "plan": plan,
                           "exec": report, "reviews": review_notes, "verdict": verdict})
        if str(verdict.get("decision", "")).upper() == "COMPLETE":
            return {"status": "COMPLETE", "mode": "team", "iterations": iteration,
                    "assessment": assessment, "team_size": 3 + len(reviewer_models),
                    "writer": writer, "executor": executor, "reviewers": reviewer_models,
                    "judge": judge, "transcript": transcript}
        if no_progress_limit and repeated_fingerprint_count >= no_progress_limit:
            reason = (
                f"no forward progress for {repeated_fingerprint_count} consecutive iterations; "
                "the executor evidence and failing checks repeated"
            )
            log.warning("mission: %s", reason)
            return {
                "status": "INCOMPLETE", "mode": "team", "iterations": iteration,
                "assessment": assessment, "team_size": 3 + len(reviewer_models),
                "writer": writer, "executor": executor, "reviewers": reviewer_models,
                "judge": judge, "transcript": transcript,
                "no_progress": True, "no_progress_reason": reason,
            }
        feedback = verdict.get("feedback", "")

    return {"status": "INCOMPLETE", "mode": "team", "iterations": max_iters,
            "assessment": assessment, "team_size": 3 + len(reviewer_models),
            "writer": writer, "executor": executor, "reviewers": reviewer_models,
            "judge": judge, "transcript": transcript}


def run_mission_sync(goal: str, **kwargs) -> dict:
    return asyncio.run(run_mission(goal, **kwargs))


def main(argv: list[str]) -> int:
    """CLI: pal mission "<goal>" [--writer M] [--executor M] [--judge M] [--max-iters N] [--no-auto] [--json]"""
    import argparse

    ap = argparse.ArgumentParser(prog="pal mission", description="adaptive writer->executor->judge mission")
    ap.add_argument("goal")
    ap.add_argument("--writer")
    ap.add_argument("--executor")
    ap.add_argument("--judge")
    ap.add_argument("--max-iters", type=int)
    ap.add_argument("--no-auto", action="store_true", help="disable auto team-sizing")
    ap.add_argument("--ro", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    os.environ.setdefault("PAL_TOOLBELT", "1")
    from server import configure_providers

    configure_providers()
    res = run_mission_sync(
        a.goal, writer=a.writer, executor=a.executor, judge=a.judge,
        max_iters=a.max_iters, full=not a.ro, auto=not a.no_auto,
    )
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        asmt = res.get("assessment", {})
        print(f"status: {res['status']}  mode: {res.get('mode')}  team_size: {res.get('team_size')}")
        print(f"assessed: type={asmt.get('type')} complexity={asmt.get('complexity')}")
        if res.get("mode") == "single":
            print(f"model: {res.get('model')}")
        else:
            print(f"writer={res.get('writer')} executor={res.get('executor')} "
                  f"reviewers={res.get('reviewers')} judge={res.get('judge')}")
    return 0 if res["status"] == "COMPLETE" else 1
