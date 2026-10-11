import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ModelEntry } from '../types';
import { configManager } from '../config';

export const CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const STATIC_CATALOG: ModelEntry[] = [
  // Claude-backed entries: explicit-selection only (routable:false), never auto/cheap/smart-picked.
  // Policy: sauron never spends Claude tokens on its own initiative — see Antigravity's
  // claude-sonnet-4-6 / claude-opus-4-6-thinking entries below for the same pattern.
  { model: 'claude-3-7-sonnet', provider: 'anthropic', intelligence: 98, costRank: 3, routable: false, tools: true, aliases: ['sonnet-3.7', 'claude-3.7'] },
  { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic', intelligence: 95, costRank: 3, routable: false, tools: true, aliases: ['sonnet', 'claude-3.5-sonnet'] },
  { model: 'claude-cli', provider: 'claude-cli', intelligence: 94, costRank: 1, routable: false, tools: true, aliases: ['claude'] },
  { model: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', intelligence: 95, costRank: 3, routable: false, tools: true, aliases: ['openrouter/claude'] },
  { model: 'gemini-3.5-flash-lite', provider: 'gemini', intelligence: 88, costRank: 1, routable: true, tools: true, aliases: ['gemini-flash', 'flash'] },
  { model: 'gemini-3.1-pro-high', provider: 'antigravity', intelligence: 93, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.1-pro-low', provider: 'antigravity', intelligence: 90, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.8-flash-high', provider: 'antigravity', intelligence: 87, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.8-flash-medium', provider: 'antigravity', intelligence: 85, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.8-flash-low', provider: 'antigravity', intelligence: 83, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.7-flash-high', provider: 'antigravity', intelligence: 82, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.7-flash-medium', provider: 'antigravity', intelligence: 80, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.7-flash-low', provider: 'antigravity', intelligence: 78, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.6-flash-high', provider: 'antigravity', intelligence: 77, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.6-flash-medium', provider: 'antigravity', intelligence: 75, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gemini-3.6-flash-low', provider: 'antigravity', intelligence: 73, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'gpt-oss-120b-medium', provider: 'antigravity', intelligence: 70, costRank: 1, routable: true, tools: false, aliases: [] },
  { model: 'claude-sonnet-4-6', provider: 'antigravity', intelligence: 95, costRank: 1, routable: false, tools: false, aliases: [] },
  { model: 'claude-opus-4-6-thinking', provider: 'antigravity', intelligence: 97, costRank: 1, routable: false, tools: false, aliases: [] },
  { model: 'local-engine', provider: 'local-engine', intelligence: 50, costRank: 0, routable: true, tools: true, aliases: ['local'] }
];

export interface CachePayload {
  timestamp: number;
  models: ModelEntry[];
}

export function getCatalogCacheDir(): string {
  const customHome = process.env.SAURON_HOME;
  const baseDir = customHome || join(homedir(), '.sauron');
  return join(baseDir, 'catalog_cache');
}

/**
 * Filter OpenAI models: only chat/completion-capable models.
 * Drops embeddings, audio/tts/whisper/realtime/transcribe, image, moderation, sora,
 * instruct-completion (babbage/davinci/instruct).
 * Keeps gpt-*, o1/o3/o4* reasoning models.
 */
export function isOpenAIChatModel(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const lower = id.toLowerCase();

  // Drop embeddings
  if (lower.includes('embedding')) return false;

  // Drop audio / tts / whisper / realtime / transcribe / live
  if (
    lower.includes('audio') ||
    lower.includes('tts') ||
    lower.includes('whisper') ||
    lower.includes('realtime') ||
    lower.includes('transcribe') ||
    lower.includes('live')
  ) {
    return false;
  }

  // Drop image / dall-e
  if (lower.includes('image') || lower.includes('dall-e')) return false;

  // Drop moderation
  if (lower.includes('moderation')) return false;

  // Drop sora
  if (lower.includes('sora')) return false;

  // Drop legacy instruct-completion (babbage, davinci, instruct)
  if (
    lower.includes('babbage') ||
    lower.includes('davinci') ||
    lower.includes('instruct')
  ) {
    return false;
  }

  // Keep gpt-*, o1/o3/o4* reasoning models, and chatgpt-*
  if (
    lower.startsWith('gpt-') ||
    /^o[134](?:-|$)/.test(lower) ||
    lower.startsWith('chatgpt-')
  ) {
    return true;
  }

  return false;
}

/**
 * Filter OpenRouter models:
 * Hard exclude any id whose provider slug is "anthropic" or whose id/name contains "claude"
 * (case-insensitive). Standing policy: sauron must never auto-route to a Claude-backed model.
 */
export function isOpenRouterAllowedModel(item: { id?: string; name?: string; provider_slug?: string }): boolean {
  if (!item || !item.id || typeof item.id !== 'string') return false;

  const idLower = item.id.toLowerCase();
  const nameLower = (item.name || '').toLowerCase();
  const cleanId = idLower.replace(/^~/, '');
  const slug = cleanId.split('/')[0];
  const providerSlug = (item.provider_slug || '').toLowerCase();

  // Hard exclude Claude / Anthropic
  if (slug === 'anthropic' || providerSlug === 'anthropic') {
    return false;
  }
  if (idLower.includes('anthropic') || nameLower.includes('anthropic')) {
    return false;
  }
  if (idLower.includes('claude') || nameLower.includes('claude')) {
    return false;
  }

  // Drop non-chat embeddings, moderation, image generators
  if (
    idLower.includes('embed') ||
    idLower.includes('moderation') ||
    idLower.includes('image') ||
    idLower.includes('dall-e')
  ) {
    return false;
  }

  return true;
}

/**
 * Assigns intelligence and costRank heuristically based on model naming patterns.
 */
export function heuristicallyScoreModel(modelId: string): { intelligence: number; costRank: number } {
  const id = modelId.toLowerCase();

  const isMiniNanoFlash =
    id.includes('mini') ||
    id.includes('nano') ||
    id.includes('flash') ||
    id.includes('lite') ||
    id.includes('small') ||
    /-[1-8]b\b/.test(id);

  if (isMiniNanoFlash) {
    if (id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) {
      return { intelligence: 88, costRank: 1 };
    }
    return { intelligence: 80, costRank: 1 };
  }

  // Ultra / reasoning / flagship
  if (
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.includes('opus') ||
    id.includes('max') ||
    id.includes('405b')
  ) {
    return { intelligence: 95, costRank: 4 };
  }

  // High-end flagships
  if (
    id.includes('pro') ||
    id.includes('gpt-4') ||
    id.includes('gpt-5') ||
    id.includes('gpt-6') ||
    id.includes('70b') ||
    id.includes('72b') ||
    id.includes('plus')
  ) {
    return { intelligence: 92, costRank: 3 };
  }

  // Standard/general LLMs
  return { intelligence: 85, costRank: 2 };
}

/**
 * Reads disk cache for a provider under ~/.sauron/catalog_cache/{provider}.json.
 */
export function readDiskCache(provider: 'openai' | 'openrouter'): { models: ModelEntry[]; isStale: boolean } | null {
  try {
    const dir = getCatalogCacheDir();
    const filePath = join(dir, `${provider}.json`);
    if (!existsSync(filePath)) return null;

    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CachePayload;
    if (!parsed || !Array.isArray(parsed.models)) return null;

    const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0;
    const isStale = Date.now() - timestamp > CATALOG_CACHE_TTL_MS;
    return { models: parsed.models, isStale };
  } catch {
    return null;
  }
}

/**
 * Writes fetched models to disk cache under ~/.sauron/catalog_cache/{provider}.json.
 */
export function writeDiskCache(provider: 'openai' | 'openrouter', models: ModelEntry[]): void {
  try {
    const dir = getCatalogCacheDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const filePath = join(dir, `${provider}.json`);
    const payload: CachePayload = {
      timestamp: Date.now(),
      models
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch {
    // Silently ignore disk write issues
  }
}

/**
 * Synchronously loads cached models from disk (falling back to empty array if absent/corrupt).
 */
export function loadCachedCatalog(): { openai: ModelEntry[]; openrouter: ModelEntry[]; openaiStale: boolean; openrouterStale: boolean } {
  const openAICache = readDiskCache('openai');
  const openRouterCache = readDiskCache('openrouter');

  return {
    openai: openAICache ? openAICache.models : [],
    openrouter: openRouterCache ? openRouterCache.models : [],
    openaiStale: !openAICache || openAICache.isStale,
    openrouterStale: !openRouterCache || openRouterCache.isStale
  };
}

/**
 * Fetches OpenAI models from https://api.openai.com/v1/models.
 * Skips cleanly (no throw, returns []) if key is unset.
 */
export async function fetchOpenAIModels(apiKey?: string): Promise<ModelEntry[]> {
  const key = apiKey !== undefined ? apiKey : (configManager.getApiKey('openai') || process.env.OPENAI_API_KEY);
  if (!key) {
    return [];
  }

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      return [];
    }

    const json = await res.json() as { data?: { id?: string }[] };
    if (!json || !Array.isArray(json.data)) {
      return [];
    }

    const entries: ModelEntry[] = [];
    for (const item of json.data) {
      const id = item.id;
      if (!id || typeof id !== 'string') continue;
      if (!isOpenAIChatModel(id)) continue;

      const { intelligence, costRank } = heuristicallyScoreModel(id);
      const aliases: string[] = [];
      if (id === 'gpt-4o') aliases.push('gpt4o');
      else if (id === 'gpt-4o-mini') aliases.push('mini', 'gpt4o-mini');
      else if (id === 'o1-mini') aliases.push('o1mini');
      else if (id === 'o3-mini') aliases.push('o3mini');

      entries.push({
        model: id,
        provider: 'openai',
        intelligence,
        costRank,
        routable: true,
        tools: true,
        aliases
      });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Fetches OpenRouter models from https://openrouter.ai/api/v1/models.
 * Skips cleanly (no throw, returns []) if key is unset.
 */
export async function fetchOpenRouterModels(apiKey?: string): Promise<ModelEntry[]> {
  const key = apiKey !== undefined ? apiKey : (configManager.getApiKey('openrouter') || process.env.OPENROUTER_API_KEY);
  if (!key) {
    return [];
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      return [];
    }

    const json = await res.json() as { data?: { id?: string; name?: string; provider_slug?: string }[] };
    if (!json || !Array.isArray(json.data)) {
      return [];
    }

    const entries: ModelEntry[] = [];
    for (const item of json.data) {
      const id = item.id;
      if (!id || typeof id !== 'string') continue;
      if (!isOpenRouterAllowedModel(item)) continue;

      const { intelligence, costRank } = heuristicallyScoreModel(id);

      entries.push({
        model: id,
        provider: 'openrouter',
        intelligence,
        costRank,
        routable: true,
        tools: true,
        aliases: []
      });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Fetches dynamic catalog for both providers, caches to disk, and falls back to stale cache on error.
 */
export async function fetchDynamicCatalog(): Promise<{ openai: ModelEntry[]; openrouter: ModelEntry[] }> {
  const [openaiResult, openrouterResult] = await Promise.allSettled([
    fetchOpenAIModels(),
    fetchOpenRouterModels()
  ]);

  const fetchedOpenAI = openaiResult.status === 'fulfilled' ? openaiResult.value : [];
  const fetchedOpenRouter = openrouterResult.status === 'fulfilled' ? openrouterResult.value : [];

  if (fetchedOpenAI.length > 0) {
    writeDiskCache('openai', fetchedOpenAI);
  }
  if (fetchedOpenRouter.length > 0) {
    writeDiskCache('openrouter', fetchedOpenRouter);
  }

  const cachedOpenAI = readDiskCache('openai')?.models || [];
  const cachedOpenRouter = readDiskCache('openrouter')?.models || [];

  return {
    openai: fetchedOpenAI.length > 0 ? fetchedOpenAI : cachedOpenAI,
    openrouter: fetchedOpenRouter.length > 0 ? fetchedOpenRouter : cachedOpenRouter
  };
}
