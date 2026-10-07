"""Provider-level test for OpenAICompatibleProvider.generate_content_stream.

A fake OpenAI client returns chunk objects shaped like the SDK's; no network.
"""

from __future__ import annotations

import pytest

from providers.openai_compatible import OpenAICompatibleProvider
from providers.shared.provider_type import ProviderType


class _Delta:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.delta = _Delta(content)


class _Chunk:
    def __init__(self, content):
        self.choices = [_Choice(content)]


class _FakeCompletions:
    def __init__(self, recorder):
        self._rec = recorder

    def create(self, **kwargs):
        self._rec["params"] = kwargs
        # last chunk has content=None (e.g. finish) -> must be skipped
        return iter([_Chunk("Port "), _Chunk("8080 "), _Chunk("open"), _Chunk(None)])


class _FakeClient:
    def __init__(self, recorder):
        self.chat = type("C", (), {"completions": _FakeCompletions(recorder)})()


class _Prov(OpenAICompatibleProvider):
    def __init__(self, recorder):
        self._rec = recorder
        self._fake = _FakeClient(recorder)

    def get_provider_type(self):
        return ProviderType.CUSTOM

    def validate_model_name(self, model_name):
        return True

    def get_capabilities(self, model_name):
        raise RuntimeError("no capabilities -> temperature passes through")

    def _resolve_model_name(self, model_name):
        return model_name

    @property
    def client(self):
        return self._fake


@pytest.fixture(autouse=True)
def _no_outbound(monkeypatch):
    from providers.router import outbound, self_heal

    monkeypatch.setattr(outbound, "prepare", lambda messages, model: (messages, None))
    monkeypatch.setattr(self_heal, "resolve", lambda m: m)


def test_stream_yields_text_and_skips_empty_final():
    rec: dict = {}
    pieces = list(_Prov(rec).generate_content_stream("hi", "local-model", "sys", temperature=0.5))
    assert pieces == ["Port ", "8080 ", "open"]           # None chunk dropped
    assert rec["params"]["stream"] is True                # really streaming
    assert rec["params"]["temperature"] == 0.5
    # system prompt + user prompt are both forwarded
    roles = [m["role"] for m in rec["params"]["messages"]]
    assert roles == ["system", "user"]
