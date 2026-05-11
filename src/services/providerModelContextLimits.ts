import type { AIModel, ModelContextLimitSource } from '../types';
import { lookupModelContextCatalogLimit } from './modelContextCatalog';
import type { ProviderModel } from './providerApi';

const toPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;

export const inferProviderContextWindowTokens = (
  model: Pick<
    ProviderModel,
    'context_window' | 'context_window_tokens' | 'max_input_tokens'
  >
): number | null =>
  toPositiveInteger(model.context_window_tokens) ??
  toPositiveInteger(model.context_window) ??
  toPositiveInteger(model.max_input_tokens) ??
  null;

export const inferProviderInputLimitTokens = (
  model: Pick<ProviderModel, 'max_input_tokens'>
): number | undefined => toPositiveInteger(model.max_input_tokens);

export const inferProviderOutputLimitTokens = (
  model: Pick<
    ProviderModel,
    'max_output_tokens' | 'output_tokens' | 'max_completion_tokens'
  >
): number | undefined =>
  toPositiveInteger(model.max_output_tokens) ??
  toPositiveInteger(model.output_tokens) ??
  toPositiveInteger(model.max_completion_tokens);

export const inferProviderContextWindowSource = (
  model: Pick<
    ProviderModel,
    'context_window' | 'context_window_tokens' | 'max_input_tokens'
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
  }
): AIModel => {
  if (model.contextWindowTokens && model.contextWindowSource !== 'macro_fallback') {
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
    return overlay ? { ...model, ...overlay } : model;
  });
};
