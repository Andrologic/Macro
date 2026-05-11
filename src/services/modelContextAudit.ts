import type {
  AIModel,
  ModelContextLimitConfidence,
  ModelContextLimitSource,
  ProviderConfig,
} from '../types';
import { resolveModelContextLimits } from './modelContextLimits';

export interface ModelContextAuditRow {
  providerId: string;
  providerType?: string;
  modelId: string;
  modelName: string;
  contextTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  source: ModelContextLimitSource;
  isAuthoritative: boolean;
  confidence: ModelContextLimitConfidence;
  updatedAt?: string;
  warning?: string;
}

export const buildModelContextAuditRows = (params: {
  providerConfigs: Pick<ProviderConfig, 'id' | 'providerType' | 'baseUrl'>[];
  modelsByProvider: Record<string, AIModel[]>;
}): ModelContextAuditRow[] => {
  const providersById = new Map(
    params.providerConfigs.map((provider) => [provider.id, provider]),
  );

  return Object.entries(params.modelsByProvider)
    .flatMap(([providerId, models]) => {
      const provider = providersById.get(providerId);
      return models.map((model) => {
        const limits = resolveModelContextLimits({
          providerType: provider?.providerType,
          providerId,
          baseUrl: provider?.baseUrl,
          modelId: model.id,
          modelContextWindowTokens: model.contextWindowTokens,
          inputLimitTokens: model.inputLimitTokens,
          outputLimitTokens: model.outputLimitTokens,
          contextWindowSource: model.contextWindowSource,
          contextLimitsUpdatedAt: model.contextLimitsUpdatedAt,
        });

        return {
          providerId,
          providerType: provider?.providerType,
          modelId: model.id,
          modelName: model.name || model.id,
          contextTokens: limits.contextTokens,
          inputTokens: limits.inputTokens,
          outputTokens: limits.outputTokens,
          source: limits.source,
          isAuthoritative: limits.isAuthoritative,
          confidence: limits.confidence,
          updatedAt: limits.updatedAt,
          warning: limits.warning,
        };
      });
    })
    .sort((left, right) =>
      `${left.providerId}/${left.modelName}`.localeCompare(
        `${right.providerId}/${right.modelName}`,
        undefined,
        { sensitivity: 'base' },
      ),
    );
};
