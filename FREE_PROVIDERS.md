# Free LLM providers — redundancy wiring for sauron

Source catalogue: https://github.com/mnfst/awesome-free-llm-apis (external, untrusted — metadata only).
Wired via the supported `~/.pal/keys.json` → `providers/extra_providers.py::register_extras` path
(an entry registers only when `status` starts `WORKING`, and it has `base`, `models`, and non-empty `keys`).
Fallback redundancy = membership in a `~/.pal/env.json` category (so `fallback_chain` can reroute to them
on 402/413/429). **Anthropic/Claude is never added.**

## Live now (verified 2026-10-08)
| Provider | Base URL | Auth | Models wired | Free limit | Fallback category |
|---|---|---|---|---|---|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | key (present) | `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nemotron-3.5-lightning-30b-a3b` | 40 RPM / 10k RPD | long_context_bulk, security_permissive, long_form_prose (super); long_context_bulk (lightning) |

Notes: both ids live-tested with a real chat completion. `openai/gpt-oss-20b` is also callable on NVIDIA but was
**deliberately excluded** so it doesn't shadow groq's existing `openai/gpt-oss-20b`. These are reasoning models
(emit a short "thinking" preamble) — great as bulk/analysis fallback peers, not for strict JSON.

Already-working providers (unchanged, pre-existing): groq, openrouter, gemini, ollama_cloud, cohere, huggingface(credit-metered), manifest, aionlabs, bazaarlink, kilo.

## Scaffolded — paste a key to activate (no account was created for you)
Add the key to `keys[0]` in `~/.pal/keys.json` and change `status` to start with `WORKING`; then add the model(s)
to a `~/.pal/env.json` category for redundancy.

| Provider | Base URL | Signup (free) | keys.json entry | Example model |
|---|---|---|---|---|
| Mistral AI | `https://api.mistral.ai/v1` | https://console.mistral.ai/ | `mistral` (keys:[] today) | `mistral-small-latest`, `open-mistral-nemo` |
| OVHcloud AI Endpoints | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | https://endpoints.ai.cloud.ovh.net/ | `ovh` (keys:[] today) | `gpt-oss-20b`, `Mistral-Small-3.2-24B-Instruct-2506` |

OVH's anonymous endpoint only serves embeddings (`bge-m3`); chat needs a free key.

## Deliberately skipped
- **Anthropic / Claude** — hard rule, never routed.
- **Cohere free** — non-commercial-only license (unsafe for pentest/commercial use) → left as-is, not added to categories.
- **Cloudflare Workers AI** — non-standard `/accounts/{id}/ai/run` path (bespoke adapter); already present in keys.json.
- **Groq /models probe** returned 403 (CF UA block) but groq chat is native & working — left untouched.
- Dead/no-balance entries already in keys.json (deepseek, deepinfra, requesty, sambanova, together, chutes, aimlapi, nscale, zenmux, orcarouter, kimi, llm7) — not touched.

## How to add another from the list later
1. `~/.pal/keys.json`: add `{"base":"<url>","models":["<id>",...],"keys":["<key>"],"status":"WORKING ..."}` (OpenAI-compatible only; for Anthropic-wire gateways set `"api":"anthropic"` — never api.anthropic.com).
2. `~/.pal/env.json`: append the model id to a category for fallback redundancy.
3. If it has a small input/TPM cap, add it to `providers/router/size_guard.py MODEL_INPUT_CAPS`.
4. Verify: `register_extras(ModelProviderRegistry); get_provider_for_model("<id>")` resolves to it.
