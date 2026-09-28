---
name: pal-learn
description: >-
  Files an observed PAL routing fact back into pal-router's model map so the framework's routing
  knowledge compounds instead of going stale. Ingests one observation — a model refused a prompt, a
  model ID stopped being served, a model started returning 402/429, a fallback worked where the
  primary failed, a model hallucinated on a task class, a rate or context limit turned out to be
  different than documented — verifies it against the live provider before writing, and enriches the
  existing entry rather than appending a duplicate. Triggers on: 'gemini refused again', 'that model
  is gone', 'nemotron made that up', 'update the model map', 'log this routing failure', 'X 402d',
  'the fallback worked', a pasted provider error body (402 / 429 / 404 / refusal text), or the end
  of a session in which any PAL route behaved differently than the map predicted.
---

# pal-learn

**One-line pitch:** The mechanism that keeps `pal-router`'s model map true. Routing facts decay —
models get withdrawn, free tiers change, refusal behaviour shifts — and a stale map sends work to a
model that cannot serve it.

Adapted from the `pentest-learn` / `pentest-debrief` loop in the pentesting knowledge base
(https://github.com/Darxbloo/Pentesting-Agent-new), which files engagement lessons into the skill
that owns them. This applies the same discipline to routing.

## Why this exists

The map in `skills/pal-router/model-map.md` named `x-ai/grok-4.1-fast` at 2M context as the
fallback for three separate routes. OpenRouter had stopped serving it, and the documented
replacement was paid-only — so all three routes had a fallback that returned 402. Nothing in the
framework noticed, because nothing owned keeping the map current. That is the failure this skill
prevents.

## Step 0 — is it a routing fact?

File only facts about **how a model behaves as a delegation target**: availability, cost, refusals,
limits, context, and output quality per task class. Not prompt technique, not findings, not target
data. A one-off network blip is not a routing fact; a reproducible behaviour is.

## Step 1 — classify the observation

| Signal | Meaning | Where it goes |
|---|---|---|
| 402 / insufficient credits | Paid model on an unfunded account. Billing, not routing. | Mark the model **paid** in the map; do not remove it |
| 404 / model not found | ID withdrawn by the provider | Replace the ID, or retire the entry and repoint aliases |
| 429, `limit_source: upstream_provider_shared_pool` | Transient upstream congestion on a `:free` model | Note as a known flake; do NOT demote the model |
| 429, account or key limit | Quota exhausted | Record the real limit and its scope (per key vs per account) |
| Refusal text | Safety classifier declined the task class | Record the task class it refuses, and what to route to instead |
| Wrong or invented output | Hallucination on a task class | Record the task class to avoid, with the observed failure |
| Fallback succeeded | The chain works | Promote it in the failover order |

## Step 2 — verify before writing

Never file a provider claim from memory or from a single failed call. Confirm it:

- `mcp__pal__listmodels` — what PAL can actually reach right now.
- `curl -s https://openrouter.ai/api/v1/models` — whether the ID is still served.
- `curl -s -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key` — credits and limits.
  Treat its `free_model_daily_requests` as eventually-consistent; trust the provider's documented
  rule over the counter.
- Re-run the failing call once. A single failure distinguishes nothing.

Record the date you verified it. Every entry in the map is a claim about a moving target.

## Step 3 — deduplicate, then enrich

Grep the destination first. If an entry for that model exists, **add to it** — a new failure mode, a
corrected limit, a date. Do not append a second entry under a variant name. If the fact contradicts
what is written, correct the text rather than stacking a caveat on it.

## Step 4 — file it

| Fact | Destination |
|---|---|
| Per-model behaviour, limits, failure modes | `skills/pal-router/model-map.md`, that model's entry |
| Changed preference order for a task | `model-map.md` "Failover order" + `pal-router/SKILL.md` |
| A model named in the rendered hook | `setup.sh` routing strings — the hook must not name a model that cannot serve |
| A model alias PAL cannot resolve | the `OPENROUTER_MODELS_CONFIG_PATH` / `CUSTOM_MODELS_CONFIG_PATH` registry |
| A claim in user-facing docs | `README.md` routing map, `docs/WORKFLOW.md` |

A fact that appears in more than one of these must be corrected in all of them; a stale README is
as misleading as a stale map.

## Step 5 — state what changed

Report the model, the observation, how it was verified, the files touched, and anything left
unverified. Never imply a limit was confirmed when it was inferred.

## What NOT to file

- Single transient failures with no second observation.
- Provider limits copied from documentation without checking them against the account in use.
- Model recommendations with no observed evidence behind them.
- Target data, findings, or credentials. This skill touches routing knowledge only.
