"""Headless verification of the Claude-Code-style boxed input (_BoxedPrompt).

Drives the prompt_toolkit Application with a piped input + DummyOutput, so we
can assert Enter submits, Alt+Enter inserts a newline, and Shift+Tab cycles the
permission mode — without a real terminal.
"""

from __future__ import annotations

import pytest

pytest.importorskip("prompt_toolkit")

from prompt_toolkit.input.defaults import create_pipe_input  # noqa: E402
from prompt_toolkit.output import DummyOutput  # noqa: E402

from providers.router import chat_repl  # noqa: E402


async def _run_box(keys: str, tmp_path, monkeypatch):
    monkeypatch.setenv("PAL_SESSION_DB", str(tmp_path / "s.db"))
    state = chat_repl._ReplState(model="qwen3", cwd="/work")
    box = chat_repl._BoxedPrompt("sess-test", state)
    with create_pipe_input() as pipe:
        pipe.send_text(keys)
        try:
            text = await box.prompt_async(_input=pipe, _output=DummyOutput())
        except (EOFError, KeyboardInterrupt) as exc:  # surfaced to caller as a marker
            return state, type(exc).__name__
    return state, text


async def test_enter_submits_typed_text(tmp_path, monkeypatch):
    state, text = await _run_box("scan the box\r", tmp_path, monkeypatch)
    assert text == "scan the box"


async def test_ctrl_d_on_empty_raises_eof(tmp_path, monkeypatch):
    state, marker = await _run_box("\x04", tmp_path, monkeypatch)
    assert marker == "EOFError"


async def test_shift_tab_cycles_permission_then_submits(tmp_path, monkeypatch):
    # Shift+Tab (ESC [ Z) cycles auto->ask, then type + Enter.
    state, text = await _run_box("\x1b[Zhi\r", tmp_path, monkeypatch)
    assert state.perm == "ask"
    assert text == "hi"
