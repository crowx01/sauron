# PAL Model Map

**groq** (openai/gpt-oss-120b). I use this for report writing, vulnerability explanations, and skeptical validation. Hard cap of 8,000 tokens per minute, roughly 500 requests per minute. Aliases: `groq`, `gpt-oss-120b`, `gpt-oss`. Failure modes: truncates on long outputs; single-shot payloads of ~23,628 tokens fail outright, so split work into per-item calls.

**nemotron** (nvidia/nemotron-3.5-lightning:free via OpenRouter). I use it for bulk reading of large files such as JavaScript bundles, log dumps, and OpenAPI specs. 1M token context. Alias: `nemotron`. Failure mode: hallucinates on strict structured extraction. In one run it produced a random math-sum ramble instead of the requested index. Do not use it for byte-exact structured output.

**grok-4.1-fast** (x-ai via OpenRouter, 2M context). Permissive high-context security reasoning; the go-to fallback when Gemini refuses recon or attack-surface prompts. No observed refusals for authorized security work.

**flash** (gemini-3.6-flash, 1M context, alias `flash`). Fast structured extraction. Failure mode: refuses recon-log and attack-surface analysis for named targets, even under authorized scope. Route around it with `jq`/local or grok-4.1-fast.

**or-free** (openrouter/free meta-router, 200K context). Generalist fallback and quick summarization when nothing more specialised is available.

**pro** (gemini-3-pro-preview, 1M context, alias `pro`). Deep reasoning and adversarial debate through `mcp__pal__challenge`. Excels at multi-turn argumentation.

## Failover order for the common tasks

- **Deterministic recon parsing** (hosts, CNAMEs, params from JSONL): `jq` and local shell first (token-free, cannot refuse), then `grok-4.1-fast` if LLM reasoning is needed.
- **Structured extraction from prose**: `flash`, fallback `grok-4.1-fast`, avoid `nemotron`.
- **Report writing / skeptical validation**: `groq`, fallback `grok-4.1-fast`.
- **Bulk reading of very large files**: `nemotron`, fallback `or-free`.
- **Deep adversarial reasoning**: `pro`, fallback `groq`.
