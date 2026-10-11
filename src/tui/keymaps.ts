/**
 * SAURON v2.0 OPENCODE TUI KEYBINDING & KEYMAP SYSTEM
 * Leader Key (Ctrl+X), Emacs Editing, Shortcuts & Layered Keymap Registry
 */

export interface KeyBinding {
  id: string;
  name: string;
  key: string;            // Representation e.g. "ctrl+p", "<leader>m", "f2"
  description: string;
  category: 'global' | 'navigation' | 'session' | 'prompt' | 'diff' | 'modal';
  action: string;
}

export class KeymapRegistry {
  private leaderActive = false;
  private leaderTimeout: Timer | null = null;
  private bindings: Map<string, KeyBinding> = new Map();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults() {
    const list: KeyBinding[] = [
      { id: 'exit', name: 'Exit Application', key: 'ctrl+c / <leader>q', description: 'Quit interactive TUI cleanly', category: 'global', action: 'EXIT' },
      { id: 'palette', name: 'Command Palette', key: 'ctrl+p', description: 'Open fuzzy command palette', category: 'global', action: 'OPEN_PALETTE' },
      { id: 'dismiss', name: 'Cancel / Dismiss', key: 'escape', description: 'Close modal / cancel in-flight stream', category: 'global', action: 'DISMISS' },
      
      { id: 'new_session', name: 'New Session', key: '<leader>n', description: 'Start a fresh conversation session', category: 'session', action: 'NEW_SESSION' },
      { id: 'session_drawer', name: 'Session List', key: '<leader>l', description: 'Open session drawer sidebar', category: 'session', action: 'TOGGLE_SESSION_DRAWER' },
      { id: 'model_picker', name: 'Model Selector', key: '<leader>m', description: 'Open fuzzy model selection modal', category: 'modal', action: 'OPEN_MODEL_PICKER' },
      { id: 'theme_picker', name: 'Theme Selector', key: '<leader>t', description: 'Open 34-theme color picker', category: 'modal', action: 'OPEN_THEME_PICKER' },
      { id: 'diff_view', name: 'Diff Viewer', key: '<leader>d', description: 'Toggle full-screen split/unified diff viewer', category: 'diff', action: 'TOGGLE_DIFF_VIEW' },
      { id: 'which_key', name: 'Which-Key Help', key: '<leader>k / ctrl+alt+k', description: 'Open keyboard shortcuts overlay', category: 'navigation', action: 'OPEN_WHICH_KEY' },
      { id: 'compact', name: 'Compact Context', key: '<leader>c', description: 'Summarize context & save JSONL archive', category: 'session', action: 'COMPACT_CONTEXT' },
      { id: 'sidebar', name: 'Toggle Sidebar', key: '<leader>b', description: 'Show/hide left information panel', category: 'navigation', action: 'TOGGLE_SIDEBAR' },
      { id: 'quick_model', name: 'Quick Model Switch', key: 'f2', description: 'Cycle through top 3 catalog models', category: 'modal', action: 'CYCLE_QUICK_MODEL' },
      { id: 'copy_response', name: 'Copy Last Response', key: '<leader>y / ctrl+y', description: 'Copy last assistant message to system clipboard', category: 'global', action: 'COPY_LAST_RESPONSE' },
      { id: 'mouse_mode', name: 'Toggle Mouse Selection', key: '<leader>s', description: 'Toggle native terminal mouse selection mode', category: 'global', action: 'TOGGLE_MOUSE_MODE' },
      
      // Emacs Prompt Navigation
      { id: 'emacs_home', name: 'Line Start', key: 'ctrl+a', description: 'Move cursor to line start', category: 'prompt', action: 'CURSOR_HOME' },
      { id: 'emacs_end', name: 'Line End', key: 'ctrl+e', description: 'Move cursor to line end', category: 'prompt', action: 'CURSOR_END' },
      { id: 'emacs_kill', name: 'Kill to End', key: 'ctrl+k', description: 'Cut from cursor to line end', category: 'prompt', action: 'KILL_TO_END' },
      { id: 'emacs_clear', name: 'Clear Line', key: 'ctrl+u', description: 'Clear entire prompt buffer', category: 'prompt', action: 'CLEAR_LINE' },
      { id: 'emacs_word_kill', name: 'Kill Word', key: 'ctrl+w', description: 'Delete word before cursor', category: 'prompt', action: 'KILL_WORD' }
    ];

    for (const b of list) {
      this.bindings.set(b.id, b);
    }
  }

  public getBindings(): KeyBinding[] {
    return Array.from(this.bindings.values());
  }

  public processInput(str: string, key: { name?: string; ctrl?: boolean; alt?: boolean; shift?: boolean }): string | null {
    // Check leader key toggle (Ctrl+X)
    if (key.ctrl && key.name === 'x') {
      this.leaderActive = true;
      if (this.leaderTimeout) clearTimeout(this.leaderTimeout);
      this.leaderTimeout = setTimeout(() => { this.leaderActive = false; }, 2000);
      return 'LEADER_PENDING';
    }

    if (this.leaderActive) {
      this.leaderActive = false;
      if (this.leaderTimeout) clearTimeout(this.leaderTimeout);
      
      switch (key.name) {
        case 'q': return 'EXIT';
        case 'n': return 'NEW_SESSION';
        case 'l': return 'TOGGLE_SESSION_DRAWER';
        case 'm': return 'OPEN_MODEL_PICKER';
        case 't': return 'OPEN_THEME_PICKER';
        case 'd': return 'TOGGLE_DIFF_VIEW';
        case 'k': return 'OPEN_WHICH_KEY';
        case 'c': return 'COMPACT_CONTEXT';
        case 'b': return 'TOGGLE_SIDEBAR';
        case 'y': return 'COPY_LAST_RESPONSE';
        case 's': return 'TOGGLE_MOUSE_MODE';
        default: return null;
      }
    }

    // Direct Keys
    if (key.ctrl && key.name === 'p') return 'OPEN_PALETTE';
    if (key.ctrl && key.name === 'y') return 'COPY_LAST_RESPONSE';
    if (key.name === 'f2') return 'CYCLE_QUICK_MODEL';
    if (key.name === 'escape') return 'DISMISS';
    if (key.ctrl && key.alt && key.name === 'k') return 'OPEN_WHICH_KEY';

    // Emacs Input Keys
    if (key.ctrl && key.name === 'a') return 'CURSOR_HOME';
    if (key.ctrl && key.name === 'e') return 'CURSOR_END';
    if (key.ctrl && key.name === 'k') return 'KILL_TO_END';
    if (key.ctrl && key.name === 'u') return 'CLEAR_LINE';
    if (key.ctrl && key.name === 'w') return 'KILL_WORD';

    return null;
  }

  public isLeaderActive(): boolean {
    return this.leaderActive;
  }
}

export function cyclePromptMode(promptText: string, cursorPos: number): { text: string; pos: number } {
  let mode = 'normal';
  let body = promptText;

  if (promptText.startsWith('/')) {
    mode = 'command';
    body = promptText.slice(1);
  } else if (promptText.startsWith('!')) {
    mode = 'shell';
    body = promptText.slice(1);
  } else if (promptText.startsWith('@')) {
    mode = 'attach';
    body = promptText.slice(1);
  }

  let nextPrefix = '';
  if (mode === 'normal') nextPrefix = '/';
  else if (mode === 'command') nextPrefix = '!';
  else if (mode === 'shell') nextPrefix = '@';
  else if (mode === 'attach') nextPrefix = '';

  const newText = nextPrefix + body;
  const oldPrefixLen = mode === 'normal' ? 0 : 1;
  const newPrefixLen = nextPrefix.length;
  const newPos = Math.max(0, Math.min(newText.length, cursorPos - oldPrefixLen + newPrefixLen));

  return { text: newText, pos: newPos };
}

export const keymapRegistry = new KeymapRegistry();
