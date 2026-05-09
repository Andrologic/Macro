import type { AIModel, ProviderConfig, ReasoningEffort } from '../types';
import { providerHasUsableCredentials } from './providerCredentials';

export type SmartCommitModelConfig =
  | { mode: 'conversation' }
  | {
      mode: 'dedicated';
      providerId: string;
      modelId: string;
      reasoningEffort: ReasoningEffort | null;
    };

export interface SmartCommitModelConfigContext {
  providerConfigs: ProviderConfig[];
  modelsByProvider: Record<string, AIModel[]>;
  getAvailableReasoningEfforts?: (
    providerId?: string | null,
    modelId?: string | null
  ) => ReasoningEffort[];
}

export const providerCanGenerateSmartCommitMessages = providerHasUsableCredentials;

const enabledModelsForProvider = (
  providerId: string,
  modelsByProvider: Record<string, AIModel[]>
): AIModel[] => (modelsByProvider[providerId] || []).filter((model) => model.isEnabled !== false);

const normalizeReasoningEffort = (
  config: Extract<SmartCommitModelConfig, { mode: 'dedicated' }>,
  context: SmartCommitModelConfigContext
): ReasoningEffort | null => {
  const efforts = context.getAvailableReasoningEfforts?.(config.providerId, config.modelId) ?? [];
  if (config.reasoningEffort && efforts.includes(config.reasoningEffort)) {
    return config.reasoningEffort;
  }
  return null;
};

export const findFallbackSmartCommitDedicatedModel = (
  context: SmartCommitModelConfigContext
): Extract<SmartCommitModelConfig, { mode: 'dedicated' }> | null => {
  for (const provider of context.providerConfigs) {
    if (!providerCanGenerateSmartCommitMessages(provider)) continue;
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

export const normalizeSmartCommitModelConfig = (
  config: SmartCommitModelConfig | null | undefined,
  context: SmartCommitModelConfigContext
): SmartCommitModelConfig | null => {
  if (config === undefined || config === null) {
    return config ?? null;
  }

  if (config.mode === 'conversation') {
    return config;
  }

  const provider = context.providerConfigs.find((candidate) => candidate.id === config.providerId);
  if (!provider || !providerCanGenerateSmartCommitMessages(provider)) {
    return findFallbackSmartCommitDedicatedModel(context) ?? { mode: 'conversation' };
  }

  const models = enabledModelsForProvider(provider.id, context.modelsByProvider);
  const model = models.find((candidate) => candidate.id === config.modelId) ?? models[0];
  if (!model) {
    return findFallbackSmartCommitDedicatedModel(context) ?? { mode: 'conversation' };
  }

  const normalized: Extract<SmartCommitModelConfig, { mode: 'dedicated' }> = {
    mode: 'dedicated',
    providerId: provider.id,
    modelId: model.id,
    reasoningEffort: config.modelId === model.id
      ? normalizeReasoningEffort(config, context)
      : null,
  };
  return normalized;
};

export const smartCommitModelConfigsEqual = (
  left: SmartCommitModelConfig | null | undefined,
  right: SmartCommitModelConfig | null | undefined
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
