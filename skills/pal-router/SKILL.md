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

Full model matrix and aliases: [model-map.md](model-map.md).

## Failover doctrine

If any model refuses, times out, or errors, immediately re-route to another model. A classifier refusal is a routing problem, not a stop.

Preferred order per common task:

1. **Deterministic recon parsing** (hosts, CNAMEs, params from JSONL): `jq` and local shell first (token-free, cannot refuse), then `grok` if LLM reasoning is needed.
2. **Structured extraction from prose**: `flash`, fallback `grok`, avoid `nemotron`.
3. **Report writing / skeptical validation**: `groq`, fallback `grok`.
4. **Bulk reading of very large files**: `nemotron`, fallback `or-free`.
5. **Deep adversarial reasoning**: `pro`, fallback `groq`.

## Wiring

The doctrine is enforced by two hooks in `~/.claude/settings.json`, both shipped in [`settings.example.json`](../../settings.example.json):

- **SessionStart** auto-invokes the `caveman`, `pentesting-agent`, and `validator` skills at the start of every session.
- **UserPromptSubmit** re-asserts the delegate-first + failover doctrine on every message so nothing drifts as sessions grow long.

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
