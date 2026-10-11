import { Message, ModelEntry, RouterOptions, StreamChunk, TaskClassification } from '../types';
import { providerRegistry, LocalSessionProviderClient } from '../providers';
import { lessonStore } from './lessons';
import { sessionStore } from '../session';
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
  private classificationCache = new Map<string, { classification: TaskClassification; expiresAt: number }>();

  public getCachedClassification(sessionId: string): TaskClassification | undefined {
    const entry = this.classificationCache.get(sessionId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.classificationCache.delete(sessionId);
      return undefined;
    }
    return entry.classification;
  }

  public setCachedClassification(
    sessionId: string,
    classification: TaskClassification,
    ttlMs: number = 120_000
  ): void {
    this.classificationCache.set(sessionId, {
      classification,
      expiresAt: Date.now() + ttlMs
    });
  }

  public clearClassificationCache(): void {
    this.classificationCache.clear();
  }

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

  /**
   * Fast cheap local classification step with hard cap ~3s.
   * Prefers antigravity gemini-3.8-flash-low, then gemini-3.5-flash-lite.
   * Returns task domain/category, estimated plan-step depth, and ambiguity/confidence score.
   * Degrades gracefully (returns null) if no cheap model is available or call fails/times out.
   */
  public async classifyTask(
    prompt: string,
    options: RouterOptions = {}
  ): Promise<TaskClassification | null> {
    let cheapProvider: string | null = null;
    let cheapModel: string | null = null;

    // Direct API (gemini) preferred over antigravity here: `agy` is a ~200MB CLI binary with
    // real process-spawn overhead, so it reliably blows the 3s classify budget and degrades to
    // null on every call — defeating the point of a fast pre-dispatch probe. antigravity is a
    // fine dispatch *target* (see route()'s normal candidate scoring), just not this fast-path.
    if (providerRegistry.get('gemini')?.isAvailable()) {
      cheapProvider = 'gemini';
      cheapModel = 'gemini-3.5-flash-lite';
    } else if (providerRegistry.get('antigravity')?.isAvailable()) {
      cheapProvider = 'antigravity';
      cheapModel = 'gemini-3.8-flash-low';
    }

    if (!cheapProvider || !cheapModel) {
      return null;
    }

    const client = providerRegistry.get(cheapProvider);
    if (!client) return null;

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal) {
      options.signal.addEventListener('abort', abort, { once: true });
    }

    const promptText = prompt.trim().slice(0, 500);
    const classificationPrompt = `Classify this user task. Respond with ONLY a compact raw JSON object (no markdown, no backticks, no explanations):
{"category":"<general|recon|exploit|codegen|audit|analysis>","planDepth":<integer 1-10>,"ambiguity":<float 0.0-1.0>}
Task: ${promptText}`;

    const timeoutMs = 3000;
    let timer: any;
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });

    const executionPromise = (async (): Promise<TaskClassification | null> => {
      try {
        let fullResponse = '';
        const msgs: Message[] = [
          {
            id: `cls_${Date.now()}`,
            role: 'user',
            content: classificationPrompt,
            timestamp: Date.now()
          }
        ];

        for await (const chunk of client.streamResponse(msgs, cheapModel, {
          signal: controller.signal
        })) {
          if (controller.signal.aborted) break;
          if (chunk.delta) fullResponse += chunk.delta;
          if (chunk.error) break;
        }

        if (controller.signal.aborted || !fullResponse.trim()) {
          return null;
        }

        const jsonMatch = fullResponse.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);
        const category = String(parsed.category || parsed.domain || 'general').trim().toLowerCase();
        const planDepth = Math.max(1, Math.min(10, Math.round(Number(parsed.planDepth ?? parsed.plan_depth ?? 1))));
        const ambiguity = Math.max(0, Math.min(1, Number(parsed.ambiguity ?? parsed.ambiguity_score ?? 0.2)));
        const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? (1 - ambiguity))));

        return {
          category,
          domain: category,
          planDepth,
          ambiguity,
          confidence
        };
      } catch {
        return null;
      }
    })();

    try {
      return await Promise.race([executionPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener('abort', abort);
      }
    }
  }

  /**
   * Combine classifier plan-depth + ambiguity with catalog intelligence,
   * lessonStore bias, and costRank into a single composite complexity score.
   */
  public computeComplexityScore(
    candidate: ModelEntry,
    taskCategory: string,
    classification?: TaskClassification
  ): number {
    const bias = lessonStore.getBias(candidate.provider, candidate.model, taskCategory);
    if (!classification) {
      return candidate.intelligence * bias;
    }

    const normDepth = Math.max(1, Math.min(10, classification.planDepth || 1)) / 10;
    const normAmbiguity = Math.max(0, Math.min(1, classification.ambiguity ?? 0.2));
    const complexity = normDepth * 0.6 + normAmbiguity * 0.4;

    const intelligenceWeight = 0.7 + complexity * 0.6;
    const costPenalty = (1 - complexity) * (candidate.costRank * 4);

    return (candidate.intelligence * intelligenceWeight * bias) - costPenalty;
  }

  /**
   * Bundles prior attempt failures into an escalation context note and passes it
   * forward to subsequent fallback targets in the chain.
   */
  public buildEscalationMessages(
    messages: Message[],
    failureHistory: { provider: string; model: string; reason: string }[]
  ): Message[] {
    if (failureHistory.length === 0) return messages;

    const failureSummary = failureHistory
      .map((f) => `- Target ${f.provider}/${f.model} failed: ${f.reason}`)
      .join('\n');
    const escalationNote = `[Routing Escalation Context: Prior attempt(s) failed in fallback chain:\n${failureSummary}\nPlease fulfill the user's request taking prior failure causes into account.]`;

    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx !== -1) {
      return messages.map((m, idx) =>
        idx === systemIdx
          ? { ...m, content: `${m.content}\n\n${escalationNote}` }
          : m
      );
    }

    return [
      {
        id: `esc_${Date.now()}_${failureHistory.length}`,
        role: 'system',
        content: escalationNote,
        timestamp: Date.now()
      },
      ...messages
    ];
  }

  public route(options: RouterOptions): {
    primaryModel: string;
    primaryProvider: string;
    fallbacks: { model: string; provider: string }[];
    classification?: TaskClassification;
  } {
    let targetModel = options.model;
    const mode = options.mode || 'auto';

    const available = providerRegistry.getAvailableProviders();

    // Available real providers (excluding local-engine)
    const realAvailable = available.filter((p) => p !== 'local-engine');

    const sessionId = options.sessionId || sessionStore.getActiveSession()?.id || 'default';
    const classification = options.classification ?? this.getCachedClassification(sessionId);

    if (!targetModel || targetModel === 'auto') {
      // Claude (anthropic/openrouter-claude/claude-cli) is never an auto cheap/smart pick —
      // policy: sauron never spends Claude tokens on its own initiative. Claude stays
      // reachable only via explicit `--model claude-cli` / `--model claude-3-7-sonnet` etc.
      if (mode === 'cheap') {
        if (available.includes('antigravity')) targetModel = 'gemini-3.8-flash-medium';
        else if (available.includes('gemini')) targetModel = 'gemini-3.5-flash-lite';
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
        } else if (available.includes('gemini')) targetModel = 'gemini-3.5-flash-lite';
        else targetModel = 'local-engine';
      } else {
        // Auto: combine plan-depth + ambiguity output from classifier with catalog intelligence
        // and lessonStore bias into one complexity score used for candidate ranking.
        // routable:false Claude-exclusion filtering is preserved untouched.
        const taskCategory = options.taskCategory || classification?.category || 'general';
        const candidates = this.catalog
          .filter((m) => m.routable && realAvailable.includes(m.provider))
          .sort((a, b) => {
            const scoreA = this.computeComplexityScore(a, taskCategory, classification);
            const scoreB = this.computeComplexityScore(b, taskCategory, classification);
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
      fallbacks,
      classification: classification ?? undefined
    };
  }

  public async routeAsync(
    options: RouterOptions = {},
    messages?: Message[]
  ): Promise<{ primaryModel: string; primaryProvider: string; fallbacks: { model: string; provider: string }[]; classification?: TaskClassification }> {
    let classification = options.classification;
    const mode = options.mode || 'auto';
    const sessionId = options.sessionId || sessionStore.getActiveSession()?.id || 'default';

    if ((!options.model || options.model === 'auto') && mode === 'auto' && !classification) {
      classification = this.getCachedClassification(sessionId);
      if (!classification && messages && messages.length > 0) {
        const promptText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
        if (promptText) {
          classification = (await this.classifyTask(promptText, options)) ?? undefined;
          if (classification) {
            this.setCachedClassification(sessionId, classification);
          }
        }
      }
    }

    const routeRes = this.route({
      ...options,
      classification: classification ?? undefined,
      taskCategory: options.taskCategory || classification?.category
    });

    return {
      ...routeRes,
      classification: classification ?? undefined
    };
  }

  public async *dispatch(
    messages: Message[],
    options: RouterOptions = {}
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = options.signal;
    const mode = options.mode || 'auto';
    const sessionId = options.sessionId || sessionStore.getActiveSession()?.id || 'default';

    // 1. Cheap local classifier step in 'auto' mode before route()'s complexity sort
    let classification = options.classification;
    if ((!options.model || options.model === 'auto') && mode === 'auto') {
      if (!classification) {
        classification = this.getCachedClassification(sessionId);
      }
      if (!classification) {
        const promptText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
        if (promptText) {
          classification = (await this.classifyTask(promptText, options)) ?? undefined;
          if (classification) {
            this.setCachedClassification(sessionId, classification);
          }
        }
      }
    }

    const { primaryModel, primaryProvider, fallbacks } = this.route({
      ...options,
      classification: classification ?? undefined,
      taskCategory: options.taskCategory || classification?.category
    });

    // NOTE / FUTURE PHASE:
    // The full blackboard / shared-context bus across multi-agent turns is explicitly out
    // of scope for this pass and flagged for a future phase. Current coordination is handled
    // via circuit-breaker escalation context propagation across chain targets in dispatch().

    const chain = [{ model: primaryModel, provider: primaryProvider }, ...fallbacks];
    const failureHistory: { provider: string; model: string; reason: string }[] = [];
    const MAX_ATTEMPTS_PER_TARGET = 1; // Circuit-breaker attempt budget per chain target

    for (const target of chain) {
      if (signal?.aborted) return;
      const client = providerRegistry.get(target.provider);
      if (!client || !client.isAvailable()) continue;

      let hasOutput = false;
      let failure: string | undefined;
      const startTime = Date.now();

      // Pass forward bundled failure summary as extra escalation context to fallback targets
      const targetMessages = this.buildEscalationMessages(messages, failureHistory);

      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_TARGET; attempt++) {
        if (signal?.aborted) return;
        try {
          for await (const chunk of client.streamResponse(targetMessages, target.model, options)) {
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

        if (hasOutput || failure) break;
      }

      if (!hasOutput && !failure) {
        failure = 'Empty output from provider';
      }

      if (target.provider !== 'local-engine') {
        const catEntry = this.catalog.find((m) => m.model === target.model && m.provider === target.provider);
        lessonStore.record({
          model: target.model,
          provider: target.provider,
          success: !failure && hasOutput,
          latencyMs: Date.now() - startTime,
          taskCategory: options.taskCategory || classification?.category || 'general',
          costRank: catEntry?.costRank ?? 1,
          error: failure
        });
      }

      if (signal?.aborted) return;
      if (hasOutput) {
        // Never splice a fallback's answer onto a half-delivered one
        if (failure) yield { error: `Stream interrupted: ${failure}`, providerUsed: target.provider, finishReason: 'error' };
        return;
      }

      // Bundle failure summary for escalation to next chain target
      failureHistory.push({
        provider: target.provider,
        model: target.model,
        reason: failure || 'failed with no output'
      });
    }

    // Last resort fallback with escalation context
    if (signal?.aborted) return;
    const local = new LocalSessionProviderClient();
    const finalMessages = this.buildEscalationMessages(messages, failureHistory);
    yield* local.streamResponse(finalMessages, primaryModel, options);
  }
}

export const chatRouter = new ChatRouter();
