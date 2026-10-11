# Sauron resilient-mission upgrades (ensemble + fallback policy)

Context: live failure 2026-10-08 — `sauron run --plan` on a ~7.1k-token spec: qwen3 ate a real 413 (size_guard under-counted because it measured prompt only, not system+tools), then fallback tried two dead HuggingFace models (402 no credits) before the working big-context model. flash-lite later stalled at max-steps authoring a large script. Deterministic cleanup (parse+curl) needed no LLM at all. Goal: merge model strengths per-subtask with a typed fallback policy so missions finish without these errors.

Repo: /home/kali/tools/sauron-work/sauron (Bun / TypeScript engine).

## P1 — size_guard counts the WHOLE request (fixes the slipped 413)
File: providers/router/size_guard.py
- `guess_input_tokens(prompt, files, system=None, tools=None, overhead=0)`: add system length//4 + a per-tool schema estimate (~250 tok/tool or len(json)//4) + a fixed SAFETY_OVERHEAD (default 800, env PAL_SIZE_OVERHEAD).
- Apply a safety margin: treat the effective cap as `int(cap * 0.9)` (env PAL_SIZE_MARGIN, default 0.9) so near-cap requests reroute instead of 413.
- `check_or_reroute(model, prompt, files=None, system=None, tools=None)` threads the new args; dispatch.generate (line ~90) and headless.py (A2) pass `system` and `tools`.

## P2 — 413-aware fallback ordering (fixes dead-peer thrash on oversize)
File: providers/router/fallback_chain.py
- New helper `_reorder_for_oversize(chain)` → sort remaining candidates by descending size_guard cap, so a 413 jumps straight to the biggest-context peer (flash-lite/pro/or-free), not the next small/dead one.
- In `call_with_fallback`, when the classified status == 413, reorder the not-yet-tried tail by that key before continuing.

## P3 — session provider quarantine (fixes HF 402 thrash)
File: providers/router/fallback_chain.py
- Module-level `_QUARANTINE: set[str]` of provider prefixes. On a 402 / "no remaining credits" / "credit" failure, add the candidate's provider prefix (text before first "/").
- `_merge_chain` filters out any model whose prefix is quarantined (never drop the primary). Env PAL_QUARANTINE=0 disables; `reset_quarantine()` test helper.

## P4 — `run --plan` prose guard (anti per-line-oversize foot-gun)
File: providers/router/headless.py (or cli --plan handling)
- If a --plan file looks like prose/markdown (any line > 400 chars, or markdown headings, or < 60% of non-blank lines start with a bullet), treat the WHOLE file as ONE task (like --task-file) instead of splitting per line. Log which mode was chosen.

## P5 — mission.py deterministic-first + explicit verifier (design → implement after P1-P4)
File: providers/router/mission.py
- Deterministic-first gate: for TYPE in (fileops, code) at complexity 1 where the writer's plan is a single script + run command, execute directly (skip reviewer/judge LLM round-trips).
- Verifier stage: the WRITER must emit a `verify` command per acceptance criterion (a shell/py check that exits 0); executor runs it; JUDGE may only say COMPLETE when every verify passed. Add a "second-tool" convention for probes (e.g. confirm httpx results with curl) in _JUDGE_SYS guidance.

## Tests (extend existing)
- tests/test_size_guard.py: system+tools+overhead push a near-cap prompt over → route hint; margin respected.
- tests/test_fallback_chain.py: 413 reorders to biggest-cap peer first; 402 quarantines the provider prefix and subsequent chains skip it.
Run: `bun test tests/stress_and_lifecycle.test.ts tests/adversarial.test.ts`.

Deliverable: unified diff per file + passing tests. Preserve all unrelated behavior; new behavior env-guarded and defaulted safe.
