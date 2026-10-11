import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'path';

describe('Sauron CLI End-to-End Command Suite', () => {
  const cliPath = join(process.cwd(), 'bin', 'cli.js');

  test('CLI diag command outputs system status and catalog size', () => {
    const res = spawnSync('node', [cliPath, 'diag'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SAURON DIAGNOSTICS');
    expect(res.stdout).toContain('Catalog models:');
  });

  test('CLI models command lists routable models', () => {
    const res = spawnSync('node', [cliPath, 'models'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SAURON MODEL CATALOG');
    expect(res.stdout).toContain('claude-3-7-sonnet');
    expect(res.stdout).toContain('gemini-3.5-flash-lite');
  });

  test('CLI sessions command lists available saved sessions', () => {
    const res = spawnSync('node', [cliPath, 'sessions'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SAVED SESSIONS');
  });

  test('CLI mission command executes 3-stage Writer-Executor-Judge pipeline', () => {
    const res = spawnSync('node', [cliPath, 'mission', 'Sanity test goal'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"success": true');
    expect(res.stdout).toContain('"planner"');
    expect(res.stdout).toContain('"executor"');
    expect(res.stdout).toContain('"judge"');
  });

  test('CLI run command executes one-shot headless query', () => {
    const res = spawnSync('node', [cliPath, 'run', 'Ping test'], { encoding: 'utf-8', timeout: 15000 });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Running headless task: "Ping test"');
  }, { timeout: 15000 });

  test('CLI debate command outputs multi-model perspectives', () => {
    const res = spawnSync('node', [cliPath, 'debate', 'Architecture trade-offs'], { encoding: 'utf-8', timeout: 15000 });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('MODEL PERSPECTIVES');
    expect(res.stdout).toContain('CONSENSUS SYNTHESIS');
  }, { timeout: 15000 });

  test('CLI selftest command validates shipped components', () => {
    const res = spawnSync('node', [cliPath, 'selftest'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
  });
});
