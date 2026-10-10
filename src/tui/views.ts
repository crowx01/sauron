/**
 * SAURON v2.0 OPENCODE COMPONENT RENDERERS
 * SessionTabBar, SidebarPane, MessageCardRenderer, BlockTool, PatchDiff & PromptComposer
 */

import { themeStore, fg, fgBg, bold, dim, italic, underline, visibleLen, padToWidth, ThemeTokens } from './themes';
import { Message, StreamChunk } from '../types';
import { chatRouter } from '../router';
import { sessionStore } from '../session';
import { playbookStore } from '../agent/playbooks';

export class SessionTabBar {
  public render(width: number, activeSessionTitle: string, sessionCount: number, t: ThemeTokens): string {
    const tab1 = ` 󰅍 ${activeSessionTitle.slice(0, 18)} `;
    const tab2 = ` + New Session `;
    const helpHint = ` ctrl+p palette │ <leader>m model │ ctrl+x leader `;

    const activeFormatted = fgBg(t.text.base, t.background.activeTab, bold(tab1));
    const inactiveFormatted = fg(t.text.muted, tab2);
    const hintFormatted = fg(t.text.muted, helpHint);

    const leftPart = `${activeFormatted}│${inactiveFormatted}`;
    const leftLen = visibleLen(leftPart);
    const hintLen = visibleLen(hintFormatted);
    const padding = Math.max(0, width - leftLen - hintLen);

    return `${leftPart}${' '.repeat(padding)}${hintFormatted}`;
  }
}

export class SidebarPane {
  public render(width: number, height: number, t: ThemeTokens): string[] {
    const lines: string[] = [];
    const activeSession = sessionStore.getActiveSession();
    const activeModel = chatRouter.getDefaultModel();
    const playbooks = playbookStore.listPlaybooks();

    const border = '─'.repeat(width - 2);
    lines.push(fg(t.border.base, `┌${border}┐`));
    lines.push(`│ ${padToWidth(bold(fg(t.text.accent, 'SAURON SIDEBAR')), width - 4)} │`);
    lines.push(fg(t.border.base, `├${border}┤`));

    // Model & Catalog Status
    lines.push(`│ ${padToWidth(`${bold(fg(t.text.base, 'Model:'))} ${fg(t.text.accent, activeModel.slice(0, width - 12))}`, width - 4)} │`);
    lines.push(`│ ${padToWidth(`${bold(fg(t.text.base, 'Session:'))} ${fg(t.text.muted, activeSession.title.slice(0, width - 14))}`, width - 4)} │`);
    lines.push(`│ ${padToWidth(`${bold(fg(t.text.base, 'Messages:'))} ${fg(t.text.info, String(activeSession.messages.length))}`, width - 4)} │`);

    lines.push(fg(t.border.base, `├${border}┤`));
    lines.push(`│ ${padToWidth(bold(fg(t.text.action, 'TACTICAL PLAYBOOKS')), width - 4)} │`);

    for (let i = 0; i < Math.min(3, playbooks.length); i++) {
      const pb = playbooks[i];
      const pbStr = `• ${pb.name}`.slice(0, width - 6);
      lines.push(`│ ${padToWidth(fg(t.text.muted, pbStr), width - 4)} │`);
    }

    lines.push(fg(t.border.base, `├${border}┤`));
    lines.push(`│ ${padToWidth(bold(fg(t.text.success, 'MCP SERVERS: 2 ACTIVE')), width - 4)} │`);
    lines.push(`│ ${padToWidth(fg(t.text.muted, '• Kali SecSuite Engine'), width - 4)} │`);
    lines.push(`│ ${padToWidth(fg(t.text.muted, '• Local Filesystem MCP'), width - 4)} │`);

    while (lines.length < height - 1) {
      lines.push(`│ ${' '.repeat(width - 4)} │`);
    }
    lines.push(fg(t.border.base, `└${border}┘`));
    return lines;
  }
}

export class MessageCardRenderer {
  public renderMessage(msg: Message, width: number, t: ThemeTokens): string[] {
    const lines: string[] = [];
    const isUser = msg.role === 'user';
    const isSystem = msg.role === 'system';

    if (isUser) {
      const headerStr = ` USER  ${new Date(msg.timestamp).toLocaleTimeString()}`;
      lines.push(fgBg(t.text.base, t.background.selection, bold(padToWidth(` ${headerStr}`, width - 2))));
      
      // Parse @extmarks
      let text = msg.content;
      text = text.replace(/@([\w.-]+)/g, (_, name) => fg(t.text.extmarkFile, `@${name}`));
      text = text.replace(/\/([\w.-]+)/g, (_, cmd) => fg(t.text.extmarkAgent, `/${cmd}`));

      for (const line of text.split('\n')) {
        lines.push(`  ${line}`);
      }
      lines.push('');
      return lines;
    }

    if (isSystem) {
      lines.push(fg(t.text.muted, `  [SYSTEM] ${msg.content}`));
      lines.push('');
      return lines;
    }

    // Assistant Message with Reasoning & Code blocks
    const headerStr = ` SAURON (${chatRouter.getDefaultModel()}) `;
    lines.push(fg(t.text.accent, bold(headerStr)));

    const rawLines = msg.content.split('\n');
    let inCode = false;

    for (const l of rawLines) {
      if (l.startsWith('```')) {
        inCode = !inCode;
        lines.push(fg(t.syntax.comment, `  ${l}`));
        continue;
      }

      if (inCode) {
        lines.push(fg(t.syntax.string, `    ${l}`));
      } else if (l.startsWith('> ')) {
        // Reasoning part
        lines.push(fg(t.text.muted, italic(`  ${l}`)));
      } else {
        lines.push(`  ${l}`);
      }
    }

    lines.push('');
    return lines;
  }

  public renderBlockToolCard(name: string, args: Record<string, any>, status: 'running' | 'success' | 'failed', output: string, width: number, t: ThemeTokens): string[] {
    const lines: string[] = [];
    const boxW = Math.min(width - 4, 84);
    const border = '─'.repeat(boxW - 2);

    let statusBadge = fgBg('#ffffff', t.background.badge, ' RUNNING ');
    if (status === 'success') statusBadge = fgBg('#ffffff', t.text.success, ' SUCCESS ');
    if (status === 'failed') statusBadge = fgBg('#ffffff', t.text.error, ' FAILED ');

    lines.push(fg(t.border.base, `┌${border}┐`));
    const title = `TOOL ${name.toUpperCase()} ${statusBadge}`;
    lines.push(`│ ${padToWidth(title, boxW - 4)} │`);
    lines.push(fg(t.border.base, `├${border}┤`));

    const argStr = JSON.stringify(args);
    lines.push(`│ ${padToWidth(fg(t.text.muted, `Args: ${argStr.slice(0, boxW - 10)}`), boxW - 4)} │`);
    
    if (output) {
      lines.push(fg(t.border.base, `├${border}┤`));
      for (const l of output.split('\n').slice(0, 6)) {
        lines.push(`│ ${padToWidth(fg(t.text.base, l.slice(0, boxW - 6)), boxW - 4)} │`);
      }
    }

    lines.push(fg(t.border.base, `└${border}┘`));
    return lines;
  }
}

export class PromptComposer {
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex = 0;

  public renderPrompt(buffer: string, cursorOffset: number, width: number, isBusy: boolean, t: ThemeTokens): string[] {
    const lines: string[] = [];
    const boxW = width;
    const border = '─'.repeat(boxW - 2);

    // Mode badge
    let modeBadge = fgBg('#ffffff', t.text.accent, ' NORMAL ');
    if (buffer.startsWith('!')) modeBadge = fgBg('#ffffff', t.text.error, ' SHELL ! ');
    if (buffer.startsWith('/')) modeBadge = fgBg('#ffffff', t.text.action, ' COMMAND / ');
    if (buffer.includes('@')) modeBadge = fgBg('#ffffff', t.text.extmarkFile, ' ATTACH @ ');

    lines.push(fg(t.border.focus, `┌${border}┐`));

    // Render multiline input with cursor
    const linesText = buffer.split('\n');
    if (linesText.length === 0 || buffer === '') {
      lines.push(`│ ${padToWidth(`${modeBadge} ${dim('Type prompt, @file, /command, or !shell...')}█`, boxW - 4)} │`);
    } else {
      for (let i = 0; i < linesText.length; i++) {
        let l = linesText[i];
        if (i === linesText.length - 1) l += '█';
        const formatted = l.startsWith('!') ? fg(t.text.error, l) : l.startsWith('/') ? fg(t.text.action, l) : l;
        lines.push(`│ ${padToWidth(formatted, boxW - 4)} │`);
      }
    }

    lines.push(fg(t.border.focus, `├${border}┤`));

    // Assistant Footer
    this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
    const spinStr = isBusy ? fg(t.text.warning, `${this.spinnerFrames[this.spinnerIndex]} Thinking...`) : fg(t.text.success, '● Ready');
    const modelBadge = fgBg(t.text.base, t.background.activeTab, ` ${chatRouter.getDefaultModel()} `);
    const agentBadge = fg(t.text.extmarkAgent, ' [Sauron Agent] ');

    const footerLeft = `${spinStr} │ ${modelBadge} │ ${agentBadge}`;
    const footerRight = fg(t.text.muted, 'press return to submit, shift+return for newline');

    const leftVis = visibleLen(footerLeft);
    const rightVis = visibleLen(footerRight);
    const pad = Math.max(0, boxW - 4 - leftVis - rightVis);

    lines.push(`│ ${footerLeft}${' '.repeat(pad)}${footerRight} │`);
    lines.push(fg(t.border.focus, `└${border}┘`));

    return lines;
  }
}
