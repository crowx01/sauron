import { configManager } from '../config';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

export interface RouteOutcome {
  model: string;
  provider: string;
  success: boolean;
  latencyMs: number;
  taskCategory?: string;
  costRank?: number;
  error?: string;
  timestamp: number;
}

export interface LedgerEntry {
  provider: string;
  model: string;
  taskCategory: string;
  total: number;
  successes: number;
  failures: number;
  successRate: number;
  avgLatency: number;
  avgCostRank: number;
  recentSuccessRate: number;
  lastTimestamp: number;
}

export type ErrorClass = 'rate_limit' | 'transient' | 'persistent' | 'request';

export function classifyError(error?: string): ErrorClass | undefined {
  if (!error) return undefined;
  const e = error.toLowerCase();
  if (e.includes('429') || e.includes('529') || e.includes('rate limit') || e.includes('quota') || e.includes('overloaded')) {
    return 'rate_limit';
  }
  if (e.includes('500') || e.includes('502') || e.includes('503') || e.includes('504') || e.includes('econnreset') || e.includes('etimedout')) {
    return 'transient';
  }
  if (e.includes('401') || e.includes('403') || e.includes('404') || e.includes('not found') || e.includes('unauthorized')) {
    return 'persistent';
  }
  return 'request';
}

export interface CooldownEntry {
  until: number;
  strikes: number;
}

export class LessonStore {
  private outcomes: RouteOutcome[] = [];
  private cooldowns: Map<string, CooldownEntry> = new Map();

  constructor() {
    this.load();
  }

  private getFilePath(): string {
    return join(configManager.getConfig().sauronDir, 'lessons.json');
  }

  public isCooledDown(provider: string, model: string): boolean {
    const pEntry = this.cooldowns.get(`provider:${provider}`);
    if (pEntry && Date.now() < pEntry.until) return true;
    const mEntry = this.cooldowns.get(`model:${model}`);
    if (mEntry && Date.now() < mEntry.until) return true;
    return false;
  }

  public record(outcome: Omit<RouteOutcome, 'timestamp'>): void {
    const entry: RouteOutcome = {
      ...outcome,
      taskCategory: outcome.taskCategory || 'general',
      costRank: outcome.costRank ?? 1,
      timestamp: Date.now()
    };
    this.outcomes.push(entry);
    if (this.outcomes.length > 500) {
      this.outcomes.shift();
    }

    // Cooldown management
    if (!outcome.success) {
      const errClass = classifyError(outcome.error);
      if (errClass === 'rate_limit') {
        const key = `provider:${outcome.provider}`;
        const cur = this.cooldowns.get(key) || { until: 0, strikes: 0 };
        const strikes = cur.strikes + 1;
        const backoffMs = Math.min(10000 * Math.pow(2, strikes - 1), 300000);
        this.cooldowns.set(key, { until: Date.now() + backoffMs, strikes });
      } else if (errClass === 'transient' || errClass === 'persistent') {
        const key = `model:${outcome.model}`;
        const cur = this.cooldowns.get(key) || { until: 0, strikes: 0 };
        const strikes = cur.strikes + 1;
        const backoffMs = Math.min(5000 * Math.pow(2, strikes - 1), 120000);
        this.cooldowns.set(key, { until: Date.now() + backoffMs, strikes });
      }
    } else {
      this.cooldowns.delete(`model:${outcome.model}`);
      this.cooldowns.delete(`provider:${outcome.provider}`);
    }

    this.save();
  }

  public getLedger(provider?: string, model?: string, taskCategory?: string): LedgerEntry[] {
    const map = new Map<string, RouteOutcome[]>();

    for (const o of this.outcomes) {
      if (provider && o.provider !== provider) continue;
      if (model && o.model !== model) continue;
      const cat = o.taskCategory || 'general';
      if (taskCategory && cat !== taskCategory) continue;

      const key = `${o.provider || 'unknown'}:${o.model}:${cat}`;
      const list = map.get(key) || [];
      list.push(o);
      map.set(key, list);
    }

    const ledger: LedgerEntry[] = [];
    const now = Date.now();

    for (const [key, list] of map.entries()) {
      const parts = key.split(':');
      const p = parts[0];
      const m = parts[1];
      const cat = parts.slice(2).join(':');
      const total = list.length;
      const successes = list.filter((item) => item.success).length;
      const failures = total - successes;
      const successRate = total > 0 ? successes / total : 1.0;
      const avgLatency = Math.round(list.reduce((acc, item) => acc + item.latencyMs, 0) / total);
      const totalCostRank = list.reduce((acc, item) => acc + (item.costRank ?? 1), 0);
      const avgCostRank = Math.round((totalCostRank / total) * 10) / 10;

      let weightedSuccesses = 0;
      let totalWeight = 0;
      for (const item of list.slice(-10)) {
        const ageMinutes = (now - item.timestamp) / 60000;
        const weight = Math.max(0.1, Math.pow(0.5, ageMinutes / 15));
        totalWeight += weight;
        if (item.success) weightedSuccesses += weight;
      }
      const recentSuccessRate = totalWeight > 0 ? weightedSuccesses / totalWeight : successRate;
      const lastTimestamp = Math.max(...list.map((item) => item.timestamp));

      ledger.push({
        provider: p,
        model: m,
        taskCategory: cat,
        total,
        successes,
        failures,
        successRate,
        avgLatency,
        avgCostRank,
        recentSuccessRate,
        lastTimestamp
      });
    }

    return ledger;
  }

  public getStats(): Record<string, { total: number; successes: number; failures: number; avgLatency: number; successRate: number; avgCostRank?: number }> {
    const stats: Record<string, { total: number; successes: number; failures: number; avgLatency: number; successRate: number; avgCostRank?: number }> = {};

    for (const o of this.outcomes) {
      if (!stats[o.model]) {
        stats[o.model] = { total: 0, successes: 0, failures: 0, avgLatency: 0, successRate: 1.0, avgCostRank: 1 };
      }
      stats[o.model].total++;
      if (o.success) stats[o.model].successes++;
      else stats[o.model].failures++;
      stats[o.model].avgLatency = Math.round(
        (stats[o.model].avgLatency * (stats[o.model].total - 1) + o.latencyMs) / stats[o.model].total
      );
      stats[o.model].successRate = stats[o.model].total > 0
        ? stats[o.model].successes / stats[o.model].total
        : 1.0;
      stats[o.model].avgCostRank = Math.round(
        (((stats[o.model].avgCostRank ?? 1) * (stats[o.model].total - 1) + (o.costRank ?? 1)) / stats[o.model].total) * 10
      ) / 10;
    }

    return stats;
  }

  public getBias(provider: string, model: string, taskCategory?: string): number {
    if (this.isCooledDown(provider, model)) {
      return 0.1;
    }

    let matching = this.outcomes.filter(
      (o) => o.model === model && (!o.provider || !provider || o.provider === provider)
    );

    if (taskCategory && matching.some((o) => o.taskCategory === taskCategory)) {
      matching = matching.filter((o) => o.taskCategory === taskCategory);
    }

    const recent = matching.slice(-10);
    if (recent.length === 0) return 1.0;

    const now = Date.now();
    let weightedSuccesses = 0;
    let totalWeight = 0;

    for (const o of recent) {
      const ageMinutes = (now - o.timestamp) / 60000;
      const weight = Math.max(0.1, Math.pow(0.5, ageMinutes / 15));
      totalWeight += weight;
      if (o.success) weightedSuccesses += weight;
    }

    const rate = totalWeight > 0 ? weightedSuccesses / totalWeight : 1.0;

    if (rate >= 0.9) return 1.1;
    if (rate >= 0.7) return 1.0;
    if (rate >= 0.5) return 0.8;
    if (rate >= 0.2) return 0.5;
    return 0.2;
  }

  public clear(): void {
    this.outcomes = [];
    this.cooldowns.clear();
    const filePath = this.getFilePath();
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {}
  }

  public save(): void {
    try {
      const filePath = this.getFilePath();
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.outcomes, null, 2), { mode: 0o600, encoding: 'utf-8' });
      renameSync(tmpPath, filePath);
    } catch (e) {}
  }

  public load(): void {
    try {
      const filePath = this.getFilePath();
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.outcomes = parsed.filter(
            (item) => item && typeof item.model === 'string' && typeof item.success === 'boolean'
          );
        }
      }
    } catch (e) {}
  }
}

export const lessonStore = new LessonStore();

