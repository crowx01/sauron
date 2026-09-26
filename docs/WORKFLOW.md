# sauron workflow

From cold box to shipping a finding, without burning Claude's context on busy work. The two invariants that anchor everything: (1) delegate the prose, never the evidence, and (2) a model refusal is a routing problem, not a stop.

## 1. One-time install (5 min)

1. Clone the PAL MCP server (a fork of zen-mcp-server): https://github.com/BeehiveInnovations/zen-mcp-server. Register it in `~/.claude.json` under `mcpServers.pal`.
2. Clone this repo.
3. Run `./setup.sh` from the sauron root. The wizard walks you through:
   - **Scope.** Global (`~/.claude/settings.json`, loads every session, every project) or per-project (`./.claude/settings.json`, only loads when Claude Code runs inside that project). Per-project is the default choice unless you want the framework everywhere.
   - **Auto-load skills.** Pick which skills fire as the first tool calls of every session (caveman, pentesting-agent, validator).
   - **Delegate-first policy.** Pick which PAL models you have keys for (groq, nemotron, grok, flash, or-free, pro). Unselected models are dropped from the rendered hook so Claude never tries to route to them.
4. Fill in your API keys in the generated `.env.sauron.example` and source it from your shell rc.
5. Symlink each chosen skill into the skills folder Claude Code discovers from. `setup.sh` will offer to do this for you; the manual equivalent:
   ```bash
   # global install
   SAURON=~/tools/sauron   # path to your local sauron clone
   mkdir -p ~/.claude/skills
   for d in "$SAURON"/skills/*/; do ln -sfn "$d" ~/.claude/skills/$(basename "$d"); done

   # per-project install (run from the project root)
   SAURON=~/tools/sauron
   mkdir -p ./.claude/skills
   for d in "$SAURON"/skills/*/; do ln -sfn "$d" ./.claude/skills/$(basename "$d"); done
   ```
6. Restart Claude Code so the new hook takes effect.

## 2. Every session boot (automatic, ~2s)

When Claude Code starts, the **SessionStart** hook injects a mandatory-first-actions block. Claude's very first tool calls are the enabled skills (caveman, pentesting-agent, validator) plus a read of `MEMORY.md` if present. One short readout, then Claude is primed.

## 3. The hunting loop (per prompt)

The **UserPromptSubmit** hook re-asserts the delegate-first + failover policy on every message. This keeps routing discipline from drifting as the session grows long.

### Concrete example

```
you> deep-recon target.com
```

1. Claude picks the tools (subfinder? amass? httpx? katana?). This decision stays in Claude.
2. The local recon suite runs: `subfinder`, `amass`, `dnsx`, `httpx`, then optionally `gau`, `katana`, `nuclei`, `naabu`.
3. Parsing `httpx.jsonl` (700 rows of infra data) routes to `jq` locally when possible, or to `grok` when LLM reasoning is needed. Claude does not see the raw rows.
4. A multi-megabyte JavaScript bundle to read cross-file? That goes to `nemotron` (1M context).
5. Structured extraction ("list every `Set-Cookie` header, group by domain") goes to `flash`.
6. If Gemini refuses a recon prompt, Claude re-routes to `grok` in the same message. No stop.
7. Any narrative write-up gets drafted by `groq`. Claude then byte-checks every technical string in the draft against the raw evidence before letting it surface.

## 4. When a confirmed finding lands (the 4-step pipeline)

Every confirmed finding runs through the same loop before you see the report.

**A. Validator stress-test.** `Skill(validator)` emits a twelve-field verdict: Confidence Score, False Positive Risk, Exploitability, Impact, Missing Evidence, Missing Tests, Suggested Attack Chains, Suggested Manual Verification, Suggested Automation, Suggested Report Improvements, Suggested Severity, Final Verdict.

**B. Gap tests.** You (or Claude via your tools) run every missing test, negative control, and live observation the validator flagged. Non-negotiable rules: no third-party PII, no destructive payloads, no account creation under your identity. If a gap cannot be closed without crossing a safety boundary, mark it explicitly in the final report rather than skipping.

**C. Adversarial debate.** `mcp__pal__challenge` runs with `pro` (Gemini 3 Pro) as primary and `groq` as fallback. Framing is adversarial: attack the severity rating, exploitability under realistic attacker preconditions, chain viability, and impact ceiling.

**D. Synthesize and write.** Validator output + gap-closing evidence + debate transcript are combined into a final finding. `groq` drafts the prose. You byte-check every technical string (hostnames, URLs, tokens, CVSS vectors, CWE, file paths) against the raw evidence. Only then does the report leave the desk, submitted by you under your identity.

## 5. Bonus: PR reviews via debate-review and babysit-pr

- **`debate-review`.** A main reviewer reads the PR, a second reviewer tries to knock its findings down, the main reviewer makes the final call. One review posted from your own `gh`, `glab`, or `az` account with inline P0/P1/P2 comments.
- **`babysit-pr`.** Harvests every reviewer thread on the PR, verifies each finding against the code, fixes what is real, replies in-thread with evidence and attribution, resolves, and re-runs the review for the next round.

Both adapted from [amElnagdy/review-skills](https://github.com/amElnagdy/review-skills) (MIT).

## Quick reference: what fires when

| Event | What runs | Where it lives |
|---|---|---|
| session start | enabled skills auto-invoke + MEMORY read | SessionStart hook |
| every prompt | delegate-first + failover re-asserted | UserPromptSubmit hook |
| any bulk read/write | routed to a PAL model per task type | pal-router skill |
| any confirmed finding | 4-step pipeline before the report surfaces | validator skill |
| any PR to review | two-model debate + one review posted | debate-review skill |
| any PR to babysit | verify, fix, reply, resolve, re-run | babysit-pr skill |

## The two invariants

> Delegate the prose, never the evidence.

> A model refusal is a routing problem, not a stop.
