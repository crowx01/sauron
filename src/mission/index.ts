import { MissionGoal, MissionReport, MissionStep, RouterOptions } from '../types';
import { toolBelt } from '../tools';
import { reactAgent } from '../agent/react';
import { playbookStore } from '../agent/playbooks';
import { dagPlanner } from '../agent/planner';
import { randomUUID } from 'crypto';

export interface JudgeVerdict {
  passed: boolean;
  score: number;
  critique: string;
}

export class MissionRunner {
  private maxRetries: number = 2;

  public async executeMission(
    goalText: string,
    options: RouterOptions = {}
  ): Promise<MissionReport> {
    const missionId = `mission_${randomUUID()}`;
    const steps: MissionStep[] = [];
    let missionSuccess = false;

    // Stage 1: Writer / Planner (Formulate dynamic decomposition & recall playbooks)
    const recalled = playbookStore.recall(goalText, 1);
    const pbNote = recalled.length > 0 ? ` (recalled tactic: ${recalled[0].name})` : '';
    const plan = this.decomposeGoal(goalText);

    steps.push({
      stepNumber: 1,
      role: 'planner',
      action: 'Decompose goal into actionable tasks and verification criteria',
      result: `${plan.description}${pbNote}`,
      passed: true
    });

    let currentCritique = '';

    // Stage 2 & 3: Executor and Judge Loop with Retries
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (options.signal?.aborted) {
        break;
      }

      // Dynamic Executor Stage
      let execOutput = '';
      let toolPassed = true;

      try {
        const toolRes = await toolBelt.executeTool(
          plan.tool,
          plan.args,
          { signal: options.signal }
        );
        execOutput = toolRes.output || toolRes.error || '';
        if (toolRes.error || execOutput.startsWith('Error:')) {
          toolPassed = false;
        }
      } catch (err: any) {
        execOutput = `Execution error: ${err.message}`;
        toolPassed = false;
      }

      steps.push({
        stepNumber: steps.length + 1,
        role: 'executor',
        action: `Execute ${plan.tool} for objective: "${goalText}" (Attempt ${attempt}${currentCritique ? ` after critique: ${currentCritique}` : ''})`,
        result: execOutput.slice(0, 500),
        passed: toolPassed
      });

      // Stage 3: Judge Stage (Evaluates evidence against goal criteria)
      const judgeVerdict = this.evaluateJudge(execOutput, toolPassed, goalText, plan.expectedKeywords);

      steps.push({
        stepNumber: steps.length + 1,
        role: 'judge',
        action: `Evaluate execution outputs against goal criteria (Attempt ${attempt})`,
        result: `Verdict: ${judgeVerdict.passed ? 'PASS' : 'FAIL'} (Score: ${judgeVerdict.score}/100). Critique: ${judgeVerdict.critique}`,
        passed: judgeVerdict.passed
      });

      if (judgeVerdict.passed) {
        missionSuccess = true;
        break;
      } else {
        currentCritique = judgeVerdict.critique;
        // On retry, if critique noted errors, narrow execution or check host state safely
        if (plan.tool === 'bash' && !plan.args.command.includes('LANG=C')) {
          plan.args.command = `LANG=C ${plan.args.command}`;
        }
      }
    }

    if (missionSuccess) {
      playbookStore.recordTrace({
        id: missionId,
        goal: goalText,
        steps: steps.filter((s) => s.role === 'executor').map((s) => ({
          tool: plan.tool,
          args: plan.args,
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
      summary: `Mission "${goalText}" ${missionSuccess ? 'PASSED' : 'FAILED'} across ${steps.length} pipeline steps.`
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

