import type { AIModel, ProviderConfig, ReasoningEffort } from '../types';
import { providerHasUsableCredentials } from './providerCredentials';

export type MetadataModelConfig =
  | { mode: 'conversation' }
  | {
      mode: 'dedicated';
      providerId: string;
      modelId: string;
      reasoningEffort: ReasoningEffort | null;
    };

export interface MetadataModelConfigContext {
  providerConfigs: ProviderConfig[];
  modelsByProvider: Record<string, AIModel[]>;
  getAvailableReasoningEfforts?: (
    providerId?: string | null,
    modelId?: string | null
  ) => ReasoningEffort[];
}

export const providerCanGenerateMetadata = providerHasUsableCredentials;

const enabledModelsForProvider = (
  providerId: string,
  modelsByProvider: Record<string, AIModel[]>
): AIModel[] => (modelsByProvider[providerId] || []).filter((model) => model.isEnabled !== false);

export const resolveMetadataModelReasoningEfforts = (
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  context: MetadataModelConfigContext
): ReasoningEffort[] => {
  if (!providerId || !modelId) return [];

  const resolvedEfforts = context.getAvailableReasoningEfforts?.(providerId, modelId) ?? [];
  if (resolvedEfforts.length > 0) return resolvedEfforts;

  const model = enabledModelsForProvider(providerId, context.modelsByProvider)
    .find((candidate) => candidate.id === modelId);
  return model?.reasoningEfforts ?? [];
};

const normalizeReasoningEffort = (
  config: Extract<MetadataModelConfig, { mode: 'dedicated' }>,
  context: MetadataModelConfigContext
): ReasoningEffort | null => {
  const efforts = resolveMetadataModelReasoningEfforts(
    config.providerId,
    config.modelId,
    context
  );
  if (config.reasoningEffort && efforts.includes(config.reasoningEffort)) {
    return config.reasoningEffort;
  }
  return null;
};

export const findFallbackMetadataDedicatedModel = (
  context: MetadataModelConfigContext
): Extract<MetadataModelConfig, { mode: 'dedicated' }> | null => {
  for (const provider of context.providerConfigs) {
    if (!providerCanGenerateMetadata(provider)) continue;
    const firstModel = enabledModelsForProvider(provider.id, context.modelsByProvider)[0];
    if (firstModel) {
      return {
        mode: 'dedicated',
        providerId: provider.id,
        modelId: firstModel.id,
        reasoningEffort: null,
      };
    }
  }
  return null;
};

export const normalizeMetadataModelConfig = (
  config: MetadataModelConfig | null | undefined,
  context: MetadataModelConfigContext
): MetadataModelConfig | null => {
  if (config === undefined || config === null) {
    return config ?? null;
  }

  if (config.mode === 'conversation') {
    return config;
  }

  const provider = context.providerConfigs.find((candidate) => candidate.id === config.providerId);
  if (!provider || !providerCanGenerateMetadata(provider)) {
    return findFallbackMetadataDedicatedModel(context) ?? { mode: 'conversation' };
  }

  const models = enabledModelsForProvider(provider.id, context.modelsByProvider);
  const model = models.find((candidate) => candidate.id === config.modelId) ?? models[0];
  if (!model) {
    return findFallbackMetadataDedicatedModel(context) ?? { mode: 'conversation' };
  }

  const normalized: Extract<MetadataModelConfig, { mode: 'dedicated' }> = {
    mode: 'dedicated',
    providerId: provider.id,
    modelId: model.id,
    reasoningEffort: config.modelId === model.id
      ? normalizeReasoningEffort(config, context)
      : null,
  };
  return normalized;
};

export const metadataModelConfigsEqual = (
  left: MetadataModelConfig | null | undefined,
  right: MetadataModelConfig | null | undefined
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.mode !== right.mode) return false;
  if (left.mode === 'conversation' || right.mode === 'conversation') return true;
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort
  );
};
