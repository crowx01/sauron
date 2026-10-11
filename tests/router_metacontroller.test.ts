import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chatRouter, ChatRouter } from '../src/router';
import { lessonStore, LessonStore } from '../src/router/lessons';
import { sessionStore } from '../src/session';
import { providerRegistry, ProviderClient } from '../src/providers';
import { Message, ModelEntry, StreamChunk, RouterOptions, TaskClassification } from '../src/types';

describe('ChatRouter Meta-Controller & Extended Lessons Suite', () => {
  beforeEach(() => {
    chatRouter.clearClassificationCache();
    lessonStore.clear();
  });

  // -------------------------------------------------------------
  // ITEM 1: Cheap Local Classifier Step & Per-Message Caching
  // -------------------------------------------------------------
  // NOTE (2026-10-11): cache key MUST include the prompt text, not just sessionId. A
  // sessionId-only key meant every message in a session reused the FIRST message's
  // classification for the whole TTL (e.g. one "hi" classified as chitchat silently routed
  // every later "say hi 20 times" in that session to local-engine). See
  // ChatRouter.classificationCacheKey's note in src/router/index.ts.
  test('Item 1.1: Classification cache stores and retrieves per (session, prompt) within TTL', () => {
    const sample: TaskClassification = {
      category: 'recon',
      domain: 'recon',
      planDepth: 4,
      ambiguity: 0.3,
      confidence: 0.7
    };

    chatRouter.setCachedClassification('sess_test_1', 'scan the target', sample, 1000);
    const cached = chatRouter.getCachedClassification('sess_test_1', 'scan the target');
    expect(cached).toBeDefined();
    expect(cached?.category).toBe('recon');
    expect(cached?.planDepth).toBe(4);
    expect(cached?.ambiguity).toBe(0.3);

    // A different message in the SAME session must NOT hit the first message's cache entry.
    expect(chatRouter.getCachedClassification('sess_test_1', 'say hi 20 times')).toBeUndefined();

    // Expired TTL should return undefined
    chatRouter.setCachedClassification('sess_expired', 'scan the target', sample, -1);
    expect(chatRouter.getCachedClassification('sess_expired', 'scan the target')).toBeUndefined();
  });

  test('Item 1.2: classifyTask degrades gracefully when providers are unavailable or fail', async () => {
    // If we call classifyTask with an abort signal that is already aborted, it immediately degrades to null
    const controller = new AbortController();
    controller.abort();

    const res = await chatRouter.classifyTask('Analyze nmap output', { signal: controller.signal });
    expect(res).toBeNull();
  });

  test('Item 1.3: classifyTask enforces ~3s hard cap timeout without hanging', async () => {
    // Register a mock provider that hangs for 10 seconds to verify timeout aborts at ~3s
    const slowClient: ProviderClient = {
      providerName: 'slow-test-provider',
      isAvailable: () => true,
      async *streamResponse(_msgs, _model, opts) {
        const start = Date.now();
        while (Date.now() - start < 10000) {
          if (opts?.signal?.aborted) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        yield { delta: '{"category":"recon","planDepth":2,"ambiguity":0.1}' };
      }
    };

    const origProvider = providerRegistry.get('antigravity');
    providerRegistry.register({ ...slowClient, providerName: 'antigravity' });

    try {
      const t0 = Date.now();
      const res = await chatRouter.classifyTask('Hang test task');
      const elapsed = Date.now() - t0;

      expect(res).toBeDefined();
      expect(res?.forceEscalate).toBe(true); // Timed out gracefully, forced escalate
      expect(elapsed).toBeLessThan(4500); // Must be around 3s, not 10s
    } finally {
      if (origProvider) providerRegistry.register(origProvider);
    }
  });

  test('Item 1.4: classifyTask structured probe parses conformant JSON schema fields', async () => {
    const mockProbe: ProviderClient = {
      providerName: 'mock-probe',
      isAvailable: () => true,
      async *streamResponse() {
        yield { delta: JSON.stringify({ category: 'recon', planDepth: 3, is_ambiguous: false, confidence: 0.95 }) };
      }
    };
    const orig = providerRegistry.get('gemini');
    providerRegistry.register({ ...mockProbe, providerName: 'gemini' });

    try {
      const res = await chatRouter.classifyTask('scan ports on 10.0.0.1');
      expect(res).toBeDefined();
      expect(res?.category).toBe('recon');
      expect(res?.planDepth).toBe(3);
      expect(res?.is_ambiguous).toBe(false);
      expect(res?.schema_conformant).toBe(true);
      expect(res?.confidence).toBe(0.95);
      expect(res?.forceEscalate).toBe(false);
    } finally {
      if (orig) providerRegistry.register(orig);
    }
  });

  test('Item 1.5: classifyTask force-escalates on invalid JSON, ambiguous task, or low confidence', async () => {
    // 1. Invalid JSON probe output
    const brokenProbe: ProviderClient = {
      providerName: 'mock-broken',
      isAvailable: () => true,
      async *streamResponse() {
        yield { delta: 'Not valid json at all' };
      }
    };
    const orig = providerRegistry.get('gemini');
    providerRegistry.register({ ...brokenProbe, providerName: 'gemini' });

    try {
      const res = await chatRouter.classifyTask('some prompt');
      expect(res).toBeDefined();
      expect(res?.forceEscalate).toBe(true);

      // Verify routing forces smart tier
      const routeRes = chatRouter.route({ classification: res! });
      expect(routeRes.primaryModel).not.toBe('local-engine');
    } finally {
      if (orig) providerRegistry.register(orig);
    }

    // 2. is_ambiguous: true
    const ambiguousProbe: ProviderClient = {
      providerName: 'mock-ambiguous',
      isAvailable: () => true,
      async *streamResponse() {
        yield { delta: JSON.stringify({ category: 'general', planDepth: 2, is_ambiguous: true, confidence: 0.9 }) };
      }
    };
    providerRegistry.register({ ...ambiguousProbe, providerName: 'gemini' });

    try {
      const res = await chatRouter.classifyTask('do whatever');
      expect(res).toBeDefined();
      expect(res?.is_ambiguous).toBe(true);
      expect(res?.forceEscalate).toBe(true);
    } finally {
      if (orig) providerRegistry.register(orig);
    }

    // 3. Low confidence (< threshold)
    const lowConfProbe: ProviderClient = {
      providerName: 'mock-low-conf',
      isAvailable: () => true,
      async *streamResponse() {
        yield { delta: JSON.stringify({ category: 'audit', planDepth: 3, is_ambiguous: false, confidence: 0.3 }) };
      }
    };
    providerRegistry.register({ ...lowConfProbe, providerName: 'gemini' });

    try {
      const res = await chatRouter.classifyTask('audit system');
      expect(res).toBeDefined();
      expect(res?.confidence).toBe(0.3);
      expect(res?.forceEscalate).toBe(true);
    } finally {
      if (orig) providerRegistry.register(orig);
    }
  });

  // -------------------------------------------------------------
  // ITEM 1.6: Workspace Blast-Radius Scorer & Routing Term
  // -------------------------------------------------------------
  test('Item 1.6: computeBlastRadius scores touched files, import/export depth, and diagnostics', () => {
    const { computeBlastRadius } = require('../src/router/blast_radius');
    const result = computeBlastRadius(['src/router/index.ts', 'src/types/index.ts']);

    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons[0]).toContain('2 file(s) touched');
  });

  test('Item 1.7: computeComplexityScore incorporates blast-radius weighted term for concrete files', () => {
    const candidate: ModelEntry = {
      model: 'test-model',
      provider: 'test-provider',
      intelligence: 90,
      costRank: 2,
      routable: true,
      tools: false,
      aliases: []
    };

    const classification: TaskClassification = {
      category: 'codegen',
      planDepth: 3,
      ambiguity: 0.2
    };

    const scoreNoFiles = chatRouter.computeComplexityScore(candidate, 'codegen', classification);
    const scoreWithFiles = chatRouter.computeComplexityScore(candidate, 'codegen', classification, ['src/router/index.ts']);

    // Blast radius should increase complexity score towards higher intelligence candidate
    expect(scoreWithFiles).toBeGreaterThan(scoreNoFiles);
  });

  // -------------------------------------------------------------
  // ITEM 1.8: Semantic Action-Graph Cache with SQLite & Jaccard
  // -------------------------------------------------------------
  test('Item 1.8: templatePrompt normalizes slots and computes Jaccard similarity', () => {
    const { templatePrompt, jaccardSimilarity } = require('../src/router/action_cache');

    const t1 = templatePrompt('scan 192.168.1.5 on port 80');
    const t2 = templatePrompt('scan 10.0.0.1 on port 443');

    expect(t1.skeleton).toBe('scan <slot:ip> on port <slot:number>');
    expect(t2.skeleton).toBe('scan <slot:ip> on port <slot:number>');
    expect(jaccardSimilarity(t1.skeleton, t2.skeleton)).toBe(1.0);

    const t3 = templatePrompt('delete file /tmp/test.txt');
    expect(jaccardSimilarity(t1.skeleton, t3.skeleton)).toBeLessThan(0.5);
  });

  test('Item 1.9: actionCache stores, replays on an exact repeat, and refuses a hit on changed slot values', async () => {
    const { actionCache } = require('../src/router/action_cache');
    actionCache.clear();

    const sampleDAG = [
      { id: '1', action: 'bash', args: { command: 'echo "cached output"' }, dependsOn: [] }
    ];

    actionCache.store({
      prompt: 'enumerate hosts at 192.168.1.1',
      providerUsed: 'test-prov',
      modelUsed: 'test-model',
      dagOrToolSequence: sampleDAG
    });

    // Replaying the stored sequence verbatim is only safe when the actual slot VALUES match
    // too (same skeleton + same values = a true exact-prompt repeat), not just the slot TYPES.
    // A different IP must NOT hit -- it would otherwise silently replay a recon/exploit action
    // against the wrong target. See the 2026-10-11 "repeat hi 20/30 times" regression that
    // exposed this same class of bug (type-only matching replaying the wrong parameter).
    const differentIpLookup = actionCache.lookup('enumerate hosts at 10.0.0.99');
    expect(differentIpLookup.hit).toBe(false);

    const sameIpLookup = actionCache.lookup('enumerate hosts at 192.168.1.1');
    expect(sameIpLookup.hit).toBe(true);
    expect(sameIpLookup.similarity).toBeGreaterThanOrEqual(0.90);
    expect(sameIpLookup.entry?.providerUsed).toBe('test-prov');

    // Test dispatch with cache hit (exact same prompt as stored)
    const userMsgs: Message[] = [
      { id: 'msg1', role: 'user', content: 'enumerate hosts at 192.168.1.1', timestamp: Date.now() }
    ];

    const deltas: string[] = [];
    for await (const chunk of chatRouter.dispatch(userMsgs)) {
      if (chunk.delta) deltas.push(chunk.delta);
    }

    const fullDelta = deltas.join('');
    expect(fullDelta).toContain('Action Cache Hit');
    expect(fullDelta).toContain('cached output');
  });

  // -------------------------------------------------------------
  // ITEM 1.10: Self-Compiling Rule Miner & Local-Engine Matcher
  // -------------------------------------------------------------
  test('Item 1.10: RuleMiner promotes patterns with >=3 clean successes and 0 corrections', () => {
    const { ruleMiner } = require('../src/router/rule_miner');
    lessonStore.clear();

    // 3 clean successes for the same prompt skeleton
    for (let i = 0; i < 3; i++) {
      lessonStore.record({
        provider: 'openai',
        model: 'gpt-4o',
        taskCategory: 'recon',
        success: true,
        latencyMs: 100,
        promptSkeleton: 'ping <slot:ip>'
      });
    }

    const rules = ruleMiner.mineRules();
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const rule = rules.find((r: any) => r.promptSkeleton === 'ping <slot:ip>');
    expect(rule).toBeDefined();
    expect(rule?.category).toBe('recon');

    // Test matcher
    const match = ruleMiner.matchCurrentRules('ping 192.168.1.1', 'recon');
    expect(match.matched).toBe(true);
    expect(match.ruleId).toBe(rule?.ruleId);
  });

  test('Item 1.11: User correction within 2 turns invalidates compiled rule on next miner run', () => {
    const { ruleMiner } = require('../src/router/rule_miner');
    lessonStore.clear();

    // 3 clean successes
    for (let i = 0; i < 3; i++) {
      lessonStore.record({
        provider: 'openai',
        model: 'gpt-4o',
        taskCategory: 'general',
        success: true,
        latencyMs: 100,
        promptSkeleton: 'show status'
      });
    }

    let rules = ruleMiner.mineRules();
    expect(rules.some((r: any) => r.promptSkeleton === 'show status')).toBe(true);

    // Turn 1: Rule-driven response
    lessonStore.record({
      provider: 'local-engine',
      model: 'local-engine',
      taskCategory: 'general',
      success: true,
      latencyMs: 10,
      promptSkeleton: 'show status',
      ruleDriven: true
    });

    // Turn 2: User correction
    lessonStore.record({
      provider: 'local-engine',
      model: 'local-engine',
      taskCategory: 'general',
      success: false,
      latencyMs: 10,
      promptSkeleton: 'no that is wrong',
      isCorrection: true
    });

    // Invalidation occurs on next miner run
    rules = ruleMiner.mineRules();
    expect(rules.some((r: any) => r.promptSkeleton === 'show status')).toBe(false);

    const match = ruleMiner.matchCurrentRules('show status', 'general');
    expect(match.matched).toBe(false);
  });

  // -------------------------------------------------------------
  // ITEM 2: Extended LessonStore Ledger & Recency-Weighted Bias
  // -------------------------------------------------------------
  test('Item 2.1: LessonStore tracks fuller ledger with latency, costRank, and taskCategory', () => {
    const store = new LessonStore();
    store.clear();

    store.record({
      provider: 'openai',
      model: 'gpt-4o',
      taskCategory: 'recon',
      latencyMs: 150,
      costRank: 3,
      success: true
    });

    store.record({
      provider: 'openai',
      model: 'gpt-4o',
      taskCategory: 'recon',
      latencyMs: 250,
      costRank: 3,
      success: false,
      error: 'HTTP 500'
    });

    const ledger = store.getLedger('openai', 'gpt-4o', 'recon');
    expect(ledger.length).toBe(1);
    expect(ledger[0].provider).toBe('openai');
    expect(ledger[0].model).toBe('gpt-4o');
    expect(ledger[0].taskCategory).toBe('recon');
    expect(ledger[0].total).toBe(2);
    expect(ledger[0].successes).toBe(1);
    expect(ledger[0].failures).toBe(1);
    expect(ledger[0].successRate).toBe(0.5);
    expect(ledger[0].avgLatency).toBe(200);
    expect(ledger[0].avgCostRank).toBe(3);
  });

  test('Item 2.2: getBias weights recent outcomes higher than older outcomes', () => {
    const store = new LessonStore();
    store.clear();

    const now = Date.now();
    // Simulate old failures from 2 hours ago (timestamp backdated)
    (store as any).outcomes.push({
      provider: 'test-p',
      model: 'test-m',
      taskCategory: 'general',
      latencyMs: 100,
      costRank: 1,
      success: false,
      timestamp: now - 120 * 60 * 1000
    });

    // Simulate recent successes from 1 minute ago
    (store as any).outcomes.push({
      provider: 'test-p',
      model: 'test-m',
      taskCategory: 'general',
      latencyMs: 100,
      costRank: 1,
      success: true,
      timestamp: now - 60 * 1000
    });

    const bias = store.getBias('test-p', 'test-m', 'general');
    // Because recent success is weighted much higher than 2-hour old failure, bias should be >= 1.0
    expect(bias).toBeGreaterThanOrEqual(1.0);
  });

  test('Item 2.3: getBias maintains existing call signature and cooldown contracts', () => {
    lessonStore.clear();

    // Default neutral bias with no history
    expect(lessonStore.getBias('openai', 'brand-new-model')).toBe(1.0);

    // Rate-limit triggers cooldown
    lessonStore.record({
      provider: 'cooldown-provider',
      model: 'cool-model',
      success: false,
      latencyMs: 50,
      error: 'HTTP 429 rate limit exceeded'
    });

    expect(lessonStore.isCooledDown('cooldown-provider', 'cool-model')).toBe(true);
    expect(lessonStore.getBias('cooldown-provider', 'cool-model')).toBe(0.1);
  });

  // -------------------------------------------------------------
  // ITEM 3: Complexity Score in route() auto-mode
  // -------------------------------------------------------------
  test('Item 3.1: Complexity scoring reorders candidates based on planDepth and ambiguity', () => {
    const router = new ChatRouter();

    const highIntelligenceExpensive: ModelEntry = {
      model: 'high-smart-expensive',
      provider: 'mock-real',
      intelligence: 95,
      costRank: 4,
      routable: true,
      tools: true,
      aliases: []
    };

    const cheapFastModel: ModelEntry = {
      model: 'cheap-fast-nano',
      provider: 'mock-real',
      intelligence: 82,
      costRank: 1,
      routable: true,
      tools: true,
      aliases: []
    };

    // Case A: High complexity task (depth: 8, ambiguity: 0.9)
    const complexTask: TaskClassification = {
      category: 'exploit',
      domain: 'exploit',
      planDepth: 8,
      ambiguity: 0.9,
      confidence: 0.1
    };
    const scoreSmartComplex = router.computeComplexityScore(highIntelligenceExpensive, 'exploit', complexTask);
    const scoreCheapComplex = router.computeComplexityScore(cheapFastModel, 'exploit', complexTask);
    expect(scoreSmartComplex).toBeGreaterThan(scoreCheapComplex);

    // Case B: Low complexity task (depth: 1, ambiguity: 0.05)
    const simpleTask: TaskClassification = {
      category: 'general',
      domain: 'general',
      planDepth: 1,
      ambiguity: 0.05,
      confidence: 0.95
    };
    const scoreSmartSimple = router.computeComplexityScore(highIntelligenceExpensive, 'general', simpleTask);
    const scoreCheapSimple = router.computeComplexityScore(cheapFastModel, 'general', simpleTask);
    // Cheap model cost penalty is minimal, so cheap model scores competitively or higher
    expect(scoreCheapSimple).toBeGreaterThan(scoreSmartSimple - 10);
  });

  test('Item 3.2: Claude models remain strictly non-routable in auto mode', () => {
    const catalog = chatRouter.getCatalog();
    const claudeModels = catalog.filter(
      (m) => m.model.toLowerCase().includes('claude') || m.provider === 'anthropic'
    );

    // Every Claude entry must be non-routable
    for (const cm of claudeModels) {
      expect(cm.routable).toBe(false);
    }

    // Auto routing must NEVER pick a non-routable Claude model
    const route = chatRouter.route({ mode: 'auto' });
    expect(route.primaryModel).not.toContain('claude');
    expect(route.primaryProvider).not.toBe('anthropic');
  });

  // -------------------------------------------------------------
  // ITEM 4: Circuit-Breaker Escalation in dispatch()
  // -------------------------------------------------------------
  test('Item 4.1: buildEscalationMessages bundles failure summaries into context', () => {
    const router = new ChatRouter();
    const originalMessages: Message[] = [
      { id: '1', role: 'user', content: 'What is the target IP?', timestamp: Date.now() }
    ];

    const failures = [
      { provider: 'antigravity', model: 'gemini-3.1-pro-high', reason: 'HTTP 429 rate limit' },
      { provider: 'openai', model: 'gpt-4o', reason: 'Empty output from provider' }
    ];

    const escalated = router.buildEscalationMessages(originalMessages, failures);
    expect(escalated.length).toBe(2);

    const systemMsg = escalated.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toContain('[Routing Escalation Context: Prior attempt(s) failed in fallback chain:');
    expect(systemMsg?.content).toContain('antigravity/gemini-3.1-pro-high failed: HTTP 429 rate limit');
    expect(systemMsg?.content).toContain('openai/gpt-4o failed: Empty output from provider');

    // Original user message is preserved at the end
    expect(escalated[escalated.length - 1].content).toBe('What is the target IP?');
  });

  test('Item 4.2: dispatch() passes escalation failure context forward upon target errors', async () => {
    let capturedFallbackMessages: Message[] | undefined;

    // Register a failing target A and a fallback target B that records incoming messages
    const failingTarget: ProviderClient = {
      providerName: 'mock-fail',
      isAvailable: () => true,
      async *streamResponse() {
        yield { error: 'Mock simulated upstream error 503', providerUsed: 'mock-fail' };
      }
    };

    const fallbackTarget: ProviderClient = {
      providerName: 'mock-fallback',
      isAvailable: () => true,
      async *streamResponse(msgs) {
        capturedFallbackMessages = msgs;
        yield { delta: 'Fallback succeeded with escalated context', providerUsed: 'mock-fallback' };
      }
    };

    providerRegistry.register(failingTarget);
    providerRegistry.register(fallbackTarget);

    const router = new ChatRouter();
    (router as any).catalog = [
      {
        model: 'fail-model',
        provider: 'mock-fail',
        intelligence: 95,
        costRank: 2,
        routable: true,
        tools: false,
        aliases: []
      },
      {
        model: 'fallback-model',
        provider: 'mock-fallback',
        intelligence: 85,
        costRank: 1,
        routable: true,
        tools: false,
        aliases: []
      },
      {
        model: 'local-engine',
        provider: 'local-engine',
        intelligence: 50,
        costRank: 0,
        routable: true,
        tools: true,
        aliases: []
      }
    ];

    const userMsgs: Message[] = [
      { id: '1', role: 'user', content: 'Escalate this task', timestamp: Date.now() }
    ];

    const deltas: string[] = [];
    for await (const chunk of router.dispatch(userMsgs, { mode: 'auto' })) {
      if (chunk.delta) deltas.push(chunk.delta);
    }

    expect(deltas.join('')).toContain('Fallback succeeded');
    expect(capturedFallbackMessages).toBeDefined();

    // The fallback target MUST have received the failure context explaining why mock-fail failed!
    const systemEscalation = capturedFallbackMessages?.find((m) => m.role === 'system');
    expect(systemEscalation).toBeDefined();
    expect(systemEscalation?.content).toContain('mock-fail/fail-model failed: Mock simulated upstream error 503');
  });

  // -------------------------------------------------------------
  // ITEM 5: Future Phase Note Verified
  // -------------------------------------------------------------
  test('Item 5: Out-of-scope note for full blackboard / shared-context bus is documented in router', async () => {
    const fs = await import('node:fs');
    const routerCode = fs.readFileSync('src/router/index.ts', 'utf-8');

    expect(routerCode).toContain('blackboard');
    expect(routerCode).toContain('future phase');
  });
});
