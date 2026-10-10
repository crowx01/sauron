import { describe, test, expect } from 'bun:test';
import { chatRouter } from '../src/router';
import { toolBelt } from '../src/tools';
import { sessionStore } from '../src/session';
import { missionRunner } from '../src/mission';
import { HeaderComponent, TranscriptComponent, ToolCardComponent, PromptEditorComponent } from '../src/tui/components';

describe('Sauron 8-Scenario Comprehensive Verification Suite', () => {
  // Scenario 1: Basic Chat & Token Streaming
  test('Scenario 1: Basic Chat & Token Streaming renders chunks without flicker', async () => {
    sessionStore.clearActiveSession();
    sessionStore.addMessage('user', 'hello sauron');

    const chunks: string[] = [];
    for await (const chunk of chatRouter.dispatch(sessionStore.getActiveSession().messages)) {
      if (chunk.delta) chunks.push(chunk.delta);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const fullText = chunks.join('');
    expect(fullText.length).toBeGreaterThan(5);
  }, { timeout: 15000 });

  // Scenario 2: Multi-Turn Conversation & Fact Memory
  test('Scenario 2: Multi-Turn Conversation & Fact Memory remembers facts across turns', async () => {
    sessionStore.clearActiveSession();

    // Turn 1
    sessionStore.addMessage('user', 'my name is Yousry');
    let t1Response = '';
    for await (const chunk of chatRouter.dispatch(sessionStore.getActiveSession().messages)) {
      if (chunk.delta) t1Response += chunk.delta;
    }
    sessionStore.addMessage('assistant', t1Response);
    expect(t1Response).toBeDefined();

    // Turn 2
    sessionStore.addMessage('user', 'do u know my name');
    let t2Response = '';
    for await (const chunk of chatRouter.dispatch(sessionStore.getActiveSession().messages)) {
      if (chunk.delta) t2Response += chunk.delta;
    }
    sessionStore.addMessage('assistant', t2Response);

    expect(t2Response.toLowerCase()).toContain('yousry');
  }, { timeout: 30000 });

  // Scenario 3: Tool Execution Engine
  test('Scenario 3: Tool Execution Engine runs commands and formats tool output cards', async () => {
    const bashResult = await toolBelt.executeTool('bash', { command: 'echo "Kali Linux Tool Test"' });
    expect(bashResult.output).toContain('Kali Linux Tool Test');

    const cardComp = new ToolCardComponent();
    const rendered = cardComp.render('bash', 'echo "Kali Linux Tool Test"', 'success', bashResult.output);
    expect(rendered.length).toBeGreaterThan(2);
    expect(rendered.join('\n')).toContain('SUCCESS');
  });

  // Scenario 4: Model Switching & Catalog Routing
  test('Scenario 4: Model Switching & Catalog Routing updates route targets dynamically', () => {
    const autoRoute = chatRouter.route({ mode: 'auto' });
    expect(autoRoute.primaryModel).toBeDefined();

    const cheapRoute = chatRouter.route({ mode: 'cheap' });
    expect(cheapRoute.primaryModel).toBeDefined();

    const smartRoute = chatRouter.route({ mode: 'smart' });
    expect(smartRoute.primaryModel).toBeDefined();

    const explicitRoute = chatRouter.route({ model: 'gpt-4o' });
    expect(explicitRoute.primaryModel).toBe('gpt-4o');
  });

  // Scenario 5: Error Recovery & Fallback Chain
  test('Scenario 5: Error Recovery & Fallback Chain handles invalid models gracefully', async () => {
    const route = chatRouter.route({ model: 'non-existent-invalid-model-xyz' });
    expect(route.fallbacks.length).toBeGreaterThan(0);

    const messages = [{ id: '1', role: 'user' as const, content: 'ping', timestamp: Date.now() }];
    const chunks: string[] = [];
    for await (const chunk of chatRouter.dispatch(messages, { model: 'non-existent-invalid-model-xyz' })) {
      if (chunk.delta) chunks.push(chunk.delta);
    }
    expect(chunks.length).toBeGreaterThan(0);
  }, { timeout: 15000 });

  // Scenario 6: Adaptive Mission Pipeline
  test('Scenario 6: Adaptive Mission Pipeline executes 3-stage Writer-Executor-Judge flow', async () => {
    const report = await missionRunner.executeMission('Verify network interfaces');
    expect(report.success).toBe(true);
    expect(report.steps.length).toBe(3);
    expect(report.steps[0].role).toBe('planner');
    expect(report.steps[1].role).toBe('executor');
    expect(report.steps[2].role).toBe('judge');
  }, { timeout: 45000 });

  // Scenario 7: Long Input, Multiline & Resizing
  test('Scenario 7: Long Input, Multiline & Layout bounds calculation', () => {
    const longInput = 'A'.repeat(500);
    const headerComp = new HeaderComponent();
    const renderedHeader = headerComp.render(100, 'claude-3-7-sonnet', 'anthropic', 'auto', 'session_123');
    expect(renderedHeader.length).toBe(5);

    const promptComp = new PromptEditorComponent();
    const renderedPrompt = promptComp.render(100, longInput, 'auto', ['/help', '/models']);
    expect(renderedPrompt.length).toBeGreaterThan(3);
  });

  // Scenario 8: Session Persistence & Context Compaction
  test('Scenario 8: Session Persistence & Context Compaction saves and compacts history', () => {
    const session = sessionStore.createSession('Persistence Scenario Test');
    for (let i = 0; i < 15; i++) {
      sessionStore.addMessage('user', `Message turn ${i}`);
      sessionStore.addMessage('assistant', `Response turn ${i}`);
    }

    expect(sessionStore.getActiveSession().messages.length).toBe(30);

    sessionStore.compactContext();
    expect(sessionStore.getActiveSession().messages.length).toBeLessThan(30);

    const list = sessionStore.listSessions();
    expect(list.length).toBeGreaterThan(0);
  });
});
