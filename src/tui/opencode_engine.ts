/**
 * SAURON v2.0 OPENCODE TERMINAL ENGINE
 * Full OpenCode Layout Engine: Split Panes, Modals, Themes & Synchronized Render Loop
 */

import { themeStore } from './themes';
import { keymapRegistry } from './keymaps';
import { modalManager } from './modals';
import { SessionTabBar, SidebarPane, MessageCardRenderer, PromptComposer } from './views';
import { sessionStore } from '../session';
import { chatRouter } from '../router';
import { toolBelt } from '../tools';
import { Message, StreamChunk } from '../types';

export class OpenCodeEngine {
  private width = 120;
  private height = 36;
  private isRaw = false;
  private promptBuffer = '';
  private cursorOffset = 0;
  private historyIndex = -1;
  private promptHistory: string[] = [];
  private isBusy = false;
  private sidebarVisible = true;

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

    // Enter alternate screen buffer & hide cursor
    process.stdout.write('\x1b[?1049h\x1b[?25l');

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

    // Leave alternate screen buffer & show cursor
    process.stdout.write('\x1b[?25h\x1b[?1049l');

    if (error) {
      console.error('\n[SAURON TUI PANIC RECOVERY]:', error);
      process.exit(1);
    }
    process.exit(0);
  }

  private handleInput(str: string) {
    const key = this.parseKey(str);

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

    // 3. Prompt History Navigation (Up/Down)
    if (key.name === 'up' && this.promptHistory.length > 0) {
      if (this.historyIndex < this.promptHistory.length - 1) {
        this.historyIndex++;
        this.promptBuffer = this.promptHistory[this.promptHistory.length - 1 - this.historyIndex];
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
      this.render();
      return;
    }

    // 4. Backspace
    if (key.name === 'backspace') {
      this.promptBuffer = this.promptBuffer.slice(0, -1);
      this.render();
      return;
    }

    // 5. Submit Prompt (Enter)
    if (key.name === 'return' && !key.shift && !key.ctrl && !key.alt) {
      if (this.promptBuffer.trim().length > 0) {
        const userText = this.promptBuffer;
        this.promptHistory.push(userText);
        this.historyIndex = -1;
        this.promptBuffer = '';
        this.processUserPrompt(userText);
      }
      return;
    }

    // Newline on Shift+Enter or Alt+Enter
    if (key.name === 'return' && (key.shift || key.alt || key.ctrl)) {
      this.promptBuffer += '\n';
      this.render();
      return;
    }

    // Plain text typing
    if (str.length === 1 && str >= ' ' && str <= '~') {
      this.promptBuffer += str;
      this.render();
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
        (chatRouter as any).defaultModel = next;
        break;
      case 'CURSOR_HOME': this.cursorOffset = 0; break;
      case 'CURSOR_END': this.cursorOffset = this.promptBuffer.length; break;
      case 'CLEAR_LINE': this.promptBuffer = ''; break;
      case 'KILL_WORD':
        const words = this.promptBuffer.trimEnd().split(' ');
        words.pop();
        this.promptBuffer = words.join(' ');
        break;
    }
  }

  private async processUserPrompt(text: string) {
    if (this.isBusy) return;
    this.isBusy = true;

    sessionStore.addMessage('user', text);
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
      this.render();
    }
  }

  public render() {
    const t = themeStore.getTheme();
    const width = this.width;
    const height = this.height;

    // Begin Synchronized Render (\x1b[?2026h)
    let frame = '\x1b[?2026h\x1b[H';

    // Top: Session Tab Bar
    const activeSession = sessionStore.getActiveSession();
    frame += this.tabBar.render(width, activeSession.title, sessionStore.listSessions().length, t) + '\n';

    // Layout Split: Sidebar (if visible) + Main Transcript Pane
    const sidebarW = this.sidebarVisible ? Math.min(32, Math.floor(width * 0.25)) : 0;
    const mainW = width - sidebarW;
    const mainH = height - 7; // Top tab bar (1) + Prompt Composer (6)

    const sidebarLines = this.sidebarVisible ? this.sidebar.render(sidebarW, mainH, t) : [];
    
    // Main Transcript Scrollbox
    const transcriptLines: string[] = [];
    for (const msg of activeSession.messages) {
      transcriptLines.push(...this.cardRenderer.renderMessage(msg, mainW, t));
    }

    const visibleTranscript = transcriptLines.slice(-mainH);
    while (visibleTranscript.length < mainH) {
      visibleTranscript.unshift('');
    }

    for (let r = 0; r < mainH; r++) {
      const left = this.sidebarVisible ? (sidebarLines[r] || ' '.repeat(sidebarW)) : '';
      const right = visibleTranscript[r] || '';
      frame += left + right + '\n';
    }

    // Bottom: Prompt Composer
    const composerLines = this.composer.renderPrompt(this.promptBuffer, this.cursorOffset, width, this.isBusy, t);
    frame += composerLines.join('\n');

    // Overlay: Active Modal (if open)
    const modalLines = modalManager.render(width, height);
    if (modalLines.length > 0) {
      frame += '\x1b[H'; // Reset to top for modal overlay
      const startRow = Math.floor((height - modalLines.length) / 2);
      for (let r = 0; r < startRow; r++) frame += '\n';
      for (const ml of modalLines) {
        const indent = ' '.repeat(Math.max(0, Math.floor((width - 88) / 2)));
        frame += indent + ml + '\n';
      }
    }

    // End Synchronized Render (\x1b[?2026l)
    frame += '\x1b[?2026l';
    process.stdout.write(frame);
  }

  private parseKey(str: string): { name?: string; ctrl?: boolean; alt?: boolean; shift?: boolean } {
    if (str === '\x1b[A') return { name: 'up' };
    if (str === '\x1b[B') return { name: 'down' };
    if (str === '\x1b[C') return { name: 'right' };
    if (str === '\x1b[D') return { name: 'left' };
    if (str === '\r' || str === '\n') return { name: 'return' };
    if (str === '\x7f' || str === '\x08') return { name: 'backspace' };
    if (str === '\x1b') return { name: 'escape' };
    if (str === '\x1b[15~') return { name: 'f5' };
    if (str === '\x1bOP') return { name: 'f1' };
    if (str === '\x1bOQ') return { name: 'f2' };
    if (str === '\x1bOR') return { name: 'f3' };
    if (str === '\x1bOS') return { name: 'f4' };
    
    // Check shift+return
    if (str === '\x1b[13;2u' || str === '\x1b\r') return { name: 'return', shift: true };

    return { name: str };
  }
}
