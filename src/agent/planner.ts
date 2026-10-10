import { playbookStore } from './playbooks';
import { randomUUID } from 'crypto';

export interface Finding {
  key: string;
  value: string;
  confidence: number;
}

export interface TaskNode {
  id: string;
  kind: 'recon' | 'inspect' | 'verify';
  tool: string;
  commandTemplate: string;
  resolvedCommand?: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  dependsOn: string[];
  findings: Finding[];
  output?: string;
  exitCode?: number;
}

export interface TaskDAG {
  id: string;
  goal: string;
  nodes: TaskNode[];
  findings: Map<string, string>;
}

export class DAGPlanner {
  public decompose(goal: string): TaskDAG {
    const dagId = `dag_${randomUUID().slice(0, 8)}`;
    const lower = goal.toLowerCase();

    const nodes: TaskNode[] = [];

    // Phase 1: Reconnaissance
    let reconCmd = 'uname -s && uname -m && whoami';
    let inspectCmd = 'id && groups';
    let verifyCmd = 'uptime';

    if (lower.includes('user') || lower.includes('identity') || lower.includes('permission') || lower.includes('privilege')) {
      reconCmd = 'whoami';
      inspectCmd = 'id && groups';
      verifyCmd = 'cat /etc/passwd | grep -E "^({{user}}):" || id -u';
    } else if (lower.includes('network') || lower.includes('interface') || lower.includes('ip') || lower.includes('port')) {
      reconCmd = 'ip addr || ifconfig -a';
      inspectCmd = 'ip route || netstat -rn';
      verifyCmd = 'cat /proc/net/dev';
    } else if (lower.includes('system') || lower.includes('kernel') || lower.includes('audit')) {
      reconCmd = 'uname -s && uname -m';
      inspectCmd = 'uname -a && uptime';
      verifyCmd = 'cat /proc/version';
    }

    nodes.push({
      id: 'node_recon',
      kind: 'recon',
      tool: 'bash',
      commandTemplate: reconCmd,
      status: 'pending',
      dependsOn: [],
      findings: []
    });

    nodes.push({
      id: 'node_inspect',
      kind: 'inspect',
      tool: 'bash',
      commandTemplate: inspectCmd,
      status: 'pending',
      dependsOn: ['node_recon'],
      findings: []
    });

    nodes.push({
      id: 'node_verify',
      kind: 'verify',
      tool: 'bash',
      commandTemplate: verifyCmd,
      status: 'pending',
      dependsOn: ['node_inspect'],
      findings: []
    });

    return {
      id: dagId,
      goal,
      nodes,
      findings: new Map()
    };
  }

  public extractFindings(stdout: string): Finding[] {
    const findings: Finding[] = [];

    // User extract
    const whoamiMatch = stdout.match(/^([a-zA-Z0-9_\-]+)$/m);
    if (whoamiMatch) {
      findings.push({ key: 'user', value: whoamiMatch[1].trim(), confidence: 0.95 });
    }

    // UID extract
    const uidMatch = stdout.match(/uid=(\d+)\(([a-zA-Z0-9_\-]+)\)/);
    if (uidMatch) {
      findings.push({ key: 'uid', value: uidMatch[1], confidence: 0.99 });
      findings.push({ key: 'user', value: uidMatch[2], confidence: 0.99 });
    }

    // IP extract
    const ipMatch = stdout.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (ipMatch) {
      findings.push({ key: 'ip', value: ipMatch[1], confidence: 0.95 });
    }

    // Architecture extract
    if (stdout.includes('x86_64')) {
      findings.push({ key: 'arch', value: 'x86_64', confidence: 0.99 });
    } else if (stdout.includes('aarch64')) {
      findings.push({ key: 'arch', value: 'aarch64', confidence: 0.99 });
    }

    // OS extract
    if (stdout.includes('Linux')) {
      findings.push({ key: 'os', value: 'Linux', confidence: 0.99 });
    }

    return findings;
  }

  public propagateFindings(dag: TaskDAG, completedNode: TaskNode): void {
    for (const f of completedNode.findings) {
      dag.findings.set(f.key, f.value);
    }

    // Resolve downstream templates
    for (const node of dag.nodes) {
      if (node.status === 'pending' && node.dependsOn.includes(completedNode.id)) {
        let cmd = node.commandTemplate;
        for (const [k, v] of dag.findings.entries()) {
          cmd = cmd.replaceAll(`{{${k}}}`, v);
        }
        node.resolvedCommand = cmd;
      }
    }
  }

  public nextRunnable(dag: TaskDAG): TaskNode | null {
    for (const node of dag.nodes) {
      if (node.status === 'pending') {
        const depsResolved = node.dependsOn.every((depId) => {
          const depNode = dag.nodes.find((n) => n.id === depId);
          return depNode && depNode.status === 'done';
        });
        if (depsResolved) {
          if (!node.resolvedCommand) {
            let cmd = node.commandTemplate;
            for (const [k, v] of dag.findings.entries()) {
              cmd = cmd.replaceAll(`{{${k}}}`, v);
            }
            node.resolvedCommand = cmd;
          }
          return node;
        }
      }
    }
    return null;
  }
}

export const dagPlanner = new DAGPlanner();
