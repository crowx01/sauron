---
name: pal-router
description: >-
  Delegate-first + failover doctrine for the framework. Dispatches sub-tasks to cheaper or free PAL
  models so Claude Opus's context stays reserved for judgment. Triggers on: 'route this to a
  cheaper model', 'delegate this read', 'who should write this report', 'which model do I use for
  X', 'gemini refused, what now'.
---

# pal-router

**One-line pitch:** Delegate-first + failover doctrine skill for the sauron framework. Dispatches sub-tasks to cheaper or free PAL models so Claude Opus's context stays reserved for judgment.

## When to invoke
- Any bulk file read (JS bundle, log dump, OpenAPI spec, GraphQL introspection).
- Any long-form writing (report, vuln explanation, remediation note, executive summary).
- Any structured extraction (endpoint list, header dump, param cluster).
- Any skeptical second-pass on someone else's output.
- Any adversarial critique of a finding.

If the task is a user-facing decision, an exploitation choice, a severity call, a safety-boundary check, an action with side effects, or an orchestration of tool sequences, keep it in Claude. Never delegate those.

## The routing map

- **groq** (`openai/gpt-oss-120b`, ~500 req/min, 8,000 tokens/min cap). Report writing, vulnerability and concept explanations, skeptical validation. Aliases: `groq`, `gpt-oss-120b`, `gpt-oss`.
- **nemotron** (`nvidia/nemotron-3.5-lightning:free` via OpenRouter, 1M context, alias `nemotron`). Bulk reading of large files. Do NOT use for strict structured extraction (it hallucinates).
- **grok** (`x-ai/grok-4.3` on OpenRouter, 1M context). Permissive high-context security reasoning. Reliable fallback when Gemini refuses — but **paid**: it returns HTTP 402 on an account with no purchased credits, and `x-ai/grok-4` / `x-ai/grok-4.1-fast` are no longer served by OpenRouter (checked 2026-09-26).
- **nemotron-ultra** (`nvidia/nemotron-3-ultra-550b-a55b:free` via OpenRouter, 1M context, alias `nemotron-ultra`). Strongest free reasoning model. Use it wherever this map says grok if the OpenRouter account has no credits.
- **flash** (`gemini-3.6-flash`, 1M context, alias `flash`). Fast structured extraction from prose. Failure mode: refuses recon-log or attack-surface analysis for named targets.
- **or-free** (`openrouter/free` meta-router, 200K context). Generalist fallback.
- **pro** (`gemini-3.1-pro-preview`, 1M context, alias `pro`). Deep reasoning and adversarial debate via `mcp__pal__challenge`.

- **Tool-capable model pool** (was: qwen3 alone). `/tools`, `/tools:full` and `pal run`'s tool loop now draw from an ordered, filtered pool — not a single hardcoded model — so one rate-limited/blacklisted provider no longer stalls the loop. `qwen3` (`qwen/qwen3.8-27b` via Groq) is still the default first candidate (gpt-oss trips Groq's output parser on tool prompts, 400 `output_parse_failed`), but the pool widens automatically to any other model the catalog marks `tools: true`. Pin the front of the pool with `PAL_TOOLS_PRIMARY_MODEL` (or the legacy `PAL_CHAT_TOOLS_MODEL` alias), extend it with `PAL_TOOLS_MODELS`/`PAL_TOOLS_FALLBACK_MODELS`, or exclude a model with `PAL_TOOLS_BLOCKLIST`. Same pool mechanism backs the `/debate` reader (role `reviewer`) and panel (role `reasoner`).

This list is a human-readable summary of defaults, not the source of truth — the source of truth is the live **capability catalog** (below). Run `pal models` or `/models` in `pal chat` any time to see exactly what's actually reachable right now, with real capability flags, not guesses.

Full model matrix and aliases: [model-map.md](model-map.md).

## Capability-aware routing (the catalog)

Routing no longer trusts a static name list alone. `pal`'s model catalog merges the static per-provider config with a live `/models` discovery call per provider (rich capability+pricing data from OpenRouter, token limits from Gemini, ids-only from OpenAI/xAI/Groq — an unconfirmed capability stays `None` and is never guessed), cached on disk for ~6h. Every catalog entry carries `chat` / `tools` / `vision` / `structured_output` / `reasoning` / `context_limit` / `availability` (`available` / `no_auth` / `unhealthy` / `stale` / `discovered`) / `quality_profile` / `cost_profile`.

What this changes for delegation:
- Capabilities are a **hard filter**. If a task needs `tools` or `structured_output`, a model the catalog can't confirm supports it is never selected — no more routing a structured-extraction task to a model that happens to hallucinate free text instead.
- Free-tier models are excluded from routing unless the category explicitly opts in (today: only `long_context_bulk`, i.e. the nemotron/or-free bulk-read lane) — so a cost-sensitive free model never silently wins a quality-sensitive slot.
- The alias list above and the legacy category-preference lists are demoted to **tie-break priors and fallback**, not the primary decision. Routing itself only ever reads the on-disk cache, never the network, so a routing decision can't hang on a live discovery call.
- `discovered` = a model the catalog found live but isn't curated for — it is visible in `pal models` for awareness but never auto-routed to.

Check what's actually live before assuming a model in this doc is reachable: `pal models [--provider X] [--refresh] [--json] [--all]`, or `/models` inside `pal chat`.

## Failover doctrine

If any model refuses, times out, or errors, immediately re-route to another model. A classifier refusal is a routing problem, not a stop.

Preferred order per common task:

1. **Deterministic recon parsing** (hosts, CNAMEs, params from JSONL): `jq` and local shell first (token-free, cannot refuse), then `grok` if LLM reasoning is needed.
2. **Structured extraction from prose**: `flash`, fallback `grok`, avoid `nemotron`.
3. **Report writing / skeptical validation**: `groq`, fallback `grok`.
4. **Bulk reading of very large files**: `nemotron`, fallback `or-free`.
5. **Deep adversarial reasoning**: `pro`, fallback `groq`.

## The smarter pal CLI

The local pal-mcp-server also ships a global `pal` CLI (`~/.local/bin/pal`). It is the delegation entry point:

- **`pal run "<task>"`**: headless one-shot; runs with local tools, prints only the result. Flags: `--ro`, `--agent`, `--model <m>`, `--plan <file>`, `--max-steps N`, `--agent-role autonomous|edit|plan|review`, `--json`.
- **`pal chat`**: interactive REPL with auto cheap/smart routing (`/smart`, `/cheap`) and per-command roles.
  - `/tools <task>`: runs any command on the Kali box (nmap, nuclei, ...) via the tool-capable model pool, full-power by default; `/tools:ro` is read-only allowlist.
  - `/agent[:edit|:plan|:review] <task>`: real local Claude Code via clink.
  - `/debate <q>`: quick take — one pool model READS the files, then a 3-model panel decides. Good for "what do you all think", not a gated pipeline.
  - `/delegate <model> <q>`: pin a model.
  - `/models`: live capability catalog panel, in-REPL (same data as `pal models`).
- **`pal debate "<objective>" [--criterion "..."]`**: the rigorous version — a stateful **executor → reviewer(s) → judge** pipeline, not a one-shot panel opinion. See below.
- **`pal models [--provider X] [--refresh] [--json] [--all]`**, **`pal diag [--json]`**, **`pal distill [--with-lessons]`**, **`pal serve`**.
- **Chat input**: multiline (`Alt+Enter`/`Ctrl+J` for a literal newline, plain `Enter` submits), session-scoped history (`Up`/`Down`/`Ctrl+P`/`Ctrl+N`) at `~/.pal/chat_history/<session_id>.jsonl` — every line is secret-masked (tokens/keys/JWTs/`Bearer ...`) before it ever touches disk, recall included.

**Plan-handoff doctrine.** Strongest delegation: write the plan to a file and run `pal run --plan file.md`. Hand off the whole job, take the result, do not babysit. Heavy coding/tool work: `pal run --agent` (`--agent-role autonomous` when it must run git/gh/network unattended). Bulk/read/report tasks still route to the cheaper models per the map above.

**Sequential debate + judge (`pal debate`).** For anything that needs a real gate, not a vibe check: `pal debate "<objective>" --criterion "..."` runs a strict loop — the **executor** does/revises the work and emits a structured JSON Handoff, one or more **reviewers** critique that Handoff and flip `verified: false` on any criterion lacking evidence, and the **judge** rules `COMPLETE` or `CONTINUE`. The `COMPLETE` gate is enforced in code, not trusted to the model: `completion_status == "review_ready"` AND every acceptance criterion `verified: true` with evidence AND zero open high/critical findings — anything else is downgraded to `CONTINUE` regardless of what the judge's prose claims. Anti-loop: a hard iteration cap (`PAL_DEBATE_MAX_ITER`, default 4, ceiling 10) plus no-progress detection on a state fingerprint. Prior-iteration handoffs are Headroom-compressed before being resent so a long-running debate doesn't blow the context budget; the newest handoff always goes through verbatim. Use this — not `/debate` — for anything feeding the validator's Step C, or any finding you're about to submit.

**Guardrails built in.** An AUTHORIZATION preamble is prepended for `security_permissive` tasks (fewer groq/qwen3 refusals on authorized recon). Groq ITPM ≈ 7000, so the tool loop trims context to `PAL_TOOLS_CTX_CHARS` (default 16000). Routing learns from outcomes: `episode_store` (`~/.pal/episodes.jsonl`) → runtime `bandit` reorder → offline `pal distill` (human-gated proposals, never auto-applied), plus a human-gated teacher `lesson_store` (routing-scope lessons only feed the distiller; classifier/prompt/tool-scope lessons are `human_review_only`, and there is no transcript/task-text parser, so task content can never mint itself a rule). Error-class-aware refusal penalties and self-heal probation stop one flaky provider being blacklisted for good.

**Headroom (automatic context compression).** Every provider call passes large tool/debate output through Headroom between masking and the size-guard/send path: recon dumps, nuclei JSON, sqlmap transcripts, and prior debate handoffs above `PAL_HEADROOM_MIN_BYTES` (default 4000) get rewritten to counts/uniques/head-tail slices instead of being sent verbatim. It never touches anything tagged `canonical`/`evidence`/`poc`, never touches outbound tool-call arguments, and fails open (any internal error passes the original bytes through). Compressed originals stay retrievable (`~/.cache/pal/headroom/` by default) — this shrinks what a model sees, it never destroys the evidence chain the validator skill needs.

**Masking & inbound scanning (guardrail) — always on, no bypass.** Every outbound provider call is walked by `guardrail.mask_outbound` first: credentials, `Authorization`/cookie headers, JWTs, cloud/API keys, and PII are replaced with `[REDACTED:<kind>:<n>]` placeholders before anything leaves the box; the restore map lives only in memory for that one call and is never logged, cached, or persisted. Responses are unmasked back for you to read. This runs at the provider layer (`gemini.py`, `openai_compatible.py`), not inside any one skill, so there is no code path that reaches a model without it. On the way back, `scan_inbound` flags prompt-injection markers (instruction-override phrasing, role-override attempts, chat-template tokens, prompt-leak asks, exfil instructions) in model output — `PAL_GUARDRAIL_INBOUND=warn` (default) logs and continues, `block` raises, `log` is silent-audit-only. This matters directly for recon: scraped target content (a page title, a header value, a JS string) that a model reads back to you is scanned before you trust it as an instruction.

## Wiring

The doctrine is enforced by two hooks in `~/.claude/settings.json`, both shipped in [`settings.example.json`](../../settings.example.json):

- **SessionStart** auto-invokes the `caveman`, `pentesting-agent`, and `validator` skills at the start of every session.
- **UserPromptSubmit** re-asserts the delegate-first + failover doctrine on every message so nothing drifts as sessions grow long.

These two hooks are the only place doctrine can drift; catalog capability filters, the tool-model pool, Headroom, and the masking/inbound-scan guardrail are not hook-gated at all — they run inside `pal`'s provider layer on every single call regardless of which skill or hook fired. There is no configuration in this repo that skips them; PAL stays the only path to a model.

## Trigger phrases
- "route this to a cheaper model"
- "delegate this read"
- "who should write this report"
- "which model do I use for X"
- "gemini refused, what now"

## Anti-patterns
- Never delegate a severity call or safety-boundary check.
- Never inline a long payload into a groq prompt if it exceeds 8,000 tokens; chunk it.
- Never trust nemotron to produce byte-exact structured output.
- Never treat a refusal as the end of the task; re-route.
- Never ask the SAME model to "try again" after a refusal or malformed output; that is a routing hole, not a retry. See the `recovery` skill.

## Error-class → model routing

When the `kali-exec` or `recovery` skills surface an `error_class`, use this
table to pick the diagnose model. The independent-recheck node must pick a
**different** model from the same row's fallback column.

| `error_class`             | Diagnose           | Independent recheck | Escalation (if they disagree) |
|---------------------------|--------------------|---------------------|-------------------------------|
| `transient`               | none (retry once)  | n/a                 | groq                          |
| `missing_file`            | groq               | grok                | pro                           |
| `wrong_cwd`               | deterministic      | n/a                 | groq                          |
| `missing_binary`          | groq               | grok                | pro                           |
| `missing_python_dep`      | groq               | grok                | pro                           |
| `pep668_blocked`          | groq               | flash               | pro                           |
| `permission_denied`       | groq               | grok                | pro                           |
| `invalid_argument`        | flash              | groq                | pro                           |
| `timeout`                 | grok               | groq                | pro                           |
| `oom`                     | pro                | grok                | user                          |
| `model_refusal`           | **route around**   | grok → or-free      | user if everyone refuses      |
| `model_hallucinated_tool` | flash              | groq                | pro                           |
| `rate_limit_402`          | queue + swap       | n/a                 | or-free / grok                |
| `context_overflow`        | nemotron (compress)| flash               | pro                           |
| `parser_failure`          | flash              | groq                | pro                           |
| `unknown`                 | pro                | grok                | user                          |

## Per-task failure memory

Within a single task, keep an in-context tally:

```json
{
  "model_failures": {
    "flash":    { "refused":  ["recon_log_summary"],              "429": 0 },
    "groq":     { "truncated":["long_json_schema"],               "429": 2 },
    "nemotron": { "hallucinated":["strict_structured_extract"],   "429": 0 }
  }
}
```

Rules:

1. A model that **refused** a task-class this task **does not** receive the
   same task-class again — route straight to the next model in its row.
2. A model that **hallucinated** structured output this task is **blocked**
   from strict structured extraction for the rest of the task; use `flash`
   or deterministic parsers instead.
3. Rate-limit (`429`, `402`) is **transient per model, not per task**:
   swap for 60 s, then allow re-use.
4. **Do not** permanently blacklist a model across runs from a single
   transient. The memory lives in task state, not in a global file.

## Capability-first before any PAL install call

`pal-router` is for **routing**, not for installing. Before delegating a
"please install X" task, the orchestrator must first ask (via the
`kali-exec` capability probes):

- Is X already a binary on PATH?
- Is X already an importable Python module in the current interpreter?
- Is X already present in a project `.venv`?
- Is X already a PAL toolbelt entry?

If any answer is yes, use it and stop; do **not** ask any model to plan an
install. "Delegate the prose, never the evidence" — and never the install
decision for a tool we already have.

## Token efficiency rules

- **Rule 1 (auto-compress large outputs):** any tool output above 5 KB (Bash, Read, WebFetch, jq) routes through `nemotron` (bulk read) or `flash` (structured) for compression before Claude reads it. Typical 10x reduction.
- **Rule 2 (batch PAL sub-tasks):** three separate groq calls for "draft report + suggest severity words + explain bug class" costs three adjudicate cycles. One structured PAL call returning all three saves two round trips.
- **Rule 3 (confidence triples):** on factual output, delegation prompts must ask for `{claim, confidence, source_span}` triples. Claude byte-checks only entries flagged below high confidence, not the whole draft.
- **Rule 4 (don't re-delegate):** never delegate the same task twice. If groq already drafted section X, quote it inline; do not re-ask.
- **Rule 5 (don't re-Read):** never `Read` a file already Read this session. Recall the content from conversation context.
- **Rule 6 (preempt predictable bloat):** on Bash calls whose full output you don't need, append `| head -c 5000` or `| jq -c` at the shell level rather than reading the whole dump and then summarizing.
- **Rule 7 (failure-map cache):** on any PAL refusal or 4xx/5xx, tag `$model refused $task-class this session` and skip that model for the next similar task in this conversation. Do not retry the failing route inside one turn. Very common: groq classifier-refuses raw exploit code -> next similar request routes straight to grok or or-free.
- **Rule 8 (delta-first for scan review):** for any "what changed on target", "recheck endpoint", "diff last scan" request, run `diff <last>.json <curr>.json` (or jq -deep) first and reason from the delta. Only read the full scan when the delta is insufficient.
- **Rule 9 (response terseness ladder):** Level 1 (one-liner) for self-explanatory findings / SHAs / URLs; Level 2 (short paragraph) for 1-2 non-obvious decisions; Level 3 (detailed section) only on explicit request or for a written security report. Never default to Level 3.
- **Rule 10 (preempt shell bloat):** cap tool output over 5 KB at the shell layer. Recon patterns: `nuclei ... -jsonl | head -100`, `subfinder ... | wc -l` first-then-head, `dnsx ... | jq -c 'select(.a)' | head -50`, `ffuf -mc 200 -of json | jq -c '.results[] | {url,status}' | head -100`.
- **Rule 11 (route-plan pre-flight, speculative):** for tasks with 3 or more distinct sub-steps, issue a small groq call (~200 tokens) FIRST asking for a routing plan; then execute. Measure impact; drop if overhead exceeds savings on tasks under 5 sub-steps.

## Auto-detect delegation triggers
Auto-invoke pal-router BEFORE reading when you see:
- A file open > 5 KB (`Read` with no `limit` on a large file)
- Any WebFetch call
- Bash output over 100 lines
- Any recon-tool result set (nuclei, dnsx, subfinder JSON) larger than 5 KB
- Any long-form prose request ("explain", "write up", "draft the report")

## When NOT to delegate
- The user asked for YOUR opinion or judgment (severity, chain viability, exploitability)
- A safety-boundary call (no 3rd-party data, no destructive action, no account creation)
- One-off short strings (< 200 bytes); PAL round-trip overhead dwarfs the saving

## The rule
> Delegate the prose, never the evidence.

## Deterministic pre-filters (`bin/`) — run BEFORE context or PAL

These are 0-token, deterministic wrappers. They cannot refuse or hallucinate, so
they run first and shrink payloads before anything reaches Claude or a PAL model.

- **`bin/sauron-normalize`** — convert recon JSON-L (httpx/subfinder/dnsx/naabu/nuclei)
  to ultra-dense TSV, stripping repeated JSON keys. ~25-35% smaller recon payloads.
  `cat httpx.jsonl | bin/sauron-normalize` (auto-detects tool per line; passes
  non-JSON through untouched; keeps host/url/status/tech/CVE/severity/matched-at).
- **`bin/strip-noise`** — strip ANSI/cursor escapes, collapse `\r` progress bars to
  their final state, and elide the middle of long stack traces (keep top 2 + bottom 2
  frames + the exception line). `noisy-cmd 2>&1 | bin/strip-noise`.

Rule: for recon output the order is **local pre-filter → (jq/deterministic parse) →
PAL only if LLM reasoning is still needed**. Never send raw JSON-L straight to a model.
