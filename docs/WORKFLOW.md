# sauron workflow

From cold box to shipping a finding, without burning Claude's context on busy work. The two invariants that anchor everything: (1) delegate the prose, never the evidence, and (2) a model refusal is a routing problem, not a stop.

## 1. One-time install (5 min)

1. Install sauron — the core engine (crowx01's routing-enhanced fork with capability-rank cross-provider auto model selection) now ships **bundled inside sauron at `./core`**, no separate download. On the claude-code path `setup.sh` provisions and registers it for you under `mcpServers.pal`; for other orchestrators, start it with `sauron serve` or register `core/server.py` there manually. (Lineage: BeehiveInnovations/pal-mcp-server, formerly zen-mcp-server; this fork carries the smarter routing.)
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

### Smarter pal: hand off whole jobs

The local `pal` CLI turns delegation into a hand-off instead of a chat.

- **`sauron run --plan plan.md`**: write the job as a plan file, run every step headless, get the result back. Do not babysit. Add `--agent` (or `--agent-role autonomous` for git/gh/network) for heavy coding work; `--ro` to keep it read-only.
- **`/tools <task>`** (in `sauron chat`): executes recon on the box itself (nmap, nuclei, ...), full-power by default; `/tools:ro` limits to a read-only allowlist. Authorized-recon prompts get an AUTHORIZATION preamble, so groq/qwen3 stop refusing.
- **`/agent[:edit|:plan|:review] <task>`**: a full local Claude Code sub-task via clink.
- **`/debate <q>`**: quick take — one model reads the files first, then a 3-model panel decides. No gate, no persisted state.
- **`/models`** (in `sauron chat`) or **`sauron models`**: the live capability catalog — what's actually reachable right now, not a static list.
- **Chat input UX**: `sauron chat` supports multiline input (`Alt+Enter`/`Ctrl+J` for a newline, plain `Enter` submits) and session-scoped history (`Up`/`Down`, or `Ctrl+P`/`Ctrl+N` regardless of cursor line) at `~/.pal/chat_history/<session_id>.jsonl` — one file per REPL run, so recall never crosses sessions. Every line is secret-masked before it touches disk, recall included.
- **Learning loop**: every run lands in `~/.pal/episodes.jsonl`; a `bandit` reorders routing at runtime (with an exploration floor); `pal distill` emits human-gated routing-order proposals (never auto-applied); a human-gated teacher `lesson_store` carries routing-scope lessons only (classifier/prompt/tool-scope lessons are review-only; there's no transcript parser, so task content can't mint its own rule). Refusal penalties are error-class-aware with self-heal probation, so one flaky provider is never permanently blacklisted.

Groq ITPM ≈ 7000: the tool loop trims context to `PAL_TOOLS_CTX_CHARS` (default 16000).

### Capability routing, the tool-model pool, and always-on protections

Four infra pieces sit underneath everything above, none of them a per-skill opt-in — they run inside PAL's provider layer on every call, so there is no configuration in this repo that skips them:

- **Capability catalog.** Routing merges static per-provider config with a live `/models` discovery call (cached ~6h) into one record per (provider, model): confirmed `tools`/`structured_output`/`vision`/`reasoning`/`context_limit`/`availability`. Capabilities are a hard filter — a task needing `tools` never lands on a model the catalog can't confirm supports it. The name lists elsewhere in this repo (model-map.md, the routing map above) are fallback priors, not the decision itself. `sauron models` / `/models` shows the live truth.
- **Tool-capable model pool.** `/tools`, `/tools:full`, and `sauron run`'s tool loop, plus the `/debate` reader and panel, all draw from an ordered, filtered pool of catalog `tools: true` models — not one hardcoded name. qwen3 stays the default front-of-pool (gpt-oss trips Groq's tool-call output parser), but a rate-limited or blacklisted model no longer stalls the loop; it auto-widens to the next candidate.
- **Headroom.** Oversized tool/debate output (a big nuclei run, an sqlmap transcript, prior debate handoffs) is compressed to counts/uniques/head-tail before it reaches any model — canonical evidence and outbound tool-call arguments are excluded, fail-open on error, originals stay retrievable on disk.
- **Guardrail (masking + inbound scan).** Every outbound call is credential/PII-masked (`Authorization` headers, JWTs, cloud keys, cookies, emails, ...) before it leaves the box; the per-call restore map lives in memory only, never logged or persisted. Every inbound model response is scanned for prompt-injection markers (instruction-override, role-override, prompt-leak, exfil asks) — `warn` (default) logs, `block` raises, `log` is silent. This is why a scraped page title or header value coming back through a model is safe to read: it's been through the scanner first.

### Sequential debate + judge — `sauron debate`

`/debate` in `sauron chat` is a quick opinion poll. For anything that needs an actual gate — a finding about to be submitted, a fix about to be merged — use `sauron debate "<objective>" --criterion "..."` instead: a stateful **executor → reviewer(s) → judge** pipeline.

Each iteration runs strictly in sequence: the executor does or revises the work and emits a structured JSON Handoff (actions taken, evidence, findings, acceptance-criteria verification, confidence); one or more reviewers critique that Handoff, flipping `verified: false` on any criterion lacking evidence; the judge rules `COMPLETE` or `CONTINUE`. The `COMPLETE` verdict is enforced in code, not trusted to the model's prose: it requires `completion_status == "review_ready"` AND every criterion `verified: true` with evidence AND zero open high/critical findings — anything short of that is downgraded to `CONTINUE` regardless of what the judge claims. A hard iteration cap (`PAL_DEBATE_MAX_ITER`, default 4) and no-progress detection (state fingerprint unchanged for N iterations) stop it from looping forever. Prior handoffs are Headroom-compressed before being resent so a long debate doesn't blow the context budget.

## 4. When a confirmed finding lands (the 4-step pipeline)

Every confirmed finding runs through the same loop before you see the report.

**A. Validator stress-test.** `Skill(validator)` emits a twelve-field verdict: Confidence Score, False Positive Risk, Exploitability, Impact, Missing Evidence, Missing Tests, Suggested Attack Chains, Suggested Manual Verification, Suggested Automation, Suggested Report Improvements, Suggested Severity, Final Verdict.

**B. Gap tests.** You (or Claude via your tools) run every missing test, negative control, and live observation the validator flagged. Non-negotiable rules: no third-party PII, no destructive payloads, no account creation under your identity. If a gap cannot be closed without crossing a safety boundary, mark it explicitly in the final report rather than skipping.

**C. Adversarial debate.** Quick pass: `mcp__pal__challenge` runs with `pro` (Gemini 3 Pro) as primary and `groq` as fallback, attacking the severity rating, exploitability under realistic attacker preconditions, chain viability, and impact ceiling. Preferred before submission: `sauron debate "<finding>" --criterion "..."` — the gated executor→reviewer→judge pipeline, one criterion per claim, `COMPLETE` only when every criterion is verified with evidence and no high/critical finding is left open. Either way the finding text is masked outbound and the transcript inbound-scanned like every other PAL call.

**D. Synthesize and write.** Validator output + gap-closing evidence + debate transcript (or `sauron debate` Handoff history) are combined into a final finding. `groq` drafts the prose from a Headroom-compressed transcript (canonical evidence excluded from compression). You byte-check every technical string (hostnames, URLs, tokens, CVSS vectors, CWE, file paths) against the raw evidence. Only then does the report leave the desk, submitted by you under your identity.

## 5. Bonus: PR reviews via debate-review and babysit-pr

- **`debate-review`.** A main reviewer reads the PR, a second reviewer tries to knock its findings down, the main reviewer makes the final call. One review posted from your own `gh`, `glab`, or `az` account with inline P0/P1/P2 comments.
- **`babysit-pr`.** Harvests every reviewer thread on the PR, verifies each finding against the code, fixes what is real, replies in-thread with evidence and attribution, resolves, and re-runs the review for the next round.

Both adapted from [amElnagdy/review-skills](https://github.com/amElnagdy/review-skills) (MIT).

## Quick reference: what fires when

| Event | What runs | Where it lives |
|---|---|---|
| session start | enabled skills auto-invoke + MEMORY read | SessionStart hook |
| every prompt | delegate-first + failover re-asserted | UserPromptSubmit hook |
| any bulk read/write | routed to a PAL model per task type, catalog capability-filtered | pal-router skill |
| any tool/`/tools`/`sauron run` call | tool-capable model pool (not one hardcoded model) | pal-router skill / `tools_pool.py` |
| any confirmed finding | 4-step pipeline before the report surfaces; Step C can use `sauron debate` | validator skill |
| any finding/fix needing a real gate | executor→reviewer→judge, `COMPLETE` enforced in code | `sauron debate` |
| any oversized tool/debate output | compressed to counts/uniques before a model sees it | Headroom (always on) |
| every outbound/inbound model call | credential/PII masked out, injection markers scanned in | guardrail (always on) |
| any PR to review | two-model debate + one review posted | debate-review skill |
| any PR to babysit | verify, fix, reply, resolve, re-run | babysit-pr skill |
| checking what's actually live | live capability catalog, not a static doc | `sauron models` / `/models` |

## The invariants

> Delegate the prose, never the evidence.

> A model refusal is a routing problem, not a stop.

> PAL is the only path to a model — masking and inbound scanning run on every call, unconditionally; there is no configuration in this repo that bypasses them.

## Lifecycle at a glance

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ONE-TIME INSTALL (~5 min)                                                  │
│                                                                            │
│    $ git clone https://github.com/crowx01/sauron ~/tools/sauron            │
│    $ cd ~/tools/sauron && ./setup.sh                                       │
│                                                                            │
│    ┌── setup.sh ─────────────────────────────────────────┐                 │
│    │ [1] scope?    g=global | p=per-project (default)   │                 │
│    │ [2] skills?   caveman? pentesting-agent? validator? │                 │
│    │ [3] models?   groq? nemotron? grok? flash?          │                 │
│    │               or-free? pro?                         │                 │
│    │ [4] proceed?  back up existing then MERGE (append,  │                 │
│    │               never clobber other frameworks)       │                 │
│    │ [5] symlink?  ln -sfn skills/* into .claude/skills/ │                 │
│    │ [6] PAL check on ~/.claude.json                     │                 │
│    │ [7] env template next to settings.json              │                 │
│    └─────────────────────────────────────────────────────┘                 │
│                                                                            │
│         writes:  <scope>/.claude/settings.json       (SS + UPS hooks)      │
│                  <scope>/.claude/.env.sauron.example (only chosen keys)    │
│                  <scope>/.claude/skills/*   -> symlinks to your clone      │
└────────────────────────────────────────────────────────────────────────────┘
                                    |
                                    v
┌────────────────────────────────────────────────────────────────────────────┐
│ EVERY SESSION BOOT (~2s, automatic)                                        │
│                                                                            │
│    Claude Code starts                                                      │
│           |                                                                │
│           v                                                                │
│    SessionStart hook fires  ->  additionalContext = "invoke caveman +      │
│           |                       pentesting-agent + validator;            │
│           |                       delegate-first policy; failover..."      │
│           v                                                                │
│    First three tool calls: Skill(caveman), Skill(pentesting-agent),        │
│                            Skill(validator)                                │
│           |                                                                │
│           v                                                                │
│    Ready. You type your first prompt.                                      │
└────────────────────────────────────────────────────────────────────────────┘
                                    |
                                    v
┌────────────────────────────────────────────────────────────────────────────┐
│ EVERY MESSAGE                                                              │
│                                                                            │
│    you> "deep-recon target.com"                                            │
│           |                                                                │
│           v                                                                │
│    UserPromptSubmit hook -> re-asserts delegate-first + failover           │
│           |                                                                │
│           v                                                                │
│    Claude picks tools (STAYS IN CLAUDE)                                    │
│           |                                                                │
│    +------+-------+-------+------+                                         │
│    v      v       v      v      v                                          │
│  subfinder amass httpx  gau  nuclei    (local, 0 tokens)                   │
│           |                                                                │
│           v                                                                │
│    parse route?                                                            │
│      +---- deterministic  ->  jq / grep locally (0 tokens)                 │
│      +---- LLM reasoning  ->  PAL(grok, 2M ctx)                            │
│      +---- huge JS bundle ->  PAL(nemotron, 1M ctx)                        │
│      +---- structured     ->  PAL(flash) -> fallback or-free               │
│      +---- report writeup ->  PAL(groq) -> Claude byte-checks              │
│      +---- model refused? ->  auto re-route (never a stop)                 │
│                                                                            │
│    every hop: catalog capability-filtered, masked out/scanned in,         │
│    Headroom-compressed if oversized -- unconditional, no bypass           │
└────────────────────────────────────────────────────────────────────────────┘
                                    |
                                    v
┌────────────────────────────────────────────────────────────────────────────┐
│ WHEN A FINDING LANDS (fixed 4-step pipeline)                               │
│                                                                            │
│    A. Skill(validator) -> 12-field verdict                                 │
│           |                                                                │
│    B. Gap tests with your tools                                            │
│       (no 3rd-party PII, no destructive, no account creation)              │
│           |                                                                │
│    C. quick: mcp__pal__challenge(finding, model=pro; fallback=groq)        │
│       gated:  sauron debate (executor->reviewer->judge, COMPLETE in code)     │
│       adversarial: severity, exploitability, chain, impact ceiling         │
│           |                                                                │
│    D. Synthesize (validator + gap evidence + debate)                       │
│       PAL(groq) drafts prose                                               │
│       Claude byte-checks every hostname/URL/token/CVSS vs raw evidence     │
│           |                                                                │
│           v                                                                │
│    YOU submit under your identity                                          │
└────────────────────────────────────────────────────────────────────────────┘
```
