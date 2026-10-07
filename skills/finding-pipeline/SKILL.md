---
name: finding-pipeline
description: >-
  Orchestrates sauron's 4-step validation pipeline over a confirmed finding before it is presented
  or reported: stress-test, close the evidence gaps, adversarial debate, synthesize. It does not
  review the finding itself -- step A delegates that to the `validator` reviewer skill, and step D
  delegates the prose to groq. Triggers on: 'run the pipeline', 'validate this finding', 'before I
  submit', 'check my PoC', 'is this a false positive', 'score this severity'.
---

# finding-pipeline

**One-line pitch:** Runs sauron's 4-step validation pipeline over a confirmed finding before it is presented or reported. It is the orchestration, not the review: step A calls the `validator` reviewer, step C calls PAL, step D calls groq.

> Renamed from `validator`. It collided with the `validator` reviewer skill in the pentesting
> knowledge base (https://github.com/Darxbloo/Pentesting-Agent-new), which is the skill step A is supposed to call — so under the old name this
> file described a pipeline whose first step invoked itself, and whichever `validator` happened to
> sit in the skills directory decided what the hook reached.

## When to invoke
- After any new confirmed vulnerability finding, PoC, or draft report.
- Before submitting to a bug-bounty program.
- Trigger phrases: "validate this finding", "before I submit", "check my PoC", "is this a false positive", "score this severity".

## The 4-step pipeline

### Step A. Stress-test
Invoke the `validator` skill — the skeptical senior reviewer, which does not hunt for bugs itself but stress-tests one already found. It returns twelve fields:

- **Confidence Score** (0-100)
- **False Positive Risk** (Low/Medium/High + the alternative explanation ruled out)
- **Exploitability** (Trivial/Moderate/Difficult/Theoretical, tied to realistic attacker preconditions)
- **Impact** (target-specific, not generic CWE text)
- **Missing Evidence** (exact artifacts still needed)
- **Missing Tests** (specific negative-controls / verb / header / role / chain-hop untried)
- **Suggested Attack Chains** (from a primitive-to-impact chain map)
- **Suggested Manual Verification** (next exact step)
- **Suggested Automation** (nuclei template, Burp ext, ffuf sweep, script)
- **Suggested Report Improvements** (concrete edits, not vibes)
- **Suggested Severity** (with target-specific justification)
- **Final Verdict** (Confirmed / Likely Valid / Needs More Evidence / Weak Evidence / False Positive)

### Step B. Gap tests
Run every missing test, negative control, and live observation the validator flagged. Use my own tools. No shortcuts, no third-party PII, no destructive payloads, no account creation under my identity.

### Step C. Adversarial debate
Two routes, pick by how much rigor the finding needs:
- **Quick adversarial pass:** `mcp__pal__challenge` with `pro` (Gemini 3 Pro) as primary and `groq` as fallback. Frame the debate adversarially: challenge severity, exploitability, chain viability, impact ceiling.
- **Gated pipeline (preferred before submission):** `pal debate "<finding + claimed severity>" --criterion "..."` for one criterion per claim (e.g. "exploitability is at least Moderate under realistic attacker preconditions", "severity X is justified by target-specific impact, not generic CWE text"). This runs a stateful executor → reviewer(s) → judge loop and only returns `COMPLETE` when every criterion is `verified: true` with evidence and no open high/critical finding remains — the judge's `COMPLETE` claim is enforced in code, not trusted as prose, so a model can't hand-wave a pass. Prefer this over the quick pass for anything about to be submitted.

Both routes run through PAL's always-on guardrail: any credential, token, or PII embedded in the finding is masked outbound before a debate model sees it, and the transcript is inbound-scanned for injection markers (relevant since a finding's PoC often quotes attacker-controlled input — a scraped page title, a header value, a JS string).

### Step D. Synthesize + write
Combine validator output + gap-closing evidence + debate transcript (quick-pass or `pal debate` Handoff history). Delegate the prose to `groq` per the delegate-first doctrine. Human then verifies every technical string (hostnames, URLs, tokens, CVSS vectors, CWE, paths) byte-for-byte against raw evidence. Long transcripts and prior debate handoffs reach `groq` already Headroom-compressed (counts/uniques, not truncation) — canonical evidence and PoC text are excluded from compression, so byte-for-byte verification is still against the real thing, not a summary.

## Anti-patterns
- Never invent evidence to fill a gap.
- Never soften a False Positive to spare feelings.
- Never inflate severity beyond what the evidence supports.
- Never skip the chain analysis because a finding "seems complete".

## Related
- Uses `debate-review` methodology adapted from https://github.com/amElnagdy/review-skills.
- Feeds `pal-router` for model dispatch, capability-aware routing, and the `pal debate` gated pipeline.

## The rule
> Delegate the prose, never the evidence.
