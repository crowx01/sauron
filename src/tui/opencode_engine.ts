/**
 * SAURON v2.0 OPENCODE TERMINAL ENGINE
 * Full OpenCode Layout Engine: Split Panes, Modals, Themes & Synchronized Render Loop
 */

import { themeStore, fg, fgBg, bold, dim, padToWidth, visibleLen, ThemeTokens } from './themes';
import { keymapRegistry, cyclePromptMode } from './keymaps';
import { modalManager } from './modals';
import { SessionTabBar, SidebarPane, MessageCardRenderer, PromptComposer } from './views';
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
  private sidebarVisible = true;
  private slashSelectedIndex = 0;

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

    // Enter alternate screen buffer, enable SGR 1000/1006 mouse tracking & hide cursor
    process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25l');

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
      this.handleInput(data.toString());
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

    // Disable SGR mouse tracking, leave alternate screen buffer & show cursor
    process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');

    if (error) {
      console.error('\n[SAURON TUI PANIC RECOVERY]:', error);
      process.exit(1);
    }
    process.exit(0);
  }

  private getFilteredSlashCommands(): SlashCommandDef[] {
    if (!this.promptBuffer.startsWith('/')) return [];
    const typed = this.promptBuffer.slice(1).trim().split(/\s+/)[0].toLowerCase();
    if (!typed) return ALL_SLASH_COMMANDS;
    return ALL_SLASH_COMMANDS.filter(
      (c) => c.cmd.slice(1).startsWith(typed) || c.cmd.toLowerCase().includes(typed) || c.desc.toLowerCase().includes(typed)
    );
  }

  private handleInput(str: string) {
    const key = this.parseKey(str);

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
    if (key.name === 'pageup') {
      this.scrollOffset += 3;
      this.render();
      return;
    }

    if (key.name === 'pagedown') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 3);
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

    // Plain text typing (also handles pasted chunks)
    if (!key.ctrl && !key.alt && /^[\x20-\x7e\u00a0-\uffff]+$/.test(str)) {
      if (this.promptBuffer === '' && str === '/') {
        this.slashSelectedIndex = 0;
      }
      this.insertAtCursor(str);
      if (this.promptBuffer.startsWith('/')) {
        const filtered = this.getFilteredSlashCommands();
        this.slashSelectedIndex = Math.min(this.slashSelectedIndex, Math.max(0, filtered.length - 1));
      }
      this.render();
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
        this.notify('Commands: /model [name] /theme [name] /sessions [clear] /clear [all] /compact /palette /keys /new /quit /help');
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
      case 'CYCLE_QUICK_MODEL':
        const models = ['claude-3-7-sonnet', 'gpt-4o', 'gemini-2.0-flash'];
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
    }
  }

  private promptQueue: string[] = [];
  private spinnerTimer: Timer | null = null;

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
        if (chunk.delta) {
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

    // Begin Synchronized Render (\x1b[?2026h)
    let frame = '\x1b[?2026h\x1b[H\x1b[2J';

    // Top: Session Tab Bar
    const activeSession = sessionStore.getActiveSession();
    frame += this.tabBar.render(width, activeSession.title, sessionStore.listSessions().length, t) + '\n';

    // Layout Split: Responsive Sidebar (collapses below 80 cols) + Main Transcript Pane
    const isSidebarVisible = this.sidebarVisible && width >= 80;
    const sidebarW = isSidebarVisible ? Math.min(32, Math.floor(width * 0.25)) : 0;
    const mainW = width - sidebarW;
    const mainH = height - 7; // Top tab bar (1) + Prompt Composer (6)

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
      frame += left + right + '\n';
    }

    // Bottom: Prompt Composer
    const composerLines = this.composer.renderPrompt(this.promptBuffer, this.cursorOffset, width, this.isBusy, t);
    frame += composerLines.join('\n');

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
    // SGR Mouse wheel scroll decoding (<64; = Up, <65; = Down) or PageUp/PageDown
    if (str.includes('<64;') || str.startsWith('\x1b[<64') || str === '\x1b[5~') return { name: 'pageup' };
    if (str.includes('<65;') || str.startsWith('\x1b[<65') || str === '\x1b[6~') return { name: 'pagedown' };

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
