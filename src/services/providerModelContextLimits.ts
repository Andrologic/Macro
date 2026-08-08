import type { AIModel, ModelContextLimitSource } from '../types';
import { lookupModelContextCatalogLimit } from './modelContextCatalog';
import type { ProviderModel } from './providerApi';

export const PROVIDER_OVERFLOW_CONTEXT_LIMIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const toPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;

const isProviderOverflowLimitFresh = (updatedAt?: string): boolean => {
  if (!updatedAt) return false;
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp <= PROVIDER_OVERFLOW_CONTEXT_LIMIT_TTL_MS;
};

const shouldKeepExistingContextWindow = (model: AIModel): boolean => {
  if (!model.contextWindowTokens) return false;
  switch (model.contextWindowSource) {
    case 'user_override':
    case 'provider_metadata':
    case 'model_metadata':
    case 'models_dev':
      return true;
    case 'provider_overflow_error':
      return isProviderOverflowLimitFresh(model.contextLimitsUpdatedAt);
    case 'macro_fallback':
    default:
      return false;
  }
};

export const inferProviderContextWindowTokens = (
  model: Pick<
    ProviderModel,
    | 'context_window'
    | 'context_window_tokens'
    | 'context_length'
    | 'max_input_tokens'
    | 'top_provider'
  >
): number | null =>
  toPositiveInteger(model.context_window_tokens) ??
  toPositiveInteger(model.context_window) ??
  toPositiveInteger(model.context_length) ??
  toPositiveInteger(model.top_provider?.context_length) ??
  null;

export const inferProviderInputLimitTokens = (
  model: Pick<ProviderModel, 'max_input_tokens'>
): number | undefined => toPositiveInteger(model.max_input_tokens);

export const inferProviderOutputLimitTokens = (
  model: Pick<
    ProviderModel,
    'max_output_tokens' | 'output_tokens' | 'max_completion_tokens' | 'top_provider'
  >
): number | undefined =>
  toPositiveInteger(model.max_output_tokens) ??
  toPositiveInteger(model.output_tokens) ??
  toPositiveInteger(model.max_completion_tokens) ??
  toPositiveInteger(model.top_provider?.max_output_tokens) ??
  toPositiveInteger(model.top_provider?.max_completion_tokens);

export const inferProviderContextWindowSource = (
  model: Pick<
    ProviderModel,
    | 'context_window'
    | 'context_window_tokens'
    | 'context_length'
    | 'max_input_tokens'
    | 'top_provider'
  >
): ModelContextLimitSource | undefined =>
  inferProviderContextWindowTokens(model) ? 'provider_metadata' : undefined;

export const buildProviderModelContextLimitOverlay = (
  model: ProviderModel
): Partial<
  Pick<
    AIModel,
    | 'contextWindowTokens'
    | 'inputLimitTokens'
    | 'outputLimitTokens'
    | 'contextWindowSource'
    | 'contextLimitsUpdatedAt'
  >
> => {
  const contextWindowTokens = inferProviderContextWindowTokens(model) ?? undefined;
  const inputLimitTokens = inferProviderInputLimitTokens(model);
  const outputLimitTokens = inferProviderOutputLimitTokens(model);
  const contextWindowSource = inferProviderContextWindowSource(model);
  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(inputLimitTokens ? { inputLimitTokens } : {}),
    ...(outputLimitTokens ? { outputLimitTokens } : {}),
    ...(contextWindowSource ? { contextWindowSource } : {}),
  };
};

export const buildCatalogModelContextLimitOverlay = (params: {
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
  modelId: string;
}): Partial<
  Pick<
    AIModel,
    | 'contextWindowTokens'
    | 'inputLimitTokens'
    | 'outputLimitTokens'
    | 'contextWindowSource'
    | 'contextLimitsUpdatedAt'
  >
> => {
  const limit = lookupModelContextCatalogLimit(params);
  if (!limit) return {};
  return {
    contextWindowTokens: limit.contextTokens,
    inputLimitTokens: limit.inputTokens,
    outputLimitTokens: limit.outputTokens,
    contextWindowSource: 'models_dev',
    contextLimitsUpdatedAt: limit.updatedAt,
  };
};

export const enrichModelWithCatalogContextLimits = (
  model: AIModel,
  params: {
    providerType?: string | null;
    providerId?: string | null;
    baseUrl?: string | null;
  },
  options: {
    refreshCatalogSource?: boolean;
  } = {}
): AIModel => {
  if (
    shouldKeepExistingContextWindow(model) &&
    !(options.refreshCatalogSource && model.contextWindowSource === 'models_dev')
  ) {
    return model;
  }
  const overlay = buildCatalogModelContextLimitOverlay({
    ...params,
    modelId: model.id,
  });
  return Object.keys(overlay).length > 0 ? { ...model, ...overlay } : model;
};

export const mergeProviderModelContextLimitOverlays = (
  models: AIModel[],
  providerModels: ProviderModel[]
): AIModel[] => {
  const overlaysById = new Map(
    providerModels.map((model) => [
      model.id,
      buildProviderModelContextLimitOverlay(model),
    ])
  );

  return models.map((model) => {
    const overlay = overlaysById.get(model.id);
    if (!overlay) return model;
    if (model.contextWindowSource === 'user_override') {
      const {
        contextWindowTokens: _contextWindowTokens,
        contextWindowSource: _contextWindowSource,
        contextLimitsUpdatedAt: _contextLimitsUpdatedAt,
        ...nonWindowOverlay
      } = overlay;
      return { ...model, ...nonWindowOverlay };
    }
    return { ...model, ...overlay };
  });
};
