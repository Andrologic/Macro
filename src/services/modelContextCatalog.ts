import snapshot from '../shared/ai/modelsDevSnapshot.json';
import { parseModelsDevProviders, validCatalogDate, type ModelsDevModel, type ModelsDevProvider } from '../shared/ai/modelsDevSchema';
import { tauriFetch } from './tauriHttp';
import type { ModelContextLimitSource, ReasoningTransportMode } from '../types';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODEL_CONTEXT_CATALOG_TTL_MS = 5 * 60 * 1000;

export interface ModelCatalogProviderParams {
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
}

/** Catalogue facts only. These do not grant account access or enable a model. */
export interface ModelCatalogMetadata {
  id: string;
  name: string;
  description?: string;
  family?: string;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  images?: boolean;
  toolCall?: boolean;
  updatedAt: string;
}

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

interface CachedCatalog {
  fetchedAt: string;
  providers: Record<string, ModelsDevProvider>;
}

const SNAPSHOT_FETCHED_AT = snapshot.fetchedAt;
const SNAPSHOT_PROVIDERS: Record<string, ModelsDevProvider> = snapshot.providers;

let loadedCatalog: CachedCatalog | null = null;
let loadedCatalogSource: ModelContextCatalogStatus['source'] | null = null;
let lastStatus: ModelContextCatalogStatus = {
  lastFetchedAt: null,
  source: 'snapshot',
  stale: true,
  error: null,
};
let refreshPromise: Promise<ModelContextCatalogStatus> | null = null;
const statusListeners = new Set<(status: ModelContextCatalogStatus) => void>();

const setLastStatus = (status: ModelContextCatalogStatus): ModelContextCatalogStatus => {
  lastStatus = status;
  for (const listener of statusListeners) listener(status);
  return status;
};

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

const normalizeBaseUrl = (value?: string | null): string =>
  normalize(value).replace(/\/+$/, '');

const safeParseCatalog = (raw: string | null): CachedCatalog | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('fetchedAt' in parsed) ||
      !validCatalogDate(parsed.fetchedAt) || !('providers' in parsed)) return null;
    const providers = parseModelsDevProviders(parsed.providers);
    return providers ? { fetchedAt: parsed.fetchedAt, providers } : null;
  } catch {
    return null;
  }
};

const readCachedCatalog = (): CachedCatalog | null => {
  if (loadedCatalog && loadedCatalogSource !== 'snapshot') return loadedCatalog;
  try {
    if (typeof window === 'undefined') return null;
    const cached = safeParseCatalog(window.localStorage.getItem(STORAGE_KEY));
    if (cached) {
      loadedCatalog = cached;
      loadedCatalogSource = 'cache';
    }
    return cached;
  } catch {
    return null;
  }
};

const writeCachedCatalog = (
  catalog: CachedCatalog,
  source: Extract<ModelContextCatalogStatus['source'], 'cache' | 'network'> = 'cache',
) => {
  loadedCatalog = catalog;
  loadedCatalogSource = source;
  try {
    if (typeof window === 'undefined') return;
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

const getProviderAliases = (params: ModelCatalogProviderParams): string[] => {
  const type = normalize(params.providerType);
  const id = normalize(params.providerId);
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.hostname === 'opencode.ai' && /^\/zen\/go(?:\/|$)/.test(url.pathname)) return ['opencode-go'];
      if (url.hostname === 'openrouter.ai') return ['openrouter'];
      if (url.hostname === 'api.openai.com') return ['openai'];
      if (url.hostname === 'api.anthropic.com') return ['anthropic'];
    } catch {
      return [];
    }
    // An OpenAI-compatible endpoint does not identify the official OpenAI offer.
    if (type === 'openai') return id && id !== 'openai' ? [id] : [];
  }
  return [...new Set([id, type === 'copilot' ? 'github-copilot' : type === 'chatgpt' ? 'openai' : type])]
    .filter(Boolean);
};

const providerFromCatalog = (
  catalog: CachedCatalog,
  alias: string,
): ModelsDevProvider | null | undefined => {
  if (Object.hasOwn(catalog.providers, alias)) return catalog.providers[alias];
  const matches = Object.entries(catalog.providers).filter(([key, provider]) =>
    normalize(key) === alias || normalize(provider.id) === alias);
  return matches.length > 1 ? null : matches[0]?.[1];
};

const findModel = (provider: ModelsDevProvider, alias: string, modelId: string): [string, ModelsDevModel] | null | undefined => {
  const entries = Object.entries(provider.models);
  const exact = entries.filter(([key, model]) => normalize(key) === modelId || normalize(model.id) === modelId);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const canonical = entries.filter(([key, model]) =>
    normalize(model.canonical_model_id) === modelId ||
    normalize(model.canonical_model_id) === `${alias}/${modelId}` ||
    `${alias}/${normalize(model.id ?? key)}` === modelId);
  return canonical.length > 1 ? null : canonical[0];
};

const selectProviderCatalogs = (params: ModelCatalogProviderParams) => {
  const catalogs = [readCachedCatalog(), getSnapshotCatalog()].filter(
    (catalog): catalog is CachedCatalog => Boolean(catalog),
  );
  // Select one provider before looking for a model, including when its model is absent.
  const alias = getProviderAliases(params).find((candidate) =>
    catalogs.some((catalog) => providerFromCatalog(catalog, candidate) !== undefined));
  return alias ? { alias, catalogs } : null;
};

const lookupModel = (params: ModelCatalogProviderParams & {
  modelId?: string | null;
}): { model: ModelsDevModel; id: string; fetchedAt: string } | null => {
  const modelId = normalize(params.modelId);
  if (!modelId) return null;
  const selected = selectProviderCatalogs(params);
  if (!selected) return null;
  const { alias, catalogs } = selected;
  for (const catalog of catalogs) {
    const provider = providerFromCatalog(catalog, alias);
    if (provider === null) return null;
    if (!provider) continue;
    const match = findModel(provider, alias, modelId);
    if (match === null) return null;
    if (match) {
      const [key, model] = match;
      return {
        model, id: model.id ?? key,
        fetchedAt: catalog.providers === SNAPSHOT_PROVIDERS
          ? model.updatedAt ?? catalog.fetchedAt : catalog.fetchedAt,
      };
    }
  }
  return null;
};

const metadataFromMatch = (match: NonNullable<ReturnType<typeof lookupModel>>): ModelCatalogMetadata => {
  const { model, id, fetchedAt } = match;
  return {
    id,
    name: model.name ?? id,
    ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.family !== undefined ? { family: model.family } : {}),
    contextTokens: toPositiveInteger(model.limit?.context),
    inputTokens: toPositiveInteger(model.limit?.input),
    outputTokens: toPositiveInteger(model.limit?.output),
    ...(model.modalities?.input !== undefined ? { images: model.modalities.input.includes('image') } : {}),
    ...(model.tool_call !== undefined ? { toolCall: model.tool_call } : {}),
    updatedAt: fetchedAt,
  };
};

export const lookupModelCatalogMetadata = (params: Parameters<typeof lookupModel>[0]): ModelCatalogMetadata | null => {
  const match = lookupModel(params);
  return match ? metadataFromMatch(match) : null;
};

/** Synchronous provider-scoped suggestions. Cached entries precede bundled fallbacks. */
export const listProviderCatalogModels = (params: ModelCatalogProviderParams): ModelCatalogMetadata[] => {
  const selected = selectProviderCatalogs(params);
  if (!selected) return [];
  const ids = new Set<string>();
  const result = new Map<string, ModelCatalogMetadata>();
  for (const catalog of selected.catalogs) {
    const provider = providerFromCatalog(catalog, selected.alias);
    if (provider === null) return [];
    if (!provider) continue;
    for (const [key, model] of Object.entries(provider.models)) {
      const id = model.id ?? key;
      const normalizedId = normalize(id);
      if (ids.has(normalizedId)) continue;
      ids.add(normalizedId);
      const metadata = lookupModelCatalogMetadata({ ...params, modelId: id });
      if (metadata && !result.has(normalize(metadata.id))) result.set(normalize(metadata.id), metadata);
    }
  }
  return [...result.values()];
};

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
  if (model?.reasoning !== true) return null;
  const options = model.reasoning_options?.filter((option) => option.type === 'effort') ?? [];
  const reasoningEfforts = toStringArray(options.flatMap((option) => option.values ?? []))
    .filter((effort) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort));
  if (reasoningEfforts.length === 0) return null;
  const requestedDefault = options.find((option) => option.default)?.default;
  return {
    reasoningEfforts,
    defaultReasoningEffort: requestedDefault && reasoningEfforts.includes(requestedDefault)
      ? requestedDefault : null,
    configurable: reasoningEfforts.length > 1,
  };
};

export const lookupModelContextCatalogLimit = (params: Parameters<typeof lookupModel>[0]): CatalogModelLimits | null => {
  const match = lookupModel(params);
  return match ? limitFromModel(match.model, match.fetchedAt) : null;
};

export const lookupModelReasoningCatalogCapability = (params: Parameters<typeof lookupModel>[0]): CatalogReasoningCapability | null =>
  reasoningFromModel(lookupModel(params)?.model);

export const getModelContextCatalogStatus = (): ModelContextCatalogStatus => {
  const cache = readCachedCatalog();
  if (!cache || !loadedCatalogSource || loadedCatalogSource === 'snapshot') return lastStatus;
  return {
    lastFetchedAt: cache.fetchedAt,
    source: loadedCatalogSource,
    stale: !isFresh(cache),
    error: lastStatus.error,
  };
};

export const subscribeModelContextCatalogStatus = (
  listener: (status: ModelContextCatalogStatus) => void,
): (() => void) => {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
};

export const refreshModelContextCatalog = async (params: {
  force?: boolean;
  fetchImpl?: typeof tauriFetch;
} = {}): Promise<ModelContextCatalogStatus> => {
  const cached = readCachedCatalog();
  if (!params.force && cached && isFresh(cached)) {
    loadedCatalogSource = 'cache';
    return setLastStatus({
      lastFetchedAt: cached.fetchedAt,
      source: 'cache',
      stale: false,
      error: lastStatus.lastFetchedAt === cached.fetchedAt ? lastStatus.error : null,
    });
  }
  if (refreshPromise) return refreshPromise;

  const fetchImpl = params.fetchImpl ?? tauriFetch;
  refreshPromise = (async () => {
    try {
      const response = await Promise.resolve().then(() => fetchImpl(MODELS_DEV_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }));
      if (!response.ok) {
        throw new Error(`Models.dev returned ${response.status}`);
      }
      const providers = parseModelsDevProviders(await response.json());
      if (!providers) throw new Error('Models.dev returned an invalid catalog');
      const fetchedAt = new Date().toISOString();
      const catalog: CachedCatalog = { fetchedAt, providers };
      writeCachedCatalog(catalog, 'network');
      return setLastStatus({
        lastFetchedAt: fetchedAt,
        source: 'network',
        stale: false,
        error: null,
      });
    } catch (error) {
      const fallback = cached ?? getSnapshotCatalog();
      loadedCatalog = fallback;
      loadedCatalogSource = cached ? 'cache' : 'snapshot';
      return setLastStatus({
        lastFetchedAt: cached?.fetchedAt ?? null,
        source: cached ? 'cache' : 'snapshot',
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
};

export const __testables = {
  STORAGE_KEY,
  getProviderAliases,
  safeParseCatalog,
  writeCachedCatalog,
  reset: () => {
    loadedCatalog = null;
    loadedCatalogSource = null;
    refreshPromise = null;
    statusListeners.clear();
    lastStatus = {
      lastFetchedAt: null,
      source: 'snapshot',
      stale: true,
      error: null,
    };
  },
};
