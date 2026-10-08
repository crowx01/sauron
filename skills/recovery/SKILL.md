---
name: recovery
description: >-
  Failure-classification and escalation chain for the sauron framework.
  Replaces blind "try, retry, retry, give up" with: classify → diagnose
  (model A) → independent recheck (model B) → stronger reasoning (model C)
  → apply → verify. Triggers on any non-zero exit from a Bash tool call,
  any `error_class` field in a structured tool result, any model refusal
  or 4xx/5xx from a PAL call, any "I already tried that" moment, any
  repeated identical failure, any "escalate", "stuck", "same error again",
  "recovery strategy" phrase.
---

# recovery

**One-line pitch:** when something fails, don't retry — classify, route to a
different model, verify the fix, and stop before the loop detector would
have stopped you anyway.

## When to invoke

- A Bash tool returned a non-zero exit code.
- A PAL call returned a refusal, 4xx, 5xx, timeout, or empty body.
- The orchestrator noticed the **same** failing action proposed twice in a
  row (loop detector).
- A verification step disagreed with a prior "success" claim.
- Any `error_class` field surfaced by the `kali-exec` skill.

## The escalation chain (not a retry loop)

```text
                 failure observed
                        │
                        ▼
            ┌───────────────────────┐
            │ 1. CLASSIFY           │   deterministic; no LLM
            │    error_class = ?    │
            └──────────┬────────────┘
                       │
                       ▼
            ┌───────────────────────┐
            │ 2. DIAGNOSE (model A) │   groq (fast, cheap, skeptical)
            │    "what broke, why"  │   fallback: or-free
            └──────────┬────────────┘
                       │
                       ▼
            ┌───────────────────────┐
            │ 3. INDEPENDENT RECHECK│   grok (permissive, 2M ctx)
            │    "is A right?"      │   DIFFERENT model, not same
            └──────────┬────────────┘
                       │
             agree ────┴──── disagree ──▶ 4. ESCALATE
                       │                        │
                       │                        ▼
                       │              ┌───────────────────────┐
                       │              │ pro (deep reasoning)  │
                       │              │ via mcp__pal__challenge
                       │              └───────────┬───────────┘
                       │                          │
                       ▼                          ▼
            ┌───────────────────────┐   ┌─────────────────────┐
            │ 5. APPLY (one action) │ ← │ reconciled plan     │
            └──────────┬────────────┘   └─────────────────────┘
                       │
                       ▼
            ┌───────────────────────┐
            │ 6. VERIFY             │   deterministic check,
            │    did it work?       │   NOT the model's self-report
            └──────────┬────────────┘
                       │
             pass ─────┴───── fail ──▶ budget check, then STOP with
                       │                 diagnostic state (never silent
                       ▼                 give-up).
                     done
```

The output of each node is **structured** so the next node can decide
without replaying the whole transcript.

## Classification table

| `error_class`             | First-line recovery                                      | Model to call           | Verify                                   |
|---------------------------|----------------------------------------------------------|-------------------------|------------------------------------------|
| `transient`               | 1 jittered retry, then escalate                          | none                    | re-run same cmd                          |
| `missing_file`            | re-check with `realpath -e`; look at sibling steps that  | groq (fast)             | `test -f` on resolved path               |
|                           | should have produced it                                  |                         |                                          |
| `wrong_cwd`               | re-emit command with absolute path (see `kali-exec`)     | none (deterministic)    | file resolves + exit 0                   |
| `missing_binary`          | capability-first probe before any install                | groq → grok on refusal  | `command -v` returns a path              |
| `missing_python_dep`      | PEP 668 decision tree (`kali-exec`)                      | groq                    | `python3 -c "import X"` with intended    |
|                           |                                                          |                         | interpreter                              |
| `pep668_blocked`          | pipx / venv / apt — never `--break-system-packages`      | groq                    | import succeeds under venv's python      |
| `permission_denied`       | diagnose first; `sudo` only with explicit user approval  | groq                    | explicit `-rc 0` from the real action    |
| `invalid_argument`        | re-read tool schema; drop hallucinated flags             | flash (structured)      | dry-run / `--help` exits 0               |
| `timeout`                 | split work, add `| head -c`, or raise bound once         | grok                    | completes under new bound                |
| `oom`                     | split input, lower parallelism; never retry same shape   | pro                     | peak RSS below cap                       |
| `model_refusal`           | **route to a different model**, don't re-ask the same    | grok → or-free          | task class now has an answer             |
| `model_hallucinated_tool` | correct the tool name; re-ground against toolbelt JSON   | flash                   | tool call now matches declared schema    |
| `rate_limit_402`          | queue + switch to another provider in the same class     | or-free / grok          | next call succeeds                       |
| `context_overflow`        | summarize the irrelevant prefix, keep the recent window  | nemotron (bulk read)    | request fits inside next model's cap     |
| `parser_failure`          | re-emit with stricter JSON prompt; failing twice =       | flash                   | parses cleanly                           |
|                           | different model                                          |                         |                                          |
| `unknown`                 | pro, with full tool result as evidence                   | pro                     | explicit cause named + patch landed      |

A **classifier refusal is not a stop**. If `flash` refuses recon,
re-route to `grok`; refusal counts as a routing problem, not a task
failure.

## Budgets (bounded, not unlimited)

Replace the single `retry_count = 3` with a tiered budget:

- **per-command budget**: an exact `(command, cwd, env-fingerprint)` tuple
  may be executed at most **2 times** in one task. The 3rd would be a
  guaranteed waste; escalate instead.
- **per-error-class budget**: at most **4 recovery cycles** per
  `error_class` per task. A 5th of the same class means "we're trying to
  fix the wrong thing" — stop and report.
- **per-task budget**: at most **12 total recovery cycles** across all
  classes per task. Beyond that, the task is almost certainly
  mis-scoped; return control to the user with the full state.
- **wall-clock budget**: 10 min default; the user can raise it with
  `recovery.budget_minutes = N` in the task prompt.

### Loop detectors (fire before the budgets)

- **same-command detector**: identical `(command, cwd)` with identical
  stderr fingerprint twice → stop, do not run a 3rd.
- **same-plan detector**: two consecutive diagnose nodes produce the same
  patch → treat as "model A agrees with model A" and escalate to model C
  immediately instead of asking A again.
- **install-oscillation detector**: `pip install X` followed by
  `pip install X` followed by `pip install X` → classify as
  `missing_python_dep` + wrong interpreter, not a transient. Switch to
  the capability check and the PEP 668 tree.

## What the diagnose model gets (and does not get)

Diagnose nodes must receive a **compact** evidence packet, not the full
transcript. Shape:

```json
{
  "task_summary":   "convert ASSETS_ALL.xlsx to JSON",
  "last_action":    "python3 /home/kali/Desktop/convert.py ASSETS_ALL.xlsx",
  "cwd":            "/home/kali/Desktop",
  "exit":           1,
  "stdout_tail":    "<last 2 KB>",
  "stderr_tail":    "<last 2 KB>",
  "error_class":    "missing_python_dep",
  "env_fingerprint":{"VIRTUAL_ENV":"", "which_python": "/usr/bin/python3"},
  "prior_attempts": [
     { "action": "...", "exit": 1, "error_class": "pep668_blocked" }
  ],
  "available_tools": ["mcp__pal__chat","Bash","Read","pipx","apt-get",...]
}
```

The diagnose model returns:

```json
{
  "cause":            "openpyxl missing in system python; pep668 blocks pip",
  "proposed_action":  "python3 -m venv .venv && .venv/bin/pip install openpyxl && .venv/bin/python convert.py ASSETS_ALL.xlsx",
  "confidence":       0.82,
  "verify":           "python3 -c 'import openpyxl' using .venv/bin/python",
  "fallback":         "sudo apt-get install -y python3-openpyxl"
}
```

The orchestrator **does not** run the proposed action yet. It passes the
packet to the independent-recheck node first.

## Independent recheck

Rules:

1. Must be a **different** model than diagnose.
2. Sees the **same packet**, not the diagnose output. We want independent
   reasoning, not an echo chamber.
3. Returns the same shape. The orchestrator compares the two:
   - If both propose the **same action**, apply it.
   - If they propose **different actions**, promote to the stronger model
     (`pro` via `mcp__pal__challenge`) and let it reconcile. The debate
     output is the authoritative plan.

## Verify before claiming success

Model self-reports (`"it should work now"`) are evidence, not truth. Every
recovery cycle ends with a **deterministic check** executed in a Bash call:

- `test -f /abs/path` for `missing_file`
- `command -v <tool>` for `missing_binary`
- `python3 -c "import X"` using the **intended** interpreter for the
  Python-dep classes (not just any `python3`)
- `curl -fsS -o /dev/null -w '%{http_code}' <url>` for network
- a sentinel-string grep on stdout for parser/invalid-arg classes

If verify fails, the cycle counts against the budgets and we start a new
diagnose with the verify result appended to `prior_attempts`.

## State the orchestrator keeps per run

```text
Run
 ├── task_id, prompt, started_at
 ├── env.fingerprint      (uname, user, VIRTUAL_ENV, PYTHONPATH, PATH-hash)
 ├── capabilities.have    (populated by kali-exec capability probes)
 ├── iterations[]
 │     ├── plan
 │     ├── action
 │     ├── result (structured)
 │     └── classify.error_class
 ├── recovery_cycles[]
 │     ├── cause
 │     ├── diagnose.model + output
 │     ├── recheck.model + output
 │     ├── escalation?        (pro debate transcript, if any)
 │     ├── applied            (command actually run)
 │     ├── verify             (deterministic check + outcome)
 │     └── classified_as      (error_class before/after)
 ├── budgets                  (remaining per-command / per-class / per-task)
 └── state                    (PENDING|RUNNING|RECOVERING|COMPLETED|INCOMPLETE|CANCELLED)
```

This is the shape the orchestrator should persist to its own
`runs/<run-id>.json` so a developer can reconstruct exactly what happened
without replaying.

## State transitions

```
PENDING → RUNNING                       (first iteration begins)
RUNNING → RECOVERING                    (classify assigned an error_class)
RECOVERING → RUNNING                    (verify passed)
RECOVERING → INCOMPLETE                 (budget exhausted, no verify)
RUNNING → COMPLETED                     (plan goal met + final verify passed)
RUNNING | RECOVERING → CANCELLED        (user Ctrl-C or explicit stop)
```

- `INCOMPLETE` is never silent — the orchestrator renders the last cause,
  the proposed next step, and the state file path so the user can resume.
- `CANCELLED` persists the same shape; a `--resume <run-id>` picks up at
  the last `RUNNING` iteration.

## Anti-patterns

- Blind retry of the same `(command, cwd, env)` tuple.
- Asking the **same** model to "try again" without changing inputs.
- Treating `error_class = model_refusal` as a stop; it is a routing cue.
- Verifying success from the model's own narration instead of a
  deterministic check.
- Removing budgets to "fix" a loop; a loop that pierces the budget is a
  symptom to stop, not to raise.
- Reporting `INCOMPLETE` without the structured state attached.
- Hiding the stderr tail from the diagnose model to "save tokens"; the
  tail of stderr is where the error_class lives.

## Trigger phrases

- "escalate"
- "same error again"
- "stuck in a loop"
- "recovery strategy"
- "why did it fail"
- "classify this failure"
- "what should I try next"

## The rule

> Classify before you retry. Change the model before you change the plan.
> Verify before you claim success. Stop before the budget stops you.
