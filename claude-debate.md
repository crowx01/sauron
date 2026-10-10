# Sauron Rebuild: Claude Code Architectural Debate & Review Record

## Executive Summary
This document records the four-round architectural debate conducted with local **Claude Code CLI** (v2.1.296) on Kali Linux regarding the complete rebuild of the Sauron offensive-security AI orchestrator. The rebuild mandates replacing the legacy Python application and prompt_toolkit terminal interface with a modern, maintainable non-Python stack (TypeScript/Bun) and integrating the OpenCode terminal UI (TUI) architecture.

---

## Round 1: Independent Architecture Proposal

### Context & Goals Presented
- **Legacy Architecture**: Python engine (`./core`) launched via Node.js bridge (`bin/cli.js`), prompt_toolkit/rich REPL (`chat_repl.py`).
- **Target Goals**:
  1. Replace Sauron's terminal UI/UX with the OpenCode TUI architecture (TypeScript, Bun, OpenTUI / SolidJS TSX).
  2. Migrate the core application from Python to a non-Python stack (TypeScript/Bun).
  3. Preserve multi-provider routing (OpenAI, Anthropic, Gemini, OpenRouter, Cohere, xAI, Azure), toolbelt (`bash`, `read_file`, `write_file`, `web_fetch`, `gh`, `secsuite`, MCP), mission execution, session persistence, and shared context.

### Claude Code Proposal & Recommendations
1. **Language & Runtime**: **TypeScript on Bun**.
   - OpenCode's TUI is TypeScript-native; staying in TS allows direct architectural adaptation without cross-language wrapper latency or dual maintenance.
   - Bun provides instant startup, native test execution, high-performance child process execution (`Bun.spawn`), and single-toolchain execution.
   - Eliminates the fragile Node-launcher to Python-backend IPC process boundary.
2. **UI Integration Strategy**:
   - Adapt OpenCode's TUI component and rendering layer.
   - Create a clean **TUI Adapter** owning the render loop, alternate-screen enter/exit, and terminal resize handlers.
   - Expose a clean event-driven interface (`renderStream`, `renderToolCall`, `onSubmit`, `onInterrupt`) separating rendering from backend domain logic.
3. **Service Boundaries**:
   - **Provider Router**: Normalizes multi-provider API calls (OpenAI, Anthropic, Gemini, OpenRouter, Cohere, xAI, Azure) into a unified async streaming interface.
   - **Tool Execution Engine**: Handles `bash`, `read_file`, `write_file`, `web_fetch`, `gh`, `secsuite`, and MCP tools with explicit permission boundaries.
   - **Session & Memory Store**: Manages persistent conversation history, context windows, and stored lessons using structured JSON / SQLite files.
   - **Mission Pipeline**: Adaptive writer-executor-judge workflow supporting headless and interactive mission execution.
   - **TUI Adapter**: Decoupled presentation layer subscribing to application events.
4. **Key Risks Identified**:
   - **Streaming Jank**: Buffering chunks instead of applying incremental diffs.
   - **Alt-Screen & Prompt Disappearance**: Toggling terminal raw mode in multiple places without clean exception bounds.
   - **Subprocess Signal Handling**: Process leaks or zombie bash processes when interrupting running tool calls via Ctrl+C.

---

## Round 2: Adversarial Review & Risk Analysis

### Challenging the Preferred Design
In Round 2, we challenged TypeScript/Bun against Go and Rust, and inspected native terminal integration risks.

### Findings & Objections
1. **Go / Rust vs. TypeScript/Bun**:
   - **Go/Rust Pros**: Single static CGO-free binary, low memory footprint (~10-20MB vs ~50-100MB), simple signal/process group management (`Setpgid`).
   - **Go/Rust Cons**: Reimplementing OpenCode's TypeScript/SolidJS component model in Go (Bubble Tea) or Rust (Ratel) requires re-authoring the full layout engine from scratch.
   - **Decision Verdict**: TypeScript/Bun remains the optimal target because UI adaptation requires maintaining a single language ecosystem.
2. **Native OpenTUI & Terminal Escape Pitfalls**:
   - Terminal capabilities (Kitty keyboard protocol, bracketed paste, mouse SGR mode) differ across qterminal, xterm, tmux, and SSH.
   - `COLORTERM=truecolor` is required for rich rendering.
   - Uncaught errors during render cycles leave terminal raw mode corrupted unless a top-level cleanup handler traps `SIGINT`, `SIGTERM`, and `uncaughtException`.
3. **Preventing Hybrid / Dual UI Debt**:
   - Establish a hard seam: The TS CLI (`src/cli.ts`) completely replaces `bin/cli.js` and eliminates Python sub-process dispatches.
   - Feature parity verification checklist prior to deleting Python files.

---

## Round 3: Evidence & Feasibility Verification

### Empirical System Verification
- **Bun Availability**: Confirmed Bun `v1.4.3` installed at `/home/kali/.bun/bin/bun`.
- **Python Baseline Test Results**: Verified 1347+ unit tests pass inside `core/`.
- **Root Cause Analysis of Legacy UI Failures**:
  - Investigated `chat_repl.py` and commit history (`b7f4670`, `df4a064`, `7189b36`).
  - **Verified Root Cause**: Uncaught exceptions during streaming or HTTP errors (e.g. HTTP 404 from unroutable endpoints) escaped into the `prompt_toolkit` render callback and `patch_stdout` context manager, destroying the active prompt buffer and corrupting terminal cursor lines.

### Preservation vs. Removal Plan
- **Preserve (Port logic & tests to TS)**: Provider routing rules, fallback chains, rate limiting, size guards, mission writer-executor-judge pipeline, toolbelt implementations (`bash`, `read_file`, `write_file`, `web_fetch`, `gh`, `secsuite`), session persistence schemas.
- **Remove**: Legacy `chat_repl.py`, Python venv launcher code in `bin/cli.js`, `.sauron_venv`, and Python runtime dependencies from production execution path.

---

## Round 4: Final Design Agreement & Dissent

### Summary of Final Consensus
1. **Language & Runtime**: TypeScript (ES2022 / ESNext modules) on Bun 1.4+.
2. **Terminal UI**: OpenCode-derived TSX component model on OpenTUI / terminal layout primitives, featuring an isolated ErrorBoundary around the PromptPanel to guarantee the input editor never disappears on recoverable errors.
3. **Module Structure**: `src/cli.ts`, `src/tui/`, `src/router/`, `src/providers/`, `src/tools/`, `src/session/`, `src/mission/`, `src/config/`.
4. **100% Python Elimination from Production**: Production CLI execution path contains zero Python calls.

### Architecture Sign-Off
- **Status**: **APPROVED & SIGNED OFF**
- **Condition 1**: Comprehensive unit & integration test coverage in Bun matching legacy test specs.
- **Condition 2**: Top-level signal handlers (`SIGINT`, `SIGTERM`, `uncaughtException`) to guarantee terminal restoration.
- **Condition 3**: Deterministic CLI entry point in `bin/cli.js` forwarding directly to Bun.

---

## Round 5: Agentic Logic & Reasoning Deep-Dive (Claude CLI Review)

### Context & Consultation
Following full TUI and runtime porting, a dedicated consultation was executed with the local Kali Linux `claude` CLI (v2.1.296) focused purely on algorithmic and agentic reasoning logic across four core modules:
1. `src/agent/react.ts` (Autonomous ReAct tool execution loop)
2. `src/mission/index.ts` (Writer $\rightarrow$ Executor $\rightarrow$ Judge mission pipeline)
3. `src/agent/debate.ts` (Multi-model debate engine)
4. `src/router/lessons.ts` (Routing intelligence & lesson store)

### Claude CLI Critique & Findings
1. **`src/mission/index.ts` (Confirmed Critical Flaw)**:
   - Claude identified that the Executor stage previously hardcoded `uname -a && id` regardless of `goalText`. The Planner was a static template string, the Judge checked only output length $>10$, and retry attempts repeated the identical command without consuming critique.
   - *Verdict*: The pipeline was a static stub rather than an adaptive cognitive workflow.
2. **`src/agent/react.ts` (Injection & Loop Weaknesses)**:
   - Tool argument parsing failed on markdown code blocks (````json ... ````).
   - Sanitization regex only stripped `<tool_call>` / `<final>`, failing to protect against injected `<tool_result>` or prompt override directives inside untrusted execution outputs.
   - Loop detection was vulnerable to stalling if calls repeated indefinitely.
3. **`src/agent/debate.ts` (Synthesis Stubs)**:
   - Consensus and dissent were static template strings rather than synthesized from model perspectives.
   - Model selection picked arbitrary catalog slots without checking provider availability.
4. **`src/router/lessons.ts` (Closed-Loop Missing)**:
   - The lesson store functioned merely as a logger; stats were never fed back into `ChatRouter` selection.
   - Direct file overwrites risked corruption; lack of `clear()` caused cross-test pollution.

### Implemented Solutions & Resolutions
1. **Dynamic Mission Pipeline**:
   - `Planner`: Analyzes `goalText` to dynamically derive actionable tool plans, argument payloads, and expected ground-truth keywords.
   - `Executor`: Executes target tools dynamically (`id`, `ip addr`, `uname -a`, etc.) capturing outputs and exit states.
   - `Judge`: Evaluates output evidence against goal keywords, scoring and output validity.
   - `Adaptive Retry`: Feeds `currentCritique` directly into subsequent execution attempts.
2. **Hardened ReAct Loop & Injection Defense**:
   - Strips code blocks and safely parses tool arguments.
   - Sanitizes XML tags via `sanitizeToolOutput` and wraps outputs in `<untrusted_tool_output>` blocks.
   - System prompt explicitly enforces untrusted data boundaries.
   - Loop stagnation threshold halts after 3 repetitive calls.
3. **Dynamic Multi-Model Debate**:
   - Prioritizes active real providers.
   - Synthesizes consensus and dissent dynamically from actual response bodies.
   - Handles unilateral analysis and provider failure states cleanly.
4. **Adaptive Routing Closed-Loop**:
   - Implemented `getBias()` computing adaptive weights from historical success rates and latencies.
   - `ChatRouter.route` scores candidates using intelligence $\times$ bias.
   - `ChatRouter.dispatch` records every outcome back to `lessonStore`.
   - Added atomic persistence (`.tmp` + rename, `0o600`), validation on load, and `clear()`.

### Verification Outcome
- 100% pass rate across 71 tests in 6 test suites (`adversarial`, `agentic_logic`, `e2e_cli`, `engine`, `scenarios`, `stress_and_lifecycle`).

---

## Round 6: Defensive Terminal Sandboxing & Long-Horizon Context Compaction (Claude CLI Review)

### Context & Consultation
In Round 6, we consulted the local Kali Linux `claude` CLI on defensive software engineering, terminal escape injection, and long-horizon session memory across:
1. `src/tools/index.ts` & `src/agent/react.ts` (Terminal escape defense & ANSI stripping)
2. `src/session/index.ts` (Context compaction & structured fact extraction)
3. `src/tui/screen.ts` & `src/tui/engine.ts` (Terminal crash recovery & signal coordination)

### Claude CLI Findings & Recommendations
1. **Terminal Escape Code Injection (Highest Severity)**:
   - Tool stdout previously flowed into session history and directly into `TranscriptComponent` without ANSI stripping.
   - Attackers or target outputs could inject OSC 52 (`\x1b]52;...`) clipboard write sequences, alt-screen toggles (`\x1b[?1049h`), title-bar rewrites, or cursor manipulations to compromise the terminal emulator.
   - *Recommendation*: Add regex-based ANSI/OSC stripping and apply it in `sanitizeToolOutput` and defensively at render time in TUI components.
2. **Context Compaction & Session Memory**:
   - Compaction previously replaced turns with a static placeholder, permanently deleting file paths, discovered credentials, and IP addresses.
   - It was also dead code uninvoked on the hot path.
   - *Recommendation*: Wire compaction into user message handling, extract structured facts (artifacts, IPs, executed tools), and preserve full history in sidecar `.archive.jsonl` files.
3. **Terminal Crash & Signal Safety**:
   - Absence of `uncaughtException` and `unhandledRejection` handlers risked leaving raw mode stdin and hidden cursors intact during unhandled errors.
   - Process-level `SIGINT` raced with `readline`'s `SIGINT` listener on in-flight requests.
   - *Recommendation*: Install panic handlers restoring alternate screen on unhandled exceptions and coordinate interrupt handlers between engine and screen.

### Implemented Solutions & Resolutions
1. **ANSI / OSC Injection Neutralization**:
   - Implemented `stripAnsi()` stripping OSC 52, CSI control codes, alt-screen escapes, and control characters.
   - Integrated into `sanitizeToolOutput()` in `src/agent/react.ts` and defensively into `TranscriptComponent` and `ToolCardComponent` in `src/tui/components.ts`.
2. **Structured Fact Compaction & Archiving**:
   - Refactored `sessionStore.compactContext()` to extract network entities (IPs), target artifacts (filesystem paths), and tool call records.
   - Appended older messages to `${sessionId}.archive.jsonl` for lossless preservation.
   - Wired compaction trigger into `InteractiveTUIEngine.handleUserMessage()` when history crosses token boundaries.
3. **Terminal Panic Handlers & Signal Coordination**:
   - Added `uncaughtException` and `unhandledRejection` traps restoring the alternate screen buffer and raw mode.
   - Added `terminalScreen.setInterruptHandler()` enabling in-flight query cancellation without process termination races.
4. **Automated Verification**:
   - Added `L6` (ANSI / OSC 52 neutralization) and `L7` (Structured fact extraction & JSONL archive) test cases.
   - All 73 tests across 6 files pass cleanly (100% pass rate).

---

## Round 7: Deep Logic Refining & Cognitive Hardening (Claude CLI Review)

### Context & Consultation
In Round 7, we engaged the local Kali Linux `claude` CLI for an adversarial audit of core reasoning algorithms, loop control flows, error taxonomies, and Judge scoring rubrics across:
1. `src/agent/react.ts` (ReAct multi-tool execution, exit codes, and self-correction feedback)
2. `src/mission/index.ts` (30/40/30 scoring rubric, shell interpolation defense, and retry purity)
3. `src/router/lessons.ts` (Error classification taxonomy, rate-limit cooldowns, and recency decay)

### Claude CLI Findings & Resolutions
1. **ReAct Self-Correction & Loop Mechanics (`react.ts`)**:
   - *Bug*: Tool results previously omitted `exitCode` and `status`, preventing models from knowing whether a tool succeeded.
   - *Bug*: Loop halt threshold ($\ge 3$) was unreachable because loop warnings skipped updating the signature history.
   - *Bug*: Malformed JSON arguments silently passed raw text to tools rather than returning structured syntax feedback.
   - *Resolution*: Surfaced `<tool_result name="..." status="ok|error" exit_code="N">`, added sequential multi-tool execution (capped at 4 per turn), fed back `[Invalid JSON Arguments]` syntax errors, and enabled reachable loop termination.
2. **Mission Pipeline Hardening & Scoring Rubric (`mission/index.ts`)**:
   - *Bug*: Retries previously appended `|| whoami`, causing failing commands to generate false PASS verdicts.
   - *Bug*: Default plans interpolated the user goal into `echo "Objective: ${goal}"`, risking shell command injection.
   - *Resolution*: Eliminated shell string interpolation and removed `|| whoami` hacks. Implemented a 30/40/30 Judge rubric: Exit status (30 pts, hard gate), Evidence relevance (40 pts, hard gate), and Completeness (30 pts), requiring $\ge 75$ with hard gates satisfied for PASS verdicts.
3. **Adaptive Routing Cooldowns & Error Taxonomy (`lessons.ts`)**:
   - *Bug*: Bias calculation previously checked `model === m || provider === p`, allowing a single failing model to poison sibling models on the same provider.
   - *Bug*: Transient rate limits (HTTP 429) permanently depressed model bias without recovery mechanisms.
   - *Resolution*: Implemented `classifyError()` categorizing failures into `rate_limit`, `transient`, `persistent`, and `request`. Added exponential backoff cooldowns (`isCooledDown`) that prioritize probe requests upon recovery and clear strikes upon success. Added a 30-minute recency decay to bias calculations.

### Automated Verification
- Added `L8` (Rate-limit cooldown & dynamic backoff) and `L9` (30/40/30 Mission Judge rubric) test cases.
- 100% pass rate across 75 tests in 6 test files (`adversarial`, `agentic_logic`, `e2e_cli`, `engine`, `scenarios`, `stress_and_lifecycle`).

---

## Round 8: Autonomous Intelligence, Self-Healing Mutation & Dynamic DAG Planning

### Context & Debate
In Round 8, we conducted an adversarial architectural review with local **Claude Code CLI** (v2.1.296) and Sauron models focused on advancing Sauron's autonomy from reactive command execution to self-directed, independent intelligence across three pillars:
1. **Playbook Distillation & Semantic Recall (`src/agent/playbooks.ts`)**
2. **Self-Healing Capability & Command Mutation (`src/agent/resolver.ts`)**
3. **Goal Decomposition via Dynamic DAG Planner (`src/agent/planner.ts`)**

### Claude CLI Findings & Structural Review
1. **Knowledge Distillation vs Static Scripts**:
   - Claude highlighted that hardcoded exploits or static recon templates fail across differing targets. True autonomy requires Sauron to distill structured, parameterized playbooks (`{{target_host}}`, `{{port_range}}`, `{{user_name}}`) directly from successful execution traces and recall them semantically.
2. **Command Brittleness & Capability Resolution**:
   - Commands routinely fail with exit code 127 ("command not found") due to distro tool variations (e.g., `ip addr` missing on legacy Linux, `ss` missing, `ps aux` flags incompatible).
   - *Resolution*: Implement a capability-oriented `ToolResolver` that transparently mutates commands upon exit code 127 and persists newly learned mutations to `~/.sauron/resolutions.json`.
3. **DAG Planning & Dynamic Finding Propagation**:
   - Flat linear plans collapse when intermediate discoveries alter subsequent actions. Missions must be modeled as Directed Acyclic Graphs (DAGs) structured into Recon $\rightarrow$ Inspect $\rightarrow$ Verify stages with topological scheduling.
   - Outputs from early stages (e.g. discovering a specific user or network interface) must automatically propagate into parameter slots of downstream nodes.

### Implemented Architecture
- `src/agent/playbooks.ts`: Full `PlaybookStore` with seed tactics (`pb_host_recon`, `pb_priv_audit`, `pb_network_discovery`), trace distillation, variable binding interpolation, and empirical success rate tracking.
- `src/agent/resolver.ts`: `ToolResolver` with pre-configured alternative chains (`ps`, `ip`, `ss`, `curl`, `netcat`), regex-based auto-mutation upon code 127, and persistent resolution learning.
- `src/agent/planner.ts`: `DAGPlanner` structuring complex goals into DAG nodes, extracting findings (`uid`, `user`, `ip`, `arch`, `os`), dynamically resolving template variables, and determining `nextRunnable` nodes.
- Integrated into `src/tools/index.ts` (auto-mutation on code 127) and `src/mission/index.ts` (trace distillation on mission pass).

### Automated Verification
- Added `tests/intelligence_and_dag.test.ts` (Tests I1–I8) validating playbook recall, distillation, mutation, DAG decomposition, and finding propagation.
- Total verification status: **83 pass, 0 fail, 2760 expect() calls across 7 test suites**.




