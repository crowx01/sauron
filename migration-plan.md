# Sauron Rebuild: Phased Migration Plan

## Overview
This migration plan details the step-by-step transformation of Sauron from its legacy Python architecture to the rebuilt TypeScript/Bun application with OpenCode TUI integration.

---

## Phase Summary

```
+-----------------------------------------------------------------------+
| Phase 0: Baseline & Recovery Checkpoint                               |
|   - Created backup branch 'backup/pre-migration-checkpoint'           |
|   - Recorded baseline 1347+ passing unit test results                 |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
| Phase 1: Independent Review & Architecture Decision                   |
|   - Conducted 4-round debate with local Claude Code CLI               |
|   - Authored architecture-decision.md and claude-debate.md            |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
| Phase 2: Core Domain & Service Porting (src/)                         |
|   - Port Configuration, Custom Models, and Provider Schemas           |
|   - Port Multi-Provider Streaming Adapters                            |
|   - Port Router, Fallback Chains, Intelligence Catalog & Rate Limit   |
|   - Port ToolBelt (bash, read_file, write_file, web_fetch, secsuite)  |
|   - Port Session Store & Persistent Memory                            |
|   - Port Mission Pipeline (writer -> executor -> judge)               |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
| Phase 3: OpenCode TUI Integration & Robust Prompt Panel               |
|   - Implement OpenCode TUI adapter & layout components                |
|   - Wrap PromptPanel in strict ErrorBoundary                            |
|   - Implement stream renderer, tool execution indicators & history   |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
| Phase 4: CLI Entry Point & Python Removal                             |
|   - Update bin/cli.js and src/cli.ts for zero-Python execution       |
|   - Ensure direct Bun invocation for all CLI verbs                    |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
| Phase 5: Testing, Validation & Error Audit Verification               |
|   - Run full bun test suite covering routing, tools, sessions, TUI    |
|   - Verify prompt panel resilience under simulated errors              |
|   - Generate error-audit.md, pending-changes.md, and final report      |
+-----------------------------------------------------------------------+
```

---

## Phase Details & Exit Criteria

### Phase 0: Baseline & Recovery Checkpoint
- **Tasks**:
  - Verify git status and create backup branch `backup/pre-migration-checkpoint`.
  - Execute baseline python tests (`1347 passed`).
- **Exit Criteria**: Pre-migration state is fully recoverable via branch.

### Phase 1: Architecture & Review
- **Tasks**:
  - Run multi-round debate with Claude Code.
  - Formulate ADR (`architecture-decision.md`) and debate log (`claude-debate.md`).
- **Exit Criteria**: Target architecture signed off.

### Phase 2: Core Domain Services
- **Tasks**:
  - Scaffold TypeScript project in `src/`.
  - Implement `src/config/`, `src/providers/`, `src/router/`, `src/tools/`, `src/session/`, `src/mission/`.
- **Exit Criteria**: All domain capabilities compiled and unit-tested in Bun.

### Phase 3: OpenCode TUI Integration
- **Tasks**:
  - Implement `src/tui/` with PromptPanel, TranscriptView, ModelPicker, StatusHeader, NotificationOverlay.
  - Implement top-level process signal handlers for terminal restoration.
- **Exit Criteria**: TUI renders, streams, handles input, and recovers gracefully from errors.

### Phase 4: CLI & Python Elimination
- **Tasks**:
  - Rebind `bin/cli.js` to launch Bun directly with `src/cli.ts`.
  - Remove Python dispatches.
- **Exit Criteria**: Zero production Python subprocess calls during CLI operations.

### Phase 5: Validation & Final Deliverables
- **Tasks**:
  - Execute test suite (`bun test`).
  - Generate `error-audit.md`, `pending-changes.md`, updated `README.md`.
- **Exit Criteria**: All deliverables present and verified.
