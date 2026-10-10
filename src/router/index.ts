import { Message, ModelEntry, RouterOptions, StreamChunk } from '../types';
import { providerRegistry, LocalSessionProviderClient } from '../providers';
import { lessonStore } from './lessons';

export class ChatRouter {
  private catalog: ModelEntry[] = [
    { model: 'claude-3-7-sonnet', provider: 'anthropic', intelligence: 98, costRank: 3, routable: true, tools: true, aliases: ['sonnet-3.7', 'claude-3.7'] },
    { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic', intelligence: 95, costRank: 3, routable: true, tools: true, aliases: ['sonnet', 'claude-3.5-sonnet'] },
    { model: 'claude-cli', provider: 'claude-cli', intelligence: 94, costRank: 1, routable: true, tools: true, aliases: ['claude'] },
    { model: 'gpt-4o', provider: 'openai', intelligence: 92, costRank: 3, routable: true, tools: true, aliases: ['gpt4o'] },
    { model: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', intelligence: 95, costRank: 3, routable: true, tools: true, aliases: ['openrouter/claude'] },
    { model: 'gemini-2.0-flash', provider: 'gemini', intelligence: 88, costRank: 1, routable: true, tools: true, aliases: ['gemini-flash', 'flash'] },
    { model: 'gpt-4o-mini', provider: 'openai', intelligence: 80, costRank: 1, routable: true, tools: true, aliases: ['mini'] },
    { model: 'local-engine', provider: 'local-engine', intelligence: 50, costRank: 0, routable: true, tools: true, aliases: ['local'] }
  ];

  public getCatalog(): ModelEntry[] {
    return [...this.catalog];
  }

  public route(options: RouterOptions): { primaryModel: string; primaryProvider: string; fallbacks: { model: string; provider: string }[] } {
    let targetModel = options.model;
    const mode = options.mode || 'auto';

    const available = providerRegistry.getAvailableProviders();

    // Available real providers (excluding local-engine)
    const realAvailable = available.filter((p) => p !== 'local-engine');

    if (!targetModel || targetModel === 'auto') {
      if (mode === 'cheap') {
        if (available.includes('gemini')) targetModel = 'gemini-2.0-flash';
        else if (available.includes('openai')) targetModel = 'gpt-4o-mini';
        else if (available.includes('claude-cli')) targetModel = 'claude-cli';
        else targetModel = 'local-engine';
      } else if (mode === 'smart') {
        if (available.includes('anthropic')) targetModel = 'claude-3-7-sonnet';
        else if (available.includes('openai')) targetModel = 'gpt-4o';
        else if (available.includes('openrouter')) targetModel = 'anthropic/claude-3.5-sonnet';
        else if (available.includes('claude-cli')) targetModel = 'claude-cli';
        else targetModel = 'local-engine';
      } else {
        // Auto: highest intelligence among real providers, nudged by distilled routing lessons
        // (a route that's actually been failing for this task category gets de-prioritized,
        // without ever letting history override the catalog ordering outright).
        const taskCategory = options.taskCategory || 'general';
        const candidates = this.catalog
          .filter((m) => realAvailable.includes(m.provider))
          .sort((a, b) => {
            const scoreA = a.intelligence * lessonStore.getBias(a.provider, a.model, taskCategory);
            const scoreB = b.intelligence * lessonStore.getBias(b.provider, b.model, taskCategory);
            return scoreB - scoreA;
          });

        if (candidates.length > 0) {
          targetModel = candidates[0].model;
        } else {
          targetModel = 'local-engine';
        }
      }
    }

    const matched = this.catalog.find(
      (m) => m.model === targetModel || m.aliases.includes(targetModel || '')
    );

    const primaryProvider = matched ? matched.provider : (realAvailable[0] || 'local-engine');
    const primaryModel = matched ? matched.model : (targetModel || 'local-engine');

    // Build fallback chain: real providers sorted by intelligence descending, local-engine strictly LAST
    const fallbacks: { model: string; provider: string }[] = [];
    const remainingReal = this.catalog
      .filter((m) => m.provider !== 'local-engine' && m.provider !== primaryProvider && realAvailable.includes(m.provider))
      .sort((a, b) => b.intelligence - a.intelligence);

    for (const r of remainingReal) {
      if (!fallbacks.some((f) => f.provider === r.provider)) {
        fallbacks.push({ model: r.model, provider: r.provider });
      }
    }

    // local-engine is strictly the last fallback
    fallbacks.push({ model: 'local-engine', provider: 'local-engine' });

    return {
      primaryModel,
      primaryProvider,
      fallbacks
    };
  }

  public async *dispatch(
    messages: Message[],
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const { primaryModel, primaryProvider, fallbacks } = this.route(options);

    const signal = options.signal;
    const chain = [{ model: primaryModel, provider: primaryProvider }, ...fallbacks];

    for (const target of chain) {
      if (signal?.aborted) return;
      const client = providerRegistry.get(target.provider);
      if (!client || !client.isAvailable()) continue;

      let hasOutput = false;
      let failure: string | undefined;
      const startTime = Date.now();
      try {
        for await (const chunk of client.streamResponse(messages, target.model, options)) {
          if (signal?.aborted) return;
          if (chunk.error) {
            failure = chunk.error;
            break;
          }
          hasOutput = true;
          yield chunk;
        }
      } catch (e: any) {
        failure = e?.message || 'provider threw';
      }

      if (target.provider !== 'local-engine') {
        lessonStore.record({
          model: target.model,
          provider: target.provider,
          success: !failure && hasOutput,
          latencyMs: Date.now() - startTime,
          taskCategory: options.taskCategory || 'general',
          error: failure
        });
      }

      if (signal?.aborted) return;
      if (hasOutput) {
        // Never splice a fallback's answer onto a half-delivered one
        if (failure) yield { error: `Stream interrupted: ${failure}`, providerUsed: target.provider, finishReason: 'error' };
        return;
      }
    }

    // Last resort fallback
    if (signal?.aborted) return;
    const local = new LocalSessionProviderClient();
    yield* local.streamResponse(messages, primaryModel, options);
  }
}

export const chatRouter = new ChatRouter();
