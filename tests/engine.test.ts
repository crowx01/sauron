import { describe, test, expect } from 'bun:test';
import { chatRouter } from '../src/router';
import { toolBelt } from '../src/tools';
import { sessionStore } from '../src/session';
import { missionRunner } from '../src/mission';

describe('Sauron TypeScript Engine Suite', () => {
  test('ChatRouter routes model requests accurately', () => {
    const routeAuto = chatRouter.route({ mode: 'auto' });
    expect(routeAuto.primaryModel).toBeDefined();
    expect(routeAuto.primaryProvider).toBeDefined();

    const routeCheap = chatRouter.route({ mode: 'cheap' });
    expect(routeCheap.primaryModel).toBeDefined();

    const routeSmart = chatRouter.route({ mode: 'smart' });
    expect(routeSmart.primaryModel).toBeDefined();
  });

  test('ToolBelt executes bash and read_file tools cleanly', async () => {
    const bashRes = await toolBelt.executeTool('bash', { command: 'echo "Sauron TS Engine"' });
    expect(bashRes.output).toContain('Sauron TS Engine');

    const readRes = await toolBelt.executeTool('read_file', { path: 'package.json' });
    expect(readRes.output).toContain('"name": "sauron"');
  });

  test('SessionStore maintains messages and persistent storage', () => {
    const session = sessionStore.createSession('Test Suite Session');
    expect(session.id).toBeDefined();

    sessionStore.addMessage('user', 'Hello Sauron');
    sessionStore.addMessage('assistant', 'Hello Operator');

    const current = sessionStore.getActiveSession();
    expect(current.messages.length).toBe(2);
    expect(current.messages[0].content).toBe('Hello Sauron');
  });

  test('MissionRunner executes adaptive 3-phase pipeline', async () => {
    const report = await missionRunner.executeMission('Perform system audit');
    expect(report.success).toBe(true);
    expect(report.steps.length).toBe(3);
    expect(report.steps[0].role).toBe('planner');
    expect(report.steps[1].role).toBe('executor');
    expect(report.steps[2].role).toBe('judge');
  }, { timeout: 45000 });

  test('ChatRouter streams response chunks without error', async () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'Test prompt', timestamp: Date.now() }
    ];

    const chunks: string[] = [];
    for await (const chunk of chatRouter.dispatch(messages)) {
      if (chunk.delta) chunks.push(chunk.delta);
    }
    expect(chunks.length).toBeGreaterThan(0);
  }, { timeout: 15000 });
});
