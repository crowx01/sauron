import { configManager } from '../config';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

export interface CommandFallbackChain {
  capability: string;
  primary: string;
  fallbacks: string[];
}

export class ToolResolver {
  private chains: Map<string, CommandFallbackChain> = new Map();
  private learnedSubstitutions: Map<string, string> = new Map();

  constructor() {
    this.registerDefaults();
    this.loadResolutions();
  }

  private registerDefaults(): void {
    const defaultChains: CommandFallbackChain[] = [
      {
        capability: 'list_processes',
        primary: 'ps aux',
        fallbacks: ['ps -ef', 'ls -d /proc/[0-9]* 2>/dev/null']
      },
      {
        capability: 'network_interfaces',
        primary: 'ip addr',
        fallbacks: ['ifconfig -a', 'cat /proc/net/dev']
      },
      {
        capability: 'network_connections',
        primary: 'ss -tulpn',
        fallbacks: ['netstat -tulpn', 'lsof -i -P -n', 'cat /proc/net/tcp']
      },
      {
        capability: 'network_routes',
        primary: 'ip route',
        fallbacks: ['netstat -rn', 'route -n', 'cat /proc/net/route']
      },
      {
        capability: 'user_identity',
        primary: 'id && whoami',
        fallbacks: ['whoami', 'id -u && id -un', 'cat /etc/passwd | grep -E "^$(whoami):"']
      },
      {
        capability: 'privilege_check',
        primary: 'sudo -l',
        fallbacks: ['groups', 'cat /etc/group | grep -E "sudo|wheel|adm"']
      },
      {
        capability: 'system_info',
        primary: 'uname -a',
        fallbacks: ['cat /proc/version', 'cat /etc/os-release']
      }
    ];

    for (const c of defaultChains) {
      this.chains.set(c.capability, c);
    }
  }

  private getFilePath(): string {
    return join(configManager.getConfig().sauronDir, 'resolutions.json');
  }

  public resolveCommand(cmd: string): string {
    const trimmed = cmd.trim();
    if (this.learnedSubstitutions.has(trimmed)) {
      return this.learnedSubstitutions.get(trimmed)!;
    }
    return trimmed;
  }

  public getAlternativeCommand(failedCmd: string, exitCode: number, errorOutput: string): string | null {
    const lowerError = errorOutput.toLowerCase();
    const isMissingOrDenied =
      exitCode === 127 ||
      lowerError.includes('not found') ||
      lowerError.includes('command not found') ||
      lowerError.includes('no such file') ||
      lowerError.includes('permission denied');

    if (!isMissingOrDenied) return null;

    const trimmed = failedCmd.trim();

    // Match against known chains
    for (const chain of this.chains.values()) {
      if (trimmed === chain.primary || chain.primary.includes(trimmed)) {
        const nextFallback = chain.fallbacks[0];
        if (nextFallback) {
          this.learnedSubstitutions.set(trimmed, nextFallback);
          this.saveResolutions();
          return nextFallback;
        }
      }

      // Check if it was one of the intermediate fallbacks
      const idx = chain.fallbacks.indexOf(trimmed);
      if (idx >= 0 && idx + 1 < chain.fallbacks.length) {
        const nextFallback = chain.fallbacks[idx + 1];
        this.learnedSubstitutions.set(trimmed, nextFallback);
        this.saveResolutions();
        return nextFallback;
      }
    }

    return null;
  }

  public registerLearnedSubstitution(failedCmd: string, workingCmd: string): void {
    this.learnedSubstitutions.set(failedCmd.trim(), workingCmd.trim());
    this.saveResolutions();
  }

  public getLearnedSubstitutions(): Record<string, string> {
    return Object.fromEntries(this.learnedSubstitutions.entries());
  }

  private saveResolutions(): void {
    try {
      const filePath = this.getFilePath();
      const tmpPath = `${filePath}.${Date.now()}.tmp`;
      const data = JSON.stringify(Object.fromEntries(this.learnedSubstitutions), null, 2);
      writeFileSync(tmpPath, data, { mode: 0o600, encoding: 'utf-8' });
      renameSync(tmpPath, filePath);
    } catch {}
  }

  private loadResolutions(): void {
    try {
      const filePath = this.getFilePath();
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') this.learnedSubstitutions.set(k, v);
          }
        }
      }
    } catch {}
  }

  public clear(): void {
    this.learnedSubstitutions.clear();
  }
}

export const toolResolver = new ToolResolver();
