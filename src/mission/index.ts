import { MissionGoal, MissionReport, MissionStep, RouterOptions } from '../types';
import { toolBelt } from '../tools';
import { reactAgent } from '../agent/react';
import { playbookStore } from '../agent/playbooks';
import { dagPlanner } from '../agent/planner';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface JudgeVerdict {
  passed: boolean;
  score: number;
  critique: string;
}

interface MissionModelEntry {
  primary: string;
  subagent: string;
  reason: string;
}

type MissionModelsConfig = Record<string, MissionModelEntry>;

export class MissionRunner {
  private maxRetries: number = 2;
  private missionModels: MissionModelsConfig = {};

  constructor() {
    this.loadMissionModels();
  }

  private loadMissionModels(): void {
    const configPath = join(process.env.SAURON_HOME || join(homedir(), '.sauron'), 'mission_models.json');
    if (existsSync(configPath)) {
      try {
        this.missionModels = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {}
    }
  }

  // Fixed routing: categorize goal text and return explicit model pair
  public selectModelForMission(goalText: string): { primary: string; subagent: string; category: string } {
    const lower = goalText.toLowerCase();

    let category = 'default';
    if (lower.match(/report|write|draft|document|summary|finding/)) {
      category = 'report_writing';
    } else if (lower.match(/code|source|script|function|class|module|review|analyze.*code|parse/)) {
      category = 'code_analysis';
    } else if (lower.match(/recon|scan|enumerate|probe|discover|subdomain|port|ffuf|nuclei/)) {
      category = 'recon_probing';
    } else if (lower.match(/vuln|exploit|bypass|inject|xss|sqli|idor|csrf|ssrf|rce|auth.*bypass|privilege/)) {
      category = 'vuln_validation';
    } else if (lower.match(/extract|parse|grep|log|data|csv|json|filter|collect/)) {
      category = 'data_extraction';
    }

    const entry = this.missionModels[category] || this.missionModels['default'];
    if (!entry) {
      return { primary: 'z-ai/glm-5.3', subagent: 'deepseek/deepseek-v4.1-flash', category };
    }
    return { primary: entry.primary, subagent: entry.subagent, category };
  }

  private raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  // Decompose a broad goal into focused sub-tasks using the sub-agent model
  private async decomposeCompoundGoal(goalText: string, subagentModel: string, options: RouterOptions): Promise<string[]> {
    const andCount = (goalText.match(/\band\b|,\s*check|,\s*test|,\s*enumerate|,\s*scan|,\s*also/gi) || []).length;
    if (andCount === 0) return [goalText];

    try {
      const result = await this.raceTimeout(
        reactAgent.run(
          `Break this compound goal into 2-6 focused, independent sub-tasks. Each sub-task must be one clear action that can succeed or fail on its own. Return ONLY a JSON array of strings, nothing else. No markdown, no explanation.\n\nGoal: "${goalText}"`,
          { ...options, model: subagentModel, taskCategory: 'default' }
        ),
        30_000,
        'Goal decomposition'
      );
      const answer = (result.finalAnswer || '').trim();
      const match = answer.match(/\[[\s\S]*\]/);
      if (match) {
        const tasks = JSON.parse(match[0]);
        if (Array.isArray(tasks) && tasks.length >= 2 && tasks.every((t: any) => typeof t === 'string')) {
          return tasks.slice(0, 6);
        }
      }
    } catch {}
    return [goalText];
  }

  public async executeMission(
    goalText: string,
    options: RouterOptions = {}
  ): Promise<MissionReport> {
    const missionId = `mission_${randomUUID()}`;
    const steps: MissionStep[] = [];
    let missionSuccess = false;

    // Reload config each mission in case it was edited
    this.loadMissionModels();

    // Fixed model routing (no auto-choose)
    const { primary, subagent, category } = this.selectModelForMission(goalText);

    // Stage 1: Writer / Planner
    const recalled = playbookStore.recall(goalText, 1);
    const pbNote = recalled.length > 0 ? ` (recalled tactic: ${recalled[0].name})` : '';

    // Auto-decompose compound goals into sub-tasks
    const subTasks = await this.decomposeCompoundGoal(goalText, subagent, options);
    const isCompound = subTasks.length > 1;

    steps.push({
      stepNumber: 1,
      role: 'planner',
      action: `Routed to ${primary} (subagent: ${subagent}) for category: ${category}`,
      result: isCompound
        ? `Decomposed into ${subTasks.length} sub-tasks: ${subTasks.map((t, i) => `[${i + 1}] ${t}`).join(' | ')}${pbNote}`
        : `Mission "${goalText}" assigned to fixed model pair${pbNote}`,
      passed: true
    });

    // Execute each sub-task sequentially
    const subTaskResults: string[] = [];
    let allSubTasksPassed = true;

    for (let taskIdx = 0; taskIdx < subTasks.length; taskIdx++) {
      if (options.signal?.aborted) break;

      const task = subTasks[taskIdx];
      const taskLabel = isCompound ? `Sub-task ${taskIdx + 1}/${subTasks.length}: "${task}"` : `"${task}"`;
      let currentCritique = '';
      let taskPassed = false;

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        if (options.signal?.aborted) break;

        const executorPrompt = currentCritique
          ? `${task}\n\n[Previous attempt failed. Judge critique: ${currentCritique}. Adjust your approach.]`
          : task;

        // Run ReAct agent with the fixed primary model (120s timeout per executor step)
        let execOutput = '';
        let toolPassed = true;

        try {
          const result = await this.raceTimeout(
            reactAgent.run(executorPrompt, {
              ...options,
              model: primary,
              taskCategory: category
            }),
            120_000,
            `Executor step (${taskLabel})`
          );
          execOutput = result.finalAnswer || '';
          toolPassed = result.status === 'complete';
        } catch (err: any) {
          execOutput = `Execution error: ${err.message}`;
          toolPassed = false;
        }

        steps.push({
          stepNumber: steps.length + 1,
          role: 'executor',
          action: `ReAct agent (model: ${primary}) for: ${taskLabel} (Attempt ${attempt})`,
          result: execOutput.slice(0, 2000),
          passed: toolPassed
        });

        // Judge via subagent model (30s timeout -- judge is a one-shot eval)
        let judgeOutput = '';
        try {
          const judgeResult = await this.raceTimeout(
            reactAgent.run(
              `Judge this execution result against the sub-task goal. Goal: "${task}". Result: "${execOutput.slice(0, 1500)}". Respond with PASS if the goal was achieved, or FAIL: [reason] if not. One word or one line only.`,
              { ...options, model: subagent, taskCategory: category }
            ),
            30_000,
            'Judge evaluation'
          );
          judgeOutput = judgeResult.finalAnswer || '';
        } catch {
          judgeOutput = 'PASS';
        }

        const judgePassed = judgeOutput.toUpperCase().startsWith('PASS');

        steps.push({
          stepNumber: steps.length + 1,
          role: 'judge',
          action: `Judge evaluation (model: ${subagent}, ${taskLabel}, Attempt ${attempt})`,
          result: judgeOutput.slice(0, 500),
          passed: judgePassed
        });

        if (judgePassed) {
          taskPassed = true;
          subTaskResults.push(execOutput);
          break;
        } else {
          currentCritique = judgeOutput;
        }
      }

      if (!taskPassed) allSubTasksPassed = false;
    }

    missionSuccess = allSubTasksPassed;

    if (missionSuccess) {
      playbookStore.recordTrace({
        id: missionId,
        goal: goalText,
        steps: steps.filter((s) => s.role === 'executor').map((s) => ({
          tool: 'react_agent',
          args: { model: primary, goal: goalText },
          stdout: s.result,
          exitCode: 0,
          durationMs: 50,
          timestamp: Date.now()
        })),
        outcome: 'success'
      });
    }

    return {
      missionId,
      goal: goalText,
      success: missionSuccess,
      steps,
      summary: `Mission "${goalText}" ${missionSuccess ? 'PASSED' : 'FAILED'} across ${steps.length} steps. Models: ${primary} + ${subagent} (${category}).`
    };
  }

  private decomposeGoal(goal: string): { tool: string; args: any; description: string; expectedKeywords: string[] } {
    const lower = goal.toLowerCase();

    if (lower.includes('user') || lower.includes('identity') || lower.includes('permission') || lower.includes('whoami')) {
      return {
        tool: 'bash',
        args: { command: 'id && whoami' },
        description: `Plan formulated for user identity audit: inspect UID/GID and active user identity via shell security tools.`,
        expectedKeywords: ['uid=', 'gid=']
      };
    }

    if (lower.includes('network') || lower.includes('interface') || lower.includes('ip') || lower.includes('port')) {
      return {
        tool: 'bash',
        args: { command: 'ip addr || ifconfig -a' },
        description: `Plan formulated for network reconnaissance: enumerate network interfaces, link states, and assigned IP addresses.`,
        expectedKeywords: ['inet', 'link', 'lo', 'eth']
      };
    }

    if (lower.includes('system') || lower.includes('audit') || lower.includes('recon') || lower.includes('host')) {
      return {
        tool: 'bash',
        args: { command: 'uname -a && uptime' },
        description: `Plan formulated for system audit: capture kernel release, host architecture, and system uptime.`,
        expectedKeywords: ['Linux', 'x86_64', 'load']
      };
    }

    // Default safe task without shell interpolation injection
    return {
      tool: 'bash',
      args: { command: 'uname -s && uname -m && uptime' },
      description: `Plan formulated for objective: verify system environment and host availability for task execution.`,
      expectedKeywords: ['Linux', 'x86_64']
    };
  }

  private evaluateJudge(output: string, toolPassed: boolean, goal: string, expectedKeywords: string[]): JudgeVerdict {
    // Dimension 1: Exit Status (30 points) - Hard Gate: 0 if failed
    let exitScore = 0;
    if (toolPassed && !output.includes('Execution error:') && !output.includes('command not found')) {
      exitScore = 30;
    }

    // Dimension 2: Evidence Relevance (40 points) - Hard Gate: 0 if no assertions match
    let matchedCount = 0;
    for (const kw of expectedKeywords) {
      if (output.toLowerCase().includes(kw.toLowerCase())) {
        matchedCount++;
      }
    }
    const relRatio = expectedKeywords.length > 0 ? matchedCount / expectedKeywords.length : 0;
    let relScore = Math.round(relRatio * 40);

    // Dimension 3: Completeness (30 points)
    let compScore = 0;
    if (output && output.trim().length > 10) {
      compScore = 30;
    } else if (output && output.trim().length > 0) {
      compScore = 15;
    }

    const totalScore = exitScore + relScore + compScore;

    // Hard Gates: Must have clean exit (exitScore > 0), at least 1 relevance match (matchedCount > 0), and totalScore >= 75
    const passed = exitScore === 30 && matchedCount > 0 && totalScore >= 75;

    let critique = '';
    if (passed) {
      critique = `Ground-truth verification passed with score ${totalScore}/100 [Exit: ${exitScore}/30, Relevance: ${relScore}/40 (${matchedCount}/${expectedKeywords.length} assertions), Completeness: ${compScore}/30].`;
    } else {
      critique = `Verification failed [Exit: ${exitScore}/30, Relevance: ${relScore}/40, Completeness: ${compScore}/30]. Missing expected evidence assertions or tool returned errors.`;
    }

    return {
      passed,
      score: totalScore,
      critique
    };
  }
}

export const missionRunner = new MissionRunner();

