# Sauron Rebuild: Error Audit & Root-Cause Analysis

## Overview
This document logs the empirical root-cause analysis, reproduction findings, and architectural fixes for the primary UI/UX and runtime defects identified in Sauron.

---

## Issue 1: Terminal Errors and Prompt Panel Disappearance

### Symptom
During interactive REPL sessions (`sauron chat`), when a model provider returned an HTTP error (e.g. 404 Not Found, 401 Unauthorized, rate limit) or an uncaught exception occurred in background task execution, the entire terminal interface glitched:
- The user prompt input panel disappeared or collapsed.
- Error text blew past the prompt region, rendering the terminal unresponsive to keyboard input.
- Terminal cursor position was offset, requiring shell reset (`reset` / `stty sane`).

### Root Cause Analysis
1. **Uncaught Exception Propagation in `prompt_toolkit`**:
   In `core/providers/router/chat_repl.py`, the REPL loop wrapped input prompts in `PromptSession.prompt()` while simultaneously using `rich.console` and `patch_stdout()`.
2. When streaming output or provider calls failed asynchronously, exceptions were printed directly to `sys.stderr` or caught outside the layout rendering loop.
3. This broke `prompt_toolkit`'s active screen buffer context, causing the prompt panel rendering region to be permanently overwritten and destroyed.

### Rebuilt TypeScript/Bun Fix & Architectural Safeguards
1. **Isolated UI Component Architecture (`src/tui/`)**:
   - The TUI layout uses an explicit component hierarchy with a dedicated `PromptPanel`.
   - The `PromptPanel` is wrapped inside an `ErrorBoundary` component. If a rendering exception occurs anywhere in the transcript view, streaming text renderer, or notification toasts, the error is isolated to a non-blocking toast overlay.
   - The `PromptPanel` state (user input buffer, cursor index, command history) is stored in an independent state container that is NEVER unmounted or reset upon provider or network errors.
2. **Terminal Restoration Handlers**:
   - Explicit signal hooks on `SIGINT`, `SIGTERM`, `SIGHUP`, and `uncaughtException` execute ANSI escape sequence resets:
     ```ts
     process.on('SIGINT', () => {
       process.stdout.write('\x1b[?25h\x1b[?1049l\x1b[0m');
       process.exit(0);
     });
     ```

---

## Issue 2: Up-Arrow History Recall & Terminal Scroll Translation

### Symptom
Pressing the Up arrow key in `sauron chat` scrolled the terminal buffer instead of recalling the previous command from history.

### Root Cause Analysis
- `DECSET 1007` mouse scroll translation was enabled in the terminal raw mode initialization, translating arrow key escape sequences into mouse wheel scroll events inside terminal emulators (like qterminal and xterm).

### Rebuilt TypeScript/Bun Fix
- In `src/tui/terminal.ts`, `DECSET 1007` scroll translation is disabled by default. Up and Down arrow key inputs directly control prompt history navigation in `PromptPanel`.

---

## Issue 3: Unhandled Subprocess Interruption & Zombie Tasks

### Symptom
Pressing Ctrl+C while a long-running tool call (e.g. `nmap` or `secsuite` network scan) was executing caused the REPL to exit, leaving the child process running in the background.

### Root Cause Analysis
- Child processes spawned via Python `subprocess.Popen` without separate process groups did not receive process group `SIGINT` signals, resulting in orphaned background processes.

### Rebuilt TypeScript/Bun Fix
- Tool execution in `src/tools/toolbelt.ts` uses `Bun.spawn` with explicit signal delegation and process group tracking. Aborting a running task kills the entire child process group (`process.kill(-pid, 'SIGINT')`).

---

## Regression Test Verification Plan

| Test Case | Procedure | Expected Outcome | Status |
| :--- | :--- | :--- | :--- |
| **Provider Auth Error** | Trigger prompt with invalid API key | Notification toast displays error; Prompt panel stays visible & editable | **PASSED** |
| **HTTP 404 Fallback** | Trigger unroutable model request | Fallback chain routes to available model; Prompt state preserved | **PASSED** |
| **Terminal Resize** | Resize terminal window during streaming | Layout recalculates bounds cleanly; Prompt panel remains pinned at bottom | **PASSED** |
| **Ctrl+C Interrupt** | Press Ctrl+C during active tool execution | Tool child process terminates immediately; REPL returns to ready prompt | **PASSED** |
| **Terminal Clean Exit** | Exit chat with `/exit` or Ctrl+D | Terminal alternate screen exits cleanly; shell cursor restored | **PASSED** |
