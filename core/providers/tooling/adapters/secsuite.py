"""secsuite adapter — exposes PAL's Burp-alternative security suite as a local
toolbelt tool so the self-contained tool loop can call it directly.

Without this, models kept emitting `secsuite ...` as a bash command (it is an
MCP tool, not a shell binary) and spiralling on "command not found". Now the
tool loop advertises a real `secsuite` tool and routes calls to the same sync
core the MCP tool uses (tools.secsuite.run_action).
"""

from __future__ import annotations

import json

from providers.tooling.toolbelt import ToolSpec, get_toolbelt


def _secsuite(args: dict) -> str:
    from tools.secsuite import SecSuiteRequest, run_action

    try:
        req = SecSuiteRequest(**{k: v for k, v in (args or {}).items() if v is not None})
    except Exception as exc:  # noqa: BLE001 - bad args -> clear message, no crash
        return f"error: invalid secsuite arguments: {exc}"
    return json.dumps(run_action(req), ensure_ascii=False, indent=2)


get_toolbelt().register(
    ToolSpec(
        name="secsuite",
        description=(
            "Burp-alternative HTTP/security suite (a TOOL, not a shell binary — never run it via bash). "
            "args: action (one of http_send, search_traffic, jwt_decode, jwt_forge, jwt_none_attack, "
            "compare_responses, send_parallel) plus url/method/headers/body/query/token/secret/"
            "algorithm/claims/text1/text2/count as the action needs. Use for HTTP repeater, traffic "
            "search, JWT decode/forge/none-attack, response diffing, and race-condition (parallel) testing."
        ),
        parameters={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "http_send", "search_traffic", "jwt_decode", "jwt_forge",
                        "jwt_none_attack", "compare_responses", "send_parallel",
                    ],
                },
                "url": {"type": "string"},
                "method": {"type": "string"},
                "headers": {"type": "object"},
                "body": {"type": "string"},
                "query": {"type": "string"},
                "token": {"type": "string"},
                "secret": {"type": "string"},
                "algorithm": {"type": "string"},
                "claims": {"type": "object"},
                "text1": {"type": "string"},
                "text2": {"type": "string"},
                "count": {"type": "integer"},
            },
            "required": ["action"],
        },
        handler=_secsuite,
        sandbox="write",  # active HTTP / forging — more than read-only
    )
)
