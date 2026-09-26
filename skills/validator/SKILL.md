# validator

**One-line pitch:** Skeptical QA reviewer skill for offensive-security findings. Runs the sauron framework's 4-step validation pipeline before any finding is reported.

## When to invoke
- After any new confirmed vulnerability finding, PoC, or draft report.
- Before submitting to a bug-bounty program.
- Trigger phrases: "validate this finding", "before I submit", "check my PoC", "is this a false positive", "score this severity".

## The 4-step pipeline

### Step A. Stress-test
Invoke the validator's own review over the finding. Produce twelve fields:

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
Route to `mcp__pal__challenge` with `pro` (Gemini 3 Pro) as primary and `groq` as fallback. Frame the debate adversarially: challenge severity, exploitability, chain viability, impact ceiling.

### Step D. Synthesize + write
Combine validator output + gap-closing evidence + debate transcript. Delegate the prose to `groq` per the delegate-first doctrine. Human then verifies every technical string (hostnames, URLs, tokens, CVSS vectors, CWE, paths) byte-for-byte against raw evidence.

## Anti-patterns
- Never invent evidence to fill a gap.
- Never soften a False Positive to spare feelings.
- Never inflate severity beyond what the evidence supports.
- Never skip the chain analysis because a finding "seems complete".

## Related
- Uses `debate-review` methodology adapted from https://github.com/amElnagdy/review-skills.
- Feeds `pal-router` for model dispatch.

## The rule
> Delegate the prose, never the evidence.
