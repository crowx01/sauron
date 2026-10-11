import { Message, StreamChunk, RouterOptions } from '../types';
import { configManager } from '../config';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AntigravityProviderClient } from './antigravity';

export interface ProviderClient {
  providerName: string;
  isAvailable: () => boolean;
  streamResponse: (
    messages: Message[],
    model: string,
    options?: RouterOptions
  ) => AsyncGenerator<StreamChunk, void, unknown>;
}

export class ClaudeCLIProviderClient implements ProviderClient {
  public providerName = 'claude-cli';

  private availableUntil = 0;
  private availableCache = false;

  public isAvailable(): boolean {
    // Cached: route() runs per dispatch and spawnSync blocks the event loop
    const now = Date.now();
    if (now < this.availableUntil) return this.availableCache;
    this.availableCache =
      existsSync('/home/kali/.local/bin/claude') || Boolean(spawnSync('which', ['claude']).stdout?.toString().trim());
    this.availableUntil = now + 30_000;
    return this.availableCache;
  }

  public async *streamResponse(
    messages: Message[],
    model: string,
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = options.signal;
    const claudeBin = existsSync('/home/kali/.local/bin/claude') ? '/home/kali/.local/bin/claude' : 'claude';

    // Format full conversation history for Claude CLI
    let promptContext = '';
    const recentMsgs = messages.slice(-10);
    for (const msg of recentMsgs) {
      if (msg.role === 'user') {
        promptContext += `User: ${msg.content}\n`;
      } else if (msg.role === 'assistant') {
        promptContext += `Assistant: ${msg.content}\n`;
      } else if (msg.role === 'system') {
        promptContext += `System: ${msg.content}\n`;
      }
    }
    promptContext += `Assistant:`;

    let proc: ReturnType<typeof spawn> | undefined;
    const kill = () => {
      if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', kill, { once: true });
    try {
      if (signal?.aborted) return;
      proc = spawn(claudeBin, ['--safe-mode', '-p', promptContext], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      // Drain stderr concurrently so a chatty child can't block on a full pipe
      const stderrPromise = proc.stderr ? streamToString(proc.stderr) : Promise.resolve('');

      let buffer = '';
      if (proc.stdout) {
        for await (const chunk of proc.stdout) {
          const text = chunk.toString();
          buffer += text;
          yield { delta: text, modelUsed: 'claude-cli', providerUsed: 'claude-cli' };
        }
      }

      if (signal?.aborted) return;
      if (!buffer.trim()) {
        const errText = await stderrPromise;
        yield { error: `Claude CLI error: ${errText || 'Empty output'}`, providerUsed: 'claude-cli' };
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      yield { error: `Claude CLI execution failed: ${err.message}`, providerUsed: 'claude-cli' };
    } finally {
      // Consumer break / abort / error: never leave the child running
      signal?.removeEventListener('abort', kill);
      kill();
    }
  }
}

/** Abortable sleep: the timer is always cleared, so no handle outlives a cancel. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Yields complete SSE lines; always cancels the body reader (closes the socket) on early exit. */
async function* readLines(res: Response, signal?: AbortSignal): AsyncGenerator<string, void, unknown> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) yield line.trim();
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

/** Never let an upstream error message leak a credential (Gemini puts the key in the URL). */
function redact(msg: string, secret?: string): string {
  return secret ? msg.split(secret).join('***') : msg;
}

async function streamToString(stream: any): Promise<string> {
  let str = '';
  for await (const chunk of stream) {
    str += chunk.toString();
  }
  return str;
}

export class LocalSessionProviderClient implements ProviderClient {
  public providerName = 'local-engine';

  public isAvailable(): boolean {
    return true;
  }

  public async *streamResponse(
    messages: Message[],
    model: string,
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = options.signal;
    const lastMsg = (messages[messages.length - 1]?.content ?? '').toLowerCase().trim();
    
    // Look up stored facts in recent conversation history (e.g. name, preferences)
    let rememberedName = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const match = messages[i].content.match(/(?:my name is|i am|call me)\s+([a-zA-Z0-9_\-]+)/i);
      if (match) {
        rememberedName = match[1];
        break;
      }
    }

    let answer = '';
    if (lastMsg.includes('your name') || lastMsg.includes('who are you')) {
      answer = "I am Sauron AI, an offensive-security orchestrator and multi-model assistant.";
    } else if (lastMsg.includes('my name') || lastMsg.includes('know my name') || lastMsg.includes('who am i')) {
      if (rememberedName) {
        answer = `Yes, your name is ${rememberedName}!`;
      } else {
        answer = "I don't believe you've told me your name yet. What would you like me to call you?";
      }
    } else if (lastMsg === 'hi' || lastMsg === 'hello' || lastMsg === 'hey') {
      answer = rememberedName ? `Hello ${rememberedName}! How can I assist you with your work today?` : "Hello! How can I assist you with your tasks or model routing today?";
    } else {
      answer = `Received your message: "${messages[messages.length - 1]?.content}". ` + 
               (rememberedName ? `(Recorded session for ${rememberedName}).` : "");
    }

    const words = answer.split(' ');
    for (const w of words) {
      yield { delta: w + ' ', modelUsed: model, providerUsed: 'local-engine' };
      if (signal?.aborted) return;
      await abortableSleep(20, signal);
    }
  }
}

export class OpenAIProviderClient implements ProviderClient {
  public providerName = 'openai';

  public isAvailable(): boolean {
    return Boolean(configManager.getApiKey('openai'));
  }

  public async *streamResponse(
    messages: Message[],
    model: string,
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = options.signal;
    const apiKey = configManager.getApiKey('openai');
    if (!apiKey) {
      yield { error: 'OpenAI API key missing', providerUsed: 'openai', modelUsed: model };
      return;
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        signal,
        body: JSON.stringify({
          model: model || 'gpt-4o',
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true
        })
      });

      if (!res.ok) {
        yield { error: `OpenAI HTTP ${res.status}: ${res.statusText}`, providerUsed: 'openai' };
        return;
      }

      for await (const trimmed of readLines(res, signal)) {
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;
          try {
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              yield { delta, modelUsed: model, providerUsed: 'openai' };
            }
          } catch (err) {}
        }
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      yield { error: redact(err.message || 'OpenAI network error', apiKey), providerUsed: 'openai' };
    }
  }
}

export class AnthropicProviderClient implements ProviderClient {
  public providerName = 'anthropic';

  public isAvailable(): boolean {
    return Boolean(configManager.getApiKey('anthropic'));
  }

  public async *streamResponse(
    messages: Message[],
    model: string,
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = options.signal;
    const apiKey = configManager.getApiKey('anthropic');
    if (!apiKey) {
      yield { error: 'Anthropic API key missing', providerUsed: 'anthropic', modelUsed: model };
      return;
    }

    try {
      const systemMsg = messages.find((m) => m.role === 'system')?.content || 'You are Sauron AI assistant.';
      const chatMsgs = messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal,
        body: JSON.stringify({
          model: model || 'claude-3-5-sonnet-20241022',
          system: systemMsg,
          messages: chatMsgs,
          max_tokens: 4096,
          stream: true
        })
      });

      if (!res.ok) {
        yield { error: `Anthropic HTTP ${res.status}: ${res.statusText}`, providerUsed: 'anthropic' };
        return;
      }

      for await (const trimmed of readLines(res, signal)) {
        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            if (json.type === 'content_block_delta' && json.delta?.text) {
              yield { delta: json.delta.text, modelUsed: model, providerUsed: 'anthropic' };
            }
          } catch (e) {}
        }
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      yield { error: redact(err.message || 'Anthropic network error', apiKey), providerUsed: 'anthropic' };
    }
  }
}

export class GeminiProviderClient implements ProviderClient {
  public providerName = 'gemini';

  public isAvailable(): boolean {
    return Boolean(configManager.getApiKey('gemini'));
  }

  public async *streamResponse(
    messages: Message[],
    model: string,
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = options.signal;
    const apiKey = configManager.getApiKey('gemini');
    if (!apiKey) {
      yield { error: 'Gemini API key missing', providerUsed: 'gemini', modelUsed: model };
      return;
    }

    try {
      const targetModel = model || 'gemini-3.5-flash-lite';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?alt=sse&key=${apiKey}`;

      const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ contents })
      });

      if (!res.ok) {
        yield { error: `Gemini HTTP ${res.status}: ${res.statusText}`, providerUsed: 'gemini' };
        return;
      }

      for await (const trimmed of readLines(res, signal)) {
        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              yield { delta: text, modelUsed: model, providerUsed: 'gemini' };
            }
          } catch (e) {}
        }
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      yield { error: redact(err.message || 'Gemini network error', apiKey), providerUsed: 'gemini' };
    }
  }
}

export class OpenRouterProviderClient implements ProviderClient {
  public providerName = 'openrouter';

  public isAvailable(): boolean {
    return Boolean(configManager.getApiKey('openrouter'));
  }

  public async *streamResponse(
    messages: Message[],
    model: string,
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = options.signal;
    const apiKey = configManager.getApiKey('openrouter');
    if (!apiKey) {
      yield { error: 'OpenRouter API key missing', providerUsed: 'openrouter', modelUsed: model };
      return;
    }

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/crowx01/sauron',
          'X-Title': 'Sauron AI'
        },
        signal,
        body: JSON.stringify({
          model: model || 'anthropic/claude-3.5-sonnet',
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true
        })
      });

      if (!res.ok) {
        yield { error: `OpenRouter HTTP ${res.status}: ${res.statusText}`, providerUsed: 'openrouter' };
        return;
      }

      for await (const trimmed of readLines(res, signal)) {
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;
          try {
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              yield { delta, modelUsed: model, providerUsed: 'openrouter' };
            }
          } catch (e) {}
        }
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      yield { error: redact(err.message || 'OpenRouter network error', apiKey), providerUsed: 'openrouter' };
    }
  }
}

export class ProviderRegistry {
  private providers: Map<string, ProviderClient> = new Map();

  constructor() {
    this.register(new ClaudeCLIProviderClient());
    this.register(new LocalSessionProviderClient());
    this.register(new OpenAIProviderClient());
    this.register(new AnthropicProviderClient());
    this.register(new GeminiProviderClient());
    this.register(new OpenRouterProviderClient());
    this.register(new AntigravityProviderClient());
  }

  public register(client: ProviderClient) {
    this.providers.set(client.providerName, client);
  }

  public get(name: string): ProviderClient | undefined {
    return this.providers.get(name);
  }

  public getAvailableProviders(): string[] {
    const out: string[] = [];
    for (const [name, client] of this.providers.entries()) {
      if (client.isAvailable()) {
        out.push(name);
      }
    }
    return out;
  }
}

export const providerRegistry = new ProviderRegistry();
