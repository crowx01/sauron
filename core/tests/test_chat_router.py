"""Unit tests for the pal-chat tier router and REPL helpers."""

from __future__ import annotations

import json

import pytest

from providers.router import chat_repl, chat_router

AVAIL = {"gpt-oss-20b", "gpt-oss-120b", "gemini-3.6-flash"}


def _av(m):
    return m in AVAIL


@pytest.mark.parametrize(
    "msg,tier",
    [
        ("hi", "cheap"),
        ("hey!!", "cheap"),
        ("thanks", "cheap"),
        ("how are you", "cheap"),
        ("what is 2+2", "cheap"),
        ("why does TCP slow start cause bufferbloat?", "smart"),
        ("write a python quicksort", "smart"),
        ("fix this sql query", "smart"),
        ("design an auth system", "smart"),
        ("test SSRF on this endpoint", "smart"),  # classifier category
        ("```def f(): pass```", "smart"),  # contains code
    ],
)
def test_tier_decisions(msg, tier):
    assert chat_router.route(msg, _av)["tier"] == tier


def test_cheap_and_smart_models_resolve():
    # Routing is catalog-driven: within a tier the capability catalog ranks the
    # reachable candidates (cheap = cheapest cost_rank first), so the exact cheap
    # pick is whatever the catalog rates lowest-cost among the available set --
    # not necessarily the first legacy CHEAP_TIER name. Assert the contract that
    # actually matters: a reachable cheap model is chosen, the smart tier lands
    # on the strongest reachable smart model, and a greeting routes to cheap.
    r = chat_router.route("hi", _av)
    assert r["cheap"] in AVAIL
    assert r["smart"] == "gpt-oss-120b"
    assert r["model"] == r["cheap"]


def test_smart_message_uses_smart_model():
    assert chat_router.route("why is the sky blue, explain", _av)["model"] == "gpt-oss-120b"


def test_env_override(monkeypatch):
    monkeypatch.setenv("PAL_CHAT_CHEAP_MODEL", "my-cheap")
    monkeypatch.setenv("PAL_CHAT_SMART_MODEL", "my-smart")
    r = chat_router.route("hi", lambda m: True)
    assert r["cheap"] == "my-cheap" and r["smart"] == "my-smart"


def test_no_models_available_returns_none():
    r = chat_router.route("hi", lambda m: False)
    assert r["model"] is None


def test_empty_prompt_is_cheap():
    assert chat_router.classify_difficulty("")[0] == "cheap"


# ----- REPL helpers ----------------------------------------------------------
class _Item:
    def __init__(self, text):
        self.text = text


def test_clean_strips_agent_boilerplate():
    raw = "Real answer here.\n\n---\nAGENT'S TURN: Evaluate this perspective..."
    assert chat_repl._clean(raw) == "Real answer here."


def test_clean_strips_continuation_note():
    raw = "The answer.\n**Please respond using the continuation_id from this response**"
    assert chat_repl._clean(raw) == "The answer."


def test_extract_plain_text():
    ans, cont = chat_repl._extract([_Item("just text")])
    assert ans == "just text"
    assert cont is None


def test_extract_json_envelope_and_continuation():
    payload = json.dumps({"content": "hello", "continuation_offer": {"continuation_id": "abc123"}})
    ans, cont = chat_repl._extract([_Item(payload)])
    assert ans == "hello"
    assert cont == "abc123"


def test_extract_cleans_boilerplate_in_content():
    payload = json.dumps({"content": "Answer.\nAGENT'S TURN: do stuff"})
    ans, _ = chat_repl._extract([_Item(payload)])
    assert ans == "Answer."


def test_extract_files_required_envelope_humanized():
    payload = json.dumps({
        "status": "files_required_to_continue",
        "mandatory_instructions": "I need src/auth/recon.js",
        "files_needed": ["src/auth/recon.js"],
    })
    ans, _ = chat_repl._extract([_Item(payload)])
    assert "wanted to see files" in ans
    assert "recon.js" in ans
    assert "files_required_to_continue" not in ans  # raw JSON not shown


# ----- self-contained conversation context (Phase 3) -------------------------
def test_ctx_append_skips_empty_and_errors():
    h: list[dict] = []
    chat_repl._ctx_append(h, "user", "  hello  ")
    chat_repl._ctx_append(h, "assistant", "")          # empty -> dropped
    chat_repl._ctx_append(h, "assistant", "   ")       # whitespace -> dropped
    chat_repl._ctx_append(h, "assistant", "__ERROR__boom")  # error sentinel -> dropped
    assert h == [{"role": "user", "content": "hello"}]


def test_ctx_append_caps_total_turns(monkeypatch):
    monkeypatch.setattr(chat_repl, "_CTX_MAX_TURNS", 3)
    h: list[dict] = []
    for i in range(6):
        chat_repl._ctx_append(h, "user", f"m{i}")
    assert [t["content"] for t in h] == ["m3", "m4", "m5"]  # oldest discarded


def test_ctx_render_empty_is_blank():
    assert chat_repl._ctx_render([]) == ""


def test_ctx_render_wraps_and_labels_turns():
    h = [
        {"role": "user", "content": "scan example.com"},
        {"role": "assistant", "content": "found an open port 8080"},
    ]
    out = chat_repl._ctx_render(h, budget=10_000)
    assert "Conversation so far" in out
    assert "[Current message]" in out
    assert "You: scan example.com" in out
    assert "Sauron: found an open port 8080" in out


def test_ctx_render_trims_oldest_first_and_keeps_newest():
    h = [
        {"role": "user", "content": "OLD-" + "x" * 200},
        {"role": "assistant", "content": "MID-" + "y" * 200},
        {"role": "user", "content": "NEWEST question"},
    ]
    out = chat_repl._ctx_render(h, budget=60)
    assert "NEWEST question" in out          # newest is always kept
    assert "OLD-" not in out                  # oldest dropped under tight budget
    assert "earlier turns omitted" in out     # visible marker left behind


def test_ctx_compact_noop_when_too_short():
    h = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
    before = list(h)
    folded, err = chat_repl._ctx_compact(h)
    assert folded == 0 and err is None
    assert h == before  # untouched


class _Resp:
    def __init__(self, content):
        self.content = content


async def test_ask_chat_prepends_context_and_uses_dispatch(monkeypatch):
    from providers.router import dispatch

    seen = {}

    def _fake_generate(model, prompt, system=None, **kw):
        seen["model"] = model
        seen["prompt"] = prompt
        seen["system"] = system
        return _Resp("the answer")

    monkeypatch.setattr(dispatch, "generate", _fake_generate)
    history = [
        {"role": "user", "content": "earlier ask"},
        {"role": "assistant", "content": "earlier reply"},
    ]
    ans = await chat_repl._ask_chat("gpt-oss-20b", "new question", history, role="smart")
    assert ans == "the answer"
    assert seen["model"] == "gpt-oss-20b"
    assert "earlier ask" in seen["prompt"]        # prior context threaded in
    assert "new question" in seen["prompt"]
    assert seen["system"] == chat_repl._ROLES["smart"]


async def test_ask_chat_error_is_sentinel(monkeypatch):
    from providers.router import dispatch

    def _boom(*a, **k):
        raise RuntimeError("provider down")

    monkeypatch.setattr(dispatch, "generate", _boom)
    ans = await chat_repl._ask_chat("m", "q", [], role=None)
    assert ans.startswith("__ERROR__")
    assert "provider down" in ans


# ----- orchestrator fallback onto smartest models ----------------------------
def test_orchestrator_available_env_force_none(monkeypatch):
    monkeypatch.setenv("PAL_ORCHESTRATOR", "none")
    assert chat_repl._orchestrator_available() is False


def test_orchestrator_available_checks_cli(monkeypatch):
    import shutil

    monkeypatch.delenv("PAL_ORCHESTRATOR", raising=False)
    monkeypatch.setenv("PAL_ORCHESTRATOR_CLI", "claude")
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/claude" if name == "claude" else None)
    assert chat_repl._orchestrator_available() is True
    monkeypatch.setattr(shutil, "which", lambda name: None)
    assert chat_repl._orchestrator_available() is False


def test_smartest_models_ranks_by_intelligence_and_tools(monkeypatch):
    from providers.router import catalog

    class _E:
        def __init__(self, model, intel, tools, aliases=()):
            self.model = model
            self.quality_profile = {"intelligence": intel}
            self.cost_profile = {}
            self.tools = tools
            self.availability = catalog.AVAILABLE
            self.provider = "p"
            self.aliases = list(aliases)

        @property
        def routable(self):
            return True

        @property
        def intelligence(self):
            return int(self.quality_profile.get("intelligence") or 0)

        @property
        def cost_rank(self):
            return 2

    cat_entries = [
        _E("smart-tool", 20, True),
        _E("mid-tool", 14, True),
        _E("smartest-notool", 30, False),   # excluded: no tools
        _E("cheap-tool", 8, True),
    ]

    class _Cat:
        entries = cat_entries

    monkeypatch.setattr(catalog, "routing_catalog", lambda *a, **k: _Cat())
    out = chat_repl._smartest_models(2, need_tools=True, is_available=lambda m: True)
    assert out == ["smart-tool", "mid-tool"]   # highest-intelligence tool-capable, no no-tool model


def test_claude_plan_only_default_and_off(monkeypatch):
    monkeypatch.delenv("PAL_CLAUDE_PLAN_ONLY", raising=False)
    assert chat_repl._claude_plan_only() is True
    monkeypatch.setenv("PAL_CLAUDE_PLAN_ONLY", "0")
    assert chat_repl._claude_plan_only() is False


def test_agent_backend_plan_only_claude_plans_engine_executes(monkeypatch):
    monkeypatch.delenv("PAL_CLAUDE_PLAN_ONLY", raising=False)  # policy on
    # Claude available: only planning uses it; execution roles -> engine.
    assert chat_repl._agent_backend("planner", True) == "claude"
    assert chat_repl._agent_backend("edit", True) == "engine"
    assert chat_repl._agent_backend("default", True) == "engine"
    assert chat_repl._agent_backend("codereviewer", True) == "engine"
    # Claude unavailable: everything (planning included) runs on the engine.
    assert chat_repl._agent_backend("planner", False) == "engine"
    assert chat_repl._agent_backend("edit", False) == "engine"


def test_agent_backend_policy_off_is_legacy(monkeypatch):
    monkeypatch.setenv("PAL_CLAUDE_PLAN_ONLY", "0")
    # legacy: Claude handles any role when available
    assert chat_repl._agent_backend("edit", True) == "claude"
    assert chat_repl._agent_backend("default", True) == "claude"
    assert chat_repl._agent_backend("edit", False) == "engine"


def test_smartest_models_falls_back_to_router(monkeypatch):
    from providers.router import catalog, chat_router

    class _Cat:
        entries = []

    monkeypatch.setattr(catalog, "routing_catalog", lambda *a, **k: _Cat())
    monkeypatch.setattr(chat_router, "route", lambda *a, **k: {"smart": "fallback-smart"})
    assert chat_repl._smartest_models(3, is_available=lambda m: True) == ["fallback-smart"]


# ----- auto-debate gate for huge tasks (Phase 4) -----------------------------
def test_is_huge_task_detects_big_and_multistep(monkeypatch):
    monkeypatch.delenv("PAL_CHAT_HUGE_STEPS", raising=False)
    monkeypatch.delenv("PAL_CHAT_HUGE_CHARS", raising=False)
    assert chat_repl._is_huge_task("hi") is False
    assert chat_repl._is_huge_task("x" * 500) is True            # long
    assert chat_repl._is_huge_task("do it", steps=6) is True     # many tool steps
    assert chat_repl._is_huge_task("1. recon\n2. scan\n3. report\n4. verify") is True  # list


def test_is_huge_task_flags_security(monkeypatch):
    from providers.router import intent

    class _I:
        is_security = True

    monkeypatch.setattr(intent, "classify_intent", lambda t: _I())
    assert chat_repl._is_huge_task("exploit the target") is True


def test_auto_debate_enabled_default_and_off(monkeypatch):
    monkeypatch.delenv("PAL_CHAT_AUTODEBATE", raising=False)
    assert chat_repl._auto_debate_enabled() is True
    monkeypatch.setenv("PAL_CHAT_AUTODEBATE", "0")
    assert chat_repl._auto_debate_enabled() is False


async def test_debate_gate_summarizes_verdict(monkeypatch):
    from providers.router import debate

    monkeypatch.setattr(debate, "is_enabled", lambda: True)
    monkeypatch.setattr(
        debate, "run_debate",
        lambda objective, *a, **k: {
            "outcome": "COMPLETE",
            "final": {"confidence": 0.9, "findings": ["looks correct"], "remaining_risks": ["rate limits"]},
        },
    )
    out = await chat_repl._debate_gate("big task", "the answer")
    assert out.startswith("verdict: COMPLETE")
    assert "looks correct" in out
    assert "rate limits" in out


async def test_debate_gate_none_when_disabled(monkeypatch):
    from providers.router import debate

    monkeypatch.setattr(debate, "is_enabled", lambda: False)
    assert await chat_repl._debate_gate("t", "a") is None


def test_ctx_compact_folds_old_turns(monkeypatch):
    from providers.router import chat_router as _cr
    from providers.router import dispatch

    monkeypatch.setattr(dispatch, "generate", lambda *a, **k: _Resp("BRIEF: target=example.com, port 8080 open"))
    monkeypatch.setattr(_cr, "route", lambda *a, **k: {"cheap": "gpt-oss-20b"})
    h = [
        {"role": "user", "content": "turn1"},
        {"role": "assistant", "content": "ans1"},
        {"role": "user", "content": "turn2"},
        {"role": "assistant", "content": "ans2"},
        {"role": "user", "content": "recent-q"},
        {"role": "assistant", "content": "recent-a"},
    ]
    folded, err = chat_repl._ctx_compact(h, keep_recent=2)
    assert err is None and folded == 4
    assert h[0]["content"].startswith("[Earlier conversation summary]")
    assert "example.com" in h[0]["content"]       # evidence preserved
    assert h[-2:] == [
        {"role": "user", "content": "recent-q"},
        {"role": "assistant", "content": "recent-a"},
    ]
