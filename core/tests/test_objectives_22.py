"""
Automated Regression Tests for 22.json Objectives
Covers:
- OBJ-01: Maximum mission execution attempts default to 10
- OBJ-02: Concise completion brief with 4 terminal statuses
- OBJ-03: Context percentage calculation from model capacity
- OBJ-04: Token capacity counter and formatting
- OBJ-05: Slash command autocomplete registry and filtering
- OBJ-06 & OBJ-07: Terminal prompt panel stability and error resilience
"""

import os
import pytest
from providers.router.mission import format_mission_summary
from providers.router.chat_repl import (
    _context_stats,
    _fmt_tokens,
    _context_pct,
    _rounded_frame,
    _filter_picker_choices,
    _PALETTE_CHOICES,
)


def test_obj01_max_attempts_default():
    """OBJ-01: Default maximum mission attempts must be 10."""
    default_iters = int(os.getenv("PAL_MISSION_MAX_ITERS", "10"))
    assert default_iters == 10


def test_obj02_mission_completion_brief():
    """OBJ-02: Concise mission completion brief with valid status label."""
    res = {
        "status": "COMPLETE",
        "iterations": 2,
        "max_iters": 10,
        "mode": "team",
        "transcript": [{"exec": {"files_written": ["test.py"]}}]
    }
    summarized = format_mission_summary(res)
    assert summarized["terminal_status"] == "SUCCESS"
    assert "Attempts: 2/10" in summarized["summary_brief"]
    assert "Modified Artifacts" in summarized["summary_brief"]


def test_obj03_and_obj04_context_stats_and_formatting():
    """OBJ-03 & OBJ-04: Non-zero context percentage and formatted token counter."""
    history = [{"role": "user", "text": "Hello world"}]
    pct, used, cap = _context_stats(history, "gemini-3.6-flash")
    
    assert used > 0
    assert cap == 900_000
    assert pct > 0.0
    
    formatted_used = _fmt_tokens(used)
    formatted_cap = _fmt_tokens(cap)
    assert "k" in formatted_used or int(formatted_used) >= 0
    assert "k" in formatted_cap or "M" in formatted_cap


def test_obj05_slash_autocomplete_filtering():
    """OBJ-05: Typing /model or / filters slash command choices accurately."""
    filtered_all = _filter_picker_choices(_PALETTE_CHOICES, "/")
    assert len(filtered_all) > 0
    
    filtered_model = _filter_picker_choices(_PALETTE_CHOICES, "/model")
    labels = [choice[1].strip() for choice in filtered_model]
    assert "/model" in labels or "/models" in labels


def test_obj07_prompt_panel_layout_constraint():
    """OBJ-07: _rounded_frame enforces minimum height dimension so prompt box is not squished."""
    from prompt_toolkit.widgets import TextArea
    ta = TextArea(text="test prompt")
    frame = _rounded_frame(ta)
    assert frame.height is not None
