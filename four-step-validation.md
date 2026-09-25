# The 4-Step Validation Pipeline

Every new confirmed finding runs through this loop before it is presented or reported. The pipeline is asserted by the `UserPromptSubmit` hook on every message so it does not drift as sessions grow long.

## Step A. Validator stress-test

Invoke the `validator` skill, a skeptical senior QA reviewer. It returns twelve output fields: Confidence Score, False Positive Risk, Exploitability, Impact, Missing Evidence, Missing Tests, Suggested Attack Chains, Suggested Manual Verification, Suggested Automation, Suggested Report Improvements, Suggested Severity, and Final Verdict.

If the verdict is anything other than Confirmed or Likely Valid, the pipeline pauses and gaps are addressed before continuing.

## Step B. Gap-test execution

Run every missing test, negative control, and live observation the validator flagged, using your own tools. No shortcuts. Respect the no-third-party-data rule: proof stays at the "HTTP 200 + response structure" level unless the target explicitly is your own.

Byte-exact evidence goes into the finding directory alongside the raw request/response captures. If a gap cannot be closed without crossing a safety boundary (unauthorized data touch, destructive action, account creation under your identity), stop and mark the gap explicitly in the report.

## Step C. Adversarial debate

Route the finding to `mcp__pal__challenge` (or `mcp__pal__consensus`) with `pro` (Gemini 3 Pro) as the primary debater and `groq` as the fallback. Frame the debate adversarially: challenge the severity rating, the exploitability under realistic attacker preconditions, chain viability toward higher impact, and the impact ceiling on this specific target.

The goal is not to win the debate but to surface hidden assumptions before a triager does.

## Step D. Synthesize and write

Combine the validator output, the gap-closing evidence, and the debate transcript into a final finding. Delegate the prose write-up to `groq` per the delegate-first rule. Then a human (or agent acting as reviewer) verifies that every technical string in the draft, including hostnames, URLs, tokens, CVSS vectors, CWE IDs, and file paths, matches the raw evidence byte-for-byte.

Only after that byte-exact check does the report leave the desk.

---

> Delegate the prose, never the evidence.
