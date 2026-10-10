import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { chatRouter } from '../src/router';
import { providerRegistry } from '../src/providers';
import { sessionStore } from '../src/session';
import { toolBelt } from '../src/tools';
import { Message, StreamChunk } from '../src/types';

const home = join(process.cwd(), '.test_sauron_adversarial');
const msg = (role: Message['role'], content: string): Message => ({
  id: `m_${Math.random()}`, role, content, timestamp: Date.now()
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Force the local engine so the test is deterministic regardless of installed CLIs/keys
const localOnly = { model: 'local-engine' };

describe('Adversarial final round', () => {
  beforeAll(() => {
    process.env.SAURON_HOME = home;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.SAURON_HOME;
  });

  test('A1: 50 concurrent dispatches never mix tokens across sessions', async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const tok = `tok${i}x${Math.random().toString(36).slice(2, 8)}`;
        let out = '';
        for await (const c of chatRouter.dispatch([msg('user', `my name is ${tok}`), msg('user', 'hi')], localOnly)) {
          out += c.delta ?? '';
        }
        return { tok, out: out.trim() };
      })
    );
    for (const r of results) {
      expect(r.out).toBe(`Hello ${r.tok}! How can I assist you with your work today?`);
      for (const other of results) if (other !== r) expect(r.out).not.toContain(other.tok);
    }
  });

  test('A2: 50 concurrent dispatches all aborted mid-stream stop promptly, emit nothing after abort', async () => {
    const t0 = Date.now();
    const lateChunks = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const ac = new AbortController();
        let afterAbort = 0;
        let got = 0;
        const text = 'word '.repeat(200); // would take ~4s if not cancelled
        for await (const _c of chatRouter.dispatch([msg('user', text)], { ...localOnly, signal: ac.signal })) {
          got++;
          if (ac.signal.aborted) afterAbort++;
          if (got === 2) ac.abort();
        }
        return afterAbort;
      })
    );
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(lateChunks.every((n) => n === 0)).toBe(true);
  });

  test('A3: pre-aborted signal yields nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const chunks: StreamChunk[] = [];
    for await (const c of chatRouter.dispatch([msg('user', 'hello there')], { signal: ac.signal })) chunks.push(c);
    expect(chunks.length).toBe(0);
  });

  test('A4: consumer `break` closes the provider generator (no work continues)', async () => {
    let finalized = false;
    providerRegistry.register({
      providerName: 'probe',
      isAvailable: () => true,
      async *streamResponse() {
        try { for (let i = 0; ; i++) { yield { delta: `${i} ` }; await sleep(5); } }
        finally { finalized = true; }
      }
    });
    (chatRouter as any).catalog.push({ model: 'probe-1', provider: 'probe', intelligence: 1, costRank: 0, routable: true, tools: false, aliases: [] });
    for await (const _c of chatRouter.dispatch([msg('user', 'x')], { model: 'probe-1' })) break;
    expect(finalized).toBe(true);
  });

  test('A5: mid-stream provider failure is surfaced, NOT spliced with a fallback answer', async () => {
    providerRegistry.register({
      providerName: 'flaky',
      isAvailable: () => true,
      async *streamResponse() {
        yield { delta: 'partial-' };
        yield { error: 'socket reset' };
      }
    });
    (chatRouter as any).catalog.push({ model: 'flaky-1', provider: 'flaky', intelligence: 1, costRank: 0, routable: true, tools: false, aliases: [] });
    const chunks: StreamChunk[] = [];
    for await (const c of chatRouter.dispatch([msg('user', 'x')], { model: 'flaky-1' })) chunks.push(c);
    expect(chunks.map((c) => c.delta ?? '').join('')).toBe('partial-');
    expect(chunks[chunks.length - 1].error).toContain('socket reset');
  });

  test('A6: a provider that throws before output falls through to a working one', async () => {
    providerRegistry.register({
      providerName: 'boom',
      isAvailable: () => true,
      async *streamResponse() { throw new Error('kaboom'); }
    });
    (chatRouter as any).catalog.push({ model: 'boom-1', provider: 'boom', intelligence: 1, costRank: 0, routable: true, tools: false, aliases: [] });
    let out = '';
    for await (const c of chatRouter.dispatch([msg('user', 'hi')], { model: 'boom-1' })) out += c.delta ?? '';
    expect(out.length).toBeGreaterThan(0);
  });

  test('B1: aborting bash kills the whole process group (no orphan)', async () => {
    const pidFile = join(home, 'pid.txt');
    const ac = new AbortController();
    const p = toolBelt.executeTool('bash', { command: `echo $$ > ${pidFile}; sleep 30` }, { signal: ac.signal });
    await sleep(400);
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(alive(pid)).toBe(true);
    ac.abort();
    const res = await p;
    expect(res.output).toContain('aborted');
    await sleep(900);
    expect(alive(pid)).toBe(false);
  });

  test('B2: bash with pre-aborted signal never spawns', async () => {
    const marker = join(home, 'should_not_exist');
    const ac = new AbortController();
    ac.abort();
    await toolBelt.executeTool('bash', { command: `touch ${marker}` }, { signal: ac.signal });
    await sleep(200);
    expect(existsSync(marker)).toBe(false);
  });

  test('B3: 1MB output cap holds under a flood', async () => {
    const res = await toolBelt.executeTool('bash', { command: 'yes AAAAAAAAAAAAAAAA | head -c 20000000' });
    expect(res.output.length).toBeLessThan(1024 * 1024 + 200);
  });

  test('C1: tools reject empty/whitespace/non-string args', async () => {
    for (const v of ['', '   ', '\n\t', undefined, null, 42, {}]) {
      expect((await toolBelt.executeTool('bash', { command: v })).output).toContain('required');
      expect((await toolBelt.executeTool('read_file', { path: v })).output).toContain('required');
      expect((await toolBelt.executeTool('write_file', { path: v, content: 'x' })).output).toContain('required');
      expect((await toolBelt.executeTool('web_fetch', { url: v })).output).toContain('required');
    }
    expect((await toolBelt.executeTool('bash', undefined as any)).output).toContain('required');
  });

  test('C2: web_fetch blocks schemes, private/loopback/metadata hosts and obfuscated IPs', async () => {
    const bad = [
      'file:///etc/passwd', 'FILE:///etc/passwd', 'ftp://example.com/x', 'gopher://x',
      'http://localhost:1/', 'http://127.0.0.1/', 'http://0.0.0.0/', 'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://[::1]/', 'http://2130706433/',
      'http://0x7f000001/', 'http://metadata.google.internal/'
    ];
    for (const url of bad) {
      const r = (await toolBelt.executeTool('web_fetch', { url })).output;
      expect(r).toMatch(/forbidden|invalid/);
    }
  });

  test('C3: sessions — 300 rapid saves leave no tmp files and a valid JSON', () => {
    sessionStore.createSession('burst');
    for (let i = 0; i < 300; i++) sessionStore.addMessage('user', `m${i}`);
    const dir = join(home, 'sessions');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const id = sessionStore.getActiveSession().id;
    expect(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf-8')).messages.length).toBe(300);
  });

  test('C4: empty / whitespace messages array and content do not crash the router', async () => {
    for (const msgs of [[], [msg('user', '')], [msg('user', '   ')], [msg('user', '\u0000‮')]]) {
      let out = '';
      for await (const c of chatRouter.dispatch(msgs, localOnly)) out += c.delta ?? '';
      expect(typeof out).toBe('string');
    }
  });

  describe('CLI empty/whitespace input', () => {
    const cli = join(process.cwd(), 'bin', 'cli.js');
    const env = { ...process.env, SAURON_HOME: home };
    for (const cmd of ['run', 'mission', 'debate']) {
      for (const args of [[], [''], ['   '], ['', ''], ['\t', '\n']]) {
        test(`${cmd} ${JSON.stringify(args)} exits 1 with usage`, () => {
          const r = spawnSync('node', [cli, cmd, ...args], { encoding: 'utf-8', env });
          expect(r.status).toBe(1);
          expect(r.stderr).toContain('Usage');
        });
      }
    }
    test('blank command is rejected cleanly by the wrapper (exit 2, no stack trace)', () => {
      const r = spawnSync('node', [cli, '   '], { encoding: 'utf-8', env, input: '', timeout: 8000 });
      expect(r.status).toBe(2);
      expect(r.stderr + r.stdout).not.toContain('Fatal');
    });

    // The TS entrypoint must hold the line itself, not rely on the wrapper
    const bun = join(process.env.HOME || '', '.bun', 'bin', 'bun');
    for (const cmd of ['run', 'mission', 'debate']) {
      for (const args of [[''], ['   '], ['', '']]) {
        test(`src/cli.ts ${cmd} ${JSON.stringify(args)} exits 1`, () => {
          const r = spawnSync(existsSync(bun) ? bun : 'bun', ['run', 'src/cli.ts', cmd, ...args], { encoding: 'utf-8', env });
          expect(r.status).toBe(1);
          expect(r.stderr).toContain('Usage');
        });
      }
    }
    test('src/cli.ts run: SIGINT mid-stream exits 130 promptly', async () => {
      const { spawn } = await import('node:child_process');
      const p = spawn(existsSync(bun) ? bun : 'bun', ['run', 'src/cli.ts', 'run', 'word '.repeat(300)], { env, stdio: 'ignore' });
      await sleep(1200);
      const t0 = Date.now();
      p.kill('SIGINT');
      const code: number = await new Promise((r) => p.on('exit', (c, s) => r(c !== null ? c : (s === 'SIGINT' ? 130 : -1))));
      expect(code).toBe(130);
      expect(Date.now() - t0).toBeLessThan(1500);
    });
  });
});
