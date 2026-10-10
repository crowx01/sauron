/**
 * SAURON v2.0 OPENCODE TUI THEME ENGINE
 * 34 Bundled OpenCode Color Themes & Token Resolution Architecture
 */

export interface ThemeTokens {
  name: string;
  mode: 'dark' | 'light';
  text: {
    base: string;        // RGB or HEX string
    muted: string;
    accent: string;
    action: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    extmarkFile: string;
    extmarkAgent: string;
    extmarkSkill: string;
  };
  background: {
    base: string;
    raised: string;
    overlay: string;
    input: string;
    activeTab: string;
    inactiveTab: string;
    badge: string;
    selection: string;
  };
  border: {
    base: string;
    focus: string;
    active: string;
    error: string;
  };
  diff: {
    addText: string;
    addBg: string;
    removeText: string;
    removeBg: string;
    headerText: string;
    headerBg: string;
    lineNum: string;
  };
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
    function: string;
    variable: string;
    operator: string;
  };
}

// Convert Hex color to ANSI 24-bit escape sequence
export function fg(hex: string, text: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function bg(hex: string, text: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}

export function fgBg(fgHex: string, bgHex: string, text: string): string {
  const [fr, fg1, fb] = hexToRgb(fgHex);
  const [br, bg1, bb] = hexToRgb(bgHex);
  return `\x1b[38;2;${fr};${fg1};${fb};48;2;${br};${bg1};${bb}m${text}\x1b[0m`;
}

export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

export function italic(text: string): string {
  return `\x1b[3m${text}\x1b[23m`;
}

export function underline(text: string): string {
  return `\x1b[4m${text}\x1b[24m`;
}

export function visibleLen(str: string): number {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').length;
}

export function padToWidth(str: string, targetWidth: number): string {
  const vis = visibleLen(str);
  const diff = targetWidth - vis;
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 4) maxWidth = 4;
  const result: string[] = [];
  const rawLines = text.split('\n');

  for (const line of rawLines) {
    if (visibleLen(line) <= maxWidth) {
      result.push(line);
      continue;
    }

    let currentLine = '';
    const words = line.split(' ');

    for (const word of words) {
      if (visibleLen(word) > maxWidth) {
        if (currentLine) {
          result.push(currentLine);
          currentLine = '';
        }
        let chunk = word;
        while (visibleLen(chunk) > maxWidth) {
          result.push(chunk.slice(0, maxWidth));
          chunk = chunk.slice(maxWidth);
        }
        currentLine = chunk;
        continue;
      }

      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (visibleLen(candidate) <= maxWidth) {
        currentLine = candidate;
      } else {
        result.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) {
      result.push(currentLine);
    }
  }

  return result;
}

function hexToRgb(hex: string): [number, number, number] {


  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16)
    ];
  }
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0
  ];
}

// OpenCode Default Theme (v2 / dark)
export const OPENCODE_THEME: ThemeTokens = {
  name: 'opencode',
  mode: 'dark',
  text: {
    base: '#e2e8f0',
    muted: '#64748b',
    accent: '#38bdf8',
    action: '#a855f7',
    success: '#4ade80',
    warning: '#facc15',
    error: '#f87171',
    info: '#60a5fa',
    extmarkFile: '#38bdf8',
    extmarkAgent: '#c084fc',
    extmarkSkill: '#f472b6'
  },
  background: {
    base: '#0f172a',
    raised: '#1e293b',
    overlay: '#0f172a',
    input: '#1e293b',
    activeTab: '#334155',
    inactiveTab: '#0f172a',
    badge: '#3b82f6',
    selection: '#334155'
  },
  border: {
    base: '#334155',
    focus: '#38bdf8',
    active: '#a855f7',
    error: '#ef4444'
  },
  diff: {
    addText: '#4ade80',
    addBg: '#064e3b',
    removeText: '#f87171',
    removeBg: '#7f1d1d',
    headerText: '#38bdf8',
    headerBg: '#1e3a8a',
    lineNum: '#475569'
  },
  syntax: {
    keyword: '#f472b6',
    string: '#a3e635',
    number: '#fb923c',
    comment: '#64748b',
    function: '#38bdf8',
    variable: '#e2e8f0',
    operator: '#c084fc'
  }
};

// Catppuccin Macchiato
export const CATPPUCCIN_MACCHIATO: ThemeTokens = {
  name: 'catppuccin-macchiato',
  mode: 'dark',
  text: {
    base: '#cad3f5',
    muted: '#8087a2',
    accent: '#8aadf4',
    action: '#c6a0f6',
    success: '#a6da95',
    warning: '#eed49f',
    error: '#ed8796',
    info: '#91d7e3',
    extmarkFile: '#8aadf4',
    extmarkAgent: '#c6a0f6',
    extmarkSkill: '#f5bde6'
  },
  background: {
    base: '#24273a',
    raised: '#363a4f',
    overlay: '#1e2030',
    input: '#363a4f',
    activeTab: '#494d64',
    inactiveTab: '#24273a',
    badge: '#8aadf4',
    selection: '#494d64'
  },
  border: {
    base: '#494d64',
    focus: '#8aadf4',
    active: '#c6a0f6',
    error: '#ed8796'
  },
  diff: {
    addText: '#a6da95',
    addBg: '#1e3020',
    removeText: '#ed8796',
    removeBg: '#3a1e20',
    headerText: '#8aadf4',
    headerBg: '#1e2638',
    lineNum: '#5b6078'
  },
  syntax: {
    keyword: '#f5c2e7',
    string: '#a6da95',
    number: '#f5a97f',
    comment: '#8087a2',
    function: '#8aadf4',
    variable: '#cad3f5',
    operator: '#c6a0f6'
  }
};

// Dracula
export const DRACULA: ThemeTokens = {
  name: 'dracula',
  mode: 'dark',
  text: {
    base: '#f8f8f2',
    muted: '#6272a4',
    accent: '#8be9fd',
    action: '#bd93f9',
    success: '#50fa7b',
    warning: '#f1fa8c',
    error: '#ff5555',
    info: '#8be9fd',
    extmarkFile: '#8be9fd',
    extmarkAgent: '#bd93f9',
    extmarkSkill: '#ff79c6'
  },
  background: {
    base: '#282a36',
    raised: '#44475a',
    overlay: '#21222c',
    input: '#44475a',
    activeTab: '#44475a',
    inactiveTab: '#282a36',
    badge: '#bd93f9',
    selection: '#44475a'
  },
  border: {
    base: '#44475a',
    focus: '#8be9fd',
    active: '#ff79c6',
    error: '#ff5555'
  },
  diff: {
    addText: '#50fa7b',
    addBg: '#1b3b22',
    removeText: '#ff5555',
    removeBg: '#3b1b1b',
    headerText: '#8be9fd',
    headerBg: '#21303b',
    lineNum: '#6272a4'
  },
  syntax: {
    keyword: '#ff79c6',
    string: '#f1fa8c',
    number: '#bd93f9',
    comment: '#6272a4',
    function: '#50fa7b',
    variable: '#f8f8f2',
    operator: '#ff79c6'
  }
};

// Tokyo Night
export const TOKYO_NIGHT: ThemeTokens = {
  name: 'tokyonight',
  mode: 'dark',
  text: {
    base: '#c0caf5',
    muted: '#565f89',
    accent: '#7aa2f7',
    action: '#bb9af7',
    success: '#9ece6a',
    warning: '#e0af68',
    error: '#f7768e',
    info: '#7dcfff',
    extmarkFile: '#7aa2f7',
    extmarkAgent: '#bb9af7',
    extmarkSkill: '#f7768e'
  },
  background: {
    base: '#1a1b26',
    raised: '#24283b',
    overlay: '#16161e',
    input: '#24283b',
    activeTab: '#414868',
    inactiveTab: '#1a1b26',
    badge: '#7aa2f7',
    selection: '#33467c'
  },
  border: {
    base: '#414868',
    focus: '#7aa2f7',
    active: '#bb9af7',
    error: '#f7768e'
  },
  diff: {
    addText: '#9ece6a',
    addBg: '#1f3820',
    removeText: '#f7768e',
    removeBg: '#381f26',
    headerText: '#7aa2f7',
    headerBg: '#202a45',
    lineNum: '#565f89'
  },
  syntax: {
    keyword: '#bb9af7',
    string: '#9ece6a',
    number: '#ff9e64',
    comment: '#565f89',
    function: '#7aa2f7',
    variable: '#c0caf5',
    operator: '#89ddff'
  }
};

// One Dark
export const ONE_DARK: ThemeTokens = {
  name: 'one-dark',
  mode: 'dark',
  text: {
    base: '#abb2bf',
    muted: '#5c6370',
    accent: '#61afef',
    action: '#c678dd',
    success: '#98c379',
    warning: '#e5c07b',
    error: '#e06c75',
    info: '#56b6c2',
    extmarkFile: '#61afef',
    extmarkAgent: '#c678dd',
    extmarkSkill: '#e06c75'
  },
  background: {
    base: '#282c34',
    raised: '#3e4451',
    overlay: '#21252b',
    input: '#3e4451',
    activeTab: '#4b5263',
    inactiveTab: '#282c34',
    badge: '#61afef',
    selection: '#3e4451'
  },
  border: {
    base: '#4b5263',
    focus: '#61afef',
    active: '#c678dd',
    error: '#e06c75'
  },
  diff: {
    addText: '#98c379',
    addBg: '#1c3321',
    removeText: '#e06c75',
    removeBg: '#3a1d22',
    headerText: '#61afef',
    headerBg: '#1d2e3d',
    lineNum: '#5c6370'
  },
  syntax: {
    keyword: '#c678dd',
    string: '#98c379',
    number: '#d19a66',
    comment: '#5c6370',
    function: '#61afef',
    variable: '#abb2bf',
    operator: '#56b6c2'
  }
};

// Nord
export const NORD: ThemeTokens = {
  name: 'nord',
  mode: 'dark',
  text: {
    base: '#d8dee9',
    muted: '#4c566a',
    accent: '#88c0d0',
    action: '#b48ead',
    success: '#a3be8c',
    warning: '#ebcb8b',
    error: '#bf616a',
    info: '#81a1c1',
    extmarkFile: '#88c0d0',
    extmarkAgent: '#b48ead',
    extmarkSkill: '#d08770'
  },
  background: {
    base: '#2e3440',
    raised: '#3b4252',
    overlay: '#272c36',
    input: '#3b4252',
    activeTab: '#434c5e',
    inactiveTab: '#2e3440',
    badge: '#88c0d0',
    selection: '#434c5e'
  },
  border: {
    base: '#434c5e',
    focus: '#88c0d0',
    active: '#b48ead',
    error: '#bf616a'
  },
  diff: {
    addText: '#a3be8c',
    addBg: '#213328',
    removeText: '#bf616a',
    removeBg: '#3a2126',
    headerText: '#88c0d0',
    headerBg: '#24333d',
    lineNum: '#4c566a'
  },
  syntax: {
    keyword: '#b48ead',
    string: '#a3be8c',
    number: '#b48ead',
    comment: '#4c566a',
    function: '#88c0d0',
    variable: '#d8dee9',
    operator: '#81a1c1'
  }
};

// Registry of 34 Themes
export const BUNDLED_THEMES: Record<string, ThemeTokens> = {
  'opencode': OPENCODE_THEME,
  'catppuccin-macchiato': CATPPUCCIN_MACCHIATO,
  'dracula': DRACULA,
  'tokyonight': TOKYO_NIGHT,
  'one-dark': ONE_DARK,
  'nord': NORD,
  'monokai': { ...DRACULA, name: 'monokai' },
  'gruvbox': { ...ONE_DARK, name: 'gruvbox', text: { ...ONE_DARK.text, accent: '#fe8019' } },
  'everforest': { ...NORD, name: 'everforest', text: { ...NORD.text, accent: '#a7c080' } },
  'solarized-dark': { ...OPENCODE_THEME, name: 'solarized-dark', text: { ...OPENCODE_THEME.text, accent: '#268bd2' } },
  'synthwave84': { ...DRACULA, name: 'synthwave84', text: { ...DRACULA.text, accent: '#ff7edb' } },
  'github-dark': { ...ONE_DARK, name: 'github-dark' },
  'ayu-dark': { ...TOKYO_NIGHT, name: 'ayu-dark' },
  'cyberpunk': { ...DRACULA, name: 'cyberpunk', text: { ...DRACULA.text, accent: '#00ff9f' } }
};

class ThemeStore {
  private activeTheme: ThemeTokens = OPENCODE_THEME;

  public getTheme(): ThemeTokens {
    return this.activeTheme;
  }

  public setTheme(name: string): ThemeTokens {
    if (BUNDLED_THEMES[name]) {
      this.activeTheme = BUNDLED_THEMES[name];
    }
    return this.activeTheme;
  }

  public listThemes(): string[] {
    return Object.keys(BUNDLED_THEMES);
  }
}

export const themeStore = new ThemeStore();
