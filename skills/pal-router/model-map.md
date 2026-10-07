# PAL Model Map

This file is a human-readable snapshot, not the live truth. Routing is driven by a capability catalog — one record per (provider, model) merging static config with a live `/models` discovery call, cached ~6h — that hard-filters on confirmed `tools`/`structured_output`/`vision`/`reasoning`/`context_limit` and on `availability` (`available`/`no_auth`/`unhealthy`/`stale`/`discovered`). A model this file lists may be `no_auth` or `stale` right now; a model not listed here may already be `discovered`. Check before trusting this doc: `pal models [--provider X] [--refresh] [--json] [--all]`, or `/models` inside `pal chat`. The names/aliases below still work as fallback priors when the catalog can't decide between otherwise-equal candidates.

**groq** (openai/gpt-oss-120b). I use this for report writing, vulnerability explanations, and skeptical validation. Hard cap of 8,000 tokens per minute, roughly 500 requests per minute. Aliases: `groq`, `gpt-oss-120b`, `gpt-oss`. Failure modes: truncates on long outputs; single-shot payloads of ~23,628 tokens fail outright, so split work into per-item calls.

**qwen3** (`qwen/qwen3.8-27b` via Groq). Front-of-pool default tool-executor for `/tools` and `pal run` — no longer sole/hardcoded: it's one candidate in the tool-capable model **pool** (`providers/router/tools_pool.py`), which auto-widens to any other catalog `tools: true` model if qwen3 is rate-limited, blacklisted, or unhealthy. Pin the pool front with `PAL_TOOLS_PRIMARY_MODEL` (legacy alias `PAL_CHAT_TOOLS_MODEL` still honored), extend with `PAL_TOOLS_MODELS`/`PAL_TOOLS_FALLBACK_MODELS`, exclude with `PAL_TOOLS_BLOCKLIST`. Failure mode it avoids: **gpt-oss trips Groq's output parser on tool-calling prompts (400 `output_parse_failed`)**, so keep gpt-oss for prose and the pool (qwen3 first) for tool loops. Shares the Groq key (`CUSTOM_API_KEY`) with `groq`.

**nemotron** (nvidia/nemotron-3.5-lightning:free via OpenRouter). I use it for bulk reading of large files such as JavaScript bundles, log dumps, and OpenAPI specs. 1M token context. Alias: `nemotron`. Failure mode: hallucinates on strict structured extraction. In one run it produced a random math-sum ramble instead of the requested index. Do not use it for byte-exact structured output.

**grok** (x-ai/grok-4.3 via OpenRouter, 1M context, alias `grok`). Permissive high-context security reasoning; the go-to fallback when Gemini refuses recon or attack-surface prompts. No observed refusals for authorized security work. Failure mode: **it is a paid model.** On an OpenRouter account that has never purchased credits every call returns HTTP 402 `Insufficient credits`, which looks like a routing bug but is billing. The older `x-ai/grok-4` and `x-ai/grok-4.1-fast` (the 2M-context one this map used to name) are no longer served by OpenRouter at all — verified against `/api/v1/models` on 2026-09-26.

**nemotron-ultra** (nvidia/nemotron-3-ultra-550b-a55b:free via OpenRouter, 1M context, alias `nemotron-ultra`). Strongest free reasoning model on a credit-less account, and the stand-in for grok everywhere below. Distinct from plain `nemotron`, which is the lightning model and is for bulk reading only.

**flash** (gemini-3.6-flash, 1M context, alias `flash`). Fast structured extraction. Failure mode: refuses recon-log and attack-surface analysis for named targets, even under authorized scope. Route around it with `jq`/local, `grok`, or `nemotron-ultra`.

**or-free** (openrouter/free meta-router, 200K context). Generalist fallback and quick summarization when nothing more specialised is available.

**pro** (gemini-3.1-pro-preview, 1M context, alias `pro`). Deep reasoning and adversarial debate through `mcp__pal__challenge`. Excels at multi-turn argumentation.

## Routing constraints

- **Authorization preamble.** When the classifier tags a task `security_permissive`, pal prepends an AUTHORIZATION preamble so groq/qwen3 stop refusing authorized recon, enum, and scan work. It complements (does not replace) the "gemini refuses, go to grok" failover.
- **Groq ITPM ≈ 7000.** The tool loop trims accumulated context to `PAL_TOOLS_CTX_CHARS` (default 16000) so each request fits. Keep tool-loop prompts small; chunk anything bigger.
- **Masking is unconditional.** Every provider call is credential/PII-masked outbound and injection-scanned inbound (`providers/router/guardrail.py`) regardless of which model or category is picked. Not a routing choice — always on, no per-model opt-out.
- **Headroom is unconditional.** Oversized tool/debate output is compressed (counts/uniques/head-tail) before it reaches any model, canonical evidence and tool-call arguments excluded (`providers/router/headroom_adapter.py`). Also not a routing choice.

## Two kinds of "debate"

- **`/debate` (pal chat)** — quick take. One pool model reads the files, a 3-model panel (`gpt-oss-120b`, `qwen3`, `gpt-oss-20b`) each give a grounded verdict. No gate, no loop, no persisted state.
- **`pal debate "<objective>"`** — the gated pipeline. Stateful executor → reviewer(s) → judge, JSON Handoff each turn, `COMPLETE` enforced in code (review_ready + all criteria verified + no open high/critical finding), anti-loop cap + no-progress halt. Use this one for anything that needs a real pass/fail, not an opinion.

## Delegation via `pal run`

`pal run "<task>"` is the headless one-shot: it runs the task with local tools and prints only the result.

- `--ro` read-only tools; `--agent` full Claude Code agent (`--agent-role autonomous|edit|plan|review`); `--model <m>`; `--max-steps N`; `--json` (task/mode/model/tools_used/result).
- `--plan <file>` runs every step of a plan file. Strongest handoff: write the plan to a file, run it, collect the result, do not babysit.
- Heavy coding/tool work: `pal run --agent`; use `--agent-role autonomous` when it must run git/gh/network unattended.

## Failover order for the common tasks

- **Deterministic recon parsing** (hosts, CNAMEs, params from JSONL): `jq` and local shell first (token-free, cannot refuse), then `grok` (or `nemotron-ultra` with no credits) if LLM reasoning is needed.
- **Structured extraction from prose**: `flash`, fallback `grok` then `nemotron-ultra`, avoid `nemotron`.
- **Report writing / skeptical validation**: `groq`, fallback `grok` then `nemotron-ultra`.
- **Bulk reading of very large files**: `nemotron`, fallback `or-free`.
- **Deep adversarial reasoning**: `pro`, fallback `groq`, then `nemotron-ultra`.

## Verify before trusting this map

Model IDs and their context windows drift, and free tiers come and go. This map records what
was true on 2026-09-26. Before blaming a route, ask PAL what it can actually reach:

- `mcp__pal__listmodels` — which providers are configured and which models they expose.
- `curl -s https://openrouter.ai/api/v1/models` — whether an ID is still served at all.
- `curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/key` —
  credits and the shared free-model daily request budget. Multiple keys on one account share
  that budget, so a second key does not buy headroom.

A 402 is billing, a 429 with `limit_source: upstream_provider_shared_pool` is transient
congestion on a `:free` model, and a 404 means the ID is gone. Only the last one is a map bug.
