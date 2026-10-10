export interface ScreenSize {
  columns: number;
  rows: number;
}

export class TerminalScreen {
  private isRawMode: boolean = false;
  private currentFrame: string[] = [];

  private active: boolean = false;
  private cleanupInstalled: boolean = false;
  private onInterrupt?: () => boolean;

  public setInterruptHandler(fn: () => boolean): void {
    this.onInterrupt = fn;
  }

  public getSize(): ScreenSize {
    return {
      columns: process.stdout.columns || 80,
      rows: process.stdout.rows || 24
    };
  }

  public enterAlternateScreen(): void {
    this.active = true;
    this.setupCleanup();
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?1049h'); // Enter alternate screen buffer
      process.stdout.write('\x1b[?25h');  // Ensure cursor visible
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
        this.isRawMode = true;
      }
      process.stdin.resume();
    }
  }

  public leaveAlternateScreen(): void {
    // Idempotent, and a no-op for headless commands (no stray escape codes on exit)
    if (!this.active) return;
    this.active = false;
    if (process.stdout.isTTY) {
      if (this.isRawMode && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
        this.isRawMode = false;
      }
      process.stdout.write('\x1b[?1049l'); // Leave alternate screen buffer
      process.stdout.write('\x1b[?25h');  // Show cursor
      process.stdout.write('\x1b[0m\n');  // Reset formatting
    }
  }

  private setupCleanup(): void {
    if (this.cleanupInstalled) return;
    this.cleanupInstalled = true;
    const exitHandler = () => {
      this.leaveAlternateScreen();
    };

    process.on('SIGINT', () => {
      if (this.onInterrupt && this.onInterrupt()) {
        return;
      }
      exitHandler();
      process.exit(130);
    });

    process.on('SIGTERM', () => {
      exitHandler();
      process.exit(143);
    });

    process.on('uncaughtException', (err) => {
      exitHandler();
      console.error('[Terminal Panic] Uncaught exception:', err);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      exitHandler();
      console.error('[Terminal Panic] Unhandled rejection:', reason);
      process.exit(1);
    });

    process.on('exit', () => {
      exitHandler();
    });
  }

  public renderFrame(lines: string[]): void {
    if (!process.stdout.isTTY) {
      // In non-TTY / test mode, print lines cleanly
      console.log(lines.join('\n'));
      return;
    }

    const { rows } = this.getSize();
    const frame = lines.slice(0, rows);

    // Synchronized update start
    process.stdout.write('\x1b[?2026h');
    process.stdout.write('\x1b[H\x1b[J'); // Move to top home and clear screen

    for (let i = 0; i < frame.length; i++) {
      process.stdout.write(frame[i] + '\n');
    }

    // Synchronized update end
    process.stdout.write('\x1b[?2026l');
    this.currentFrame = frame;
  }
}

export const terminalScreen = new TerminalScreen();
