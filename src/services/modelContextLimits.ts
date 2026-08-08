import type { ModelContextLimitConfidence, ModelContextLimitSource } from '../types';
import { lookupModelContextCatalogLimit } from './modelContextCatalog';

export const OUTPUT_TOKEN_MAX = 32_000;
export const COMPACTION_BUFFER = 20_000;

export interface ModelContextLimits {
  contextTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  source: ModelContextLimitSource;
  isAuthoritative: boolean;
  updatedAt?: string;
  confidence: ModelContextLimitConfidence;
  warning?: string;
}

export type ResolvedModelContextLimits = ModelContextLimits;

export interface ContextLimitFootprintFields {
  modelContextWindowTokens: number;
  inputLimitTokens?: number;
  outputLimitTokens?: number;
  contextLimitSource: ModelContextLimitSource;
  isContextLimitAuthoritative: boolean;
  contextLimitConfidence: ModelContextLimitConfidence;
  contextLimitWarning?: string;
}

export interface ResolveModelContextLimitsParams {
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
  modelContextWindowTokens?: number | null;
  inputLimitTokens?: number | null;
  outputLimitTokens?: number | null;
  contextWindowSource?: ModelContextLimitSource | null;
  contextLimitsUpdatedAt?: string | null;
}

const MACRO_FALLBACK_CONTEXT_WINDOWS: Record<string, number> = {
  chatgpt: 128_000,
  copilot: 128_000,
  openai: 64_000,
  openrouter: 64_000,
  anthropic: 64_000,
  ollama: 16_000,
  lmstudio: 16_000,
};

const toPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;

const normalize = (value?: string | null): string =>
  (value || '').trim().toLowerCase();

const resolveConfidenceForSource = (
  source: ModelContextLimitSource
): ModelContextLimitConfidence => {
  switch (source) {
    case 'user_override':
      return 'configured';
    case 'provider_metadata':
    case 'model_metadata':
      return 'verified';
    case 'models_dev':
      return 'catalog';
    case 'provider_overflow_error':
      return 'learned';
    case 'macro_fallback':
      return 'fallback';
  }
};

const resolveWarningForSource = (
  source: ModelContextLimitSource
): string | undefined => {
  if (source === 'macro_fallback') {
    return "Limite estimée par Macro faute de métadonnée provider fiable; elle ne déclenche pas de compaction automatique à elle seule.";
  }
  if (source === 'provider_overflow_error') {
    return "Limite apprise après une erreur provider; elle peut être remplacée par une métadonnée provider plus fraîche.";
  }
  return undefined;
};

const buildResolvedLimits = (params: {
  contextTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  source: ModelContextLimitSource;
  updatedAt?: string | null;
}): ModelContextLimits => {
  const confidence = resolveConfidenceForSource(params.source);
  const warning = resolveWarningForSource(params.source);
  return {
    contextTokens: params.contextTokens,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    source: params.source,
    isAuthoritative: params.source !== 'macro_fallback',
    confidence,
    ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
    ...(warning ? { warning } : {}),
  };
};

export const resolveMaxOutputTokens = (outputTokens?: number | null): number => {
  const normalized = toPositiveInteger(outputTokens);
  return Math.min(normalized ?? OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX;
};

export const resolveDefaultReservedTokens = (
  outputTokens?: number | null,
  contextTokens?: number | null,
): number => {
  const normalizedOutputTokens = toPositiveInteger(outputTokens);
  if (normalizedOutputTokens) {
    return Math.min(COMPACTION_BUFFER, resolveMaxOutputTokens(normalizedOutputTokens));
  }

  const normalizedContextTokens = toPositiveInteger(contextTokens);
  const proportionalReserve = normalizedContextTokens
    ? Math.max(1, Math.floor(normalizedContextTokens * 0.25))
    : OUTPUT_TOKEN_MAX;
  return Math.min(COMPACTION_BUFFER, OUTPUT_TOKEN_MAX, proportionalReserve);
};

export const resolveModelContextLimits = (
  params: ResolveModelContextLimitsParams
): ModelContextLimits => {
  const explicitContextTokens = toPositiveInteger(params.modelContextWindowTokens);
  const inputTokens = toPositiveInteger(params.inputLimitTokens);
  const outputTokens = toPositiveInteger(params.outputLimitTokens);

  if (explicitContextTokens) {
    const source = params.contextWindowSource ?? 'provider_metadata';
    return buildResolvedLimits({
      contextTokens: explicitContextTokens,
      inputTokens,
      outputTokens,
      source,
      updatedAt: params.contextLimitsUpdatedAt,
    });
  }

  const modelsDevLimit = lookupModelContextCatalogLimit(params);
  if (modelsDevLimit) {
    return buildResolvedLimits({
      contextTokens: modelsDevLimit.contextTokens,
      inputTokens: inputTokens ?? modelsDevLimit.inputTokens,
      outputTokens: outputTokens ?? modelsDevLimit.outputTokens,
      source: 'models_dev',
      updatedAt: modelsDevLimit.updatedAt,
    });
  }

  const providerType = normalize(params.providerType);
  return buildResolvedLimits({
    contextTokens: MACRO_FALLBACK_CONTEXT_WINDOWS[providerType] ?? 16_000,
    inputTokens,
    outputTokens,
    source: 'macro_fallback',
  });
};

export const contextLimitsToFootprintFields = (
  limits: ModelContextLimits
): ContextLimitFootprintFields => ({
  modelContextWindowTokens: limits.contextTokens,
  inputLimitTokens: limits.inputTokens,
  outputLimitTokens: limits.outputTokens,
  contextLimitSource: limits.source,
  isContextLimitAuthoritative: limits.isAuthoritative,
  contextLimitConfidence: limits.confidence,
  contextLimitWarning: limits.warning,
});

export const resolveUsableContextTokens = (params: {
  contextTokens: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  explicitReservedTokens?: number | null;
}): {
  maxOutputTokens: number;
  reservedTokens: number;
  outputReserveTokens: number;
  usableContextTokens: number;
} => {
  const contextTokens = Math.max(1, Math.trunc(params.contextTokens || 1));
  const inputTokens = toPositiveInteger(params.inputTokens);
  const outputTokens = toPositiveInteger(params.outputTokens);
  const maxOutputTokens = resolveMaxOutputTokens(outputTokens);
  const explicitReservedTokens =
    typeof params.explicitReservedTokens === 'number' &&
    Number.isFinite(params.explicitReservedTokens) &&
    params.explicitReservedTokens >= 0
      ? Math.trunc(params.explicitReservedTokens)
      : null;
  const defaultReservedTokens = resolveDefaultReservedTokens(outputTokens, contextTokens);
  const reservedTokens = Math.min(
    contextTokens - 1,
    Math.max(
      0,
      explicitReservedTokens ?? defaultReservedTokens
    )
  );
  const outputReserveTokens = explicitReservedTokens ??
    (outputTokens ? maxOutputTokens : defaultReservedTokens);
  const rawUsable = inputTokens
    ? inputTokens - reservedTokens
    : contextTokens - outputReserveTokens;

  return {
    maxOutputTokens,
    reservedTokens,
    outputReserveTokens,
    usableContextTokens: Math.max(1, Math.min(contextTokens - 1, rawUsable)),
  };
};
