import { spawn, spawnSync } from 'node:child_process';
import type { Message, RouterOptions, StreamChunk } from '../types';
import type { ProviderClient } from './index';

/** `agy` model ids. Claude-backed ids are explicit-selection only (Claude-spend-avoidance policy). */
export const ANTIGRAVITY_AUTO_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gpt-oss-120b-medium'
] as const;

export const ANTIGRAVITY_EXPLICIT_ONLY_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6-thinking'] as const;

export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3.8-flash-medium';

/** agy is already authenticated; there is no key. Sentinel keeps generic key-gated code paths unblocked. */
export const ANTIGRAVITY_KEY_SENTINEL = '';

export function getAntigravityApiKey(): string {
  return ANTIGRAVITY_KEY_SENTINEL;
}

export class AntigravityProviderClient implements ProviderClient {
  public providerName = 'antigravity';

  private availableUntil = 0;
  private availableCache = false;

  public isAvailable(): boolean {
    // Cached: route() runs per dispatch and spawnSync blocks the event loop
    const now = Date.now();
    if (now < this.availableUntil) return this.availableCache;
    this.availableCache = Boolean(spawnSync('which', ['agy']).stdout?.toString().trim());
    this.availableUntil = now + 30_000;
    return this.availableCache;
  }

  // Hard ceiling for a single agy call. agy cold-spawns in 2-5s and normal generation finishes
  // in 30-45s; anything past this is a hung backend connection/gateway stall, not a slow but
  // live model, and should fail fast so the router's circuit-breaker can fall through to the
  // next provider instead of hanging forever. Debated with antigravity itself 2026-10-11 after
  // a real case hung 7+ minutes wall-clock on only ~10s of actual CPU time.
  private static readonly HARD_TIMEOUT_MS = 90_000;
  // agy buffers its whole answer and emits nothing on stdout until it's fully done, so without
  // this the TUI sits frozen with zero feedback for the entire call. Yield a synthetic "still
  // waiting" delta periodically until real output starts arriving.
  private static readonly HEARTBEAT_INTERVAL_MS = 5_000;

  public async *streamResponse(
    messages: Message[],
    model: string,
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = options.signal;
    const targetModel = model && model !== 'antigravity' ? model : ANTIGRAVITY_DEFAULT_MODEL;

    let prompt = '';
    for (const msg of messages.slice(-10)) {
      const label = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
      prompt += `${label}: ${msg.content}\n`;
    }
    prompt += 'Assistant:';

    let proc: ReturnType<typeof spawn> | undefined;
    let timedOut = false;
    const hardTimeout = setTimeout(() => {
      timedOut = true;
      if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    }, AntigravityProviderClient.HARD_TIMEOUT_MS);

    const kill = () => {
      if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', kill, { once: true });
    try {
      if (signal?.aborted) return;
      proc = spawn('agy', ['-p', prompt, '--output-format', 'text', '--model', targetModel], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      // Drain stderr concurrently so a chatty child can't block on a full pipe
      let stderr = '';
      proc.stderr?.on('data', (c) => (stderr += c.toString()));

      let buffer = '';
      let gotFirstChunk = false;
      let elapsedHeartbeats = 0;

      if (proc.stdout) {
        const stdoutIterator = proc.stdout[Symbol.asyncIterator]();
        // IMPORTANT: a Node readable's async iterator supports exactly one pending next() call
        // at a time. Calling .next() again on every heartbeat tick (the original version of this
        // fix) started a second concurrent read before the first resolved, silently dropping
        // real chunks on timing-sensitive cases (caught by tests/scenarios.test.ts Scenario 2
        // going empty). Keep the SAME pending promise across heartbeat ticks instead -- only
        // request a new one once the current one actually resolves.
        let pending: ReturnType<typeof stdoutIterator.next> | null = null;
        while (true) {
          if (!pending) pending = stdoutIterator.next();
          const heartbeatTimer = new Promise<'heartbeat'>((resolve) =>
            setTimeout(() => resolve('heartbeat'), AntigravityProviderClient.HEARTBEAT_INTERVAL_MS)
          );
          const result = await Promise.race([pending, heartbeatTimer]);

          if (result === 'heartbeat') {
            if (signal?.aborted || timedOut) break;
            if (!gotFirstChunk) {
              elapsedHeartbeats++;
              yield {
                delta: '',
                modelUsed: targetModel,
                providerUsed: 'antigravity',
                statusNote: `Waiting for Antigravity response (${elapsedHeartbeats * AntigravityProviderClient.HEARTBEAT_INTERVAL_MS / 1000}s)...`
              };
            }
            continue;
          }

          pending = null;
          if (result.done) break;
          gotFirstChunk = true;
          const text = result.value.toString();
          buffer += text;
          yield { delta: text, modelUsed: targetModel, providerUsed: 'antigravity' };
        }
      }

      if (signal?.aborted) return;
      if (timedOut) {
        yield { error: `Antigravity error: timed out after ${AntigravityProviderClient.HARD_TIMEOUT_MS / 1000}s with no response (likely a hung backend connection)`, providerUsed: 'antigravity', modelUsed: targetModel };
        return;
      }
      if (!buffer.trim()) {
        yield { error: `Antigravity error: ${stderr.trim() || 'Empty output'}`, providerUsed: 'antigravity', modelUsed: targetModel };
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      yield { error: `Antigravity execution failed: ${err.message}`, providerUsed: 'antigravity', modelUsed: targetModel };
    } finally {
      clearTimeout(hardTimeout);
      signal?.removeEventListener('abort', kill);
      kill();
    }
  }
}
