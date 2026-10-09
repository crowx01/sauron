"""Regression tests for mission authoring and progress guards."""

import asyncio
import json
from types import SimpleNamespace

from providers.router import mission


def _resp(content: str):
    return SimpleNamespace(content=content, metadata={})


def test_repo_context_seeds_relative_target_file(tmp_path, monkeypatch):
    target = tmp_path / "src" / "worker.py"
    target.parent.mkdir()
    target.write_text("def existing():\n    return 'seeded'\n")
    monkeypatch.chdir(tmp_path)

    context = mission._repo_context("Update src/worker.py to improve existing().")

    assert f"--- FILE {target} ---" in context
    assert "return 'seeded'" in context


def test_writer_protocol_prefers_whole_file_replacements():
    prompt = mission._WRITER_SYS.lower()
    assert "whole-file" in prompt
    assert "small edits" in prompt


def test_execute_plan_replaces_existing_python_file_and_checks_new_symbol(tmp_path):
    target = tmp_path / "worker.py"
    target.write_text("def old():\n    return 0\n")
    replacement = "def build_widget():\n    return 42\n\nbuild_widget()\n"

    report = asyncio.run(
        mission._execute_plan(
            {"files": [{"path": str(target), "content": replacement}]},
            "executor",
            False,
            goal="replace worker",
        )
    )

    assert target.read_text() == replacement
    assert str(target) in report["files_written"]
    assert report["code_checks"]
    assert all(check["ok"] for check in report["code_checks"])
    assert report["symbol_checks"]
    assert all(check["ok"] for check in report["symbol_checks"])
    assert any(check["symbol"] == "build_widget" for check in report["symbol_checks"])


def test_execute_plan_reports_python_syntax_errors_for_next_iteration(tmp_path):
    target = tmp_path / "broken.py"
    report = asyncio.run(
        mission._execute_plan(
            {"files": [{"path": str(target), "content": "def broken(:\n    pass\n"}]},
            "executor",
            False,
            goal="write broken.py",
        )
    )

    assert report["code_checks"]
    assert any(not check["ok"] and "syntax" in check["message"].lower() for check in report["code_checks"])
    forced, why = mission._deterministic_gate("write broken.py", report)
    assert forced == "CONTINUE"
    assert "code check" in why.lower()


def test_python_import_gate_catches_missing_module(tmp_path, monkeypatch):
    monkeypatch.setenv("PAL_MISSION_ALLOW_SENSITIVE", "0")
    target = tmp_path / "imports.py"
    target.write_text("import sauron_module_that_does_not_exist_xyz\n")

    checks = mission._check_python_file(str(target))

    assert any(
        check["check"] == "import" and not check["ok"]
        and "sauron_module_that_does_not_exist_xyz" in check["message"]
        for check in checks
    )


def test_code_check_errors_are_fed_back_to_writer(monkeypatch, tmp_path):
    target = tmp_path / "repair.py"
    prompts = []
    writer_calls = {"count": 0}

    def fake_generate(model, prompt, system, **kwargs):
        if "WRITER" in system:
            prompts.append(prompt)
            writer_calls["count"] += 1
            source = "def broken(:\n    pass\n" if writer_calls["count"] == 1 else "value = 1\n"
            return _resp(json.dumps({"files": [{"path": str(target), "content": source}]}))
        return _resp(json.dumps({"decision": "COMPLETE"}))

    monkeypatch.setattr("providers.router.dispatch.generate", fake_generate)
    monkeypatch.setattr(mission, "_pick", lambda models: models[0] if models else None)
    monkeypatch.setattr(mission, "_pick_distinct", lambda models, used: models[0] if models else None)

    result = asyncio.run(
        mission.run_mission(
            "repair repair.py",
            writer="writer",
            executor="executor",
            judge="judge",
            max_iters=3,
            auto=False,
        )
    )

    assert result["status"] == "COMPLETE"
    assert writer_calls["count"] == 2
    assert "syntax/compile error" in prompts[1].lower()
    assert target.read_text() == "value = 1\n"


def test_new_callable_without_a_callsite_is_rejected(tmp_path):
    target = tmp_path / "unused.py"
    report = asyncio.run(
        mission._execute_plan(
            {
                "files": [
                    {
                        "path": str(target),
                        "content": "def " + "never_called" + "():\n    return 1\n",
                    }
                ]
            },
            "executor",
            False,
            goal="add helper",
        )
    )

    assert any(check["symbol"] == "never_called" and not check["ok"] for check in report["symbol_checks"])
    forced, why = mission._deterministic_gate("add helper", report)
    assert forced == "CONTINUE"
    assert "never_called" in why


def test_no_progress_stops_repeated_failed_mission_iterations(monkeypatch, tmp_path):
    monkeypatch.setenv("PAL_MISSION_NOPROGRESS_ITERS", "2")
    monkeypatch.setenv("PAL_MISSION_ENSEMBLE", "off")
    target = tmp_path / "output.txt"
    plan = json.dumps({"files": [{"path": str(target), "content": "same"}], "verify": ["false"]})

    def fake_generate(model, prompt, system, **kwargs):
        if "WRITER" in system:
            return _resp(plan)
        return _resp(json.dumps({"decision": "COMPLETE", "reason": "claimed done"}))

    monkeypatch.setattr("providers.router.dispatch.generate", fake_generate)
    monkeypatch.setattr(mission, "_pick", lambda models: models[0] if models else None)
    monkeypatch.setattr(mission, "_pick_distinct", lambda models, used: models[0] if models else None)

    result = asyncio.run(
        mission.run_mission(
            "write output.txt",
            writer="writer",
            executor="executor",
            judge="judge",
            max_iters=5,
            auto=False,
        )
    )

    assert result["status"] == "INCOMPLETE"
    # The first write is progress; the next two identical runs make no change.
    assert result["iterations"] == 3
    assert result["no_progress"] is True
    assert "no forward progress" in result["no_progress_reason"].lower()


def test_panel_marks_duplicate_failing_subtasks_as_no_progress(monkeypatch):
    def fake_generate(model, prompt, system, **kwargs):
        if "decomposer" in system.lower():
            return _resp(json.dumps({"subtasks": ["first", "second"]}))
        if "SYNTHESIZER" in system:
            return _resp("same failure")
        if "JUDGE" in system:
            return _resp(json.dumps({"decision": "COMPLETE"}))
        return _resp(json.dumps({"files": [], "edits": [], "commands": [], "verify": ["false"]}))

    async def fake_execute(plan, executor, full, goal=""):
        return {
            "files_written": [],
            "edits_applied": [],
            "results": [],
            "verify": [{"cmd": "false", "exit": 1, "ok": False, "output": "same error"}],
            "code_checks": [],
            "symbol_checks": [],
        }

    monkeypatch.setattr("providers.router.dispatch.generate", fake_generate)
    monkeypatch.setattr(mission, "_execute_plan", fake_execute)
    monkeypatch.setattr(mission, "_pick", lambda models: models[0] if models else None)

    result = asyncio.run(mission.run_panel("goal", ["m1", "m2"], "judge", True))

    assert result["status"] == "INCOMPLETE"
    assert result["no_progress"] is True
    assert "repeated failing" in result["no_progress_reason"].lower()
