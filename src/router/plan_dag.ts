import { Message, StreamChunk, RouterOptions, ToolResult } from '../types';
import { providerRegistry } from '../providers';
import { toolBelt } from '../tools';

export interface PlanNode {
  id: string;
  action: string;
  args: Record<string, any>;
  dependsOn: string[];
}

export interface DAGExecutionResult {
  success: boolean;
  nodesExecuted: { id: string; action: string; output: string; error?: string }[];
  summary: string;
}

/**
 * Validates whether a task classification represents a multi-step / non-linear plan.
 * Multi-step / non-linear tasks have planDepth >= 3 or are in audit/codegen/exploit categories
 * with planDepth > 1.
 */
export function isNonLinearTask(planDepth: number, category: string): boolean {
  if (planDepth >= 3) return true;
  const nonLinearCategories = ['audit', 'codegen', 'exploit'];
  return nonLinearCategories.includes(category.toLowerCase()) && planDepth >= 2;
}

/**
 * Requests a strict JSON plan DAG from the smart-tier model instead of asking it to solve+execute inline.
 * Strict JSON schema: Array of { id: string, action: string, args: Record<string, any>, dependsOn: string[] }
 */
export async function requestPlanDAG(
  smartClient: any,
  smartModel: string,
  userPrompt: string,
  options: RouterOptions = {}
): Promise<PlanNode[] | null> {
  const availableTools = toolBelt.listTools().map((t) => `${t.name}: ${t.description}`).join('; ');

  const dagPrompt = `You are a planner creating a strict execution plan DAG for the user goal.
Available tool actions:
${availableTools}

You must respond with ONLY a raw JSON array of DAG steps, conforming strictly to this format (no markdown, no backticks, no extra text):
[
  {
    "id": "step_1",
    "action": "bash",
    "args": {"command": "whoami"},
    "dependsOn": []
  },
  {
    "id": "step_2",
    "action": "bash",
    "args": {"command": "id"},
    "dependsOn": ["step_1"]
  }
]

Goal: ${userPrompt}`;

  const msgs: Message[] = [
    {
      id: `dag_plan_${Date.now()}`,
      role: 'user',
      content: dagPrompt,
      timestamp: Date.now()
    }
  ];

  let raw = '';
  try {
    for await (const chunk of smartClient.streamResponse(msgs, smartModel, options)) {
      if (options.signal?.aborted) return null;
      if (chunk.delta) raw += chunk.delta;
      if (chunk.error) break;
    }

    if (!raw.trim()) return null;

    const match = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const nodes: PlanNode[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || `node_${nodes.length + 1}`);
      const action = String(item.action || item.tool || 'bash');
      const args = typeof item.args === 'object' && item.args !== null ? item.args : {};
      const dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [];
      nodes.push({ id, action, args, dependsOn });
    }

    return nodes.length > 0 ? nodes : null;
  } catch {
    return null;
  }
}

/**
 * Local engine executes DAG nodes in dependency order via existing toolBelt machinery.
 * Yields streaming chunks reflecting step progression and final execution summary.
 */
export async function* executePlanDAG(
  nodes: PlanNode[],
  options: RouterOptions = {}
): AsyncGenerator<StreamChunk, DAGExecutionResult, unknown> {
  const signal = options.signal;
  const executed: { id: string; action: string; output: string; error?: string }[] = [];
  const completedIds = new Set<string>();
  const failedIds = new Set<string>();

  yield { delta: `[Plan DAG]: Executing ${nodes.length} plan nodes in dependency order...\n`, providerUsed: 'local-engine' };

  // Track remaining nodes
  const pendingNodes = [...nodes];
  let iterations = 0;
  const maxIterations = nodes.length * 3;

  while (pendingNodes.length > 0 && iterations++ < maxIterations) {
    if (signal?.aborted) {
      yield { error: 'Plan DAG execution aborted by user', finishReason: 'abort' };
      return { success: false, nodesExecuted: executed, summary: 'Aborted by user' };
    }

    // Find ready nodes whose dependencies are all satisfied
    const readyIdx = pendingNodes.findIndex((n) =>
      n.dependsOn.every((dep) => completedIds.has(dep))
    );

    if (readyIdx === -1) {
      // Unresolvable dependency or previous failure blocked remaining nodes
      const blockedNodes = pendingNodes.map((n) => n.id).join(', ');
      yield {
        delta: `\n[Plan DAG Warning]: Remaining node(s) [${blockedNodes}] cannot run due to failed or cyclic dependencies.\n`,
        providerUsed: 'local-engine'
      };
      break;
    }

    const [currentNode] = pendingNodes.splice(readyIdx, 1);

    yield {
      delta: `\n▶ [Node ${currentNode.id}] Action: ${currentNode.action} (${JSON.stringify(currentNode.args)})\n`,
      providerUsed: 'local-engine'
    };

    let toolRes: ToolResult;
    try {
      toolRes = await toolBelt.executeTool(currentNode.action, currentNode.args, { signal });
    } catch (e: any) {
      toolRes = { toolCallId: currentNode.id, output: '', error: e.message };
    }

    const outputText = toolRes.output || toolRes.error || '';
    const isError = Boolean(toolRes.error || outputText.startsWith('Error:'));

    if (isError) {
      failedIds.add(currentNode.id);
      executed.push({ id: currentNode.id, action: currentNode.action, output: outputText, error: toolRes.error });
      yield {
        delta: `✖ [Node ${currentNode.id} Failed]: ${toolRes.error || outputText.slice(0, 200)}\n`,
        providerUsed: 'local-engine'
      };
    } else {
      completedIds.add(currentNode.id);
      executed.push({ id: currentNode.id, action: currentNode.action, output: outputText });
      const preview = outputText.slice(0, 300).trim();
      yield {
        delta: `✔ [Node ${currentNode.id} OK]: ${preview ? preview + '\n' : 'Done\n'}`,
        providerUsed: 'local-engine'
      };
    }
  }

  const allPassed = failedIds.size === 0 && completedIds.size === nodes.length;
  const summary = `DAG Execution ${allPassed ? 'Complete' : 'Finished with errors'}: ${completedIds.size}/${nodes.length} nodes succeeded.`;

  yield {
    delta: `\n[Plan DAG Complete]: ${summary}\n`,
    providerUsed: 'local-engine',
    finishReason: 'stop'
  };

  return {
    success: allPassed,
    nodesExecuted: executed,
    summary
  };
}
