"""
Sauron Complete Visual Identity, Brand Palette & Terminal UI Framework

Defines Sauron's distinctive visual theme, multi-node watchful eye logo, ANSI styling,
startup splash, and status bar rendering.

Palette:
- Obsidian (#121212)
- Muted Silver (#cbd5e1)
- Crimson (#ef4444)
- Amber (#f59e0b)
- Electric Violet (#a855f7)
"""

from __future__ import annotations

from rich.console import Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

# Brand Color Palette
SAURON_OBSIDIAN = "#121212"
SAURON_SILVER = "#cbd5e1"
SAURON_CRIMSON = "#ef4444"
SAURON_AMBER = "#f59e0b"
SAURON_VIOLET = "#a855f7"
SAURON_MUTED = "#64748b"

# Multi-Node Watchful Eye Logo Artwork (5-line high-contrast design)
SAURON_LOGO_ASCII = [
    "  ⬡───[ 👁 ]───⬡  ",
    " ╱   ███████   ╲ ",
    "⬢   ██ ◈ ◈ ██   ⬢",
    " ╲   ███████   ╱ ",
    "  ⬡───[ ❖ ]───⬡  ",
]

SAURON_LOGO_STYLES = [
    f"bold {SAURON_VIOLET}",
    f"bold {SAURON_CRIMSON}",
    f"bold {SAURON_CRIMSON}",
    f"bold {SAURON_CRIMSON}",
    f"bold {SAURON_AMBER}",
]


def render_sauron_logo() -> Text:
    """Render colored Rich Text object for Sauron Multi-Node Watchful Eye logo."""
    logo = Text()
    for i, line in enumerate(SAURON_LOGO_ASCII):
        style = SAURON_LOGO_STYLES[i] if i < len(SAURON_LOGO_STYLES) else SAURON_CRIMSON
        logo.append(line + ("\n" if i < len(SAURON_LOGO_ASCII) - 1 else ""), style=style)
    return logo


def render_sauron_banner(model_disp: str = "auto (routed)", cwd_disp: str = "", memory_count: int = 0) -> Group:
    """Render modern, compact Sauron CLI startup banner with identity and features."""
    logo = render_sauron_logo()

    ident = Group(
        Text.assemble(
            ("SAURON ", f"bold {SAURON_CRIMSON}"),
            ("ENGINE", f"bold {SAURON_SILVER}"),
            ("  v2.5.0", f"dim {SAURON_MUTED}"),
        ),
        Text("Central Multi-Model Shared Intelligence Orchestrator", style=f"bold {SAURON_VIOLET}"),
        Text(f"Model: {model_disp}  ·  Shared Memory: {memory_count} facts active", style=f"dim {SAURON_SILVER}"),
        Text(cwd_disp or "~", style=f"dim {SAURON_MUTED}"),
    )

    grid = Table.grid(padding=(0, 2))
    grid.add_column()
    grid.add_column(vertical="middle")
    grid.add_row(logo, ident)

    hint = Text(
        "/help  ·  shift+tab cycle mode  ·  /memory list  ·  /exit",
        style=f"dim {SAURON_AMBER}",
    )

    return Group(grid, Text(""), hint)


def render_sauron_statusline(
    model: str = "auto",
    provider: str = "router",
    context_pct: float = 0.0,
    used_tokens: int = 0,
    total_tokens: int = 1048576,
    memory_facts: int = 0,
    cycle_mode: str = "default",
) -> str:
    """Render plain or ANSI status line string for header/status line integration."""
    def fmt(n: int) -> str:
        if n >= 1000000:
            return f"{n/1000000:.2f}M"
        if n >= 1000:
            return f"{n/1000:.1f}k"
        return str(n)

    tokens_str = f"{fmt(used_tokens)} / {fmt(total_tokens)}"
    return (
        f"\033[1;35m👁 SAURON\033[0m | "
        f"\033[1;36mContext: {context_pct:.1f}%\033[0m | "
        f"\033[1;32mTokens: {tokens_str}\033[0m | "
        f"\033[1;33mMemory: {memory_facts} facts\033[0m | "
        f"\033[1;34m[{model} via {provider}]\033[0m"
    )
