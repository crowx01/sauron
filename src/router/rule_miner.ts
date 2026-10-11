import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { configManager } from '../config';
import { lessonStore, RouteOutcome } from './lessons';
import { templatePrompt } from './action_cache';

export interface CompiledRule {
  ruleId: string;
  category: string;
  promptSkeleton: string;
  responsePattern?: string;
  successCount: number;
}

export interface RuleMatchResult {
  matched: boolean;
  ruleId?: string;
  response?: string;
}

export class RuleMiner {
  private getCompiledRulesPath(): string {
    const sauronDir = configManager.getSauronDir();
    return join(sauronDir, 'compiled_rules.ts');
  }

  /**
   * Scans lessonStore outcomes for (taskCategory, promptSkeleton) pairs with:
   * - >= 3 consecutive clean successes
   * - 0 corrections overall for that pair (or invalidated if correction within 2 turns of rule-driven execution)
   */
  public mineRules(): CompiledRule[] {
    const rawOutcomes = lessonStore.getRawOutcomes();
    if (!rawOutcomes || rawOutcomes.length === 0) {
      this.generateRulesFile([]);
      return [];
    }

    // 1. Group records chronologically by key (category:skeleton)
    const grouped = new Map<string, RouteOutcome[]>();
    for (let i = 0; i < rawOutcomes.length; i++) {
      const outcome = rawOutcomes[i];
      const skeleton = outcome.promptSkeleton || ((outcome as any).prompt ? templatePrompt((outcome as any).prompt).skeleton : undefined);
      const cat = outcome.taskCategory || 'general';
      if (!skeleton) continue;

      const key = `${cat}:::${skeleton}`;
      const list = grouped.get(key) || [];
      list.push(outcome);
      grouped.set(key, list);
    }

    // Check invalidation across turns:
    // Any user correction within 2 turns of a rule-driven response must invalidate that rule
    // (remove from promotion set).
    const invalidatedSkeletons = new Set<string>();

    for (let i = 0; i < rawOutcomes.length; i++) {
      const curr = rawOutcomes[i];
      if (curr.isCorrection) {
        // Look back up to 2 turns for any rule-driven response
        for (let j = Math.max(0, i - 2); j < i; j++) {
          const prior = rawOutcomes[j];
          if (prior.ruleDriven && prior.promptSkeleton) {
            invalidatedSkeletons.add(`${prior.taskCategory || 'general'}:::${prior.promptSkeleton}`);
          }
        }
      }
    }

    const candidateRules: CompiledRule[] = [];

    for (const [key, outcomes] of grouped.entries()) {
      if (invalidatedSkeletons.has(key)) {
        continue;
      }

      // Check if any outcome in this group was marked as a direct correction
      const hasCorrection = outcomes.some((o) => o.isCorrection === true);
      if (hasCorrection) {
        continue;
      }

      // Check consecutive clean successes (at the tail or count >= 3 consecutive successes without intervening failures)
      // Spec: ">=3 consecutive clean successes and 0 corrections"
      let maxConsecutiveSuccesses = 0;
      let curConsecutive = 0;
      for (const o of outcomes) {
        if (o.success) {
          curConsecutive++;
          if (curConsecutive > maxConsecutiveSuccesses) {
            maxConsecutiveSuccesses = curConsecutive;
          }
        } else {
          curConsecutive = 0;
        }
      }

      if (maxConsecutiveSuccesses >= 3) {
        const [category, ...rest] = key.split(':::');
        const skeleton = rest.join(':::');
        const ruleId = `rule_${Math.abs(this.hashString(key)).toString(16)}`;

        candidateRules.push({
          ruleId,
          category,
          promptSkeleton: skeleton,
          successCount: maxConsecutiveSuccesses
        });
      }
    }

    this.generateRulesFile(candidateRules);
    return candidateRules;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  /**
   * Generates ~/.sauron/compiled_rules.ts idempotently.
   */
  public generateRulesFile(rules: CompiledRule[]): string {
    const filePath = this.getCompiledRulesPath();
    const tsCode = this.renderRulesCode(rules);
    try {
      writeFileSync(filePath, tsCode, 'utf-8');
    } catch (err) {
      // In tests or environments where ~/.sauron might need directory creation
    }
    return filePath;
  }

  private renderRulesCode(rules: CompiledRule[]): string {
    const rulesJson = JSON.stringify(rules, null, 2);
    return `// GENERATED FILE - DO NOT HAND-EDIT.
// Regenerated automatically by Sauron RuleMiner from clean lesson ledger records.

export interface RuleMatch {
  matched: boolean;
  ruleId?: string;
  response?: string;
}

export const COMPILED_RULES = ${rulesJson};

export function matchRule(prompt: string, category: string = 'general'): RuleMatch {
  if (!prompt) return { matched: false };
  const normalizedPrompt = prompt.trim().toLowerCase();

  for (const rule of COMPILED_RULES) {
    if (rule.category && rule.category !== category && category !== 'general') {
      continue;
    }
    const skeleton = rule.promptSkeleton.toLowerCase();
    if (skeleton === normalizedPrompt) {
      return {
        matched: true,
        ruleId: rule.ruleId,
        response: '[Compiled Rule ' + rule.ruleId + ']: matched skeleton "' + rule.promptSkeleton + '"'
      };
    }

    const regexPattern = skeleton
      .replace(/[\.\*\\+\\?\\^\\$\\(\\)\\|\\[\\]\\\\\\{\\}]/g, '\\\\$&')
      .replace(/<slot:[^>]+>/g, '[^\\\\s]+')
      .replace(/\\\{slot\\\}/g, '[^\\\\s]+')
      .replace(/\\\{file\\\}/g, '[^\\\\s]+')
      .replace(/\\\{str\\\}/g, '[^\\\\s]+')
      .replace(/\\\{num\\\}/g, '\\\\d+');

    try {
      const rx = new RegExp('^' + regexPattern + '$', 'i');
      if (rx.test(normalizedPrompt)) {
        return {
          matched: true,
          ruleId: rule.ruleId,
          response: '[Compiled Rule ' + rule.ruleId + ']: matched pattern for "' + rule.promptSkeleton + '"'
        };
      }
    } catch {}
  }

  return { matched: false };
}
`;
  }

  /**
   * Fast in-memory check against current compiled rules without loading dynamic imports
   */
  public matchCurrentRules(prompt: string, category: string = 'general'): RuleMatchResult {
    if (!prompt) return { matched: false };
    const filePath = this.getCompiledRulesPath();
    if (!existsSync(filePath)) {
      return { matched: false };
    }

    try {
      // Read file and parse COMPILED_RULES directly for safety & speed
      const content = require('node:fs').readFileSync(filePath, 'utf-8');
      const jsonMatch = content.match(/export const COMPILED_RULES = (\[[\s\S]*?\]);/);
      if (jsonMatch && jsonMatch[1]) {
        const rules: CompiledRule[] = JSON.parse(jsonMatch[1]);
        const normalizedPrompt = prompt.trim().toLowerCase();
        for (const rule of rules) {
          if (rule.category && rule.category !== category && category !== 'general') {
            continue;
          }
          const skeleton = rule.promptSkeleton.toLowerCase();
          if (skeleton === normalizedPrompt) {
            return {
              matched: true,
              ruleId: rule.ruleId,
              response: `[Compiled Rule ${rule.ruleId}]: matched skeleton "${rule.promptSkeleton}"`
            };
          }

          const regexPattern = skeleton
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/<slot:[^>]+>/g, '[^\\s]+')
            .replace(/\\\{slot\\\}/g, '[^\\s]+')
            .replace(/\\\{file\\\}/g, '[^\\s]+')
            .replace(/\\\{str\\\}/g, '[^\\s]+')
            .replace(/\\\{num\\\}/g, '\\d+');

          try {
            const rx = new RegExp('^' + regexPattern + '$', 'i');
            if (rx.test(normalizedPrompt)) {
              return {
                matched: true,
                ruleId: rule.ruleId,
                response: `[Compiled Rule ${rule.ruleId}]: matched pattern for "${rule.promptSkeleton}"`
              };
            }
          } catch {}
        }
      }
    } catch {}

    return { matched: false };
  }
}

export const ruleMiner = new RuleMiner();
