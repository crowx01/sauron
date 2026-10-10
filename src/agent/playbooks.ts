import { configManager } from '../config';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface ExecutionStep {
  tool: string;
  args: Record<string, any>;
  stdout: string;
  stderr?: string;
  exitCode: number;
  durationMs: number;
  timestamp: number;
}

export interface ExecutionTrace {
  id: string;
  goal: string;
  steps: ExecutionStep[];
  outcome: 'success' | 'partial' | 'failure';
  targetContext?: Record<string, any>;
}

export interface PlaybookStep {
  id: string;
  tool: string;
  argsTemplate: Record<string, string>;
  dependsOn?: string[];
}

export interface Playbook {
  id: string;
  name: string;
  category: 'recon' | 'service-inspect' | 'privilege-audit' | 'log-analysis' | 'network-discovery';
  description: string;
  template: PlaybookStep[];
  successRate: number;
  usageCount: number;
  sourceTraceIds: string[];
}

export class PlaybookStore {
  private playbooks: Map<string, Playbook> = new Map();
  private traces: ExecutionTrace[] = [];

  constructor() {
    this.ensureDir();
    this.loadSeeds();
    this.load();
  }

  private getDir(): string {
    return join(configManager.getConfig().sauronDir, 'playbooks');
  }

  private ensureDir(): void {
    const dir = this.getDir();
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch {}
    }
  }

  private loadSeeds(): void {
    const seeds: Playbook[] = [
      {
        id: 'pb_host_recon',
        name: 'Host Architecture & Kernel Recon',
        category: 'recon',
        description: 'Standard reconnaissance playbook for operating system, kernel release, and hardware architecture',
        template: [
          { id: 'step_1', tool: 'bash', argsTemplate: { command: 'uname -s && uname -m && uname -r' } },
          { id: 'step_2', tool: 'bash', argsTemplate: { command: 'uptime && whoami' }, dependsOn: ['step_1'] }
        ],
        successRate: 1.0,
        usageCount: 10,
        sourceTraceIds: ['seed_recon']
      },
      {
        id: 'pb_priv_audit',
        name: 'User Identity & Permission Audit',
        category: 'privilege-audit',
        description: 'Audit current process UID, GID, group memberships, and user context',
        template: [
          { id: 'step_1', tool: 'bash', argsTemplate: { command: 'id && whoami' } },
          { id: 'step_2', tool: 'bash', argsTemplate: { command: 'groups' }, dependsOn: ['step_1'] }
        ],
        successRate: 1.0,
        usageCount: 8,
        sourceTraceIds: ['seed_priv']
      },
      {
        id: 'pb_network_discovery',
        name: 'Network Interface & Link Enumeration',
        category: 'network-discovery',
        description: 'Enumerate network interfaces, assigned IP addresses, and routing state',
        template: [
          { id: 'step_1', tool: 'bash', argsTemplate: { command: 'ip addr || ifconfig -a' } },
          { id: 'step_2', tool: 'bash', argsTemplate: { command: 'ip route || netstat -rn' }, dependsOn: ['step_1'] }
        ],
        successRate: 1.0,
        usageCount: 6,
        sourceTraceIds: ['seed_net']
      }
    ];

    for (const p of seeds) {
      this.playbooks.set(p.id, p);
    }
  }

  public recordTrace(trace: ExecutionTrace): void {
    this.traces.push(trace);
    if (this.traces.length > 200) {
      this.traces.shift();
    }
    if (trace.outcome === 'success' && trace.steps.length > 0) {
      this.extractPlaybook(trace);
    }
  }

  public extractPlaybook(trace: ExecutionTrace): Playbook {
    const targetName = `Playbook: ${trace.goal.slice(0, 40)}`;
    const existing = Array.from(this.playbooks.values()).find(
      (p) => p.name.toLowerCase() === targetName.toLowerCase()
    );
    if (existing) {
      existing.usageCount++;
      existing.successRate = (existing.successRate * (existing.usageCount - 1) + 1.0) / existing.usageCount;
      this.savePlaybook(existing);
      return existing;
    }

    const category = this.categorizeGoal(trace.goal);
    const playbook: Playbook = {
      id: `pb_${randomUUID().slice(0, 8)}`,
      name: targetName,
      category,
      description: `Autonomous playbook distilled from successful goal: "${trace.goal}"`,
      template: trace.steps.map((s, idx) => ({
        id: `step_${idx + 1}`,
        tool: s.tool,
        argsTemplate: Object.fromEntries(
          Object.entries(s.args).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
        ),
        dependsOn: idx > 0 ? [`step_${idx}`] : undefined
      })),
      successRate: 1.0,
      usageCount: 1,
      sourceTraceIds: [trace.id]
    };

    this.playbooks.set(playbook.id, playbook);
    this.savePlaybook(playbook);
    return playbook;
  }

  public recall(goal: string, topK: number = 2): Playbook[] {
    const category = this.categorizeGoal(goal);
    const matches: { playbook: Playbook; score: number }[] = [];

    const goalLower = goal.toLowerCase();

    for (const pb of this.playbooks.values()) {
      let score = 0;
      if (pb.category === category) score += 3.0;

      // Strong boost for title overlap
      const rawTitle = pb.name.toLowerCase().replace('playbook: ', '');
      if (goalLower.includes(rawTitle) || rawTitle.includes(goalLower)) {
        score += 15.0;
      }

      const keywords = pb.name.toLowerCase().split(/\s+/);
      for (const kw of keywords) {
        if (kw.length > 3 && goalLower.includes(kw)) score += 2.0;
      }

      score += pb.successRate * 2.0;
      score += Math.min(pb.usageCount * 0.1, 1.0);

      matches.push({ playbook: pb, score });
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, topK).map((m) => m.playbook);
  }

  public instantiate(playbook: Playbook, bindings: Record<string, string> = {}): PlaybookStep[] {
    return playbook.template.map((step) => {
      const instantiatedArgs: Record<string, string> = {};
      for (const [k, v] of Object.entries(step.argsTemplate)) {
        let replaced = v;
        for (const [bKey, bVal] of Object.entries(bindings)) {
          replaced = replaced.replaceAll(`{{${bKey}}}`, bVal);
        }
        instantiatedArgs[k] = replaced;
      }
      return {
        ...step,
        argsTemplate: instantiatedArgs
      };
    });
  }

  public reportOutcome(playbookId: string, success: boolean): void {
    const pb = this.playbooks.get(playbookId);
    if (!pb) return;
    pb.usageCount++;
    const weight = success ? 1.0 : 0.0;
    pb.successRate = (pb.successRate * (pb.usageCount - 1) + weight) / pb.usageCount;
    this.savePlaybook(pb);
  }

  private categorizeGoal(goal: string): Playbook['category'] {
    const g = goal.toLowerCase();
    if (g.includes('user') || g.includes('identity') || g.includes('permission') || g.includes('whoami')) {
      return 'privilege-audit';
    }
    if (g.includes('net') || g.includes('ip') || g.includes('port') || g.includes('interface')) {
      return 'network-discovery';
    }
    if (g.includes('log') || g.includes('auth') || g.includes('audit')) {
      return 'log-analysis';
    }
    return 'recon';
  }

  private savePlaybook(playbook: Playbook): void {
    try {
      const filePath = join(this.getDir(), `${playbook.id}.json`);
      const tmpPath = `${filePath}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(playbook, null, 2), { mode: 0o600, encoding: 'utf-8' });
      renameSync(tmpPath, filePath);
    } catch {}
  }

  private load(): void {
    try {
      const dir = this.getDir();
      if (!existsSync(dir)) return;
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const pb = JSON.parse(raw) as Playbook;
        if (pb && pb.id && Array.isArray(pb.template)) {
          this.playbooks.set(pb.id, pb);
        }
      }
    } catch {}
  }

  public listPlaybooks(): Playbook[] {
    return Array.from(this.playbooks.values());
  }

  public clear(): void {
    this.playbooks.clear();
    this.traces = [];
    this.loadSeeds();
  }
}

export const playbookStore = new PlaybookStore();
