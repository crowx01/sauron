<p align="center">
  <img src="sauron.png" alt="Sauron holding the One Ring, tethering six Nazgul-servant AI models with fiery threads" width="960"/>
</p>
<p align="center"><sub>diagram view: <a href="sauron.svg">sauron.svg</a> · full resolution: <a href="sauron_full.png">sauron_full.png</a></sub></p>

# sauron

**One agent to route them all.**

> **One model to rule them all, one model to find them, one model to bring them all, and in the darkness bind them.**

## What it is

I built Sauron as a collection of skills that let my AI orchestrator become the puppet-master of a multi-model chain for bug-bounty and offensive-security work. The installer drops the appropriate rules into Claude Code, Cursor, Cline, Codex CLI, Aider, or, for any other orchestrator, writes a portable `SYSTEM_PROMPT.md`. The setup wizard walks you through picking the orchestrator, the install scope, the skills, and the PAL models, so the master model calls the helpers while you keep the judgment calls.

## The Nazgul (skills)

| Skill | Job | Source |
|-------|-----|--------|
| [`validator`](skills/validator/SKILL.md) | Skeptical QA reviewer that runs the 4-step validation pipeline before any finding is reported. | mine |
| [`pal-router`](skills/pal-router/SKILL.md) | Delegate-first + failover doctrine for dispatching sub-tasks to cheaper or free PAL models. | mine |
| [`debate-review`](skills/debate-review/SKILL.md) | Two-model debate review of a GitHub PR, GitLab MR, or Azure DevOps PR. Posts inline P0/P1/P2 comments from your own gh/glab/az. | adapted from [amElnagdy/review-skills](https://github.com/amElnagdy/review-skills) (MIT) |
| [`babysit-pr`](skills/babysit-pr/SKILL.md) | Works PR review rounds automatically: verifies findings, fixes blockers, replies in-thread, resolves, re-runs. | adapted from [amElnagdy/review-skills](https://github.com/amElnagdy/review-skills) (MIT) |

## What stays in your orchestrator (never delegated)

- user-facing decisions
- exploitation choices
- severity and CVSS calls
- safety-boundary checks
- side-effecting actions
- tool-sequence orchestration

## The routing map

- **groq** (openai/gpt-oss-120b, ~500 req/min, 8,000 tokens/min cap): report writing, vuln explanations, skeptical validation.
- **nemotron** (NVIDIA Nemotron, 1M context): bulk reading. Do NOT use for strict structured extraction (hallucinates).
- **grok** (x-ai on OpenRouter, 2M context): permissive high-context security reasoning; fallback when Gemini refuses.
- **flash** (Gemini 3.6-flash, 1M context): fast structured extraction; refuses recon for named targets.
- **or-free** (OpenRouter free meta-router, 200K context): generalist fallback.
- **pro** (Gemini 3 Pro preview): deep reasoning and adversarial debate.

Full matrix: [skills/pal-router/model-map.md](skills/pal-router/model-map.md).

## The 4-step validation pipeline

1. Validator stress-test (twelve fields).
2. Gap tests (run the missing checks with your own tools).
3. Adversarial debate via `mcp__pal__challenge` (pro primary, groq fallback).
4. Synthesize + write (delegate prose to groq; human sanity-checks byte-exact against evidence).

Full spec: [skills/validator/SKILL.md](skills/validator/SKILL.md).

## Orchestrators

The installer supports six targets. Pick one at prompt `0` in `./setup.sh`.

- **Claude Code** (default): writes `~/.claude/settings.json` (or `./.claude/settings.json` for per-project) with `SessionStart` + `UserPromptSubmit` hooks, and symlinks `skills/*` into `~/.claude/skills/`.
- **Cursor**: writes `./.cursor/rules/sauron.mdc` with `alwaysApply: true`, and copies `skills/*` into `./.cursor/rules/sauron-skills/` so the model can read them.
- **Cline**: writes `./.clinerules` (or `~/.clinerules` for global) with the routing doctrine, and copies `skills/*` into `./sauron-skills/`.
- **Codex CLI**: writes `~/.codex/instructions.md` and copies `skills/*` into `~/.codex/sauron-skills/`.
- **Aider**: writes `./.aider.sauron.md` (add to your `.aider.conf.yml` as `read: [./.aider.sauron.md]`) and copies `skills/*` into `./sauron-skills/`.
- **Generic / other**: writes `./SYSTEM_PROMPT.sauron.md` you can paste into any tool's system prompt, with `skills/*` copied alongside.

For non-Claude orchestrators the installer also appends an index of the shipped skills to the rules file so the model knows what SKILL.md files it can read when a trigger phrase appears (since only Claude Code has the `Skill()` primitive).

## Failover doctrine

If any model refuses, times out, or errors, immediately re-route to another model. A classifier refusal is a routing problem, not a stop.

## Install

```bash
# 1. Get the PAL MCP server (fork of zen-mcp-server) and register it in ~/.claude.json
git clone https://github.com/BeehiveInnovations/zen-mcp-server ~/tools/zen-mcp-server

# 2. Get sauron and run the interactive setup
git clone https://github.com/crowx01/sauron && cd sauron
./setup.sh
```

`setup.sh` walks you through:
- **Scope.** Global (`~/.claude/settings.json`, loads every session everywhere) or per-project (`./.claude/settings.json`, only loads when the chosen orchestrator runs in that project). Per-project is the default so the framework does not attach to unrelated work.
- **Auto-load skills.** Pick which skills fire at session start (caveman, pentesting-agent, validator).
- **Delegate-first policy.** Pick which PAL models you have keys for. Unselected models are dropped from the rendered hook.
- **Backup.** Any existing `settings.json` gets a timestamped `.bak` before write.

Full walkthrough from cold box to shipping a finding: **[docs/WORKFLOW.md](docs/WORKFLOW.md)**.

See a full picture-book walkthrough of the wizard + what your orchestrator sees at boot: **[docs/install-walkthrough.pdf](docs/install-walkthrough.pdf)** (4 pages, fire-palette rendering).

> Prefer to skip the wizard? Copy `settings.example.json` to `~/.claude/settings.json` (or `./.claude/settings.json` for per-project) and edit it by hand. `setup.sh` is just a friendlier way to produce the same file.

Then restart your orchestrator.

## Real-world lessons

- Delegate the prose, never the evidence. A groq draft once mislabeled a production host as staging and dropped a WebSocket query string; the byte-exact human check caught it.
- Gemini flash refuses recon or attack-surface analysis for named targets. Route deterministic parsing to `jq` and local shell. Reserve `grok` for LLM reasoning over recon.
- NVIDIA Nemotron hallucinates on strict structured extraction. Use it only for bulk reading.
- Groq's 8,000 TPM cap forces chunking. A 23,628-token single-shot call fails outright.

## Attribution

- `skills/debate-review/` and `skills/babysit-pr/` are adapted from [amElnagdy/review-skills](https://github.com/amElnagdy/review-skills) (MIT, Copyright Ahmed Mohammed). Upstream license is preserved inside each skill directory and in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## License

MIT for sauron's own code ([LICENSE](LICENSE)). Third-party licenses in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Authorized use only

Sauron is provided for authorized penetration-testing and bug-bounty engagements only. Using it against systems you do not own or lack explicit permission to test is illegal.
