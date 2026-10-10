import { Message, Session } from '../types';
import { configManager } from '../config';
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';

export class SessionStore {
  private activeSession?: Session;

  public getActiveSession(): Session {
    if (!this.activeSession) {
      this.activeSession = this.createSession('New Session');
    }
    return this.activeSession;
  }

  public createSession(title: string = 'New Conversation'): Session {
    const session: Session = {
      id: `session_${Date.now()}_${randomUUID().slice(0, 8)}`,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    this.activeSession = session;
    this.saveSession(session);
    return session;
  }

  public addMessage(role: 'user' | 'assistant' | 'system' | 'tool', content: string): Message {
    const session = this.getActiveSession();
    const msg: Message = {
      id: `msg_${Date.now()}_${randomUUID().slice(0, 8)}`,
      role,
      content,
      timestamp: Date.now()
    };
    session.messages.push(msg);
    session.updatedAt = Date.now();
    this.saveSession(session);
    return msg;
  }

  public saveSession(session: Session): void {
    const sessionDir = configManager.getConfig().sessionDir;
    const safeId = basename(session.id.replace(/[^a-zA-Z0-9_\-]/g, ''));
    const finalPath = join(sessionDir, `${safeId}.json`);
    const tmpPath = join(sessionDir, `${safeId}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);

    const data = JSON.stringify(session, null, 2);
    // Atomic write: write to temp file then atomic rename
    try {
      writeFileSync(tmpPath, data, { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmpPath, finalPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }

  public loadSession(sessionId: string): Session | undefined {
    const sessionDir = configManager.getConfig().sessionDir;
    const safeId = basename(sessionId.replace(/[^a-zA-Z0-9_\-]/g, ''));
    if (!safeId) return undefined;

    const filePath = join(sessionDir, `${safeId}.json`);
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const session = JSON.parse(raw);
        if (session && Array.isArray(session.messages)) {
          this.activeSession = session;
          return session;
        }
      } catch (err) {
        // Quarantine corrupt file
        try {
          renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
        } catch (e) {}
      }
    }
    return undefined;
  }

  public listSessions(): { id: string; title: string; updatedAt: number; messageCount: number }[] {
    const sessionDir = configManager.getConfig().sessionDir;
    if (!existsSync(sessionDir)) return [];

    const out: { id: string; title: string; updatedAt: number; messageCount: number }[] = [];
    try {
      const files = readdirSync(sessionDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const fullPath = join(sessionDir, file);
        try {
          const raw = readFileSync(fullPath, 'utf-8');
          const parsed = JSON.parse(raw) as Session;
          if (parsed && parsed.id && Array.isArray(parsed.messages)) {
            out.push({
              id: parsed.id,
              title: parsed.title || 'Untitled Session',
              updatedAt: parsed.updatedAt || 0,
              messageCount: parsed.messages.length
            });
          }
        } catch (err) {
          // Quarantine corrupt file without breaking listSessions!
          try {
            renameSync(fullPath, `${fullPath}.corrupt-${Date.now()}`);
          } catch (e) {}
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      return [];
    }
  }

  public clearActiveSession(): void {
    const session = this.getActiveSession();
    session.messages = [];
    session.updatedAt = Date.now();
    this.saveSession(session);
  }

  public compactContext(sessionId?: string): void {
    const session = sessionId ? (this.loadSession(sessionId) || this.getActiveSession()) : this.getActiveSession();
    if (session.messages.length > 10) {
      const system = session.messages.filter((m) => m.role === 'system');
      const nonSystem = session.messages.filter((m) => m.role !== 'system');
      const recent = nonSystem.slice(-6);
      const older = nonSystem.slice(0, -6);

      if (older.length === 0) return;

      // 1. Archive older raw messages to sidecar JSONL so nothing is ever lost
      this.archiveMessages(session.id, older);

      // 2. Extract structured facts (file paths, target IPs, tools, key findings)
      const extracted = this.extractStructuredFacts(older);

      // 3. Formulate structured summary message
      const oldSummary: Message = {
        id: `summary_${Date.now()}`,
        role: 'system',
        content: `[Compact Context Summary - Compressed ${older.length} turns]\n` +
          `• Target Artifacts & Paths: ${extracted.artifacts.join(', ') || 'None'}\n` +
          `• Discovered Hosts & Network: ${extracted.networkEntities.join(', ') || 'None'}\n` +
          `• Tools Executed: ${extracted.toolsUsed.join(', ') || 'None'}\n` +
          `• Key Extracted Findings: ${extracted.findingsExcerpt || 'Previous turns summarized.'}`,
        timestamp: Date.now()
      };

      session.messages = [...system, oldSummary, ...recent];
      session.updatedAt = Date.now();
      this.saveSession(session);
    }
  }

  private archiveMessages(sessionId: string, messages: Message[]): void {
    try {
      const sessionDir = configManager.getConfig().sessionDir;
      const safeId = basename(sessionId.replace(/[^a-zA-Z0-9_\-]/g, ''));
      const archivePath = join(sessionDir, `${safeId}.archive.jsonl`);
      const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
      appendFileSync(archivePath, lines, { encoding: 'utf-8', mode: 0o600 });
    } catch {}
  }

  private extractStructuredFacts(messages: Message[]): {
    artifacts: string[];
    networkEntities: string[];
    toolsUsed: string[];
    findingsExcerpt: string;
  } {
    const artifacts = new Set<string>();
    const networkEntities = new Set<string>();
    const toolsUsed = new Set<string>();
    const findings: string[] = [];

    const pathRegex = /(?:\/[\w.\-]+)+(?:\/)?/g;
    const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    const toolRegex = /⚡\s*\[Tool:\s*(\w+)\]|<tool_call\s+name=["'](\w+)["']/g;

    for (const msg of messages) {
      const paths = msg.content.match(pathRegex);
      if (paths) {
        for (const p of paths.slice(0, 5)) {
          if (p.length > 3 && !p.startsWith('//')) artifacts.add(p);
        }
      }

      const ips = msg.content.match(ipRegex);
      if (ips) {
        for (const ip of ips.slice(0, 5)) networkEntities.add(ip);
      }

      let match;
      while ((match = toolRegex.exec(msg.content)) !== null) {
        toolsUsed.add(match[1] || match[2]);
      }

      if (msg.role === 'assistant' && msg.content.length > 10) {
        findings.push(msg.content.slice(0, 80).replace(/\n/g, ' '));
      }
    }

    return {
      artifacts: Array.from(artifacts).slice(0, 5),
      networkEntities: Array.from(networkEntities).slice(0, 5),
      toolsUsed: Array.from(toolsUsed).slice(0, 5),
      findingsExcerpt: findings.slice(-2).join(' | ').slice(0, 200) || 'Previous operations archived.'
    };
  }
}

export const sessionStore = new SessionStore();
