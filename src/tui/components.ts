import { Message, Session } from '../types';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const COLOR_HEADER = '\x1b[38;2;99;102;241m';   // Indigo
const COLOR_CYAN = '\x1b[38;2;56;189;248m';     // Sky Cyan
const COLOR_GREEN = '\x1b[38;2;52;211;153m';    // Emerald Green
const COLOR_PURPLE = '\x1b[38;2;168;85;247m';   // Purple
const COLOR_YELLOW = '\x1b[38;2;251;191;36m';   // Amber Gold
const COLOR_RED = '\x1b[38;2;248;113;113m';    // Coral Red
const COLOR_GRAY = '\x1b[38;2;156;163;175m';    // Muted Slate

export class HeaderComponent {
  public render(width: number, model: string, provider: string, mode: string, sessionId: string): string[] {
    const title = `${BOLD}👁️  SAURON v2.0${RESET}${COLOR_HEADER}  •  ${COLOR_CYAN}OPENCODE TUI${RESET}${COLOR_HEADER}  •  ${COLOR_GREEN}ACTIVE ENGINE${RESET}`;
    const statusLine = `${DIM}Model:${RESET} ${COLOR_CYAN}${model}${RESET}  ${DIM}Provider:${RESET} ${COLOR_GREEN}${provider}${RESET}  ${DIM}Mode:${RESET} ${COLOR_YELLOW}${mode}${RESET}  ${DIM}Session:${RESET} ${COLOR_GRAY}${sessionId.slice(-8)}${RESET}`;

    const topBorder = `${COLOR_HEADER}╭` + '─'.repeat(Math.max(10, width - 2)) + `╮${RESET}`;
    const titleRow = `${COLOR_HEADER}│${RESET}  ${title}`.padEnd(width + 35) + `${COLOR_HEADER}│${RESET}`;
    const midBorder = `${COLOR_HEADER}├` + '─'.repeat(Math.max(10, width - 2)) + `┤${RESET}`;
    const statusRow = `${COLOR_HEADER}│${RESET}  ${statusLine}`.padEnd(width + 35) + `${COLOR_HEADER}│${RESET}`;
    const botBorder = `${COLOR_HEADER}╰` + '─'.repeat(Math.max(10, width - 2)) + `╯${RESET}`;

    return [topBorder, titleRow, midBorder, statusRow, botBorder];
  }
}

const ESCAPE_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[PX^_].*?\x1b\\|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(s: string): string {
  return s ? s.replace(ESCAPE_RE, '') : '';
}

export class TranscriptComponent {
  public render(width: number, messages: Message[], scrollOffset: number = 0): string[] {
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(`${DIM}  No messages yet. Type a question or /help to view commands.${RESET}`);
      return lines;
    }

    for (const msg of messages) {
      const safeContent = stripAnsi(msg.content);
      if (msg.role === 'user') {
        lines.push(`${COLOR_CYAN}╭─ 👤 USER ───────────────────────────────────────────────────────────────────╮${RESET}`);
        lines.push(`│ ${safeContent}`);
        lines.push(`${COLOR_CYAN}╰─────────────────────────────────────────────────────────────────────────────╯${RESET}`);
      } else if (msg.role === 'assistant') {
        lines.push(`${COLOR_GREEN}╭─ 👁️ SAURON AI ───────────────────────────────────────────────────────────────╮${RESET}`);
        const formatted = this.formatMarkdown(safeContent);
        for (const line of formatted.split('\n')) {
          lines.push(`│ ${line}`);
        }
        lines.push(`${COLOR_GREEN}╰─────────────────────────────────────────────────────────────────────────────╯${RESET}`);
      } else if (msg.role === 'system') {
        lines.push(`${COLOR_YELLOW}▶ ${safeContent}${RESET}`);
      }
    }

    return lines;
  }

  private formatMarkdown(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, `${BOLD}$1${RESET}`)
      .replace(/`([^`]+)`/g, `${COLOR_CYAN}$1${RESET}`);
  }
}

export class ToolCardComponent {
  public render(toolName: string, command: string, status: 'running' | 'success' | 'failed', output?: string): string[] {
    const color = status === 'success' ? COLOR_GREEN : status === 'failed' ? COLOR_RED : COLOR_YELLOW;
    const icon = status === 'success' ? '✓' : status === 'failed' ? '✗' : '⚙';

    const safeCmd = stripAnsi(command);
    const header = `${color}⚡ [Tool: ${toolName}] ${icon} ${status.toUpperCase()}${RESET} ${DIM}cmd: "${safeCmd}"${RESET}`;
    const lines = [`${color}╭─ ${header} ─╮${RESET}`];

    if (output) {
      const safeOutput = stripAnsi(output);
      const outLines = safeOutput.split('\n').slice(0, 5);
      for (const line of outLines) {
        lines.push(`│ ${COLOR_GRAY}${line}${RESET}`);
      }
      if (safeOutput.split('\n').length > 5) {
        lines.push(`│ ${DIM}... (+${safeOutput.split('\n').length - 5} lines hidden)${RESET}`);
      }
    }

    lines.push(`${color}╰─────────────────────────────────────────────────────────────────────────────╯${RESET}`);
    return lines;
  }
}

export class PromptEditorComponent {
  public render(width: number, buffer: string, mode: string, suggestions: string[] = []): string[] {
    const lines: string[] = [];

    if (suggestions.length > 0) {
      lines.push(`${COLOR_PURPLE}╭─ Autocomplete Suggestions ──────────────────────────────────────────────────╮${RESET}`);
      for (const s of suggestions.slice(0, 4)) {
        lines.push(`│ ${COLOR_CYAN}• ${s}${RESET}`);
      }
      lines.push(`${COLOR_PURPLE}╰─────────────────────────────────────────────────────────────────────────────╯${RESET}`);
    }

    const modeBadge = `${COLOR_YELLOW}[${mode}]${RESET}`;
    lines.push(`${COLOR_CYAN}╭─ Prompt ${modeBadge} ────────────────────────────────────────────────────────────╮${RESET}`);
    lines.push(`│ ${BOLD}> ${RESET}${buffer}`);
    lines.push(`${COLOR_CYAN}╰─────────────────────────────── [F1] Help  [F2] Models  [F3] Clear  [F4] Exit ╯${RESET}`);

    return lines;
  }
}

export class FooterComponent {
  public render(width: number): string[] {
    return [
      `${DIM}Shortcuts: Enter (Submit) | Shift+Enter (Newline) | Up/Down (History) | Ctrl+C (Interrupt) | /help${RESET}`
    ];
  }
}
