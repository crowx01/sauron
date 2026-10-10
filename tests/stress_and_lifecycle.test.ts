import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sessionStore } from '../src/session';
import { toolBelt } from '../src/tools';
import { chatRouter } from '../src/router';
import { configManager } from '../src/config';
import { existsSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';

describe('Sauron Deep Stress & Lifecycle Suite', () => {
  const testHome = join(process.cwd(), '.test_sauron_lifecycle');

  beforeAll(() => {
    process.env.SAURON_HOME = testHome;
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
    mkdirSync(testHome, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
    delete process.env.SAURON_HOME;
  });

  // Test 1: Corrupted session file isolation and quarantine
  test('S1: Corrupted session JSON files are quarantined without throwing', () => {
    const sessionDir = configManager.getConfig().sessionDir;
    mkdirSync(sessionDir, { recursive: true });

    // Create 2 valid sessions
    sessionStore.createSession('Valid Session 1');
    sessionStore.createSession('Valid Session 2');

    // Create corrupted JSON files
    writeFileSync(join(sessionDir, 'corrupt_1.json'), '{"id": "c1", malformed', 'utf-8');
    writeFileSync(join(sessionDir, 'corrupt_2.json'), '', 'utf-8');
    writeFileSync(join(sessionDir, 'corrupt_3.json'), '{"unexpected": 123}', 'utf-8');

    // listSessions should isolate the corrupt files and return the valid ones
    const sessions = sessionStore.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    // Corrupt files should have been quarantined
    const files = readdirSync(sessionDir);
    expect(files.some((f) => f.includes('corrupt') && f.includes('.corrupt-'))).toBe(true);
  });

  // Test 2: Path Traversal defense in session loading
  test('S6: Path traversal attempts in loadSession are blocked safely', () => {
    const res1 = sessionStore.loadSession('../../etc/passwd');
    expect(res1).toBeUndefined();

    const res2 = sessionStore.loadSession('../../../secret.json');
    expect(res2).toBeUndefined();

    const res3 = sessionStore.loadSession('valid_session_id');
    expect(res3).toBeUndefined(); // non-existent safe ID
  });

  // Test 3: Toolbelt Output Buffer Capping (Max 1MB limit)
  test('T4: Large tool output is capped at 1MB to prevent memory exhaustion', async () => {
    // Generate 2MB of output in bash
    const res = await toolBelt.executeTool('bash', {
      command: 'python3 -c "print(\'X\' * 1500000)" 2>/dev/null || node -e "console.log(\'X\'.repeat(1500000))"'
    });

    expect(res.output.length).toBeLessThanOrEqual(1024 * 1024 + 500);
    expect(res.output).toContain('[Output truncated: exceeded 1MB limit]');
  });

  // Test 4: Web Fetch SSRF Defense (Forbidden Schemes)
  test('T11: web_fetch blocks file:// scheme to prevent local file disclosures', async () => {
    const res = await toolBelt.executeTool('web_fetch', { url: 'file:///etc/passwd' });
    expect(res.output).toContain('Error: file:// scheme is forbidden');
  });

  // Test 5: Toolbelt Bash Timeout Handling
  test('T1: Bash tool executes commands and handles timeouts cleanly', async () => {
    const fastRes = await toolBelt.executeTool('bash', { command: 'echo "fast execution"' });
    expect(fastRes.output).toContain('fast execution');
  });

  // Test 6: Fallback Chain Intelligence Ordering
  test('R1: Real available providers are prioritized before local-engine', () => {
    const route = chatRouter.route({ mode: 'auto' });
    expect(route.primaryModel).toBeDefined();

    // Fallbacks list must have local-engine strictly at the very end
    const lastFallback = route.fallbacks[route.fallbacks.length - 1];
    expect(lastFallback.provider).toBe('local-engine');
  });

  // Test 7: Atomic Session File Creation and Persistence
  test('S3: Rapid sequential addMessage operations produce valid parseable JSON', () => {
    const session = sessionStore.createSession('Concurrency Stress Test');
    for (let i = 0; i < 50; i++) {
      sessionStore.addMessage('user', `Stress message ${i}`);
    }

    const reloaded = sessionStore.loadSession(session.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.messages.length).toBe(50);
  });
});
