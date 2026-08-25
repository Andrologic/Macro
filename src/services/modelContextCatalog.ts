import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { ModelContextLimitSource, ReasoningTransportMode } from '../types';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODEL_CONTEXT_CATALOG_TTL_MS = 5 * 60 * 1000;

const STORAGE_KEY = 'macro_modelContextCatalog_v1';

export interface CatalogModelLimits {
  contextTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  source: Extract<ModelContextLimitSource, 'models_dev'>;
  updatedAt: string;
}

export interface CatalogReasoningCapability {
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  configurable: boolean;
  transportMode?: ReasoningTransportMode;
}

export interface ModelContextCatalogStatus {
  lastFetchedAt: string | null;
  source: 'cache' | 'network' | 'snapshot';
  stale: boolean;
  error: string | null;
}

interface ModelsDevModel {
  id?: unknown;
  reasoning?: unknown;
  limit?: {
    context?: unknown;
    input?: unknown;
    output?: unknown;
  };
}

interface ModelsDevProvider {
  id?: unknown;
  models?: Record<string, ModelsDevModel>;
}

interface CachedCatalog {
  fetchedAt: string;
  providers: Record<string, ModelsDevProvider>;
}

const SNAPSHOT_FETCHED_AT = '2026-05-11T00:00:00.000Z';

const SNAPSHOT_PROVIDERS: Record<string, ModelsDevProvider> = {
  openai: {
    id: 'openai',
    models: {
      'gpt-4o': { id: 'gpt-4o', limit: { context: 128_000, output: 16_384 } },
      'gpt-4.1': { id: 'gpt-4.1', limit: { context: 1_047_576, output: 32_768 } },
      'gpt-5': {
        id: 'gpt-5',
        reasoning: { efforts: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
        limit: { context: 400_000, output: 128_000 },
      },
    },
  },
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-3-5-sonnet-latest': {
        id: 'claude-3-5-sonnet-latest',
        limit: { context: 200_000, output: 8_192 },
      },
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        limit: { context: 200_000, output: 64_000 },
      },
    },
  },
  openrouter: {
    id: 'openrouter',
    models: {
      'moonshotai/kimi-k2': {
        id: 'moonshotai/kimi-k2',
        limit: { context: 128_000, output: 32_000 },
      },
      'anthropic/claude-sonnet-4.5': {
        id: 'anthropic/claude-sonnet-4.5',
        limit: { context: 200_000, output: 64_000 },
      },
      'qwen/qwen3.6-plus': {
        id: 'qwen/qwen3.6-plus',
        limit: { context: 1_000_000, output: 66_000 },
      },
      'qwen3.6-plus': {
        id: 'qwen3.6-plus',
        limit: { context: 1_000_000, output: 66_000 },
      },
    },
  },
  'github-copilot': {
    id: 'github-copilot',
    models: {
      'gpt-4o': { id: 'gpt-4o', limit: { context: 128_000, output: 16_384 } },
      'claude-sonnet-4.5': {
        id: 'claude-sonnet-4.5',
        limit: { context: 200_000, output: 64_000 },
      },
    },
  },
  'opencode-go': {
    id: 'opencode-go',
    models: {
      'kimi-k2.6': { id: 'kimi-k2.6', limit: { context: 128_000, output: 32_000 } },
      'kimi-k2': { id: 'kimi-k2', limit: { context: 128_000, output: 32_000 } },
      'qwen3.6-plus': { id: 'qwen3.6-plus', limit: { context: 262_144, output: 66_000 } },
      'qwen3-6-plus': { id: 'qwen3-6-plus', limit: { context: 262_144, output: 66_000 } },
      'qwen/qwen3.6-plus': {
        id: 'qwen/qwen3.6-plus',
        limit: { context: 262_144, output: 66_000 },
      },
    },
  },
};

let loadedCatalog: CachedCatalog | null = null;
let lastStatus: ModelContextCatalogStatus = {
  lastFetchedAt: null,
  source: 'snapshot',
  stale: true,
  error: null,
};
let refreshPromise: Promise<ModelContextCatalogStatus> | null = null;

const toPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;

const normalize = (value?: string | null): string =>
  (value || '').trim().toLowerCase();

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !seen.has(entry) && seen.add(entry));
};

const toTransportMode = (value: unknown): ReasoningTransportMode | undefined => {
  if (
    value === 'openai_effort' ||
    value === 'openrouter_reasoning' ||
    value === 'deepseek_thinking' ||
    value === 'kimi_fixed'
  ) return value;
  return undefined;
};

const normalizeBaseUrl = (value?: string | null): string =>
  normalize(value).replace(/\/+$/, '');

const safeParseCatalog = (raw: string | null): CachedCatalog | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedCatalog>;
    if (!parsed || typeof parsed.fetchedAt !== 'string' || !parsed.providers) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      providers: parsed.providers as Record<string, ModelsDevProvider>,
    };
  } catch {
    return null;
  }
};

const readCachedCatalog = (): CachedCatalog | null => {
  if (loadedCatalog) return loadedCatalog;
  if (typeof window === 'undefined' || !window.localStorage) return null;
  loadedCatalog = safeParseCatalog(window.localStorage.getItem(STORAGE_KEY));
  return loadedCatalog;
};

const writeCachedCatalog = (catalog: CachedCatalog) => {
  loadedCatalog = catalog;
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog));
  } catch {
    // Cache persistence failure should not block context-limit resolution.
  }
};

const getSnapshotCatalog = (): CachedCatalog => ({
  fetchedAt: SNAPSHOT_FETCHED_AT,
  providers: SNAPSHOT_PROVIDERS,
});

const isFresh = (catalog: CachedCatalog, now = Date.now()): boolean => {
  const fetchedMs = Date.parse(catalog.fetchedAt);
  return Number.isFinite(fetchedMs) && now - fetchedMs < MODEL_CONTEXT_CATALOG_TTL_MS;
};

const getProviderAliases = (params: {
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
}): string[] => {
  const aliases = new Set<string>();
  const providerType = normalize(params.providerType);
  const providerId = normalize(params.providerId);
  const baseUrl = normalizeBaseUrl(params.baseUrl);

  [providerId, providerType].forEach((value) => {
    if (value) aliases.add(value);
  });

  if (providerType === 'chatgpt' || providerType === 'openai') aliases.add('openai');
  if (providerType === 'anthropic') aliases.add('anthropic');
  if (providerType === 'openrouter') aliases.add('openrouter');
  if (providerType === 'copilot') aliases.add('github-copilot');
  if (baseUrl.includes('opencode.ai/zen/go')) aliases.add('opencode-go');
  if (baseUrl.includes('openrouter.ai')) aliases.add('openrouter');
  if (baseUrl.includes('api.openai.com')) aliases.add('openai');
  if (baseUrl.includes('api.anthropic.com')) aliases.add('anthropic');

  return Array.from(aliases);
};

const getModelCandidates = (modelId?: string | null): string[] => {
  const normalized = normalize(modelId);
  if (!normalized) return [];
  const candidates = new Set([normalized]);
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    candidates.add(normalized.slice(slashIndex + 1));
  }
  const colonIndex = normalized.lastIndexOf(':');
  if (colonIndex >= 0 && colonIndex < normalized.length - 1) {
    candidates.add(normalized.slice(0, colonIndex));
  }
  return Array.from(candidates);
};

const providerFromCatalog = (
  catalog: CachedCatalog,
  providerAlias: string,
): ModelsDevProvider | undefined =>
  catalog.providers[providerAlias] ??
  Object.values(catalog.providers).find(
    (provider) => normalize(provider.id as string | undefined) === providerAlias,
  );

const limitFromModel = (
  model: ModelsDevModel | undefined,
  fetchedAt: string,
): CatalogModelLimits | null => {
  const contextTokens = toPositiveInteger(model?.limit?.context);
  if (!contextTokens) return null;
  return {
    contextTokens,
    inputTokens: toPositiveInteger(model?.limit?.input),
    outputTokens: toPositiveInteger(model?.limit?.output),
    source: 'models_dev',
    updatedAt: fetchedAt,
  };
};

const reasoningFromModel = (
  model: ModelsDevModel | undefined,
): CatalogReasoningCapability | null => {
  const reasoning = model?.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) return null;
  const metadata = reasoning as Record<string, unknown>;
  const reasoningEfforts = toStringArray(
    metadata.efforts ?? metadata.levels ?? metadata.supported_efforts,
  );
  if (reasoningEfforts.length === 0) return null;
  const requestedDefault =
    typeof metadata.default === 'string'
      ? metadata.default.trim()
      : typeof metadata.default_effort === 'string'
        ? metadata.default_effort.trim()
        : '';
  return {
    reasoningEfforts,
    defaultReasoningEffort: reasoningEfforts.includes(requestedDefault)
      ? requestedDefault
      : reasoningEfforts[0] ?? null,
    configurable: typeof metadata.configurable === 'boolean'
      ? metadata.configurable
      : reasoningEfforts.length > 1,
    transportMode: toTransportMode(metadata.transport_mode ?? metadata.transportMode),
  };
};

export const lookupModelContextCatalogLimit = (params: {
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
}): CatalogModelLimits | null => {
  const catalogs = [readCachedCatalog(), getSnapshotCatalog()].filter(
    (catalog): catalog is CachedCatalog => Boolean(catalog),
  );
  const providerAliases = getProviderAliases(params);
  const modelCandidates = getModelCandidates(params.modelId);

  for (const catalog of catalogs) {
    for (const providerAlias of providerAliases) {
      const provider = providerFromCatalog(catalog, providerAlias);
      if (!provider?.models) continue;
      const indexedModels = new Map(
        Object.entries(provider.models).map(([key, model]) => [
          normalize((model.id as string | undefined) ?? key),
          model,
        ]),
      );
      for (const candidate of modelCandidates) {
        const direct = limitFromModel(indexedModels.get(candidate), catalog.fetchedAt);
        if (direct) return direct;
      }
    }
  }

  return null;
};

export const lookupModelReasoningCatalogCapability = (params: {
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
}): CatalogReasoningCapability | null => {
  const catalogs = [readCachedCatalog(), getSnapshotCatalog()].filter(
    (catalog): catalog is CachedCatalog => Boolean(catalog),
  );
  const providerAliases = getProviderAliases(params);
  const modelCandidates = getModelCandidates(params.modelId);

  for (const catalog of catalogs) {
    for (const providerAlias of providerAliases) {
      const provider = providerFromCatalog(catalog, providerAlias);
      if (!provider?.models) continue;
      const indexedModels = new Map(
        Object.entries(provider.models).map(([key, model]) => [
          normalize((model.id as string | undefined) ?? key),
          model,
        ]),
      );
      for (const candidate of modelCandidates) {
        const capability = reasoningFromModel(indexedModels.get(candidate));
        if (capability) return capability;
      }
    }
  }
  return null;
};

export const getModelContextCatalogStatus = (): ModelContextCatalogStatus => {
  const cache = readCachedCatalog();
  if (!cache) return lastStatus;
  return {
    lastFetchedAt: cache.fetchedAt,
    source: lastStatus.source === 'network' ? 'network' : 'cache',
    stale: !isFresh(cache),
    error: lastStatus.error,
  };
};

export const refreshModelContextCatalog = async (params: {
  force?: boolean;
  fetchImpl?: typeof tauriFetch;
} = {}): Promise<ModelContextCatalogStatus> => {
  const cached = readCachedCatalog();
  if (!params.force && cached && isFresh(cached)) {
    lastStatus = {
      lastFetchedAt: cached.fetchedAt,
      source: 'cache',
      stale: false,
      error: null,
    };
    return lastStatus;
  }
  if (refreshPromise) return refreshPromise;

  const fetchImpl = params.fetchImpl ?? tauriFetch;
  refreshPromise = (async () => {
    try {
      const response = await fetchImpl(MODELS_DEV_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Models.dev returned ${response.status}`);
      }
      const providers = (await response.json()) as Record<string, ModelsDevProvider>;
      const fetchedAt = new Date().toISOString();
      const catalog: CachedCatalog = { fetchedAt, providers };
      writeCachedCatalog(catalog);
      lastStatus = {
        lastFetchedAt: fetchedAt,
        source: 'network',
        stale: false,
        error: null,
      };
      return lastStatus;
    } catch (error) {
      const fallback = cached ?? getSnapshotCatalog();
      loadedCatalog = fallback;
      lastStatus = {
        lastFetchedAt: cached?.fetchedAt ?? null,
        source: cached ? 'cache' : 'snapshot',
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      };
      return lastStatus;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
};

export const __testables = {
  STORAGE_KEY,
  getProviderAliases,
  getModelCandidates,
  safeParseCatalog,
  writeCachedCatalog,
  reset: () => {
    loadedCatalog = null;
    refreshPromise = null;
    lastStatus = {
      lastFetchedAt: null,
      source: 'snapshot',
      stale: true,
      error: null,
    };
  },
};
