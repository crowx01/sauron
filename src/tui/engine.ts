import { Message, RouterOptions } from '../types';
import { chatRouter } from '../router';
import { sessionStore } from '../session';
import { toolBelt } from '../tools';
import { missionRunner } from '../mission';
import { terminalScreen } from './screen';
import {
  HeaderComponent,
  TranscriptComponent,
  ToolCardComponent,
  PromptEditorComponent,
  FooterComponent
} from './components';
import { createInterface, Interface } from 'readline';

export class OpenCodeTUIEngine {
  private headerComp = new HeaderComponent();
  private transcriptComp = new TranscriptComponent();
  private toolCardComp = new ToolCardComponent();
  private promptComp = new PromptEditorComponent();
  private footerComp = new FooterComponent();

  private activeModel: string = 'auto';
  private activeMode: 'auto' | 'cheap' | 'smart' | 'delegate' = 'auto';
  private history: string[] = [];
  private historyIndex: number = -1;
  private inputBuffer: string = '';
  private isBusy: boolean = false;
  private uiNotifications: string[] = [];
  private rl?: Interface;
  private abortController?: AbortController;

  constructor() {
    this.setupResizeHandler();
  }

  private setupResizeHandler(): void {
    process.stdout.on('resize', () => {
      this.render();
    });
  }

  public render(): void {
    const { columns, rows } = terminalScreen.getSize();
    const route = chatRouter.route({ model: this.activeModel, mode: this.activeMode });

    const headerLines = this.headerComp.render(
      columns,
      route.primaryModel,
      route.primaryProvider,
      this.activeMode,
      sessionStore.getActiveSession().id
    );

    const transcriptLines = this.transcriptComp.render(
      columns,
      sessionStore.getActiveSession().messages
    );

    // Append transient UI notifications to transcript
    for (const notif of this.uiNotifications) {
      transcriptLines.push(notif);
    }

    const suggestions = this.inputBuffer.startsWith('/')
      ? ['/help', '/status', '/models', '/model', '/clear', '/sessions', '/cheap', '/smart', '/plan', '/exit'].filter((c) =>
          c.startsWith(this.inputBuffer)
        )
      : [];

    const promptLines = this.promptComp.render(columns, this.inputBuffer, this.activeMode, suggestions);
    const footerLines = this.footerComp.render(columns);

    // Calculate available vertical space for transcript to GUARANTEE prompt panel never scrolls off
    const fixedRows = headerLines.length + promptLines.length + footerLines.length + 2;
    const availableTranscriptRows = Math.max(3, rows - fixedRows);

    const visibleTranscript = transcriptLines.slice(-availableTranscriptRows);

    const frame = [...headerLines, '', ...visibleTranscript, '', ...promptLines, ...footerLines];
    terminalScreen.renderFrame(frame);
  }

  public async start(): Promise<void> {
    terminalScreen.enterAlternateScreen();
    terminalScreen.setInterruptHandler(() => {
      if (this.isBusy && this.abortController) {
        this.abortController.abort();
        this.addNotification('Request cancelled (Ctrl+C).');
        this.render();
        return true;
      }
      return false;
    });

    this.render();

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: ''
    });

    // Raw mode: Ctrl+C arrives here, not as a process signal. First press cancels the
    // in-flight request; with nothing in flight it exits.
    this.rl.on('SIGINT', () => {
      if (this.isBusy && this.abortController) {
        this.abortController.abort();
        this.addNotification('Request cancelled (Ctrl+C).');
        this.render();
        return;
      }
      terminalScreen.leaveAlternateScreen();
      process.exit(130);
    });

    this.rl.on('line', async (line) => {
      if (this.isBusy) {
        this.addNotification('Busy: input ignored. Press Ctrl+C to cancel the current request.');
        this.render();
        return;
      }

      const trimmed = line.trim();
      this.inputBuffer = '';
      if (!trimmed) {
        this.render();
        return;
      }

      this.history.push(trimmed);
      this.historyIndex = this.history.length;

      // Busy for the whole line (commands such as /plan included), cancellable via Ctrl+C
      this.isBusy = true;
      this.abortController = new AbortController();
      try {
        if (trimmed.startsWith('/')) {
          await this.handleCommand(trimmed);
        } else {
          await this.handleUserMessage(trimmed);
        }
      } catch (err: any) {
        this.addNotification(`[UI Error Boundary]: ${err.message}`);
      } finally {
        this.isBusy = false;
        this.abortController = undefined;
      }

      this.render();
    });

    this.rl.on('close', () => {
      terminalScreen.leaveAlternateScreen();
      process.exit(0);
    });
  }

  private addNotification(msg: string): void {
    this.uiNotifications.push(msg);
    if (this.uiNotifications.length > 5) {
      this.uiNotifications.shift();
    }
  }

  private async handleCommand(cmdStr: string): Promise<void> {
    const parts = cmdStr.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();

    switch (cmd) {
      case '/help':
        this.addNotification(
          'SAURON COMMAND MENU:\n' +
            '  /help                 Show this help menu\n' +
            '  /status               Show router status & provider health\n' +
            '  /models               List all routable catalog models\n' +
            '  /model <name>         Switch active model (e.g. gemini, gpt-4o, claude)\n' +
            '  /clear                Clear conversation session history\n' +
            '  /sessions             List saved conversation sessions\n' +
            '  /cheap <question>     Ask question using low-cost tier\n' +
            '  /smart <question>     Ask question using high-reasoning tier\n' +
            '  /plan <goal>          Execute adaptive 3-phase mission pipeline\n' +
            '  /exit                 Exit Sauron chat session'
        );
        break;

      case '/status': {
        const route = chatRouter.route({ model: this.activeModel, mode: this.activeMode });
        this.addNotification(
          `STATUS: Model=${route.primaryModel} (${route.primaryProvider}) | Mode=${this.activeMode} | Session=${sessionStore.getActiveSession().id} | Messages=${sessionStore.getActiveSession().messages.length}`
        );
        break;
      }

      case '/models': {
        const list = chatRouter
          .getCatalog()
          .map((m) => `• ${m.model} [${m.provider}] Intell: ${m.intelligence}`)
          .join('\n');
        this.addNotification(`CATALOG MODELS:\n${list}`);
        break;
      }

      case '/model':
        if (arg) {
          this.activeModel = arg;
          const route = chatRouter.route({ model: this.activeModel, mode: this.activeMode });
          this.addNotification(
            `Switched active model to: ${this.activeModel} (Routes to: ${route.primaryModel} via ${route.primaryProvider})`
          );
        } else {
          this.addNotification(`Current active model: ${this.activeModel}`);
        }
        break;

      case '/clear':
        sessionStore.clearActiveSession();
        this.uiNotifications = [];
        this.addNotification('Session history cleared.');
        break;

      case '/sessions': {
        const list = sessionStore
          .listSessions()
          .map((s) => `• [${s.id}] ${s.title} (${s.messageCount} msgs)`)
          .join('\n');
        this.addNotification(`SAVED SESSIONS:\n${list}`);
        break;
      }

      case '/cheap':
        if (arg) await this.handleUserMessage(arg, 'cheap');
        break;

      case '/smart':
        if (arg) await this.handleUserMessage(arg, 'smart');
        break;

      case '/plan':
        if (arg) {
          this.addNotification(`Executing Mission Pipeline: "${arg}"`);
          const report = await missionRunner.executeMission(arg, { signal: this.abortController?.signal });
          if (!this.abortController?.signal.aborted) {
            this.addNotification(`[Mission Result]: ${report.summary}`);
          }
        }
        break;

      case '/exit':
        terminalScreen.leaveAlternateScreen();
        process.exit(0);

      default:
        this.addNotification(`Unknown command: ${cmdStr}. Type /help for options.`);
        break;
    }
  }

  private async handleUserMessage(text: string, overrideMode?: 'cheap' | 'smart'): Promise<void> {
    sessionStore.addMessage('user', text);
    if (sessionStore.getActiveSession().messages.length > 25) {
      sessionStore.compactContext();
    }
    this.render();

    const signal = this.abortController?.signal;
    const options: RouterOptions = {
      model: this.activeModel,
      mode: overrideMode || this.activeMode,
      signal
    };

    // Snapshot: the stream must not observe messages appended while it runs
    const messages = [...sessionStore.getActiveSession().messages];
    let fullResponse = '';

    try {
      for await (const chunk of chatRouter.dispatch(messages, options)) {
        if (chunk.delta) {
          fullResponse += chunk.delta;
        }
        if (chunk.error) {
          this.addNotification(`[Stream Error]: ${chunk.error}`);
        }
      }
      if (signal?.aborted) {
        return; // Discard the partial answer; the cancel notice was already shown
      }
      if (fullResponse.trim()) {
        sessionStore.addMessage('assistant', fullResponse);
      }
    } catch (err: any) {
      this.addNotification(`[Stream Error]: ${err.message}`);
    }
  }
}

export const openCodeTUIEngine = new OpenCodeTUIEngine();
