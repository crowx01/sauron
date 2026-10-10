"""
Tests for Sauron Rebranding & Visual Identity System
"""

import pytest
from utils.sauron_brand import (
    render_sauron_logo,
    render_sauron_banner,
    render_sauron_statusline,
    SAURON_CRIMSON,
    SAURON_VIOLET,
)


def test_logo_rendering():
    logo = render_sauron_logo()
    plain_text = logo.plain
    assert "👁" in plain_text
    assert "SAURON" not in plain_text  # Logo is artwork
    assert len(plain_text.splitlines()) == 5


def test_banner_rendering():
    banner = render_sauron_banner(model_disp="gemini-2.5-flash", memory_count=3)
    assert banner is not None


def test_statusline_formatting():
    sl = render_sauron_statusline(
        model="gemini-2.5-flash",
        provider="google",
        context_pct=4.2,
        used_tokens=45000,
        total_tokens=1048576,
        memory_facts=3,
    )
    assert "SAURON" in sl
    assert "Context: 4.2%" in sl
    assert "45.0k / 1.05M" in sl
    assert "3 facts" in sl
