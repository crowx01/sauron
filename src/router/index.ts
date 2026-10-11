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
import { computeBlastRadius, BlastRadiusResult } from './blast_radius';
import { requestPlanDAG, executePlanDAG, isNonLinearTask, PlanNode, DAGExecutionResult } from './plan_dag';
import { actionCache, ActionCache, templatePrompt } from './action_cache';
import { ruleMiner, RuleMiner, CompiledRule, RuleMatchResult } from './rule_miner';

export { STATIC_CATALOG, computeBlastRadius, requestPlanDAG, executePlanDAG, isNonLinearTask, actionCache, ruleMiner };
export type { BlastRadiusResult, PlanNode, DAGExecutionResult, ActionCache, RuleMiner, CompiledRule, RuleMatchResult };

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

    // Fallback classification representing forced escalation to smart tier
    const escalationFallback: TaskClassification = {
      category: 'general',
      domain: 'general',
      planDepth: 1,
      ambiguity: 0.9,
      confidence: 0.1,
      is_ambiguous: true,
      schema_conformant: false,
      forceEscalate: true
    };

    if (!cheapProvider || !cheapModel) {
      return null;
    }

    const client = providerRegistry.get(cheapProvider);
    if (!client) return null;

    if (options.signal?.aborted) {
      return null;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal) {
      options.signal.addEventListener('abort', abort, { once: true });
    }

    const promptText = prompt.trim().slice(0, 500);
    const classificationPrompt = `Classify this user task. Respond with ONLY a compact raw JSON object conforming strictly to this schema (no markdown, no backticks, no explanations):
{
  "category": "<general|recon|exploit|codegen|audit|analysis>",
  "planDepth": <integer 1-10>,
  "is_ambiguous": <boolean true|false>,
  "confidence": <float 0.0-1.0>
}
Task: ${promptText}`;

    const timeoutMs = 3000;
    let timer: any;
    const timeoutPromise = new Promise<TaskClassification>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(escalationFallback);
      }, timeoutMs);
    });

    const executionPromise = (async (): Promise<TaskClassification> => {
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
          return escalationFallback;
        }

        const jsonMatch = fullResponse.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) {
          return escalationFallback;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          return escalationFallback;
        }

        // Validate schema conformance
        const validCategories = ['general', 'recon', 'exploit', 'codegen', 'audit', 'analysis'];
        const rawCategory = String(parsed.category || parsed.domain || '').trim().toLowerCase();
        const hasValidCategory = validCategories.includes(rawCategory);
        const hasPlanDepth = typeof parsed.planDepth === 'number' || typeof parsed.plan_depth === 'number';
        const hasAmbiguityField = typeof parsed.is_ambiguous === 'boolean' || typeof parsed.ambiguity === 'number';
        const hasConfidenceField = typeof parsed.confidence === 'number';

        const isSchemaConformant = Boolean(parsed && hasValidCategory && (hasPlanDepth || hasConfidenceField || hasAmbiguityField));

        const category = hasValidCategory ? rawCategory : 'general';
        const planDepth = Math.max(1, Math.min(10, Math.round(Number(parsed.planDepth ?? parsed.plan_depth ?? 1))));
        const isAmbiguous = typeof parsed.is_ambiguous === 'boolean'
          ? parsed.is_ambiguous
          : (Number(parsed.ambiguity ?? parsed.ambiguity_score ?? 0.2) > 0.5);
        const ambiguity = isAmbiguous ? 0.8 : Math.max(0, Math.min(1, Number(parsed.ambiguity ?? parsed.ambiguity_score ?? 0.2)));
        const confidence = typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : (1 - ambiguity);

        // Escalation threshold check: confidence < 0.6 or is_ambiguous=true or schema non-conformant
        const CONFIDENCE_THRESHOLD = 0.6;
        const needsEscalation = !isSchemaConformant || isAmbiguous || confidence < CONFIDENCE_THRESHOLD;

        return {
          category,
          domain: category,
          planDepth: planDepth,
          ambiguity: needsEscalation ? Math.max(ambiguity, 0.7) : ambiguity,
          confidence,
          is_ambiguous: isAmbiguous,
          schema_conformant: isSchemaConformant,
          forceEscalate: needsEscalation
        };
      } catch {
        return escalationFallback;
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
   * lessonStore bias, costRank, and workspace blast radius into a single composite complexity score.
   */
  public computeComplexityScore(
    candidate: ModelEntry,
    taskCategory: string,
    classification?: TaskClassification,
    targetFiles?: string[]
  ): number {
    const bias = lessonStore.getBias(candidate.provider, candidate.model, taskCategory);

    // Compute blast radius if file paths are referenced
    let blastRadiusTerm = 0;
    if (targetFiles && targetFiles.length > 0) {
      const { score: blastScore } = computeBlastRadius(targetFiles);
      // Normalized blast radius (0.0 to 1.0): higher blast radius increases complexity,
      // weighting towards more capable/intelligent models
      const normBlast = Math.min(1, blastScore / 10);
      blastRadiusTerm = normBlast * 0.5;
    }

    if (!classification) {
      return (candidate.intelligence * (1 + blastRadiusTerm) * bias);
    }

    const normDepth = Math.max(1, Math.min(10, classification.planDepth || 1)) / 10;
    const normAmbiguity = Math.max(0, Math.min(1, classification.ambiguity ?? 0.2));
    const baseComplexity = normDepth * 0.6 + normAmbiguity * 0.4;
    const complexity = Math.min(1, baseComplexity + blastRadiusTerm);

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
      const shouldForceSmart = classification?.forceEscalate || mode === 'smart';

      if (shouldForceSmart) {
        const smartCandidates = this.catalog
          .filter((m) => m.routable && realAvailable.includes(m.provider))
          .sort((a, b) => b.intelligence - a.intelligence);
        if (smartCandidates.length > 0) {
          targetModel = smartCandidates[0].model;
        } else if (available.includes('antigravity')) {
          targetModel = 'gemini-3.1-pro-high';
        } else if (available.includes('openai')) {
          targetModel = 'gpt-4o';
        } else if (available.includes('gemini')) {
          targetModel = 'gemini-3.5-flash-lite';
        } else {
          targetModel = 'local-engine';
        }
      } else if (mode === 'cheap') {
        if (available.includes('antigravity')) targetModel = 'gemini-3.8-flash-medium';
        else if (available.includes('gemini')) targetModel = 'gemini-3.5-flash-lite';
        else if (available.includes('openai')) {
          targetModel = this.catalog.find((m) => m.provider === 'openai' && m.routable && m.model === 'gpt-4o-mini')?.model
            ?? this.catalog.find((m) => m.provider === 'openai' && m.routable && m.model.includes('mini'))?.model
            ?? this.catalog.filter((m) => m.provider === 'openai' && m.routable).sort((a, b) => a.costRank - b.costRank)[0]?.model
            ?? 'gpt-4o-mini';
        } else targetModel = 'local-engine';
      } else {
        // Auto: combine plan-depth + ambiguity output from classifier with catalog intelligence
        // and lessonStore bias into one complexity score used for candidate ranking.
        // routable:false Claude-exclusion filtering is preserved untouched.
        const taskCategory = options.taskCategory || classification?.category || 'general';
        const targetFiles = options.targetFiles;
        const candidates = this.catalog
          .filter((m) => m.routable && realAvailable.includes(m.provider))
          .sort((a, b) => {
            const scoreA = this.computeComplexityScore(a, taskCategory, classification, targetFiles);
            const scoreB = this.computeComplexityScore(b, taskCategory, classification, targetFiles);
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

    // Extract referenced concrete file paths if not explicitly supplied
    let targetFiles = options.targetFiles;
    if (!targetFiles && messages && messages.length > 0) {
      const userText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const fileMatches = userText.match(/(?:[\w\-./\\]+\.(?:[a-zA-Z0-9]+))\b/g);
      if (fileMatches) {
        targetFiles = Array.from(new Set(fileMatches));
      }
    }

    const routeRes = this.route({
      ...options,
      targetFiles,
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

    // Extract file paths from user message if targetFiles not explicitly provided
    let targetFiles = options.targetFiles;
    if (!targetFiles && messages && messages.length > 0) {
      const userText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      // Regex match file paths like src/foo.ts, ./path/to/file.js, /abs/path, config.json etc.
      const fileMatches = userText.match(/(?:[\w\-./\\]+\.(?:[a-zA-Z0-9]+))\b/g);
      if (fileMatches) {
        targetFiles = Array.from(new Set(fileMatches));
      }
    }

    const { primaryModel, primaryProvider, fallbacks } = this.route({
      ...options,
      targetFiles,
      classification: classification ?? undefined,
      taskCategory: options.taskCategory || classification?.category
    });

    // NOTE / FUTURE PHASE:
    // The full blackboard / shared-context bus across multi-agent turns is explicitly out
    // of scope for this pass and flagged for a future phase. Current coordination is handled
    // via circuit-breaker escalation context propagation across chain targets in dispatch().

    const promptText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

    // 4. Semantic action-graph cache check:
    // Check cache for similarity >= 0.90 AND same param slot types; if hit, replay cached sequence directly,
    // skip model call entirely, log a cache-hit lesson entry.
    if (promptText) {
      const cacheResult = actionCache.lookup(promptText);
      if (cacheResult.hit && cacheResult.entry && cacheResult.instantiatedSequence) {
        lessonStore.record({
          model: cacheResult.entry.modelUsed,
          provider: cacheResult.entry.providerUsed,
          success: true,
          latencyMs: 1,
          taskCategory: options.taskCategory || classification?.category || 'cache-hit',
          costRank: 0
        });

        yield { delta: `[Action Cache Hit]: Replaying cached execution sequence (similarity: ${(cacheResult.similarity! * 100).toFixed(0)}%)...\n`, providerUsed: 'local-engine' };

        if (Array.isArray(cacheResult.instantiatedSequence)) {
          yield* executePlanDAG(cacheResult.instantiatedSequence, options);
        } else if (typeof cacheResult.instantiatedSequence === 'string') {
          yield { delta: cacheResult.instantiatedSequence, providerUsed: 'local-engine', finishReason: 'stop' };
        }
        return;
      }
    }

    // 3. Plan/Execute split for 'auto' smart-tier dispatch:
    // If task is classified as multi-step / non-linear, request strict JSON plan DAG from smart-tier model
    // and execute DAG nodes in dependency order via local-engine toolBelt.
    const isSmartTierTarget = primaryProvider !== 'local-engine' && (primaryModel.includes('pro') || primaryModel.includes('gpt-4o') || primaryModel.includes('flash'));
    const isNonLinear = classification ? isNonLinearTask(classification.planDepth, classification.category) : false;

    if (mode === 'auto' && isSmartTierTarget && isNonLinear) {
      const smartClient = providerRegistry.get(primaryProvider);

      if (smartClient && smartClient.isAvailable() && promptText) {
        const dagPlan = await requestPlanDAG(smartClient, primaryModel, promptText, options);
        if (dagPlan && dagPlan.length > 0) {
          const dagExecution = executePlanDAG(dagPlan, options);
          let dagOutput = '';
          for await (const chunk of dagExecution) {
            if (chunk.delta) dagOutput += chunk.delta;
            yield chunk;
          }

          // Cache successfully completed DAG plan
          actionCache.store({
            prompt: promptText,
            providerUsed: primaryProvider,
            modelUsed: primaryModel,
            dagOrToolSequence: dagPlan
          });
          return;
        }
      }
    }

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

      let collectedOutput = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_TARGET; attempt++) {
        if (signal?.aborted) return;
        try {
          for await (const chunk of client.streamResponse(targetMessages, target.model, options)) {
            if (signal?.aborted) return;
            if (chunk.error) {
              failure = chunk.error;
              break;
            }
            if (chunk.delta) collectedOutput += chunk.delta;
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
        const taskCat = options.taskCategory || classification?.category || 'general';
        const skeleton = promptText ? templatePrompt(promptText).skeleton : undefined;
        lessonStore.record({
          model: target.model,
          provider: target.provider,
          success: !failure && hasOutput,
          latencyMs: Date.now() - startTime,
          taskCategory: taskCat,
          costRank: catEntry?.costRank ?? 1,
          promptSkeleton: skeleton,
          error: failure
        });
      }

      if (signal?.aborted) return;
      if (hasOutput) {
        // Never splice a fallback's answer onto a half-delivered one
        if (failure) {
          yield { error: `Stream interrupted: ${failure}`, providerUsed: target.provider, finishReason: 'error' };
        } else if (promptText) {
          // On clean successful dispatch completion, store in action cache
          actionCache.store({
            prompt: promptText,
            providerUsed: target.provider,
            modelUsed: target.model,
            dagOrToolSequence: collectedOutput
          });
          // Opportunistically trigger background rule mining
          try {
            ruleMiner.mineRules();
          } catch {}
        }
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
