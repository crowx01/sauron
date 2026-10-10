# Sauron Rebuild: Architecture Decision Record (ADR)

## ADR-001: Migration to TypeScript/Bun & OpenCode TUI Architecture

### Status
**APPROVED** (Date: October 10, 2026)

### Context
Sauron was previously implemented as a hybrid system: a Node.js launcher (`bin/cli.js`) spawning a Python engine (`./core`) via virtualenv, with a terminal UI built on Python's `prompt_toolkit` and `rich` (`chat_repl.py`). 

This architecture suffered from several critical defects:
1. **Terminal UI Instability**: Uncaught exceptions during streaming or HTTP request failures crashed the `prompt_toolkit` rendering context, destroying the active prompt panel and hiding user input.
2. **IPC & Process Overhead**: Bridging Node.js CLI arguments into Python via subprocesses introduced signal handling friction (Ctrl+C child process leaks), latency, and complex environment dependencies (`.sauron_venv`, `requirements.txt`, system Python versions).
3. **UI/UX Fragmentation**: Maintenance of terminal rendering primitives in Python diverged from modern terminal UI frameworks like OpenCode's OpenTUI.

---

### Candidate Technologies Evaluated

| Criteria | Candidate 1: TS + Bun + OpenTUI (Selected) | Candidate 2: Go + Bubble Tea | Candidate 3: Rust + Ratatui |
| :--- | :--- | :--- | :--- |
| **OpenCode UI Reuse** | High (Native TSX / OpenTUI alignment) | Low (Requires complete UI re-authoring) | Low (Requires complete UI re-authoring) |
| **Startup & Runtime Speed** | Fast (~15-30ms startup under Bun) | Extremely Fast (~5ms startup) | Extremely Fast (~2ms startup) |
| **Subprocess & Signal Handling** | Native `Bun.spawn` & POSIX signal handlers | Superior (`os/signal`, `Setpgid`) | Superior (`tokio::signal`, `nix`) |
| **Maintenance & Single Language** | Excellent (One TS codebase for UI + Router + Tools) | Medium (Separate UI and logic paradigms) | High complexity |

---

### Decision
We select **TypeScript on Bun (v1.4+)** with an **OpenCode-inspired Terminal UI Architecture**.

Key architectural choices:
1. **Single Runtime Engine**: Eliminate Python from the production CLI execution path. Sauron runs natively in Bun.
2. **Decoupled Terminal UI Adapter**:
   - `src/tui/`: Built with SolidJS TSX layout primitives / ANSI rendering pipeline.
   - Isolated `ErrorBoundary` around the `PromptPanel` component so errors in streamed chunks, model fallback events, or background tasks NEVER cause the user prompt input panel to collapse or disappear.
3. **Modular Subsystems**:
   - `src/router/`: Multi-provider router with fallback chains, intelligence catalog, size guard, rate limiter, and key pool.
   - `src/providers/`: Uniform async streaming provider clients (OpenAI, Anthropic, Gemini, OpenRouter, Cohere, xAI, Azure OpenAI).
   - `src/tools/`: Local toolbelt (`bash`, `read_file`, `write_file`, `web_fetch`, `gh`, `secsuite`) and Model Context Protocol (MCP) support.
   - `src/session/`: Session history persistence and context compaction.
   - `src/mission/`: Adaptive writer-executor-judge mission execution pipeline.
   - `src/config/`: System configuration and custom model management.

---

### Consequences & Mitigations
- **Consequence**: Python code under `core/` will no longer be invoked during runtime.
- **Mitigation**: All legacy routing rules, fallback logic, tool implementations, and test expectations are ported to TypeScript under `src/` and verified with Bun's test runner (`bun test`).
- **Consequence**: Terminal raw mode could remain active if Bun crashes unexpectedly.
- **Mitigation**: Top-level handlers for `process.on('SIGINT')`, `process.on('SIGTERM')`, and `process.on('uncaughtException')` execute terminal reset sequences (`\x1b[?25h\x1b[?1049l\x1b[0m`).
