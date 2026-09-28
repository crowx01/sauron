# PAL Model Map

**groq** (openai/gpt-oss-120b). I use this for report writing, vulnerability explanations, and skeptical validation. Hard cap of 8,000 tokens per minute, roughly 500 requests per minute. Aliases: `groq`, `gpt-oss-120b`, `gpt-oss`. Failure modes: truncates on long outputs; single-shot payloads of ~23,628 tokens fail outright, so split work into per-item calls.

**nemotron** (nvidia/nemotron-3.5-lightning:free via OpenRouter). I use it for bulk reading of large files such as JavaScript bundles, log dumps, and OpenAPI specs. 1M token context. Alias: `nemotron`. Failure mode: hallucinates on strict structured extraction. In one run it produced a random math-sum ramble instead of the requested index. Do not use it for byte-exact structured output.

**grok** (x-ai/grok-4.3 via OpenRouter, 1M context, alias `grok`). Permissive high-context security reasoning; the go-to fallback when Gemini refuses recon or attack-surface prompts. No observed refusals for authorized security work. Failure mode: **it is a paid model.** On an OpenRouter account that has never purchased credits every call returns HTTP 402 `Insufficient credits`, which looks like a routing bug but is billing. The older `x-ai/grok-4` and `x-ai/grok-4.1-fast` (the 2M-context one this map used to name) are no longer served by OpenRouter at all — verified against `/api/v1/models` on 2026-09-26.

**nemotron-ultra** (nvidia/nemotron-3-ultra-550b-a55b:free via OpenRouter, 1M context, alias `nemotron-ultra`). Strongest free reasoning model on a credit-less account, and the stand-in for grok everywhere below. Distinct from plain `nemotron`, which is the lightning model and is for bulk reading only.

**flash** (gemini-3.6-flash, 1M context, alias `flash`). Fast structured extraction. Failure mode: refuses recon-log and attack-surface analysis for named targets, even under authorized scope. Route around it with `jq`/local, `grok`, or `nemotron-ultra`.

**or-free** (openrouter/free meta-router, 200K context). Generalist fallback and quick summarization when nothing more specialised is available.

**pro** (gemini-3.1-pro-preview, 1M context, alias `pro`). Deep reasoning and adversarial debate through `mcp__pal__challenge`. Excels at multi-turn argumentation.

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
