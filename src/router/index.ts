import { Message, ModelEntry, RouterOptions, StreamChunk } from '../types';
import { providerRegistry, LocalSessionProviderClient } from '../providers';
import { lessonStore } from './lessons';
import {
  STATIC_CATALOG,
  loadCachedCatalog,
  fetchDynamicCatalog,
  readDiskCache
} from './catalog_fetch';

export { STATIC_CATALOG };

export class ChatRouter {
  public defaultModel = 'gemini-3.1-pro-high';

  public getDefaultModel(): string {
    return this.defaultModel;
  }

  public catalog: ModelEntry[] = [];
  private isRefreshing = false;

  constructor() {
    this.initCatalog();
  }

  private initCatalog(): void {
    const cached = loadCachedCatalog();
    this.catalog = [...STATIC_CATALOG, ...cached.openai, ...cached.openrouter];

    if (cached.openaiStale || cached.openrouterStale) {
      this.refreshCatalog().catch(() => {});
    }
  }

  public checkAndRefreshStale(): void {
    const cached = loadCachedCatalog();
    if (cached.openaiStale || cached.openrouterStale) {
      this.refreshCatalog().catch(() => {});
    }
  }

  public async refreshCatalog(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      const dynamic = await fetchDynamicCatalog();
      this.updateDynamicCatalog(dynamic.openai, dynamic.openrouter);
    } catch {
      // Never throw
    } finally {
      this.isRefreshing = false;
    }
  }

  public updateDynamicCatalog(openaiModels: ModelEntry[], openrouterModels: ModelEntry[]): void {
    const staticOpenRouterModels = new Set(
      STATIC_CATALOG.filter((m) => m.provider === 'openrouter').map((m) => m.model)
    );

    const nonDynamic = this.catalog.filter((m) => {
      if (m.provider === 'openai') return false;
      if (m.provider === 'openrouter') return staticOpenRouterModels.has(m.model);
      return true;
    });

    this.catalog = [...nonDynamic, ...openaiModels, ...openrouterModels];
  }

  /** Resolve a model name or alias against the catalog; returns the canonical name or null. */
  public resolveModel(name: string): string | null {
    const q = name.trim().toLowerCase();
    const hit = this.catalog.find((m) => m.model.toLowerCase() === q || m.aliases?.some((a) => a.toLowerCase() === q))
      ?? this.catalog.find((m) => m.model.toLowerCase().includes(q));
    return hit ? hit.model : null;
  }

  public setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  public getCatalog(): ModelEntry[] {
    this.checkAndRefreshStale();
    return [...this.catalog];
  }

  public route(options: RouterOptions): { primaryModel: string; primaryProvider: string; fallbacks: { model: string; provider: string }[] } {
    let targetModel = options.model;
    const mode = options.mode || 'auto';

    const available = providerRegistry.getAvailableProviders();

    // Available real providers (excluding local-engine)
    const realAvailable = available.filter((p) => p !== 'local-engine');

    if (!targetModel || targetModel === 'auto') {
      // Claude (anthropic/openrouter-claude/claude-cli) is never an auto cheap/smart pick —
      // policy: sauron never spends Claude tokens on its own initiative. Claude stays
      // reachable only via explicit `--model claude-cli` / `--model claude-3-7-sonnet` etc.
      if (mode === 'cheap') {
        if (available.includes('antigravity')) targetModel = 'gemini-3.8-flash-medium';
        else if (available.includes('gemini')) targetModel = 'gemini-2.0-flash';
        else if (available.includes('openai')) {
          targetModel = this.catalog.find((m) => m.provider === 'openai' && m.routable && m.model === 'gpt-4o-mini')?.model
            ?? this.catalog.find((m) => m.provider === 'openai' && m.routable && m.model.includes('mini'))?.model
            ?? this.catalog.filter((m) => m.provider === 'openai' && m.routable).sort((a, b) => a.costRank - b.costRank)[0]?.model
            ?? 'gpt-4o-mini';
        } else targetModel = 'local-engine';
      } else if (mode === 'smart') {
        if (available.includes('antigravity')) targetModel = 'gemini-3.1-pro-high';
        else if (available.includes('openai')) {
          targetModel = this.catalog.find((m) => m.provider === 'openai' && m.routable && m.model === 'gpt-4o')?.model
            ?? this.catalog.filter((m) => m.provider === 'openai' && m.routable).sort((a, b) => b.intelligence - a.intelligence)[0]?.model
            ?? 'gpt-4o';
        } else if (available.includes('gemini')) targetModel = 'gemini-2.0-flash';
        else targetModel = 'local-engine';
      } else {
        // Auto: highest intelligence among real providers, nudged by distilled routing lessons
        // (a route that's actually been failing for this task category gets de-prioritized,
        // without ever letting history override the catalog ordering outright).
        const taskCategory = options.taskCategory || 'general';
        const candidates = this.catalog
          .filter((m) => m.routable && realAvailable.includes(m.provider))
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
      .filter((m) => m.routable && m.provider !== 'local-engine' && m.provider !== primaryProvider && realAvailable.includes(m.provider))
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
