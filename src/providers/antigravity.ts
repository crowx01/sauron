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
      if (proc.stdout) {
        for await (const chunk of proc.stdout) {
          const text = chunk.toString();
          buffer += text;
          yield { delta: text, modelUsed: targetModel, providerUsed: 'antigravity' };
        }
      }

      if (signal?.aborted) return;
      if (!buffer.trim()) {
        yield { error: `Antigravity error: ${stderr.trim() || 'Empty output'}`, providerUsed: 'antigravity', modelUsed: targetModel };
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      yield { error: `Antigravity execution failed: ${err.message}`, providerUsed: 'antigravity', modelUsed: targetModel };
    } finally {
      signal?.removeEventListener('abort', kill);
      kill();
    }
  }
}
