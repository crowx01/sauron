import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  isOpenAIChatModel,
  isOpenRouterAllowedModel,
  heuristicallyScoreModel,
  readDiskCache,
  writeDiskCache,
  loadCachedCatalog,
  fetchOpenAIModels,
  fetchOpenRouterModels,
  STATIC_CATALOG,
  CATALOG_CACHE_TTL_MS,
  getCatalogCacheDir
} from '../src/router/catalog_fetch';
import { ChatRouter, chatRouter } from '../src/router';

describe('Sauron Catalog Dynamic Fetch & Cache Suite', () => {
  const cacheDir = getCatalogCacheDir();
  const testOpenAIFile = join(cacheDir, 'openai.json');
  const testOpenRouterFile = join(cacheDir, 'openrouter.json');

  // Test 1: OpenAI model filtering
  test('Filters OpenAI models strictly for chat/reasoning models', () => {
    // Drop list
    expect(isOpenAIChatModel('text-embedding-3-small')).toBe(false);
    expect(isOpenAIChatModel('text-embedding-3-large')).toBe(false);
    expect(isOpenAIChatModel('text-embedding-ada-002')).toBe(false);
    expect(isOpenAIChatModel('whisper-1')).toBe(false);
    expect(isOpenAIChatModel('tts-1')).toBe(false);
    expect(isOpenAIChatModel('tts-1-hd')).toBe(false);
    expect(isOpenAIChatModel('dall-e-2')).toBe(false);
    expect(isOpenAIChatModel('dall-e-3')).toBe(false);
    expect(isOpenAIChatModel('chatgpt-image-latest')).toBe(false);
    expect(isOpenAIChatModel('gpt-image-1')).toBe(false);
    expect(isOpenAIChatModel('omni-moderation-latest')).toBe(false);
    expect(isOpenAIChatModel('text-moderation-007')).toBe(false);
    expect(isOpenAIChatModel('sora-2')).toBe(false);
    expect(isOpenAIChatModel('sora-2-pro')).toBe(false);
    expect(isOpenAIChatModel('babbage-002')).toBe(false);
    expect(isOpenAIChatModel('davinci-002')).toBe(false);
    expect(isOpenAIChatModel('gpt-3.5-turbo-instruct')).toBe(false);
    expect(isOpenAIChatModel('gpt-4o-realtime-preview')).toBe(false);
    expect(isOpenAIChatModel('gpt-4o-audio-preview')).toBe(false);
    expect(isOpenAIChatModel('gpt-4o-mini-transcribe')).toBe(false);
    expect(isOpenAIChatModel('gpt-4o-mini-tts')).toBe(false);
    expect(isOpenAIChatModel('gpt-realtime-mini')).toBe(false);
    expect(isOpenAIChatModel('gpt-live-1')).toBe(false);

    // Keep list
    expect(isOpenAIChatModel('gpt-4o')).toBe(true);
    expect(isOpenAIChatModel('gpt-4o-mini')).toBe(true);
    expect(isOpenAIChatModel('gpt-4o-2024-08-06')).toBe(true);
    expect(isOpenAIChatModel('gpt-4.1')).toBe(true);
    expect(isOpenAIChatModel('gpt-4.1-mini')).toBe(true);
    expect(isOpenAIChatModel('gpt-4.1-nano')).toBe(true);
    expect(isOpenAIChatModel('gpt-5')).toBe(true);
    expect(isOpenAIChatModel('gpt-5-mini')).toBe(true);
    expect(isOpenAIChatModel('gpt-3.5-turbo')).toBe(true);
    expect(isOpenAIChatModel('chatgpt-4o-latest')).toBe(true);
    expect(isOpenAIChatModel('o1')).toBe(true);
    expect(isOpenAIChatModel('o1-mini')).toBe(true);
    expect(isOpenAIChatModel('o1-preview')).toBe(true);
    expect(isOpenAIChatModel('o3')).toBe(true);
    expect(isOpenAIChatModel('o3-mini')).toBe(true);
    expect(isOpenAIChatModel('o4-mini')).toBe(true);
  });

  // Test 2: OpenRouter hard exclusion of Claude/Anthropic
  test('Enforces hard exclusion of any Claude/Anthropic model from OpenRouter', () => {
    // Anthropic slug
    expect(isOpenRouterAllowedModel({ id: 'anthropic/claude-3.5-sonnet' })).toBe(false);
    expect(isOpenRouterAllowedModel({ id: 'anthropic/claude-haiku-5.5' })).toBe(false);
    expect(isOpenRouterAllowedModel({ id: 'anthropic/anything-else' })).toBe(false);
    expect(isOpenRouterAllowedModel({ id: 'some-provider/model', provider_slug: 'anthropic' })).toBe(false);

    // Claude in id
    expect(isOpenRouterAllowedModel({ id: '~anthropic/claude-haiku-latest' })).toBe(false);
    expect(isOpenRouterAllowedModel({ id: 'thirdparty/claude-instant' })).toBe(false);
    expect(isOpenRouterAllowedModel({ id: 'openrouter/claude' })).toBe(false);

    // Claude or Anthropic in name
    expect(isOpenRouterAllowedModel({ id: 'proxy/model-x', name: 'Claude 3.5 Sonnet' })).toBe(false);
    expect(isOpenRouterAllowedModel({ id: 'proxy/model-y', name: 'Anthropic Direct' })).toBe(false);

    // Other non-chat
    expect(isOpenRouterAllowedModel({ id: 'cohere/embed-english-v3.0' })).toBe(false);
    expect(isOpenRouterAllowedModel({ id: 'openai/text-embedding-3-small' })).toBe(false);
    expect(isOpenRouterAllowedModel({ id: 'black-forest-labs/flux-1-image' })).toBe(false);

    // Allowed models
    expect(isOpenRouterAllowedModel({ id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta Llama 3.3 70B' })).toBe(true);
    expect(isOpenRouterAllowedModel({ id: 'deepseek/deepseek-r1', name: 'DeepSeek R1' })).toBe(true);
    expect(isOpenRouterAllowedModel({ id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' })).toBe(true);
    expect(isOpenRouterAllowedModel({ id: 'mistralai/mistral-large-2407', name: 'Mistral Large' })).toBe(true);
    expect(isOpenRouterAllowedModel({ id: 'openai/gpt-4o', name: 'OpenAI GPT-4o' })).toBe(true);
  });

  // Test 3: Heuristic scoring
  test('Assigns intelligence and costRank heuristically by name pattern', () => {
    const miniScore = heuristicallyScoreModel('gpt-4o-mini');
    const nanoScore = heuristicallyScoreModel('gpt-4.1-nano');
    const flashScore = heuristicallyScoreModel('google/gemini-2.0-flash');
    const flagshipScore = heuristicallyScoreModel('gpt-4o');
    const ultraScore = heuristicallyScoreModel('o1');
    const reasoningMini = heuristicallyScoreModel('o3-mini');
    const llama70b = heuristicallyScoreModel('meta-llama/llama-3.3-70b-instruct');

    // Mini/nano/flash should have lower costRank than flagship
    expect(miniScore.costRank).toBe(1);
    expect(nanoScore.costRank).toBe(1);
    expect(flashScore.costRank).toBe(1);
    expect(miniScore.intelligence).toBe(80);

    // Reasoning mini
    expect(reasoningMini.costRank).toBe(1);
    expect(reasoningMini.intelligence).toBe(88);

    // Flagship & Ultra
    expect(flagshipScore.costRank).toBe(3);
    expect(flagshipScore.intelligence).toBe(92);
    expect(llama70b.costRank).toBe(3);
    expect(llama70b.intelligence).toBe(92);

    expect(ultraScore.costRank).toBe(4);
    expect(ultraScore.intelligence).toBe(95);
  });

  // Test 4: Disk caching and TTL
  test('Writes and reads disk cache with TTL detection', () => {
    const dummyModels = [
      {
        model: 'test-cached-model',
        provider: 'openai',
        intelligence: 85,
        costRank: 2,
        routable: true,
        tools: true,
        aliases: []
      }
    ];

    const origHome = process.env.SAURON_HOME;
    const tempDir = `/tmp/sauron-test-cache-${Date.now()}`;
    process.env.SAURON_HOME = tempDir;

    try {
      writeDiskCache('openai', dummyModels);

      const loaded = readDiskCache('openai');
      expect(loaded).not.toBeNull();
      expect(loaded?.models.length).toBe(1);
      expect(loaded?.models[0].model).toBe('test-cached-model');
      expect(loaded?.isStale).toBe(false);

      // Stale test
      const tempCacheDir = join(tempDir, 'catalog_cache');
      mkdirSync(tempCacheDir, { recursive: true, mode: 0o700 });
      const stalePayload = {
        timestamp: Date.now() - (CATALOG_CACHE_TTL_MS + 10000),
        models: dummyModels
      };
      writeFileSync(join(tempCacheDir, 'openai.json'), JSON.stringify(stalePayload));

      const loadedStale = readDiskCache('openai');
      expect(loadedStale).not.toBeNull();
      expect(loadedStale?.isStale).toBe(true);
    } finally {
      if (origHome === undefined) {
        delete process.env.SAURON_HOME;
      } else {
        process.env.SAURON_HOME = origHome;
      }
    }
  });

  // Test 5: Clean skipping when API keys are unset
  test('Skips provider cleanly when API key is unset without throwing', async () => {
    const resOpenAI = await fetchOpenAIModels('fake-unset-dummy-that-we-wont-use');
    // Calling with empty string or undefined
    const resUnset = await fetchOpenAIModels('');
    expect(resUnset).toEqual([]);

    const resORUnset = await fetchOpenRouterModels('');
    expect(resORUnset).toEqual([]);
  });

  // Test 6: ChatRouter catalog merges static and dynamic entries
  test('ChatRouter merges static non-OpenAI/OpenRouter entries and dynamic models', () => {
    const router = new ChatRouter();
    const catalog = router.getCatalog();

    // Must contain static Claude entries with routable: false
    const claude37 = catalog.find((m) => m.model === 'claude-3-7-sonnet');
    expect(claude37).toBeDefined();
    expect(claude37?.routable).toBe(false);

    const claudeCli = catalog.find((m) => m.model === 'claude-cli');
    expect(claudeCli).toBeDefined();
    expect(claudeCli?.routable).toBe(false);

    const orClaude = catalog.find((m) => m.model === 'anthropic/claude-3.5-sonnet');
    expect(orClaude).toBeDefined();
    expect(orClaude?.routable).toBe(false);

    // Must contain static non-Claude entries
    const geminiFlash = catalog.find((m) => m.model === 'gemini-2.0-flash');
    expect(geminiFlash).toBeDefined();
    expect(geminiFlash?.routable).toBe(true);

    const localEngine = catalog.find((m) => m.model === 'local-engine');
    expect(localEngine).toBeDefined();
    expect(localEngine?.routable).toBe(true);

    // Absolutely NO Claude model in catalog should be routable: true
    const autoRoutableClaude = catalog.filter((m) =>
      m.routable && (m.model.toLowerCase().includes('claude') || m.provider === 'anthropic')
    );
    expect(autoRoutableClaude).toEqual([]);
  });

  // Test 7: updateDynamicCatalog preserves static entries and test additions
  test('updateDynamicCatalog cleanly swaps dynamic entries while preserving custom/static ones', () => {
    const router = new ChatRouter();
    (router as any).catalog.push({
      model: 'custom-adversarial-test',
      provider: 'custom',
      intelligence: 1,
      costRank: 0,
      routable: true,
      tools: false,
      aliases: []
    });

    const newOpenAIModels = [
      {
        model: 'gpt-4o',
        provider: 'openai',
        intelligence: 92,
        costRank: 3,
        routable: true,
        tools: true,
        aliases: ['gpt4o']
      }
    ];

    const newOpenRouterModels = [
      {
        model: 'deepseek/deepseek-r1',
        provider: 'openrouter',
        intelligence: 85,
        costRank: 2,
        routable: true,
        tools: true,
        aliases: []
      }
    ];

    router.updateDynamicCatalog(newOpenAIModels, newOpenRouterModels);

    const cat = router.getCatalog();
    expect(cat.find((m) => m.model === 'gpt-4o')).toBeDefined();
    expect(cat.find((m) => m.model === 'deepseek/deepseek-r1')).toBeDefined();
    expect(cat.find((m) => m.model === 'custom-adversarial-test')).toBeDefined();
    expect(cat.find((m) => m.model === 'gemini-2.0-flash')).toBeDefined();

    // Static Claude openrouter entry remains routable: false
    const orClaude = cat.find((m) => m.model === 'anthropic/claude-3.5-sonnet');
    expect(orClaude).toBeDefined();
    expect(orClaude?.routable).toBe(false);
  });
});
