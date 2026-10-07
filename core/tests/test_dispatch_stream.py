"""Unit tests for dispatch.generate_stream — streaming, fallback, and errors.

Providers/registry are stubbed so nothing hits the network.
"""

from __future__ import annotations

import pytest

from providers.router import dispatch


class _Resp:
    def __init__(self, content):
        self.content = content


class _StreamProv:
    def generate_content_stream(self, prompt, model, system=None, temperature=0.3):
        yield from ("Hello", ", ", "world")


class _StreamThenDie:
    def generate_content_stream(self, prompt, model, system=None, temperature=0.3):
        yield "partial "
        raise RuntimeError("stream broke mid-way")


class _DieImmediately:
    def generate_content_stream(self, prompt, model, system=None, temperature=0.3):
        raise RuntimeError("no stream at all")
        yield  # pragma: no cover


class _NoStreamProv:  # has no generate_content_stream attribute
    pass


@pytest.fixture(autouse=True)
def _no_sizeguard_no_caveman(monkeypatch):
    from providers.router import caveman, size_guard

    monkeypatch.setattr(caveman, "is_enabled", lambda: False)
    monkeypatch.setattr(size_guard, "check_or_reroute", lambda m, p: (True, ""))
    # silence episode/refusal recording side effects
    from providers.router import episode_store, refusal_memory

    monkeypatch.setattr(episode_store, "record", lambda *a, **k: None)
    monkeypatch.setattr(refusal_memory, "classify", lambda t: None)
    monkeypatch.setattr(refusal_memory, "record_success", lambda *a, **k: None)
    monkeypatch.setattr(refusal_memory, "record", lambda *a, **k: None)


def _set_provider(monkeypatch, prov):
    from providers.registry import ModelProviderRegistry

    monkeypatch.setattr(ModelProviderRegistry, "get_provider_for_model", classmethod(lambda cls, m: prov))


def test_generate_stream_streams_deltas(monkeypatch):
    _set_provider(monkeypatch, _StreamProv())
    got = []
    out = dispatch.generate_stream("m", "hi", None, on_delta=got.append)
    assert got == ["Hello", ", ", "world"]
    assert out == "Hello, world"


def test_generate_stream_falls_back_when_no_stream_method(monkeypatch):
    _set_provider(monkeypatch, _NoStreamProv())
    monkeypatch.setattr(dispatch, "generate", lambda *a, **k: _Resp("unary answer"))
    got = []
    out = dispatch.generate_stream("m", "hi", None, on_delta=got.append)
    assert out == "unary answer"
    assert got == ["unary answer"]          # emitted in one delta


def test_generate_stream_falls_back_when_stream_dies_before_output(monkeypatch):
    _set_provider(monkeypatch, _DieImmediately())
    monkeypatch.setattr(dispatch, "generate", lambda *a, **k: _Resp("recovered"))
    got = []
    out = dispatch.generate_stream("m", "hi", None, on_delta=got.append)
    assert out == "recovered"               # nothing streamed -> unary fallback
    assert got == ["recovered"]


def test_generate_stream_reraises_on_mid_stream_failure(monkeypatch):
    _set_provider(monkeypatch, _StreamThenDie())
    got = []
    with pytest.raises(RuntimeError):
        dispatch.generate_stream("m", "hi", None, on_delta=got.append)
    assert got == ["partial "]              # the partial delta reached the caller
