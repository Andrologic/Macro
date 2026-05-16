import type {
  ChatMessage,
  ContextCompactionKind,
  ContextFootprint,
  ConversationCompactionState,
} from '../types';
import type { MacroToolRegistryEntry } from '../shared/macroToolRegistry';
import type { Citation } from '../stores/useCitationsStore';
import {
  buildCompactedMessagesForRequest,
  buildContextCompactionDecisionAudit,
  buildContextTooLargeErrorMessage,
  buildManualCompactionRequiredErrorMessage,
  estimateConversationFootprint,
  type ContextBudgetPolicy,
  type MaybeCompactConversationResult,
  type SummaryGenerationInput,
} from './contextCompaction';
import {
  evaluateContextCompaction,
  type ContextCompactionBoundary,
  type ContextCompactionEvaluation,
} from './contextCompactionPlanner';
import type { ContextLimitFootprintFields } from './modelContextLimits';
import type { StreamMessage } from './streamingChat';

export type CompactionEventStatus =
  | 'success'
  | 'failed'
  | 'blocked'
  | 'degraded'
  | 'skipped';

export const getCompactionBoundaryForMode = (
  mode: ContextCompactionKind,
): ContextCompactionBoundary => {
  switch (mode) {
    case 'manual':
      return 'manual';
    case 'model_switch':
      return 'model_switch';
    case 'overflow_recovery':
    case 'stream_overflow':
      return 'overflow_recovery';
    case 'safety_prestream':
      return 'pre_send';
    case 'background':
    case 'blocking':
    default:
      return 'diagnostics';
  }
};

export const shouldPersistCompactionResult = (params: {
  hasCompaction: boolean;
  usedExistingCompaction: boolean;
  forceCompaction?: boolean;
  mode: ContextCompactionKind;
}): boolean =>
  params.hasCompaction &&
  (!params.usedExistingCompaction ||
    Boolean(params.forceCompaction) ||
    params.mode === 'manual' ||
    params.mode === 'model_switch' ||
    params.mode === 'safety_prestream' ||
    params.mode === 'stream_overflow' ||
    params.mode === 'overflow_recovery');

export const buildCompactionDecisionAuditMetadata = (params: {
  providerId?: string | null;
  providerType?: string | null;
  modelId?: string | null;
  trigger?: ConversationCompactionState['lastTrigger'] | ContextCompactionKind;
  status?: CompactionEventStatus;
  footprintBefore?: ContextFootprint | null;
  footprintAfter?: ContextFootprint | null;
  footprint?: ContextFootprint | null;
  footprintFields?: ContextLimitFootprintFields;
  budgetPolicy?: ContextBudgetPolicy | null;
  reason?: string | null;
  result?: string | null;
}): Record<string, unknown> => {
  const audit = buildContextCompactionDecisionAudit({
    providerId: params.providerId,
    providerType: params.providerType,
    modelId: params.modelId,
    trigger: params.trigger,
    result: params.result ?? params.status ?? null,
    reason: params.reason,
    footprint: params.footprint,
    footprintBefore: params.footprintBefore,
    footprintAfter: params.footprintAfter,
    budgetPolicy: params.budgetPolicy,
  });
  return {
    ...audit,
    status: params.status ?? null,
    contextLimitSource:
      audit.contextLimitSource ?? params.footprintFields?.contextLimitSource ?? null,
    isContextLimitAuthoritative:
      audit.isContextLimitAuthoritative ??
      params.footprintFields?.isContextLimitAuthoritative ??
      null,
    contextLimitConfidence:
      audit.contextLimitConfidence ??
      params.footprintFields?.contextLimitConfidence ??
      null,
    contextLimitWarning:
      audit.contextLimitWarning ?? params.footprintFields?.contextLimitWarning ?? null,
    modelContextWindowTokens:
      audit.modelContextWindowTokens ??
      params.footprintFields?.modelContextWindowTokens ??
      null,
    inputLimitTokens:
      audit.inputLimitTokens ?? params.footprintFields?.inputLimitTokens ?? null,
    outputLimitTokens:
      audit.outputLimitTokens ?? params.footprintFields?.outputLimitTokens ?? null,
    tokensBefore: params.footprintBefore?.totalEstimatedTokens ?? null,
    tokensAfter: params.footprintAfter?.totalEstimatedTokens ?? null,
  };
};

export type ContextCompactionOrchestrationResult =
  | {
      outcome: 'blocked';
      preflightFootprint: ContextFootprint;
      evaluation: ContextCompactionEvaluation;
      errorMessage: string;
    }
  | {
      outcome: 'manual_required';
      preflightFootprint: ContextFootprint;
      evaluation: ContextCompactionEvaluation;
      errorMessage: string;
    }
  | {
      outcome: 'completed';
      preflightFootprint: ContextFootprint;
      evaluation: ContextCompactionEvaluation;
      result: MaybeCompactConversationResult;
      hadCompaction: boolean;
      hasCompaction: boolean;
      shouldPersistCompaction: boolean;
    };

export const runContextCompactionOrchestration = async (params: {
  boundary: ContextCompactionBoundary;
  mode: ContextCompactionKind;
  systemMessage: string;
  preparedMessages: StreamMessage[];
  orderedMessages: ChatMessage[];
  citations: Citation[];
  toolDefinitions: MacroToolRegistryEntry[];
  footprintFields: ContextLimitFootprintFields;
  providerId?: string | null;
  providerType?: string | null;
  modelId?: string | null;
  currentCompactionState?: ConversationCompactionState | null;
  budgetPolicy?: ContextBudgetPolicy | null;
  forceCompaction?: boolean;
  buildForceCompaction?: boolean;
  forcePrune?: boolean;
  latestBoundaryPayloadTokens?: number | null;
  previousModelContextWindowTokens?: number | null;
  estimateSerializedPayloadTokens?: (
    messages: StreamMessage[],
  ) => number | null | undefined;
  onCompactionStarted?: () => void;
  generateSummary?: (input: SummaryGenerationInput) => Promise<string | null>;
}): Promise<ContextCompactionOrchestrationResult> => {
  const budgetPolicy = params.budgetPolicy ?? undefined;
  const preflightFootprint = estimateConversationFootprint({
    systemMessage: params.systemMessage,
    preparedMessages: params.preparedMessages,
    orderedMessages: params.orderedMessages,
    citations: params.citations,
    toolDefinitions: params.toolDefinitions,
    ...params.footprintFields,
    previousModelContextWindowTokens: params.previousModelContextWindowTokens,
    estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
    mode: params.mode,
    budgetPolicy,
  });
  const evaluation = evaluateContextCompaction({
    boundary: params.boundary,
    footprint: preflightFootprint,
    budgetPolicy,
    currentCompactionState: params.currentCompactionState,
    forceCompaction: params.forceCompaction,
    latestBoundaryPayloadTokens: params.latestBoundaryPayloadTokens,
    providerId: params.providerId,
    providerType: params.providerType,
    modelId: params.modelId,
  });

  if (evaluation.decision === 'block') {
    return {
      outcome: 'blocked',
      preflightFootprint,
      evaluation,
      errorMessage: buildContextTooLargeErrorMessage(preflightFootprint),
    };
  }
  if (
    evaluation.decision === 'manual_required' &&
    params.boundary !== 'diagnostics'
  ) {
    return {
      outcome: 'manual_required',
      preflightFootprint,
      evaluation,
      errorMessage: buildManualCompactionRequiredErrorMessage(preflightFootprint),
    };
  }

  const shouldForceBuildCompaction =
    params.buildForceCompaction === true
      ? evaluation.decision === 'compact'
      : params.forceCompaction;
  const result = await buildCompactedMessagesForRequest({
    systemMessage: params.systemMessage,
    preparedMessages: params.preparedMessages,
    orderedMessages: params.orderedMessages,
    citations: params.citations,
    toolDefinitions: params.toolDefinitions,
    ...params.footprintFields,
    previousModelContextWindowTokens: params.previousModelContextWindowTokens,
    providerId: params.providerId,
    modelId: params.modelId,
    currentCompactionState: params.currentCompactionState,
    estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
    mode: params.mode,
    budgetPolicy,
    forceCompaction: shouldForceBuildCompaction,
    forcePrune: params.forcePrune,
    onCompactionStarted: params.onCompactionStarted,
    generateSummary: params.generateSummary,
  });
  const hadCompaction = Boolean(params.currentCompactionState);
  const hasCompaction = Boolean(result.compactionState);

  return {
    outcome: 'completed',
    preflightFootprint,
    evaluation,
    result,
    hadCompaction,
    hasCompaction,
    shouldPersistCompaction: shouldPersistCompactionResult({
      hasCompaction,
      usedExistingCompaction: result.usedExistingCompaction,
      forceCompaction: shouldForceBuildCompaction,
      mode: params.mode,
    }),
  };
};
