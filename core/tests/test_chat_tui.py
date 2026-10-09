import asyncio
from types import SimpleNamespace

from providers.router.chat_repl import (
    _PALETTE_CHOICES,
    _filter_picker_choices,
    _FullScreenUI,
    _pick_model_menu,
    _pick_session_menu,
    _session_picker_choices,
)


def test_command_picker_filters_all_words_and_prefers_title_matches():
    choices = [
        ("Show status", "/status", "Inspect engine settings", "Sauron"),
        ("Switch session", "/sessions", "Browse saved conversations", "Session"),
        ("Browse model catalog", "/models", "Inspect model availability", "Model"),
    ]

    assert _filter_picker_choices(choices, "model catalog") == [choices[2]]
    assert _filter_picker_choices(choices, "status") == [choices[0]]
    assert _filter_picker_choices(_PALETTE_CHOICES, "") == list(_PALETTE_CHOICES)


def test_session_picker_choices_include_id_and_context():
    choices = _session_picker_choices(
        [
            {
                "id": "20261009-102030-abcd",
                "turns": 4,
                "updated_at": 1791549000,
                "cwd": "/work/sauron",
            },
        ]
    )

    assert len(choices) == 1
    assert choices[0][0] == "20261009-102030-abcd · 4 turn(s)"
    assert choices[0][1] == "20261009-102030-abcd"
    assert "/work/sauron" in choices[0][2]


def test_model_picker_returns_selected_model(monkeypatch):
    import providers.router.chat_repl as chat_repl

    monkeypatch.setattr(chat_repl, "_available_models", lambda: ["provider/model-x"])

    class Picker:
        async def choose(self, title, choices):
            assert title == "Choose model"
            assert choices[0][1] == "__auto__"
            return choices[1]

    assert asyncio.run(_pick_model_menu(None, "/tmp", None, ui=Picker())) == "provider/model-x"


def test_session_picker_returns_selected_saved_session():
    rows = [{"id": "saved-1", "turns": 2, "updated_at": 1, "cwd": "/work"}]

    class Picker:
        async def choose(self, title, choices):
            assert title == "Switch session"
            return choices[0]

    assert asyncio.run(_pick_session_menu(None, "/tmp", rows, ui=Picker())) == rows[0]


def test_ctrl_p_opens_searchable_command_palette():
    from prompt_toolkit.input import create_pipe_input
    from prompt_toolkit.output import DummyOutput

    async def exercise(ui, app_input):
        app_task = asyncio.create_task(ui.app.run_async())
        await asyncio.sleep(0.05)
        next_task = asyncio.create_task(ui.next())
        app_input.send_text("\x10")  # Ctrl+P
        await asyncio.sleep(0.05)
        app_input.send_text("status")
        await asyncio.sleep(0.05)
        app_input.send_text("\r")
        result = await asyncio.wait_for(next_task, timeout=2)
        ui.app.exit()
        await asyncio.wait_for(app_task, timeout=2)
        return result

    state = SimpleNamespace(
        busy=False,
        queued=0,
        perm="auto",
        model=None,
        cycle_perm=lambda: None,
    )
    with create_pipe_input() as app_input:
        ui = _FullScreenUI(
            lambda: [("", " Sauron")],
            state,
            lambda: [("", " status")],
            content_width=80,
            _input=app_input,
            _output=DummyOutput(),
        )
        assert asyncio.run(exercise(ui, app_input)) == ("line", "/status")
