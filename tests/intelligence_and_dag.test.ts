import { describe, test, expect, beforeEach } from 'bun:test';
import { playbookStore } from '../src/agent/playbooks';
import { toolResolver } from '../src/agent/resolver';
import { dagPlanner } from '../src/agent/planner';

describe('Sauron Intelligence & Autonomous Independence Suite', () => {
  beforeEach(() => {
    playbookStore.clear();
    toolResolver.clear();
  });

  // Test 1: PlaybookStore seeds and recall
  test('I1: PlaybookStore recalls domain playbooks based on goal semantics', () => {
    const reconPlaybooks = playbookStore.recall('Audit system architecture and kernel version');
    expect(reconPlaybooks.length).toBeGreaterThan(0);
    expect(reconPlaybooks[0].category).toBe('recon');

    const privPlaybooks = playbookStore.recall('Check current user permissions and group membership');
    expect(privPlaybooks.length).toBeGreaterThan(0);
    expect(privPlaybooks[0].category).toBe('privilege-audit');

    const netPlaybooks = playbookStore.recall('Enumerate network interfaces and ip routing table');
    expect(netPlaybooks.length).toBeGreaterThan(0);
    expect(netPlaybooks[0].category).toBe('network-discovery');
  });

  // Test 2: Playbook trace recording and autonomous tactic extraction
  test('I2: Successful execution trace distills reusable parameterized playbook', () => {
    playbookStore.recordTrace({
      id: 'trace_test_1',
      goal: 'Custom service inspection on port 8080',
      steps: [
        {
          tool: 'bash',
          args: { command: 'curl -I http://127.0.0.1:8080' },
          stdout: 'HTTP/1.1 200 OK',
          exitCode: 0,
          durationMs: 45,
          timestamp: Date.now()
        }
      ],
      outcome: 'success'
    });

    const recalled = playbookStore.recall('Custom service inspection on port 8080');
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0].name).toContain('Custom service inspection');
    expect(recalled[0].usageCount).toBeGreaterThanOrEqual(1);
  });

  // Test 3: Playbook instantiation with variable bindings
  test('I3: Playbook template instantiates dynamically with bindings', () => {
    const sample = playbookStore.recall('Audit system architecture and kernel version')[0];
    const steps = playbookStore.instantiate(sample, { host: '127.0.0.1', port: '22' });
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].tool).toBe('bash');
  });

  // Test 4: ToolResolver handles missing binaries and mutates commands
  test('I4: ToolResolver autonomously mutates commands upon missing binary errors', () => {
    // When a command fails with command not found (127)
    const fallback = toolResolver.getAlternativeCommand('ps aux', 127, 'bash: ps: command not found');
    expect(fallback).toBe('ps -ef');

    // Register working substitution
    toolResolver.registerLearnedSubstitution('ps aux', 'ps -ef');
    expect(toolResolver.resolveCommand('ps aux')).toBe('ps -ef');
  });

  // Test 5: ToolResolver network and route fallbacks
  test('I5: ToolResolver provides valid fallback chains for network commands', () => {
    const netFallback = toolResolver.getAlternativeCommand('ip addr', 127, 'ip: not found');
    expect(netFallback).toBe('ifconfig -a');

    const routeFallback = toolResolver.getAlternativeCommand('ip route', 127, 'ip: command not found');
    expect(routeFallback).toBe('netstat -rn');
  });

  // Test 6: DAGPlanner decomposes goals into multi-stage dependency graphs
  test('I6: DAGPlanner decomposes goals into Recon, Inspect, and Verify stages', () => {
    const dag = dagPlanner.decompose('Audit user permissions and check /etc/passwd');
    expect(dag.nodes.length).toBe(3);
    expect(dag.nodes[0].id).toBe('node_recon');
    expect(dag.nodes[1].id).toBe('node_inspect');
    expect(dag.nodes[2].id).toBe('node_verify');

    // Verify dependency relationship
    expect(dag.nodes[0].dependsOn.length).toBe(0);
    expect(dag.nodes[1].dependsOn).toContain('node_recon');
    expect(dag.nodes[2].dependsOn).toContain('node_inspect');
  });

  // Test 7: DAGPlanner extracts findings and propagates to downstream nodes
  test('I7: DAGPlanner extracts findings from stdout and resolves downstream templates', () => {
    const dag = dagPlanner.decompose('Audit user permissions and check /etc/passwd');

    // Recon stage produces whoami output
    const reconNode = dag.nodes[0];
    reconNode.status = 'done';
    reconNode.findings = dagPlanner.extractFindings('kali\n');

    expect(reconNode.findings.length).toBeGreaterThan(0);
    expect(reconNode.findings[0].key).toBe('user');
    expect(reconNode.findings[0].value).toBe('kali');

    // Propagate findings
    dagPlanner.propagateFindings(dag, reconNode);

    // Downstream verify node commandTemplate had {{user}}
    const verifyNode = dag.nodes[2];
    expect(verifyNode.commandTemplate).toContain('{{user}}');
    // Once propagated, resolved command has 'kali'
    expect(dag.findings.get('user')).toBe('kali');
  });

  // Test 8: DAGPlanner topological scheduler picks next runnable node
  test('I8: DAGPlanner topological scheduler correctly identifies next runnable node', () => {
    const dag = dagPlanner.decompose('System audit and recon');
    
    // Initially, only recon is runnable
    const firstRunnable = dagPlanner.nextRunnable(dag);
    expect(firstRunnable).not.toBeNull();
    expect(firstRunnable?.id).toBe('node_recon');

    // Mark recon done
    firstRunnable!.status = 'done';
    dagPlanner.propagateFindings(dag, firstRunnable!);

    // Next runnable should be inspect
    const secondRunnable = dagPlanner.nextRunnable(dag);
    expect(secondRunnable).not.toBeNull();
    expect(secondRunnable?.id).toBe('node_inspect');
  });

  // Test 9: Plan/Execute split DAG request and topological execution
  test('I9: requestPlanDAG parses strict JSON plan DAG from smart-tier model', async () => {
    const { requestPlanDAG, isNonLinearTask } = require('../src/router/plan_dag');

    expect(isNonLinearTask(4, 'general')).toBe(true);
    expect(isNonLinearTask(1, 'general')).toBe(false);
    expect(isNonLinearTask(2, 'codegen')).toBe(true);

    const mockSmartClient = {
      async *streamResponse() {
        yield {
          delta: JSON.stringify([
            { id: '1', action: 'bash', args: { command: 'echo "hello"' }, dependsOn: [] },
            { id: '2', action: 'bash', args: { command: 'echo "world"' }, dependsOn: ['1'] }
          ])
        };
      }
    };

    const dag = await requestPlanDAG(mockSmartClient, 'gemini-3.1-pro-high', 'Run two commands');
    expect(dag).toBeDefined();
    expect(dag?.length).toBe(2);
    expect(dag?.[0].id).toBe('1');
    expect(dag?.[1].dependsOn).toContain('1');
  });

  test('I10: executePlanDAG runs DAG nodes in dependency order via local-engine toolBelt', async () => {
    const { executePlanDAG } = require('../src/router/plan_dag');

    const nodes = [
      { id: 'step_b', action: 'bash', args: { command: 'echo "second"' }, dependsOn: ['step_a'] },
      { id: 'step_a', action: 'bash', args: { command: 'echo "first"' }, dependsOn: [] }
    ];

    const chunks: string[] = [];
    const execution = executePlanDAG(nodes);
    let iter = await execution.next();
    while (!iter.done) {
      if (iter.value.delta) chunks.push(iter.value.delta);
      iter = await execution.next();
    }

    const result = iter.value;
    expect(result.success).toBe(true);
    expect(result.nodesExecuted.length).toBe(2);
    // Verified executed in topological order: step_a before step_b
    expect(result.nodesExecuted[0].id).toBe('step_a');
    expect(result.nodesExecuted[1].id).toBe('step_b');
  });
});
