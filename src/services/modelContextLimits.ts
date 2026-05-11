import type { ModelContextLimitSource } from '../types';
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
}

export interface ContextLimitFootprintFields {
  modelContextWindowTokens: number;
  inputLimitTokens?: number;
  outputLimitTokens?: number;
  contextLimitSource: ModelContextLimitSource;
  isContextLimitAuthoritative: boolean;
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

export const resolveMaxOutputTokens = (outputTokens?: number | null): number => {
  const normalized = toPositiveInteger(outputTokens);
  return Math.min(normalized ?? OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX;
};

export const resolveDefaultReservedTokens = (
  outputTokens?: number | null
): number => Math.min(COMPACTION_BUFFER, resolveMaxOutputTokens(outputTokens));

export const resolveModelContextLimits = (
  params: ResolveModelContextLimitsParams
): ModelContextLimits => {
  const explicitContextTokens = toPositiveInteger(params.modelContextWindowTokens);
  const inputTokens = toPositiveInteger(params.inputLimitTokens);
  const outputTokens = toPositiveInteger(params.outputLimitTokens);

  if (explicitContextTokens) {
    const source = params.contextWindowSource ?? 'provider_metadata';
    return {
      contextTokens: explicitContextTokens,
      inputTokens,
      outputTokens,
      source,
      isAuthoritative: source !== 'macro_fallback',
      ...(params.contextLimitsUpdatedAt
        ? { updatedAt: params.contextLimitsUpdatedAt }
        : {}),
    };
  }

  const modelsDevLimit = lookupModelContextCatalogLimit(params);
  if (modelsDevLimit) {
    return {
      contextTokens: modelsDevLimit.contextTokens,
      inputTokens: inputTokens ?? modelsDevLimit.inputTokens,
      outputTokens: outputTokens ?? modelsDevLimit.outputTokens,
      source: 'models_dev',
      isAuthoritative: true,
      updatedAt: modelsDevLimit.updatedAt,
    };
  }

  const providerType = normalize(params.providerType);
  return {
    contextTokens: MACRO_FALLBACK_CONTEXT_WINDOWS[providerType] ?? 16_000,
    inputTokens,
    outputTokens,
    source: 'macro_fallback',
    isAuthoritative: false,
  };
};

export const contextLimitsToFootprintFields = (
  limits: ModelContextLimits
): ContextLimitFootprintFields => ({
  modelContextWindowTokens: limits.contextTokens,
  inputLimitTokens: limits.inputTokens,
  outputLimitTokens: limits.outputTokens,
  contextLimitSource: limits.source,
  isContextLimitAuthoritative: limits.isAuthoritative,
});

export const resolveUsableContextTokens = (params: {
  contextTokens: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  explicitReservedTokens?: number | null;
}): {
  maxOutputTokens: number;
  reservedTokens: number;
  usableContextTokens: number;
} => {
  const contextTokens = Math.max(1, Math.trunc(params.contextTokens || 1));
  const inputTokens = toPositiveInteger(params.inputTokens);
  const maxOutputTokens = resolveMaxOutputTokens(params.outputTokens);
  const explicitReservedTokens =
    typeof params.explicitReservedTokens === 'number' &&
    Number.isFinite(params.explicitReservedTokens) &&
    params.explicitReservedTokens >= 0
      ? Math.trunc(params.explicitReservedTokens)
      : null;
  const reservedTokens = Math.min(
    contextTokens - 1,
    Math.max(
      0,
      explicitReservedTokens ?? resolveDefaultReservedTokens(params.outputTokens)
    )
  );
  const outputReserve = explicitReservedTokens ?? maxOutputTokens;
  const rawUsable = inputTokens
    ? inputTokens - reservedTokens
    : contextTokens - outputReserve;

  return {
    maxOutputTokens,
    reservedTokens,
    usableContextTokens: Math.max(1, Math.min(contextTokens - 1, rawUsable)),
  };
};
