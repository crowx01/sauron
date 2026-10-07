"""secsuite as a self-contained tool: sync run_action core + toolbelt adapter.

All cases here are offline (no HTTP) so they are deterministic and fast.
"""

from __future__ import annotations

import json

from tools.secsuite import SecSuiteRequest, run_action


def test_run_action_jwt_roundtrip():
    forged = run_action(SecSuiteRequest(action="jwt_forge", claims={"sub": "x", "admin": True},
                                        secret="k" * 32, algorithm="HS256"))
    assert forged.get("token")
    decoded = run_action(SecSuiteRequest(action="jwt_decode", token=forged["token"]))
    assert decoded["payload"]["sub"] == "x"
    assert decoded["payload"]["admin"] is True


def test_run_action_jwt_none_attack():
    out = run_action(SecSuiteRequest(action="jwt_none_attack", claims={"sub": "admin"}))
    tok = out["token"]
    assert tok.endswith(".")                  # empty signature segment
    assert tok.count(".") == 2


def test_run_action_compare_responses():
    out = run_action(SecSuiteRequest(action="compare_responses", text1="a\nb\nc", text2="a\nB\nc"))
    assert "diff" in out and "-b" in out["diff"] and "+B" in out["diff"]


def test_run_action_unknown_action_is_error_not_crash():
    out = run_action(SecSuiteRequest(action="does_not_exist"))
    assert "error" in out and "Unknown action" in out["error"]


def test_secsuite_adapter_registered_and_routes(monkeypatch):
    monkeypatch.setenv("PAL_TOOLBELT", "1")
    from providers.tooling import toolbelt as tb_mod

    tb = tb_mod.get_toolbelt()  # import bootstraps the secsuite adapter
    assert "secsuite" in tb.snapshot()["registered"]
    tb.enable("secsuite")
    out = tb.execute("secsuite", {"action": "compare_responses", "text1": "x", "text2": "y"})
    assert "error: tool" not in out              # enabled, not blocked
    parsed = json.loads(out)
    assert parsed["action"] == "compare_responses" and "diff" in parsed


def test_secsuite_adapter_bad_args_message(monkeypatch):
    monkeypatch.setenv("PAL_TOOLBELT", "1")
    from providers.tooling.adapters.secsuite import _secsuite

    # missing required 'action' -> clear message, no traceback
    out = _secsuite({})
    assert out.startswith("error: invalid secsuite arguments")
