/**
 * SAURON v2.0 OPENCODE TERMINAL ENGINE
 * Full OpenCode Layout Engine: Split Panes, Modals, Themes & Synchronized Render Loop
 */

import { themeStore, fg, fgBg, bold, dim, padToWidth, visibleLen, ThemeTokens } from './themes';
import { keymapRegistry, cyclePromptMode } from './keymaps';
import { modalManager } from './modals';
import { SessionTabBar, SidebarPane, MessageCardRenderer, PromptComposer } from './views';
import { stripAnsi, highlightVisibleRange } from './components';
import { sessionStore } from '../session';
import { chatRouter } from '../router';
import { toolBelt } from '../tools';
import { Message, StreamChunk } from '../types';

export interface SlashCommandDef {
  cmd: string;
  usage: string;
  desc: string;
  badge: string;
}

export const ALL_SLASH_COMMANDS: SlashCommandDef[] = [
  { cmd: '/model', usage: '/model [name]', desc: 'Switch active AI model catalog picker', badge: 'MODEL' },
  { cmd: '/theme', usage: '/theme [name]', desc: 'Change TUI color theme palette (34 themes)', badge: 'THEME' },
  { cmd: '/sessions', usage: '/sessions [clear]', desc: 'Browse or clear all saved sessions', badge: 'SESSION' },
  { cmd: '/clear', usage: '/clear [all]', desc: 'Clear active session or all saved sessions', badge: 'CLEAR' },
  { cmd: '/compact', usage: '/compact', desc: 'Compact context memory & save JSONL archive', badge: 'COMPACT' },
  { cmd: '/palette', usage: '/palette', desc: 'Open fuzzy command palette dialog', badge: 'PALETTE' },
  { cmd: '/keys', usage: '/keys', desc: 'View keyboard shortcuts & leader bindings', badge: 'HELP' },
  { cmd: '/new', usage: '/new', desc: 'Start a fresh conversation session', badge: 'NEW' },
  { cmd: '/copy', usage: '/copy', desc: 'Copy last assistant message to system clipboard', badge: 'COPY' },
  { cmd: '/mouse', usage: '/mouse', desc: 'Toggle mouse tracking on/off (enables native selection)', badge: 'TOGGLE' },
  { cmd: '/quit', usage: '/quit', desc: 'Exit Sauron TUI cleanly', badge: 'EXIT' },
  { cmd: '/help', usage: '/help', desc: 'Show interactive help reference', badge: 'HELP' },
];

export class OpenCodeEngine {
  private width = 120;
  private height = 36;
  private isRaw = false;
  private promptBuffer = '';
  private cursorOffset = 0;
  private scrollOffset = 0;
  private historyIndex = -1;
  private promptHistory: string[] = [];
  private isBusy = false;
  /** Transient progress note from a provider that buffers its whole answer (e.g. antigravity's
   * agy CLI doesn't stream) -- surfaces "Waiting for Antigravity response (Ns)..." instead of a
   * frozen spinner with zero feedback. Read by views.ts's footer render; cleared on completion. */
  public busyStatusNote = '';
  private sidebarVisible = true;
  private slashSelectedIndex = 0;
  private mouseTrackingEnabled = true;
  private inBracketedPaste = false;
  private bracketedPasteBuffer = '';
  private isSelecting = false;
  private selection: { startCol: number; startRow: number; endCol: number; endRow: number } | null = null;
  private hasActiveSelection = false;
  private lastScreenRows: string[] = [];

  private tabBar = new SessionTabBar();
  private sidebar = new SidebarPane();
  private cardRenderer = new MessageCardRenderer();
  private composer = new PromptComposer();

  constructor() {
    this.updateDimensions();
  }

  private updateDimensions() {
    this.width = process.stdout.columns || 120;
    this.height = process.stdout.rows || 36;
  }

  public start() {
    if (this.isRaw) return;

    // Enter alternate screen buffer, enable SGR 1002/1006 mouse tracking, hide cursor, and enable bracketed paste mode (\x1b[?2004h)
    process.stdout.write('\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[?2004h');

    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');
      this.isRaw = true;
    }

    process.stdout.on('resize', () => {
      this.updateDimensions();
      this.render();
    });

    process.stdin.on('data', (data: Buffer | string) => {
      this.processRawInput(data.toString());
    });

    // Install panic traps
    process.on('uncaughtException', (err) => this.stop(err));
    process.on('unhandledRejection', (reason) => this.stop(reason));
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());

    this.render();
  }

  public stop(error?: any) {
    if (this.isRaw) {
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
      this.isRaw = false;
    }

    // Disable bracketed paste mode (\x1b[?2004l), disable mouse tracking, show cursor & leave alternate screen
    process.stdout.write('\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l');

    if (error) {
      console.error('\n[SAURON TUI PANIC RECOVERY]:', error);
      process.exit(1);
    }
    process.exit(0);
  }

  private toggleMouseTracking() {
    this.mouseTrackingEnabled = !this.mouseTrackingEnabled;
    if (this.mouseTrackingEnabled) {
      process.stdout.write('\x1b[?1002h\x1b[?1006h');
      this.notify('Mouse wheel scrolling & drag-selection enabled.');
    } else {
      process.stdout.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
      this.notify('Native mouse text selection enabled! (Mouse scroll disabled).');
    }
  }

  private copyLastAssistantMessage() {
    const activeSession = sessionStore.getActiveSession();
    const assistantMsgs = activeSession.messages.filter((m) => m.role === 'assistant');
    if (assistantMsgs.length === 0) {
      this.notify('No assistant message to copy.');
      return;
    }
    const lastMsg = assistantMsgs[assistantMsgs.length - 1].content;
    this.copyToClipboard(lastMsg);
    this.notify('Copied last assistant response to system clipboard!');
  }

  public copyToClipboard(text: string) {
    if (!text) return;
    // 1. Send OSC 52 clipboard escape sequence (both clipboard 'c' and primary 'p')
    try {
      const base64 = Buffer.from(text).toString('base64');
      process.stdout.write(`\x1b]52;c;${base64}\x07`);
      process.stdout.write(`\x1b]52;p;${base64}\x07`);
    } catch {}

    // 2. Try native OS clipboard utilities
    try {
      const { exec } = require('child_process');
      if (process.platform === 'linux') {
        const procClip = exec('xclip -selection clipboard 2>/dev/null || wl-copy 2>/dev/null || xsel --clipboard 2>/dev/null');
        procClip.stdin.write(text);
        procClip.stdin.end();
        const procPrim = exec('xclip -selection primary 2>/dev/null || xsel --primary 2>/dev/null');
        procPrim.stdin.write(text);
        procPrim.stdin.end();
      } else if (process.platform === 'darwin') {
        const proc = exec('pbcopy');
        proc.stdin.write(text);
        proc.stdin.end();
      }
    } catch {}
  }

  public extractSelectedText(
    start: { col: number; row: number },
    end: { col: number; row: number }
  ): string {
    let r1 = start.row;
    let c1 = start.col;
    let r2 = end.row;
    let c2 = end.col;

    if (r1 > r2 || (r1 === r2 && c1 > c2)) {
      const tr = r1; const tc = c1;
      r1 = r2; c1 = c2;
      r2 = tr; c2 = tc;
    }

    const lines: string[] = [];
    for (let r = r1; r <= r2; r++) {
      const idx = r - 1;
      if (idx < 0 || idx >= this.lastScreenRows.length) continue;
      const plain = stripAnsi(this.lastScreenRows[idx]);

      let slice = '';
      if (r1 === r2) {
        slice = plain.slice(Math.max(0, c1 - 1), Math.max(0, c2));
      } else if (r === r1) {
        slice = plain.slice(Math.max(0, c1 - 1));
      } else if (r === r2) {
        slice = plain.slice(0, Math.max(0, c2));
      } else {
        slice = plain;
      }

      lines.push(slice.trimEnd());
    }

    return lines.join('\n');
  }

  private handleSingleClick(col: number, row: number) {
    this.hasActiveSelection = false;
    this.selection = null;

    // Check if clicked in prompt composer input area
    const composerLines = this.composer.renderPrompt(
      this.promptBuffer,
      this.cursorOffset,
      this.width,
      this.isBusy,
      themeStore.getTheme()
    );
    const mainH = Math.max(3, this.height - 1 - composerLines.length);
    const promptBoxTopRow = 2 + mainH; // 1-indexed row of top border ┌───┐

    // Input lines are from promptBoxTopRow + 1
    const promptLines = this.promptBuffer.split('\n');
    const lineIndex = row - promptBoxTopRow - 1;

    if (lineIndex >= 0 && lineIndex < promptLines.length) {
      let offset = 0;
      for (let i = 0; i < lineIndex; i++) {
        offset += promptLines[i].length + 1;
      }
      const clickCol = Math.max(0, Math.min(promptLines[lineIndex].length, col - 3));
      this.cursorOffset = offset + clickCol;
    }
  }

  public handleMouseEvent(btn: number, col: number, row: number, isRelease: boolean) {
    // 1. Mouse wheel
    if (btn === 64 || btn === 68 || btn === 72 || btn === 80) {
      this.scrollOffset += 3;
      this.render();
      return;
    }
    if (btn === 65 || btn === 69 || btn === 73 || btn === 81) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 3);
      this.render();
      return;
    }

    // 2. Middle click (paste clipboard)
    if (btn === 1 && !isRelease) {
      const text = this.pasteFromClipboard();
      if (text) {
        this.handlePastedText(text);
      }
      return;
    }

    // 3. Left click press (btn 0, !isRelease)
    if (btn === 0 && !isRelease) {
      this.isSelecting = true;
      this.selection = { startCol: col, startRow: row, endCol: col, endRow: row };
      this.hasActiveSelection = false;
      return;
    }

    // 4. Left button drag motion (btn 32, !isRelease)
    if (btn === 32 && !isRelease) {
      if (this.isSelecting && this.selection) {
        this.selection.endCol = col;
        this.selection.endRow = row;
        this.hasActiveSelection = (this.selection.startRow !== row || this.selection.startCol !== col);
        this.render();
      }
      return;
    }

    // 5. Left button release (btn 0, isRelease)
    if (btn === 0 && isRelease) {
      if (this.isSelecting && this.selection) {
        this.isSelecting = false;
        this.selection.endCol = col;
        this.selection.endRow = row;

        if (this.selection.startRow !== row || this.selection.startCol !== col) {
          const selectedText = this.extractSelectedText(
            { col: this.selection.startCol, row: this.selection.startRow },
            { col: this.selection.endCol, row: this.selection.endRow }
          );
          if (selectedText.trim().length > 0) {
            this.copyToClipboard(selectedText);
            this.hasActiveSelection = true;
            this.notify(`Copied selection to clipboard! (${selectedText.length} chars)`);
          } else {
            this.hasActiveSelection = false;
            this.selection = null;
          }
        } else {
          this.handleSingleClick(col, row);
        }
        this.render();
      }
      return;
    }
  }

  private getFilteredSlashCommands(): SlashCommandDef[] {
    if (!this.promptBuffer.startsWith('/')) return [];
    const typed = this.promptBuffer.slice(1).trim().split(/\s+/)[0].toLowerCase();
    if (!typed) return ALL_SLASH_COMMANDS;
    return ALL_SLASH_COMMANDS.filter(
      (c) => c.cmd.slice(1).startsWith(typed) || c.cmd.toLowerCase().includes(typed) || c.desc.toLowerCase().includes(typed)
    );
  }

  public static pasteFromClipboard(): string | null {
    try {
      const { execSync } = require('node:child_process');
      if (process.platform === 'linux') {
        const cmds = [
          'xclip -selection clipboard -o 2>/dev/null',
          'wl-paste 2>/dev/null',
          'xsel --clipboard -o 2>/dev/null',
          'xclip -selection primary -o 2>/dev/null',
          'xsel --primary -o 2>/dev/null'
        ];
        for (const cmd of cmds) {
          try {
            const out = execSync(cmd, { encoding: 'utf-8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] });
            if (out && out.length > 0) return out;
          } catch {}
        }
      } else if (process.platform === 'darwin') {
        return execSync('pbpaste 2>/dev/null', { encoding: 'utf-8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] });
      } else if (process.platform === 'win32') {
        return execSync('powershell.exe -NoProfile -Command Get-Clipboard 2>$null', { encoding: 'utf-8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] });
      }
    } catch {}
    return null;
  }

  public pasteFromClipboard(): string | null {
    return OpenCodeEngine.pasteFromClipboard();
  }

  public handlePastedText(text: string) {
    if (!text) return;
    const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (modalManager.getActiveModal() !== 'none') {
      if (modalManager.handlePaste(clean)) {
        this.render();
      }
      return;
    }

    this.insertAtCursor(clean);
    if (this.promptBuffer.startsWith('/')) {
      const filtered = this.getFilteredSlashCommands();
      this.slashSelectedIndex = Math.min(this.slashSelectedIndex, Math.max(0, filtered.length - 1));
    }
    this.render();
  }

  public processRawInput(chunk: string) {
    let remaining = chunk;

    while (remaining.length > 0) {
      if (this.inBracketedPaste) {
        const endIdx = remaining.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          this.bracketedPasteBuffer += remaining.slice(0, endIdx);
          const pasted = this.bracketedPasteBuffer;
          this.bracketedPasteBuffer = '';
          this.inBracketedPaste = false;
          this.handlePastedText(pasted);
          remaining = remaining.slice(endIdx + 6);
        } else {
          this.bracketedPasteBuffer += remaining;
          return;
        }
      } else {
        const startIdx = remaining.indexOf('\x1b[200~');
        if (startIdx !== -1) {
          const before = remaining.slice(0, startIdx);
          if (before.length > 0) {
            this.handleInput(before);
          }
          this.inBracketedPaste = true;
          this.bracketedPasteBuffer = '';
          remaining = remaining.slice(startIdx + 6);
        } else {
          this.handleInput(remaining);
          return;
        }
      }
    }
  }

  private handleInput(str: string) {
    // Process SGR Mouse events if present
    const mouseMatches: RegExpExecArray[] = [];
    const mouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let match: RegExpExecArray | null;
    while ((match = mouseRe.exec(str)) !== null) {
      mouseMatches.push(match);
    }
    if (mouseMatches.length > 0) {
      for (const m of mouseMatches) {
        const btn = parseInt(m[1], 10);
        const col = parseInt(m[2], 10);
        const row = parseInt(m[3], 10);
        const isRelease = m[4] === 'm';
        this.handleMouseEvent(btn, col, row, isRelease);
      }
      return;
    }

    // Keyboard action clears active selection highlight
    if (this.hasActiveSelection) {
      this.hasActiveSelection = false;
      this.selection = null;
    }

    const key = this.parseKey(str);

    // Direct Clipboard Paste: Ctrl+V, \x16, or Shift+Insert (\x1b[2;2~, \x1b[2~)
    if ((key.ctrl && key.name === 'v') || str === '\x16' || str === '\x1b[2;2~' || str === '\x1b[2~') {
      const text = this.pasteFromClipboard();
      if (text) {
        this.handlePastedText(text);
      } else {
        this.notify('Clipboard is empty or inaccessible.');
        this.render();
      }
      return;
    }

    // Shift+Tab Mode Switcher (NORMAL -> /COMMAND -> !SHELL -> @ATTACH -> NORMAL)
    if (key.name === 'backtab' || (key.name === 'tab' && key.shift) || str === '\x1b[Z') {
      const res = cyclePromptMode(this.promptBuffer, this.cursorOffset);
      this.promptBuffer = res.text;
      this.cursorOffset = res.pos;
      if (this.promptBuffer.startsWith('/')) {
        this.slashSelectedIndex = 0;
      }
      this.render();
      return;
    }

    // Ctrl+C / Ctrl+D Exit
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      this.stop();
      return;
    }

    // 1. Give active modal priority
    if (modalManager.getActiveModal() !== 'none') {
      if (key.name === 'return') {
        const action = modalManager.getSelectedAction();
        action();
        this.render();
        return;
      }
      if (modalManager.handleInput(key.name || '', str)) {
        this.render();
        return;
      }
    }

    // 2. Process Keymaps & Shortcuts
    const keyAction = keymapRegistry.processInput(str, key);
    if (keyAction) {
      this.dispatchKeyAction(keyAction);
      this.render();
      return;
    }

    // 3. Mouse Wheel Scroll & PageUp / PageDown Transcript Scroll
    const upMatches = (str.match(/<(64|68|72|80);/g) || []).length;
    const downMatches = (str.match(/<(65|69|73|81);/g) || []).length;

    if (key.name === 'pageup' || upMatches > 0) {
      const delta = Math.max(1, upMatches) * 3;
      this.scrollOffset += delta;
      this.render();
      return;
    }

    if (key.name === 'pagedown' || downMatches > 0) {
      const delta = Math.max(1, downMatches) * 3;
      this.scrollOffset = Math.max(0, this.scrollOffset - delta);
      this.render();
      return;
    }

    // 4. Slash Command Palette Controls (when buffer starts with /)
    if (this.promptBuffer.startsWith('/')) {
      const filtered = this.getFilteredSlashCommands();

      if (key.name === 'up') {
        this.slashSelectedIndex = Math.max(0, this.slashSelectedIndex - 1);
        this.render();
        return;
      }

      if (key.name === 'down') {
        this.slashSelectedIndex = Math.min(Math.max(0, filtered.length - 1), this.slashSelectedIndex + 1);
        this.render();
        return;
      }

      if (key.name === 'tab') {
        if (filtered[this.slashSelectedIndex]) {
          this.promptBuffer = filtered[this.slashSelectedIndex].cmd + ' ';
          this.cursorOffset = this.promptBuffer.length;
        }
        this.render();
        return;
      }

      if (key.name === 'escape') {
        this.promptBuffer = '';
        this.cursorOffset = 0;
        this.render();
        return;
      }
    } else {
      // Prompt History Navigation (Up/Down) when NOT in slash command mode
      if (key.name === 'up' && this.promptHistory.length > 0) {
        if (this.historyIndex < this.promptHistory.length - 1) {
          this.historyIndex++;
          this.promptBuffer = this.promptHistory[this.promptHistory.length - 1 - this.historyIndex];
          this.cursorOffset = this.promptBuffer.length;
        }
        this.render();
        return;
      }

      if (key.name === 'down') {
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.promptBuffer = this.promptHistory[this.promptHistory.length - 1 - this.historyIndex];
        } else if (this.historyIndex === 0) {
          this.historyIndex = -1;
          this.promptBuffer = '';
        }
        this.cursorOffset = this.promptBuffer.length;
        this.render();
        return;
      }
    }

    // 5. Cursor movement & deletion (supports Word Navigation)
    if (key.name === 'left' || key.name === 'right') {
      if (key.word) {
        if (key.name === 'left') {
          let c = this.cursorOffset;
          while (c > 0 && /\s/.test(this.promptBuffer[c - 1])) c--;
          while (c > 0 && !/\s/.test(this.promptBuffer[c - 1])) c--;
          this.cursorOffset = c;
        } else {
          let c = this.cursorOffset;
          while (c < this.promptBuffer.length && !/\s/.test(this.promptBuffer[c])) c++;
          while (c < this.promptBuffer.length && /\s/.test(this.promptBuffer[c])) c++;
          this.cursorOffset = c;
        }
      } else {
        const delta = key.name === 'left' ? -1 : 1;
        this.cursorOffset = Math.max(0, Math.min(this.promptBuffer.length, this.cursorOffset + delta));
      }
      this.render();
      return;
    }

    if (key.name === 'backspace') {
      const c = this.cursorOffset;
      if (c > 0) {
        this.promptBuffer = this.promptBuffer.slice(0, c - 1) + this.promptBuffer.slice(c);
        this.cursorOffset = c - 1;
        if (this.promptBuffer.startsWith('/')) {
          this.slashSelectedIndex = 0;
        }
      }
      this.render();
      return;
    }

    if (key.name === 'delete') {
      const c = this.cursorOffset;
      this.promptBuffer = this.promptBuffer.slice(0, c) + this.promptBuffer.slice(c + 1);
      this.render();
      return;
    }

    if (key.name === 'home') { this.cursorOffset = 0; this.render(); return; }
    if (key.name === 'end') { this.cursorOffset = this.promptBuffer.length; this.scrollOffset = 0; this.render(); return; }

    // 6. Submit Prompt (Enter)
    if (key.name === 'return' && !key.shift && !key.ctrl && !key.alt) {
      if (this.promptBuffer.trim().length > 0) {
        let userText = this.promptBuffer.trim();

        if (userText.startsWith('/')) {
          const filtered = this.getFilteredSlashCommands();
          const rawCmd = userText.split(/\s+/)[0];
          const isExact = ALL_SLASH_COMMANDS.some((c) => c.cmd === rawCmd.toLowerCase());

          if (!isExact && filtered[this.slashSelectedIndex]) {
            const restArgs = userText.slice(rawCmd.length).trim();
            userText = filtered[this.slashSelectedIndex].cmd + (restArgs ? ' ' + restArgs : '');
          }

          this.promptHistory.push(userText);
          this.historyIndex = -1;
          this.promptBuffer = '';
          this.cursorOffset = 0;
          this.scrollOffset = 0;

          this.handleSlashCommand(userText);
          this.render();
          return;
        }

        this.promptHistory.push(userText);
        this.historyIndex = -1;
        this.promptBuffer = '';
        this.cursorOffset = 0;
        this.scrollOffset = 0;
        this.enqueueUserPrompt(userText);
      }
      return;
    }

    // Newline on Shift+Enter or Alt+Enter
    if (key.name === 'return' && (key.shift || key.alt || key.ctrl)) {
      this.insertAtCursor('\n');
      this.render();
      return;
    }

    // Plain text typing and pasted text chunks (supports multiline, tabs, unicode, and emojis)
    if (!key.ctrl && !key.alt && !str.startsWith('\x1b')) {
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(str)) {
        const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (this.promptBuffer === '' && normalized === '/') {
          this.slashSelectedIndex = 0;
        }
        this.insertAtCursor(normalized);
        if (this.promptBuffer.startsWith('/')) {
          const filtered = this.getFilteredSlashCommands();
          this.slashSelectedIndex = Math.min(this.slashSelectedIndex, Math.max(0, filtered.length - 1));
        }
        this.render();
      }
    }
  }

  private insertAtCursor(text: string) {
    const c = this.cursorOffset;
    this.promptBuffer = this.promptBuffer.slice(0, c) + text + this.promptBuffer.slice(c);
    this.cursorOffset = c + text.length;
  }

  private notify(text: string) {
    sessionStore.addMessage('system', text);
  }

  /** Handle a /command typed in the prompt. Returns true if consumed. */
  private handleSlashCommand(line: string): boolean {
    const [rawCmd, ...rest] = line.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case '/model':
      case '/models': {
        if (cmd === '/model' && arg) {
          const resolved = chatRouter.resolveModel(arg);
          if (resolved) {
            chatRouter.setDefaultModel(resolved);
            this.notify(`Switched active model to: ${resolved}`);
          } else {
            this.notify(`Unknown model "${arg}". Use /model with no argument to pick from the catalog.`);
          }
        } else {
          modalManager.openModal('model_picker');
        }
        return true;
      }
      case '/theme':
        if (arg && themeStore.listThemes().includes(arg)) {
          themeStore.setTheme(arg);
        } else {
          modalManager.openModal('theme_picker');
        }
        return true;
      case '/sessions':
        if (arg === 'clear' || arg === 'reset' || arg === 'delete' || arg === 'all') {
          sessionStore.clearAllSessions();
          this.notify('Cleared all saved conversation sessions.');
        } else {
          modalManager.openModal('session_drawer');
        }
        return true;
      case '/palette':
      case '/commands':
        modalManager.openModal('command_palette');
        return true;
      case '/keys':
        modalManager.openModal('which_key');
        return true;
      case '/new':
        sessionStore.createSession('New Session');
        return true;
      case '/copy':
        this.copyLastAssistantMessage();
        return true;
      case '/mouse':
        this.toggleMouseTracking();
        return true;
      case '/clear':
        if (arg === 'all' || arg === 'sessions') {
          sessionStore.clearAllSessions();
          this.notify('Cleared all saved conversation sessions.');
        } else {
          sessionStore.clearActiveSession();
        }
        return true;
      case '/compact':
        sessionStore.compactContext();
        this.notify('Context compacted.');
        return true;
      case '/exit':
      case '/quit':
        this.stop();
        return true;
      case '/help':
        this.notify('Commands: /model [name] /theme [name] /sessions [clear] /clear [all] /compact /copy /mouse /palette /keys /new /quit /help');
        return true;
      default:
        this.notify(`Unknown command ${cmd}. Type /help.`);
        return true;
    }
  }

  private dispatchKeyAction(action: string) {
    switch (action) {
      case 'EXIT': this.stop(); break;
      case 'OPEN_PALETTE': modalManager.openModal('command_palette'); break;
      case 'OPEN_MODEL_PICKER': modalManager.openModal('model_picker'); break;
      case 'OPEN_THEME_PICKER': modalManager.openModal('theme_picker'); break;
      case 'TOGGLE_SESSION_DRAWER': modalManager.openModal('session_drawer'); break;
      case 'TOGGLE_DIFF_VIEW': modalManager.openModal('diff_viewer'); break;
      case 'OPEN_WHICH_KEY': modalManager.openModal('which_key'); break;
      case 'DISMISS': modalManager.closeModal(); break;
      case 'TOGGLE_SIDEBAR': this.sidebarVisible = !this.sidebarVisible; break;
      case 'NEW_SESSION': sessionStore.createSession('New Session'); break;
      case 'COMPACT_CONTEXT': sessionStore.compactContext(); break;
      case 'COPY_LAST_RESPONSE': this.copyLastAssistantMessage(); break;
      case 'TOGGLE_MOUSE_MODE': this.toggleMouseTracking(); break;
      case 'CYCLE_QUICK_MODEL':
        const models = ['gemini-3.1-pro-high', 'gpt-4o', 'gemini-3.5-flash-lite'];
        const cur = chatRouter.getDefaultModel();
        const next = models[(models.indexOf(cur) + 1) % models.length];
        chatRouter.setDefaultModel(next);
        break;
      case 'CURSOR_HOME': this.cursorOffset = 0; break;
      case 'CURSOR_END': this.cursorOffset = this.promptBuffer.length; break;
      case 'CLEAR_LINE': this.promptBuffer = ''; this.cursorOffset = 0; break;
      case 'KILL_WORD':
        const words = this.promptBuffer.trimEnd().split(' ');
        words.pop();
        this.promptBuffer = words.join(' ');
        this.cursorOffset = this.promptBuffer.length;
        break;
      case 'PASTE_CLIPBOARD': {
        const text = this.pasteFromClipboard();
        if (text) {
          this.handlePastedText(text);
        } else {
          this.notify('Clipboard is empty or inaccessible.');
          this.render();
        }
        break;
      }
    }
  }

  private promptQueue: string[] = [];
  private spinnerTimer: any = null;

  private enqueueUserPrompt(text: string) {
    sessionStore.addMessage('user', text);
    this.promptQueue.push(text);
    this.render();
    this.drainQueue();
  }

  private async drainQueue() {
    if (this.isBusy || this.promptQueue.length === 0) return;

    this.isBusy = true;
    if (!this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => this.render(), 80);
    }

    const currentPrompt = this.promptQueue.shift();
    this.render();

    try {
      let assistantText = '';
      const activeSession = sessionStore.getActiveSession();

      for await (const chunk of chatRouter.dispatch(activeSession.messages)) {
        if (chunk.statusNote) {
          this.busyStatusNote = chunk.statusNote;
          this.render();
        }
        if (chunk.delta) {
          if (this.busyStatusNote) this.busyStatusNote = '';
          assistantText += chunk.delta;
          this.render();
        }
      }

      if (assistantText) {
        sessionStore.addMessage('assistant', assistantText);
      }
    } catch (e: any) {
      sessionStore.addMessage('system', `Error: ${e.message}`);
    } finally {
      this.isBusy = false;
      this.busyStatusNote = '';
      if (this.spinnerTimer) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
      }
      this.render();
      setImmediate(() => this.drainQueue());
    }
  }

  public renderSlashOverlay(width: number, t: ThemeTokens): string[] {
    const filtered = this.getFilteredSlashCommands();
    const boxW = Math.min(width - 6, 88);
    const lines: string[] = [];

    const borderChar = '─';
    const topBar = fg(t.border.focus, `┌${borderChar.repeat(boxW - 2)}┐`);
    const bottomBar = fg(t.border.focus, `└${borderChar.repeat(boxW - 2)}┘`);

    lines.push(topBar);

    const titleText = bold(fg(t.text.action, ` ⚡ SLASH COMMAND PALETTE (${filtered.length} matched) — Up/Down navigate, Tab complete, Enter run `));
    lines.push(`│ ${padToWidth(titleText, boxW - 4)} │`);
    lines.push(fg(t.border.focus, `├${borderChar.repeat(boxW - 2)}┤`));

    this.slashSelectedIndex = Math.min(this.slashSelectedIndex, Math.max(0, filtered.length - 1));
    const visibleCount = Math.min(6, filtered.length);

    for (let i = 0; i < visibleCount; i++) {
      const item = filtered[i];
      const isSelected = i === this.slashSelectedIndex;

      const prefix = isSelected ? '▶ ' : '  ';
      const cmdStr = item.cmd.padEnd(12);
      const usageStr = item.usage.padEnd(20);
      const descW = Math.max(10, boxW - 4 - 2 - 12 - 20 - 10);
      const descStr = item.desc.slice(0, descW).padEnd(descW);
      const badgeStr = fgBg(t.text.base, t.background.badge, ` [${item.badge}] `);

      const rowContent = `${prefix}${cmdStr}${usageStr}${descStr}${badgeStr}`;
      if (isSelected) {
        lines.push(`│ ${padToWidth(fgBg(t.text.base, t.background.selection, bold(rowContent)), boxW - 4)} │`);
      } else {
        lines.push(`│ ${padToWidth(fg(t.text.base, rowContent), boxW - 4)} │`);
      }
    }

    if (filtered.length === 0) {
      lines.push(`│ ${padToWidth(fg(t.text.muted, '  No matching slash command. Type /help for options.'), boxW - 4)} │`);
    }

    lines.push(bottomBar);
    return lines;
  }

  public render() {
    const t = themeStore.getTheme();
    const width = this.width;
    const height = this.height;

    const screenRows: string[] = [];

    // Top: Session Tab Bar
    const activeSession = sessionStore.getActiveSession();
    screenRows.push(this.tabBar.render(width, activeSession.title, sessionStore.listSessions().length, t));

    // Bottom: Prompt Composer
    const composerLines = this.composer.renderPrompt(this.promptBuffer, this.cursorOffset, width, this.isBusy, t);

    // Layout Split: Responsive Sidebar (collapses below 80 cols) + Main Transcript Pane
    const isSidebarVisible = this.sidebarVisible && width >= 80;
    const sidebarW = isSidebarVisible ? Math.min(32, Math.floor(width * 0.25)) : 0;
    const mainW = width - sidebarW;
    const mainH = Math.max(3, height - 1 - composerLines.length); // Top tab bar (1) + Prompt Composer lines

    const sidebarLines = isSidebarVisible ? this.sidebar.render(sidebarW, mainH, t) : [];

    // Main Transcript Scrollbox with scrollOffset support
    const transcriptLines: string[] = [];
    for (const msg of activeSession.messages) {
      transcriptLines.push(...this.cardRenderer.renderMessage(msg, mainW, t));
    }

    const totalLines = transcriptLines.length;
    const maxScroll = Math.max(0, totalLines - mainH);
    this.scrollOffset = Math.min(maxScroll, Math.max(0, this.scrollOffset));

    const end = Math.max(mainH, totalLines - this.scrollOffset);
    const start = Math.max(0, end - mainH);
    const visibleTranscript = transcriptLines.slice(start, end);
    while (visibleTranscript.length < mainH) {
      visibleTranscript.unshift('');
    }

    if (this.scrollOffset > 0 && visibleTranscript.length > 0) {
      const banner = ` ▲ SCROLLED UP (${this.scrollOffset} lines) - Press End or type to return to bottom `;
      visibleTranscript[0] = padToWidth(banner, mainW);
    }

    for (let r = 0; r < mainH; r++) {
      const left = this.sidebarVisible ? (sidebarLines[r] || ' '.repeat(sidebarW)) : '';
      const right = visibleTranscript[r] || '';
      screenRows.push(left + right);
    }

    screenRows.push(...composerLines);

    // Cache unhighlighted lines for mouse selection extraction
    this.lastScreenRows = [...screenRows];

    // Apply visual selection highlight if active
    if (this.hasActiveSelection && this.selection) {
      let r1 = this.selection.startRow;
      let c1 = this.selection.startCol;
      let r2 = this.selection.endRow;
      let c2 = this.selection.endCol;

      if (r1 > r2 || (r1 === r2 && c1 > c2)) {
        const tr = r1; const tc = c1;
        r1 = r2; c1 = c2;
        r2 = tr; c2 = tc;
      }

      for (let r = r1; r <= r2; r++) {
        const idx = r - 1;
        if (idx < 0 || idx >= screenRows.length) continue;

        let sc = 1;
        let ec = width;
        if (r1 === r2) {
          sc = c1;
          ec = c2;
        } else if (r === r1) {
          sc = c1;
          ec = width;
        } else if (r === r2) {
          sc = 1;
          ec = c2;
        }

        screenRows[idx] = highlightVisibleRange(screenRows[idx], sc, ec);
      }
    }

    // Begin Synchronized Render (\x1b[?2026h)
    let frame = '\x1b[?2026h\x1b[H\x1b[2J';
    frame += screenRows.join('\n');

    // Overlay: Slash Command Palette Overlay (if buffer starts with /)
    if (modalManager.getActiveModal() === 'none' && this.promptBuffer.startsWith('/')) {
      const slashLines = this.renderSlashOverlay(width, t);
      const startRow = Math.max(1, height - 6 - slashLines.length);
      const slashW = visibleLen(slashLines[0]);
      const startCol = Math.floor((width - slashW) / 2);
      for (let r = 0; r < slashLines.length; r++) {
        const row = startRow + r + 1;
        const col = startCol + 1;
        frame += `\x1b[${row};${col}H${slashLines[r]}`;
      }
    }

    // Overlay: Active Modal (if open)
    const modalLines = modalManager.render(width, height);
    if (modalLines.length > 0) {
      const startRow = Math.floor((height - modalLines.length) / 2);
      const modalW = visibleLen(modalLines[0]);
      const startCol = Math.floor((width - modalW) / 2);
      for (let r = 0; r < modalLines.length; r++) {
        const row = startRow + r + 1;
        const col = startCol + 1;
        frame += `\x1b[${row};${col}H${modalLines[r]}`;
      }
    }

    // End Synchronized Render (\x1b[?2026l)
    frame += '\x1b[?2026l';
    process.stdout.write(frame);
  }

  private parseKey(str: string): { name?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; word?: boolean } {
    // SGR Mouse wheel scroll decoding (<64; = Up, <65; = Down, with Shift/Alt/Ctrl modifiers) or PageUp/PageDown
    if (/<(64|68|72|80);/.test(str) || str.startsWith('\x1b[<64') || str === '\x1b[5~' || str === '\x1b[Ma' || str === '\x1b[M`') return { name: 'pageup' };
    if (/<(65|69|73|81);/.test(str) || str.startsWith('\x1b[<65') || str === '\x1b[6~' || str === '\x1b[Mb') return { name: 'pagedown' };

    // Tab & Backtab (Shift+Tab)
    if (str === '\x1b[Z' || str === '\x1b[9;2u') return { name: 'backtab', shift: true };
    if (str === '\t' || str === '\x09') return { name: 'tab' };

    // Ctrl+<letter> arrives as a single control byte (0x01-0x1a), excluding tab/enter/backspace
    if (str.length === 1) {
      const code = str.charCodeAt(0);
      if (code >= 1 && code <= 26 && ![8, 9, 10, 13].includes(code)) {
        return { name: String.fromCharCode(code + 96), ctrl: true };
      }
    }
    // Ctrl+Alt+<letter>
    if (str.length === 2 && str[0] === '\x1b') {
      const code = str.charCodeAt(1);
      if (code >= 1 && code <= 26 && ![8, 9, 10, 13].includes(code)) {
        return { name: String.fromCharCode(code + 96), ctrl: true, alt: true };
      }
    }

    // Word navigation (Ctrl+Left / Alt+Left / Ctrl+Right / Alt+Right)
    if (str === '\x1b[1;5D' || str === '\x1b[1;3D' || str === '\x1bb') return { name: 'left', word: true };
    if (str === '\x1b[1;5C' || str === '\x1b[1;3C' || str === '\x1bf') return { name: 'right', word: true };

    if (str === '\x1b[A' || str === '\x1bOA') return { name: 'up' };
    if (str === '\x1b[B' || str === '\x1bOB') return { name: 'down' };
    if (str === '\x1b[C' || str === '\x1bOC') return { name: 'right' };
    if (str === '\x1b[D' || str === '\x1bOD') return { name: 'left' };
    if (str === '\x1b[3~') return { name: 'delete' };
    if (str === '\x1b[H' || str === '\x1bOH' || str === '\x1b[1~' || str === '\x1b[7~') return { name: 'home' };
    if (str === '\x1b[F' || str === '\x1bOF' || str === '\x1b[4~' || str === '\x1b[8~') return { name: 'end' };

    if (str === '\r' || str === '\n') return { name: 'return' };
    if (str === '\x7f' || str === '\x08') return { name: 'backspace' };
    if (str === '\x1b') return { name: 'escape' };
    if (str === '\x1b[15~') return { name: 'f5' };
    if (str === '\x1bOP') return { name: 'f1' };
    if (str === '\x1bOQ') return { name: 'f2' };
    if (str === '\x1bOR') return { name: 'f3' };
    if (str === '\x1bOS') return { name: 'f4' };

    if (str === '\x1b[13;2u' || str === '\x1b\r') return { name: 'return', shift: true };

    return { name: str };
  }
}
