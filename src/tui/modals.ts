/**
 * SAURON v2.0 OPENCODE TUI DIALOG & MODAL SYSTEM
 * Model Selector, Session Drawer, Command Palette, Theme Selector, Which-Key Help & Diff Viewer
 */

import { themeStore, fg, fgBg, bold, dim, underline, visibleLen, padToWidth, ThemeTokens } from './themes';
import { keymapRegistry, KeyBinding } from './keymaps';
import { chatRouter } from '../router';
import { sessionStore } from '../session';
import { ModelEntry } from '../types';

export type ActiveModalType = 'none' | 'model_picker' | 'session_drawer' | 'command_palette' | 'theme_picker' | 'which_key' | 'diff_viewer';

export interface CommandPaletteItem {
  id: string;
  title: string;
  description: string;
  category: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}

export class ModalManager {
  private activeModal: ActiveModalType = 'none';
  private selectedIndex = 0;
  private filterQuery = '';
  private providerFilter = 'all';

  public getActiveModal(): ActiveModalType {
    return this.activeModal;
  }

  public openModal(type: ActiveModalType) {
    this.activeModal = type;
    this.selectedIndex = 0;
    this.filterQuery = '';
    this.providerFilter = 'all';
  }

  public closeModal() {
    this.activeModal = 'none';
    this.selectedIndex = 0;
    this.filterQuery = '';
  }

  public handleInput(keyName: string, char?: string): boolean {
    if (this.activeModal === 'none') return false;

    if (keyName === 'escape') {
      this.closeModal();
      return true;
    }

    if (keyName === 'up') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return true;
    }

    if (keyName === 'down') {
      this.selectedIndex++;
      return true;
    }

    if (keyName === 'backspace') {
      this.filterQuery = this.filterQuery.slice(0, -1);
      this.selectedIndex = 0;
      return true;
    }

    if (char && char.length === 1 && char >= ' ' && char <= '~') {
      this.filterQuery += char;
      this.selectedIndex = 0;
      return true;
    }

    return false;
  }

  public render(width: number, height: number): string[] {
    if (this.activeModal === 'none') return [];

    const t = themeStore.getTheme();
    switch (this.activeModal) {
      case 'model_picker': return this.renderModelPicker(width, height, t);
      case 'session_drawer': return this.renderSessionDrawer(width, height, t);
      case 'command_palette': return this.renderCommandPalette(width, height, t);
      case 'theme_picker': return this.renderThemePicker(width, height, t);
      case 'which_key': return this.renderWhichKey(width, height, t);
      case 'diff_viewer': return this.renderDiffViewer(width, height, t);
      default: return [];
    }
  }

  // 1. OpenCode Model Selector Dialog (<leader>m)
  private renderModelPicker(width: number, height: number, t: ThemeTokens): string[] {
    const catalog = chatRouter.getCatalog();
    const query = this.filterQuery.toLowerCase();
    const filtered = catalog.filter((m) =>
      m.model.toLowerCase().includes(query) || m.provider.toLowerCase().includes(query)
    );

    const dialogWidth = Math.min(width - 8, 88);
    const dialogHeight = Math.min(height - 6, 22);
    const lines: string[] = [];

    const borderChar = '─';
    const topBar = `┌${borderChar.repeat(dialogWidth - 2)}┐`;
    const bottomBar = `└${borderChar.repeat(dialogWidth - 2)}┘`;

    lines.push(fg(t.border.focus, topBar));
    
    // Header Title
    const titleText = ` OPENCODE MODEL SELECTOR (${filtered.length} models) `;
    lines.push(`│ ${padToWidth(bold(fg(t.text.accent, titleText)), dialogWidth - 4)} │`);

    // Search input line
    const searchPrompt = ` Filter: ${this.filterQuery}█`;
    lines.push(`│ ${padToWidth(fg(t.text.muted, searchPrompt), dialogWidth - 4)} │`);
    lines.push(`├${borderChar.repeat(dialogWidth - 2)}┤`);

    // Model list
    const visibleCount = dialogHeight - 6;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));

    for (let i = 0; i < visibleCount; i++) {
      if (i >= filtered.length) {
        lines.push(`│ ${' '.repeat(dialogWidth - 4)} │`);
        continue;
      }

      const item = filtered[i];
      const isSelected = i === this.selectedIndex;
      const star = isSelected ? '▶ ' : '  ';
      const providerBadge = `[${item.provider}]`.padEnd(14);
      const intelBadge = `IQ:${item.intelligence}`;
      const nameStr = item.model.padEnd(32);

      let lineStr = `${star}${providerBadge} ${nameStr} ${intelBadge}`;
      if (isSelected) {
        lines.push(`│ ${padToWidth(fgBg(t.text.base, t.background.selection, bold(lineStr)), dialogWidth - 4)} │`);
      } else {
        lines.push(`│ ${padToWidth(fg(t.text.base, lineStr), dialogWidth - 4)} │`);
      }
    }

    lines.push(fg(t.border.focus, bottomBar));
    return lines;
  }

  // 2. OpenCode Session Drawer Sidebar (<leader>l)
  private renderSessionDrawer(width: number, height: number, t: ThemeTokens): string[] {
    const sessions = sessionStore.listSessions();
    const query = this.filterQuery.toLowerCase();
    const filtered = sessions.filter((s) => s.id.toLowerCase().includes(query) || s.title.toLowerCase().includes(query));

    const drawerWidth = Math.min(width - 10, 72);
    const drawerHeight = Math.min(height - 6, 20);
    const lines: string[] = [];

    lines.push(fg(t.border.active, `┌${'─'.repeat(drawerWidth - 2)}┐`));
    const title = ` SAURON SESSION DRAWER (${filtered.length} saved sessions) `;
    lines.push(`│ ${padToWidth(bold(fg(t.text.action, title)), drawerWidth - 4)} │`);
    lines.push(`├${'─'.repeat(drawerWidth - 2)}┤`);

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));
    const visibleCount = drawerHeight - 5;

    for (let i = 0; i < visibleCount; i++) {
      if (i >= filtered.length) {
        lines.push(`│ ${' '.repeat(drawerWidth - 4)} │`);
        continue;
      }

      const s = filtered[i];
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? '● ' : '  ';
      const titleStr = s.title.slice(0, 24).padEnd(24);
      const msgStr = `${s.messages.length} msgs`;
      const timeStr = new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const rowStr = `${prefix}${titleStr} │ ${msgStr.padEnd(8)} │ ${timeStr}`;
      if (isSelected) {
        lines.push(`│ ${padToWidth(fgBg(t.text.base, t.background.selection, bold(rowStr)), drawerWidth - 4)} │`);
      } else {
        lines.push(`│ ${padToWidth(fg(t.text.muted, rowStr), drawerWidth - 4)} │`);
      }
    }

    lines.push(fg(t.border.active, `└${'─'.repeat(drawerWidth - 2)}┘`));
    return lines;
  }

  // 3. OpenCode Fuzzy Command Palette (Ctrl+P)
  private renderCommandPalette(width: number, height: number, t: ThemeTokens): string[] {
    const actions: CommandPaletteItem[] = [
      { id: '1', title: 'Switch AI Model', description: 'Open fuzzy model catalog picker', category: 'Model', shortcut: '<leader>m', action: () => this.openModal('model_picker') },
      { id: '2', title: 'New Conversation Session', description: 'Start a clean chat session', category: 'Session', shortcut: '<leader>n', action: () => { sessionStore.createSession('New Session'); this.closeModal(); } },
      { id: '3', title: 'Toggle Session Drawer', description: 'Browse and restore saved sessions', category: 'Session', shortcut: '<leader>l', action: () => this.openModal('session_drawer') },
      { id: '4', title: 'Change Theme', description: 'Switch between 34 bundled color palettes', category: 'UI', shortcut: '<leader>t', action: () => this.openModal('theme_picker') },
      { id: '5', title: 'Toggle Diff Viewer', description: 'View full-screen split/unified diffs', category: 'Diff', shortcut: '<leader>d', action: () => this.openModal('diff_viewer') },
      { id: '6', title: 'Compact Context Memory', description: 'Extract facts & save lossless archive', category: 'Session', shortcut: '<leader>c', action: () => { sessionStore.compactContext(); this.closeModal(); } },
      { id: '7', title: 'Which-Key Keyboard Help', description: 'View all keyboard shortcuts and leader bindings', category: 'Help', shortcut: 'ctrl+alt+k', action: () => this.openModal('which_key') },
      { id: '8', title: 'Exit Sauron TUI', description: 'Close application cleanly', category: 'System', shortcut: 'ctrl+c', action: () => process.exit(0) }
    ];

    const query = this.filterQuery.toLowerCase();
    const filtered = actions.filter((a) => a.title.toLowerCase().includes(query) || a.description.toLowerCase().includes(query) || a.category.toLowerCase().includes(query));

    const pWidth = Math.min(width - 8, 80);
    const pHeight = Math.min(height - 6, 18);
    const lines: string[] = [];

    lines.push(fg(t.border.focus, `┌${'─'.repeat(pWidth - 2)}┐`));
    lines.push(`│ ${padToWidth(bold(fg(t.text.accent, ' COMMAND PALETTE (ctrl+p)')), pWidth - 4)} │`);
    lines.push(`│ ${padToWidth(fg(t.text.muted, ` Query: > ${this.filterQuery}█`), pWidth - 4)} │`);
    lines.push(`├${'─'.repeat(pWidth - 2)}┤`);

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));
    const visibleCount = pHeight - 5;

    for (let i = 0; i < visibleCount; i++) {
      if (i >= filtered.length) {
        lines.push(`│ ${' '.repeat(pWidth - 4)} │`);
        continue;
      }

      const item = filtered[i];
      const isSelected = i === this.selectedIndex;
      const tag = `[${item.category}]`.padEnd(10);
      const titleStr = item.title.padEnd(28);
      const scStr = (item.shortcut || '').padStart(12);

      const rowStr = `${tag} ${titleStr} ${scStr}`;
      if (isSelected) {
        lines.push(`│ ${padToWidth(fgBg(t.text.base, t.background.selection, bold(rowStr)), pWidth - 4)} │`);
      } else {
        lines.push(`│ ${padToWidth(fg(t.text.base, rowStr), pWidth - 4)} │`);
      }
    }

    lines.push(fg(t.border.focus, `└${'─'.repeat(pWidth - 2)}┘`));
    return lines;
  }

  // 4. OpenCode 34-Theme Selector (<leader>t)
  private renderThemePicker(width: number, height: number, t: ThemeTokens): string[] {
    const themes = themeStore.listThemes();
    const query = this.filterQuery.toLowerCase();
    const filtered = themes.filter((th) => th.toLowerCase().includes(query));

    const tWidth = Math.min(width - 8, 64);
    const tHeight = Math.min(height - 6, 18);
    const lines: string[] = [];

    lines.push(fg(t.border.active, `┌${'─'.repeat(tWidth - 2)}┐`));
    lines.push(`│ ${padToWidth(bold(fg(t.text.action, ' SELECT THEME PALETTE')), tWidth - 4)} │`);
    lines.push(`├${'─'.repeat(tWidth - 2)}┤`);

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));
    const visibleCount = tHeight - 4;

    for (let i = 0; i < visibleCount; i++) {
      if (i >= filtered.length) {
        lines.push(`│ ${' '.repeat(tWidth - 4)} │`);
        continue;
      }

      const thName = filtered[i];
      const isSelected = i === this.selectedIndex;
      const isCurrent = themeStore.getTheme().name === thName;
      const mark = isCurrent ? '✓ ' : '  ';
      const nameStr = `${mark}${thName}`;

      if (isSelected) {
        lines.push(`│ ${padToWidth(fgBg(t.text.base, t.background.selection, bold(nameStr)), tWidth - 4)} │`);
      } else {
        lines.push(`│ ${padToWidth(fg(t.text.muted, nameStr), tWidth - 4)} │`);
      }
    }

    lines.push(fg(t.border.active, `└${'─'.repeat(tWidth - 2)}┘`));
    return lines;
  }

  // 5. OpenCode Which-Key Help Overlay (<leader>k / ctrl+alt+k)
  private renderWhichKey(width: number, height: number, t: ThemeTokens): string[] {
    const bindings = keymapRegistry.getBindings();
    const kWidth = Math.min(width - 6, 84);
    const kHeight = Math.min(height - 4, 22);
    const lines: string[] = [];

    lines.push(fg(t.border.focus, `┌${'─'.repeat(kWidth - 2)}┐`));
    lines.push(`│ ${padToWidth(bold(fg(t.text.accent, ' WHICH-KEY SHORTCUT OVERLAY (Leader Key: ctrl+x)')), kWidth - 4)} │`);
    lines.push(`├${'─'.repeat(kWidth - 2)}┤`);

    const visibleCount = kHeight - 4;
    for (let i = 0; i < visibleCount; i++) {
      if (i >= bindings.length) {
        lines.push(`│ ${' '.repeat(kWidth - 4)} │`);
        continue;
      }

      const b = bindings[i];
      const keyStr = bold(b.key.padEnd(20));
      const nameStr = b.name.padEnd(24);
      const descStr = b.description.slice(0, 26);

      const row = `${keyStr} │ ${nameStr} │ ${descStr}`;
      lines.push(`│ ${padToWidth(row, kWidth - 4)} │`);
    }

    lines.push(fg(t.border.focus, `└${'─'.repeat(kWidth - 2)}┘`));
    return lines;
  }

  // 6. OpenCode Full-Screen Diff Viewer (<leader>d)
  private renderDiffViewer(width: number, height: number, t: ThemeTokens): string[] {
    const dWidth = width - 4;
    const dHeight = height - 4;
    const lines: string[] = [];

    lines.push(fg(t.border.active, `┌${'─'.repeat(dWidth - 2)}┐`));
    lines.push(`│ ${padToWidth(bold(fg(t.text.action, ' SAURON UNIFIED/SPLIT DIFF VIEWER')), dWidth - 4)} │`);
    lines.push(`├${'─'.repeat(dWidth - 2)}┤`);

    const mockDiff = [
      '@@ -1,6 +1,8 @@',
      ' # SAURON ARCHITECTURE REBUILD',
      '- legacy python prompt_toolkit',
      '+ typescript bun v1.4 runtime',
      '+ opencode terminal ui component model',
      '  multi-model catalog & provider fallback',
      '- static command retry loops',
      '+ autonomous react loop & dag planner'
    ];

    for (let i = 0; i < dHeight - 4; i++) {
      if (i >= mockDiff.length) {
        lines.push(`│ ${' '.repeat(dWidth - 4)} │`);
        continue;
      }

      const l = mockDiff[i];
      let formatted = l;
      if (l.startsWith('+')) formatted = fgBg(t.diff.addText, t.diff.addBg, l);
      else if (l.startsWith('-')) formatted = fgBg(t.diff.removeText, t.diff.removeBg, l);
      else if (l.startsWith('@')) formatted = fgBg(t.diff.headerText, t.diff.headerBg, l);

      lines.push(`│ ${padToWidth(formatted, dWidth - 4)} │`);
    }

    lines.push(fg(t.border.active, `└${'─'.repeat(dWidth - 2)}┘`));
    return lines;
  }

  public getSelectedAction(): () => void | Promise<void> {
    const catalog = chatRouter.getCatalog();
    const query = this.filterQuery.toLowerCase();

    if (this.activeModal === 'model_picker') {
      const filtered = catalog.filter((m) =>
        m.model.toLowerCase().includes(query) || m.provider.toLowerCase().includes(query)
      );
      if (filtered[this.selectedIndex]) {
        const targetModel = filtered[this.selectedIndex].model;
        return () => {
          (chatRouter as any).defaultModel = targetModel;
          this.closeModal();
        };
      }
    }

    if (this.activeModal === 'theme_picker') {
      const themes = themeStore.listThemes();
      const filtered = themes.filter((th) => th.toLowerCase().includes(query));
      if (filtered[this.selectedIndex]) {
        const th = filtered[this.selectedIndex];
        return () => {
          themeStore.setTheme(th);
          this.closeModal();
        };
      }
    }

    if (this.activeModal === 'session_drawer') {
      const sessions = sessionStore.listSessions();
      const filtered = sessions.filter((s) => s.id.toLowerCase().includes(query) || s.title.toLowerCase().includes(query));
      if (filtered[this.selectedIndex]) {
        const sId = filtered[this.selectedIndex].id;
        return () => {
          sessionStore.loadSession(sId);
          this.closeModal();
        };
      }
    }

    return () => this.closeModal();
  }
}

export const modalManager = new ModalManager();
