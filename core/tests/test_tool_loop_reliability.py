"""Regression tests for explicit command-sequence and repeated-call guards."""

from types import SimpleNamespace

import pytest

from providers.router import chat_repl, headless


def test_parse_explicit_fenced_cli_sequence_only():
    task = (
        "Run these commands in order:\n"
        "```bash\n"
        "git status --short\n"
        "git log -1 --oneline\n"
        "gh pr list --limit 1\n"
        "```\n"
    )
    assert chat_repl._parse_ordered_cli_commands(task) == [
        "git status --short",
        "git log -1 --oneline",
        "gh pr list --limit 1",
    ]
    assert chat_repl._parse_ordered_cli_commands("First run git status, then git log -1.") == []
    assert chat_repl._parse_ordered_cli_commands(
        "```bash\ngit status && git push\n```"
    ) == []
    assert chat_repl._parse_ordered_cli_commands(
        "What do these commands do?\n```bash\ngit status\ngit log\n```"
    ) == []
    assert chat_repl._parse_ordered_cli_commands(
        "Should I run these commands?\n```bash\ngit status\ngit log\n```"
    ) == []


def test_adaptive_step_budget_scales_explicit_sequence_and_caps(monkeypatch):
    monkeypatch.setenv("PAL_TOOLS_STEP_LIMIT", "20")
    task = "Run these commands:\n```sh\ngit status\ngit add README.md\ngit commit -m ok\ngh pr create\n```"
    assert chat_repl._adaptive_step_budget(task, 5) == 12
    assert chat_repl._adaptive_step_budget("just inspect this", 5) == 5
    monkeypatch.setenv("PAL_TOOLS_STEP_LIMIT", "7")
    assert chat_repl._adaptive_step_budget(task, 5) == 7


@pytest.mark.asyncio
async def test_headless_runner_passes_adaptive_step_budget(monkeypatch, tmp_path):
    task = "Run these commands:\n```bash\ngit status\ngit add README.md\ngit commit -m done\ngh pr create\n```"
    received = {}

    monkeypatch.setattr(headless, "_pick_tools_model", lambda task, model: "m")
    monkeypatch.setattr("providers.router.size_guard.check_or_reroute", lambda *args: (True, ""))
    monkeypatch.setattr("providers.router.fallback_chain.is_enabled", lambda: False)

    async def fake_loop(task, model, cwd, max_steps=5, full=False):
        received["max_steps"] = max_steps
        return "done", []

    monkeypatch.setattr(chat_repl, "_tools_loop", fake_loop)
    monkeypatch.setattr(chat_repl, "_auto_debate_enabled", lambda: False)
    monkeypatch.chdir(tmp_path)

    await headless.run_task(task, max_steps=None)

    assert received["max_steps"] == 12


@pytest.mark.asyncio
async def test_tools_loop_executes_explicit_sequence_before_model(monkeypatch, tmp_path):
    task = "Run exactly in order:\n```bash\ngit status --short\ngit log -1 --oneline\n```"
    calls = []
    prompts = []

    class Toolbelt:
        def react_schema(self):
            return "test schema"

        def execute(self, name, args, caller_model=None):
            calls.append(args["command"])
            return f"result-{len(calls)}"

    monkeypatch.setenv("PAL_TOOLS_DIRECT_SEQUENCE", "1")
    monkeypatch.setenv("PAL_TOOLS_TRANSPORT", "text")
    monkeypatch.setattr(chat_repl, "_ensure_toolbelt", lambda: Toolbelt())
    monkeypatch.setattr(
        "providers.registry.ModelProviderRegistry.get_provider_for_model",
        lambda model: SimpleNamespace(base_url=""),
    )

    def fake_generate(model, prompt, system, **kwargs):
        prompts.append(prompt)
        return SimpleNamespace(content="Both explicit commands completed.", metadata={})

    monkeypatch.setattr("providers.router.dispatch.generate", fake_generate)

    answer, transcript = await chat_repl._tools_loop(task, "test-model", str(tmp_path), max_steps=2)

    assert answer == "Both explicit commands completed."
    assert len(calls) == 2
    assert "git status --short" in calls[0]
    assert "git log -1 --oneline" in calls[1]
    assert len(transcript) == 2
    assert "result-1" in prompts[0] and "result-2" in prompts[0]


@pytest.mark.asyncio
async def test_direct_sequence_stops_when_a_precondition_command_fails(monkeypatch, tmp_path):
    task = "Run these commands in order:\n```bash\ngit status --short\ngit push\n```"
    calls = []

    class Toolbelt:
        def react_schema(self):
            return "test schema"

        def execute(self, name, args, caller_model=None):
            calls.append(args["command"])
            return "error: blocked by policy\n[exit=1]"

    monkeypatch.setenv("PAL_TOOLS_DIRECT_SEQUENCE", "1")
    monkeypatch.setenv("PAL_TOOLS_TRANSPORT", "text")
    monkeypatch.setattr(chat_repl, "_ensure_toolbelt", lambda: Toolbelt())
    monkeypatch.setattr(
        "providers.registry.ModelProviderRegistry.get_provider_for_model",
        lambda model: SimpleNamespace(base_url=""),
    )
    monkeypatch.setattr(
        "providers.router.dispatch.generate",
        lambda *args, **kwargs: SimpleNamespace(content="Stopped safely.", metadata={}),
    )

    await chat_repl._tools_loop(task, "test-model", str(tmp_path), max_steps=2)

    assert len(calls) == 1
    assert "git status --short" in calls[0]
    assert all("git push" not in command for command in calls)


@pytest.mark.asyncio
async def test_tools_loop_replay_guard_includes_actual_result_and_next_step(monkeypatch, tmp_path):
    execute_calls = []
    prompts = []

    class Toolbelt:
        def react_schema(self):
            return "test schema"

        def execute(self, name, args, caller_model=None):
            execute_calls.append((name, args))
            return "error: missing prerequisite file"

    monkeypatch.setenv("PAL_TOOLS_TRANSPORT", "text")
    monkeypatch.setattr(chat_repl, "_ensure_toolbelt", lambda: Toolbelt())
    monkeypatch.setattr(
        "providers.registry.ModelProviderRegistry.get_provider_for_model",
        lambda model: SimpleNamespace(base_url=""),
    )

    call = '<tool_call>{"name":"bash","arguments":{"command":"test -f prerequisite.txt"}}</tool_call>'

    def fake_generate(model, prompt, system, **kwargs):
        prompts.append(prompt)
        content = call if len(prompts) <= 2 else "The prerequisite is missing; stopping here."
        return SimpleNamespace(content=content, metadata={})

    monkeypatch.setattr("providers.router.dispatch.generate", fake_generate)

    await chat_repl._tools_loop("check prerequisite", "test-model", str(tmp_path), max_steps=3)

    assert len(execute_calls) == 1
    assert len(prompts) == 3
    assert "missing prerequisite file" in prompts[2]
    assert "next" in prompts[2].lower()
