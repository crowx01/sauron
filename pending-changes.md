# Sauron Rebuild: Pending Changes & Inventory Log

## Summary of Rebuild
This log documents all file changes, additions, modifications, and removals performed during the OpenCode TUI migration, TypeScript/Bun application rebuild, and cognitive agentic reasoning overhaul.

---

## Deliverables Created
1. `architecture-decision.md`: ADR-001 documenting language choice (TypeScript/Bun), candidate comparisons, OpenCode TUI integration strategy, and service boundaries.
2. `claude-debate.md`: Comprehensive 8-round architectural debate transcript with local Claude Code CLI (`claude` v2.1.296) covering runtime migration, terminal safety, ANSI injection defense, ReAct loops, 30/40/30 rubric, and autonomous DAG planning.
3. `migration-plan.md`: Phased migration roadmap (Phases 0–5) with exit criteria.
4. `error-audit.md`: Root-cause investigation and reproduction log for terminal prompt panel disappearance and exception handling fixes.
5. `pending-changes.md`: Inventory of all added, modified, migrated, and removed repository files.
6. `README.md`: Updated comprehensive documentation covering prerequisites, architecture, installation, startup, testing, and troubleshooting.

---

## Source Code & Infrastructure Changes (`src/`, `bin/`, `tests/`)

| File Path | Status | Purpose / Description |
| :--- | :--- | :--- |
| `package.json` | **Modified** | Updated engine settings for Bun (>=1.0.0), ES modules (`"type": "module"`), TS scripts, and devDependencies. |
| `tsconfig.json` | **Added** | Strict ESNext bundler configuration targeting Bun runtime. |
| `bin/cli.js` | **Modified** | Updated CLI launcher to dispatch engine subcommands directly into Bun (`src/cli.ts`), completely removing Python dispatches. |
| `src/types/index.ts` | **Added** | Core domain interfaces (`Message`, `ToolCall`, `ModelEntry`, `RouterOptions`, `StreamChunk`, `Session`, `MissionReport`, `Playbook`, `Resolution`, `DAGPlan`). |
| `src/config/index.ts` | **Added** | System settings, custom model loading, and environment API key resolution (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, etc.). |
| `src/providers/index.ts` | **Added** | Async streaming provider adapters for OpenAI, Anthropic, Gemini, OpenRouter, Cohere, xAI, Azure, and Mock provider. |
| `src/router/index.ts` | **Added** | Intelligence catalog, automatic model routing, fallback chain dispatching, closed-loop bias scoring, and rate limit handling. |
| `src/router/lessons.ts` | **Added** | Dynamic lesson store with error classification (`classifyError`), rate-limit cooldowns (`isCooledDown`), recency decay, and atomic persistence. |
| `src/tools/index.ts` | **Added** | ToolBelt execution engine (`bash`, `read_file`, `write_file`, `web_fetch`, `secsuite`) with timeout, child process group cleanup, 1MB output cap, SSRF guards, and ToolResolver auto-mutation. |
| `src/session/index.ts` | **Added** | Persistent session storage (`~/.sauron/sessions/`), atomic writes, path traversal checks, structured fact context compaction, and JSONL archive sidecars. |
| `src/mission/index.ts` | **Added** | Hardened 3-phase Writer -> Executor -> Judge mission pipeline with 30/40/30 scoring rubric (Exit status 30, Relevance 40, Completeness 30) and Playbook distillation. |
| `src/agent/react.ts` | **Added** | Autonomous ReAct loop with multi-tool execution (cap 4), exit codes, JSON syntax feedback, prompt injection defense, `<untrusted_tool_output>` boundaries, and 3-repeat stagnation halts. |
| `src/agent/debate.ts` | **Added** | Dynamic multi-model debate engine querying candidate perspectives in parallel and synthesizing consensus and dissent. |
| `src/agent/playbooks.ts` | **Added** | PlaybookStore with tactical knowledge distillation, parameterized template instantiation (`{{var}}`), and semantic goal recall. |
| `src/agent/resolver.ts` | **Added** | ToolResolver providing capability-based command alternatives, auto-mutation on exit code 127 / command not found, and learned persistence in `~/.sauron/resolutions.json`. |
| `src/agent/planner.ts` | **Added** | Dynamic DAGPlanner decomposing non-trivial goals into Recon $\rightarrow$ Inspect $\rightarrow$ Verify nodes, topological scheduling, and dynamic finding propagation. |
| `src/tui/screen.ts` | **Added** | Terminal screen primitive managing raw mode, alternate screen buffer, synchronized output (`\x1b[?2026h`), panic recovery traps, and coordinated interrupts. |
| `src/tui/components.ts` | **Added** | OpenCode-styled components (`Header`, `Transcript`, `Prompt`, `ToolCard`, `StatusLine`) with defense-in-depth ANSI/OSC stripping. |
| `src/tui/engine.ts` | **Added** | Full interactive TUI engine with isolated Prompt ErrorBoundary, dynamic viewport bounds calculation, and context compaction triggers. |
| `src/tui/index.ts` | **Added** | High-level TUI entry point integrating screen, engine, and top-level process signal handlers. |
| `src/cli.ts` | **Added** | Main TypeScript CLI router handling `chat`, `run`, `mission`, `diag`, `models`, `sessions`, `debate`, `distill`, `selftest`. |
| `tests/adversarial.test.ts` | **Added** | 39 stress and adversarial tests (50 concurrent streams, process group kills, 1MB output flood, argument fuzzing, SSRF blocking). |
| `tests/agentic_logic.test.ts` | **Added** | 9 logic and security tests (L1–L9) covering ReAct loop, injection defense, 30/40/30 rubric, rate-limit cooldowns, ANSI stripping, and compaction. |
| `tests/intelligence_and_dag.test.ts` | **Added** | 8 cognitive autonomy tests (I1–I8) covering PlaybookStore recall, trace distillation, parameter templating, ToolResolver auto-mutation, and DAG planning. |
| `tests/e2e_cli.test.ts` | **Added** | 7 CLI end-to-end command tests (`diag`, `models`, `sessions`, `mission`, `run`, `debate`, `selftest`). |
| `tests/scenarios.test.ts` | **Added** | 8 comprehensive scenarios covering streaming, fact memory, tool execution, model switching, fallback chains, missions, multiline layout, and compaction. |
| `tests/stress_and_lifecycle.test.ts` | **Added** | 7 stress and lifecycle tests (corrupt session quarantine, path traversal, 1MB cap, SSRF, rapid writes). |
| `tests/engine.test.ts` | **Added** | 5 core engine tests exercising ChatRouter, ToolBelt, SessionStore, MissionRunner, and streaming. |

---

## Python Code Retirement Status
- Legacy Python application files in `core/` are retained strictly as non-blocking migration reference artifacts and will not be invoked in production.
- Production CLI entry point (`bin/cli.js`) launches the TypeScript/Bun runtime directly (`src/cli.ts`) with zero Python processes spawned.
- Backup branch `backup/pre-migration-checkpoint` contains the exact pre-migration git checkpoint.

---

## Verification Summary
- **Bun Automated Test Suites**: **83 pass, 0 fail, 2760 expect() calls across 7 test files** (`bun test`).
- **CLI Commands Verified**: `sauron diag`, `sauron models`, `sauron run`, `sauron mission`, `sauron debate`, `sauron sessions`, `sauron selftest`.
- **Zero Python Invocations**: Verified 0 Python processes spawned during any production CLI execution.

