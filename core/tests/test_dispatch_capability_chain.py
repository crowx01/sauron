"""Unit tests for dispatch._capability_chain — the catalog-backed, capability
matched fallback peers that dispatch.generate seeds into call_with_fallback.

These are pure (catalog.select is stubbed), so they make no network calls.
"""

from __future__ import annotations

from providers.router import dispatch


class _Entry:
    def __init__(self, model):
        self.model = model


def test_capability_chain_excludes_primary_and_dedupes(monkeypatch):
    from providers.router import catalog

    captured = {}

    def _fake_select(need, entries=None, priors=()):
        captured["need"] = need
        return [_Entry("gpt-oss-20b"), _Entry("gpt-oss-120b"), _Entry("gemini-3.6-flash")]

    monkeypatch.setattr(catalog, "select", _fake_select)
    # no provider registered for the primary in this unit env -> alias lookup is
    # best-effort and simply yields the primary name itself for exclusion.
    out = dispatch._capability_chain("gpt-oss-20b", "a short prompt", tools=None, category="chat")
    assert "gpt-oss-20b" not in out          # primary excluded
    assert out == ["gpt-oss-120b", "gemini-3.6-flash"]


def test_capability_chain_sets_tools_and_context_need(monkeypatch):
    from providers.router import catalog

    captured = {}

    def _fake_select(need, entries=None, priors=()):
        captured["need"] = need
        return []

    monkeypatch.setattr(catalog, "select", _fake_select)
    prompt = "x" * 4000  # ~1000 tokens
    dispatch._capability_chain("m", prompt, tools=[{"type": "function"}], category="chat")
    need = captured["need"]
    assert need.tools is True                 # tool call -> fallbacks must be tool-capable
    assert need.min_context == len(prompt) // 4  # fallbacks must hold the prompt
    assert need.allow_free_tier is False


def test_capability_chain_allows_free_tier_for_bulk(monkeypatch):
    from providers.router import catalog

    captured = {}
    monkeypatch.setattr(catalog, "select", lambda need, **k: captured.setdefault("need", need) or [])
    dispatch._capability_chain("m", "p", tools=None, category="long_context_bulk")
    assert captured["need"].allow_free_tier is True


def test_capability_chain_degrades_to_empty_on_error(monkeypatch):
    from providers.router import catalog

    def _boom(*a, **k):
        raise RuntimeError("catalog down")

    monkeypatch.setattr(catalog, "select", _boom)
    assert dispatch._capability_chain("m", "p", tools=None, category="chat") == []
