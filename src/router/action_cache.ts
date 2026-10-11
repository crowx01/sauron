// @ts-ignore - bun:sqlite is built-in to the Bun runtime
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configManager } from '../config';

export interface ActionCacheEntry {
  id?: number;
  promptSkeleton: string;
  providerUsed: string;
  modelUsed: string;
  dagOrToolSequence: string; // JSON serialized string of DAG or tool sequence
  success: boolean;
  paramSlots: string; // JSON serialized object of slot types { [slotName: string]: string }
  createdAt: number;
}

/**
 * Extracts param slots and creates a templated prompt skeleton.
 * Identifies IPs, domains, paths, numbers, and quoted literals.
 * E.g., "scan 192.168.1.1 on port 80" ->
 * skeleton: "scan <SLOT:ip> on port <SLOT:number>"
 * slots: { ip: "192.168.1.1", number: "80" }
 */
export function templatePrompt(prompt: string): { skeleton: string; slots: Record<string, string> } {
  const slots: Record<string, string> = {};
  let slotIndex = 0;

  let text = prompt.trim();

  // 1. IPs (IPv4)
  text = text.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (match) => {
    const key = `ip_${slotIndex++}`;
    slots[key] = match;
    return `<SLOT:ip>`;
  });

  // 2. File paths (e.g. /etc/passwd, ./src/index.ts, file.txt)
  text = text.replace(/(?:^|\s)([/~.][\w\-./\\]+\.[a-zA-Z0-9]+)\b/g, (match, pathGroup) => {
    const key = `path_${slotIndex++}`;
    slots[key] = pathGroup;
    return match.replace(pathGroup, `<SLOT:path>`);
  });

  // 3. Quoted strings ("foo" or 'bar')
  text = text.replace(/["']([^"']+)["']/g, (match, inner) => {
    const key = `str_${slotIndex++}`;
    slots[key] = inner;
    return `<SLOT:string>`;
  });

  // 4. Standalone numbers
  text = text.replace(/\b\d+\b/g, (match) => {
    const key = `num_${slotIndex++}`;
    slots[key] = match;
    return `<SLOT:number>`;
  });

  return {
    skeleton: text.toLowerCase().replace(/\s+/g, ' ').trim(),
    slots
  };
}

/**
 * Lightweight local similarity metric proxy:
 * Since no local embedding model is available, we use normalized token-overlap /
 * Jaccard similarity on the templated prompt skeleton as the similarity signal.
 * NOTE: This is an intentional lightweight local proxy to avoid calling out to any paid embedding APIs.
 */
export function jaccardSimilarity(textA: string, textB: string): number {
  if (textA === textB) return 1.0;

  const tokensA = new Set(textA.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(textB.toLowerCase().split(/\s+/).filter(Boolean));

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection++;
    }
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0.0 : intersection / union;
}

export function extractSlotTypes(skeleton: string): string[] {
  const matches = skeleton.match(/<slot:([a-z0-9_-]+)>/gi) || [];
  return matches.map((m) => m.toLowerCase()).sort();
}

export class ActionCache {
  private db: Database | null = null;

  private getDbPath(): string {
    const customHome = process.env.SAURON_HOME;
    const baseDir = customHome || join(homedir(), '.sauron');
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    }
    return join(baseDir, 'action_cache.sqlite');
  }

  public getDb(): Database {
    if (!this.db) {
      const dbPath = this.getDbPath();
      this.db = new Database(dbPath);
      this.initSchema();
    }
    return this.db;
  }

  private initSchema(): void {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS action_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_skeleton TEXT NOT NULL,
        provider_used TEXT NOT NULL,
        model_used TEXT NOT NULL,
        dag_or_tool_sequence TEXT NOT NULL,
        success INTEGER NOT NULL,
        param_slots TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_skeleton ON action_cache(prompt_skeleton);
    `);
  }

  /**
   * Stores a successfully executed dispatch into SQLite action cache.
   */
  public store(entry: {
    prompt: string;
    providerUsed: string;
    modelUsed: string;
    dagOrToolSequence: any;
  }): void {
    try {
      const { skeleton, slots } = templatePrompt(entry.prompt);
      const db = this.getDb();

      const stmt = db.prepare(`
        INSERT INTO action_cache (prompt_skeleton, provider_used, model_used, dag_or_tool_sequence, success, param_slots, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `);

      stmt.run(
        skeleton,
        entry.providerUsed,
        entry.modelUsed,
        typeof entry.dagOrToolSequence === 'string' ? entry.dagOrToolSequence : JSON.stringify(entry.dagOrToolSequence),
        JSON.stringify(slots),
        Date.now()
      );
    } catch {
      // Non-blocking
    }
  }

  /**
   * Looks up a cached tool or DAG sequence matching >= 0.90 similarity and identical param slot types.
   */
  public lookup(prompt: string): {
    hit: boolean;
    entry?: ActionCacheEntry;
    similarity?: number;
    instantiatedSequence?: any;
  } {
    try {
      const { skeleton, slots } = templatePrompt(prompt);
      const querySlotTypes = extractSlotTypes(skeleton);
      const db = this.getDb();

      const rows = db.query(`
        SELECT id, prompt_skeleton as promptSkeleton, provider_used as providerUsed,
               model_used as modelUsed, dag_or_tool_sequence as dagOrToolSequence,
               success, param_slots as paramSlots, created_at as createdAt
        FROM action_cache
        WHERE success = 1
        ORDER BY id DESC
        LIMIT 200
      `).all() as ActionCacheEntry[];

      let bestMatch: ActionCacheEntry | undefined;
      let highestSim = 0;

      for (const row of rows) {
        const rowSlotTypes = extractSlotTypes(row.promptSkeleton);

        // Check if slot types match
        if (querySlotTypes.length !== rowSlotTypes.length) continue;
        const slotsMatch = querySlotTypes.every((val, idx) => val === rowSlotTypes[idx]);
        if (!slotsMatch) continue;

        const sim = jaccardSimilarity(skeleton, row.promptSkeleton);
        if (sim >= 0.90 && sim > highestSim) {
          highestSim = sim;
          bestMatch = row;
        }
      }

      if (bestMatch) {
        let sequence: any;
        try {
          sequence = JSON.parse(bestMatch.dagOrToolSequence);
        } catch {
          sequence = bestMatch.dagOrToolSequence;
        }

        return {
          hit: true,
          entry: bestMatch,
          similarity: highestSim,
          instantiatedSequence: sequence
        };
      }

      return { hit: false };
    } catch {
      return { hit: false };
    }
  }

  public clear(): void {
    try {
      const db = this.getDb();
      db.run(`DELETE FROM action_cache`);
    } catch {}
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const actionCache = new ActionCache();
