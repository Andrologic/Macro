import type {
  AIModel,
  ContextCompactionDecisionAudit,
  ModelContextLimitConfidence,
  ModelContextLimitSource,
  ProviderConfig,
} from '../types';
import { buildContextCompactionDecisionAudit } from './contextCompaction';
import {
  resolveModelContextLimits,
  resolveUsableContextTokens,
} from './modelContextLimits';

export interface ModelContextAuditRow {
  providerId: string;
  providerType?: string;
  modelId: string;
  modelName: string;
  contextTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  outputReserveTokens?: number;
  reservedTokens?: number;
  usableContextTokens: number;
  source: ModelContextLimitSource;
  isAuthoritative: boolean;
  confidence: ModelContextLimitConfidence;
  updatedAt?: string;
  warning?: string;
  audit: ContextCompactionDecisionAudit;
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
        const budget = resolveUsableContextTokens({
          contextTokens: limits.contextTokens,
          inputTokens: limits.inputTokens,
          outputTokens: limits.outputTokens,
        });
        const audit = buildContextCompactionDecisionAudit({
          providerId,
          providerType: provider?.providerType,
          modelId: model.id,
          footprint: {
            totalEstimatedTokens: 0,
            messageTokens: 0,
            hiddenContextTokens: 0,
            systemTokens: 0,
            toolSchemaTokens: 0,
            imagePlaceholderTokens: 0,
            citationTokens: 0,
            modelContextWindowTokens: limits.contextTokens,
            inputLimitTokens: limits.inputTokens,
            outputLimitTokens: limits.outputTokens,
            contextLimitSource: limits.source,
            isContextLimitAuthoritative: limits.isAuthoritative,
            contextLimitConfidence: limits.confidence,
            contextLimitWarning: limits.warning,
            reservedTokens: budget.reservedTokens,
            outputReserveTokens: budget.outputReserveTokens,
            usableContextTokens: budget.usableContextTokens,
            threshold: 'none',
            reason: 'below_threshold',
            totalContextRatio: 0,
            usableContextRatio: 0,
            hiddenContextRatio: 0,
            hardStopRatio: 0.98,
            isHardStop: false,
            toolTurnCount: 0,
          },
        });

        return {
          providerId,
          providerType: provider?.providerType,
          modelId: model.id,
          modelName: model.name || model.id,
          contextTokens: limits.contextTokens,
          inputTokens: limits.inputTokens,
          outputTokens: limits.outputTokens,
          outputReserveTokens: budget.outputReserveTokens,
          reservedTokens: budget.reservedTokens,
          usableContextTokens: budget.usableContextTokens,
          source: limits.source,
          isAuthoritative: limits.isAuthoritative,
          confidence: limits.confidence,
          updatedAt: limits.updatedAt,
          warning: limits.warning,
          audit,
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
