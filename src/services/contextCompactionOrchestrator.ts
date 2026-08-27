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

const SYNTHETIC_STREAM_BOUNDARY_PREFIX = 'stream-boundary-';

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

export interface CompactionRuntimeAdapters {
  loadCheckpoint: (
    conversationId: string,
  ) => Promise<ConversationCompactionState | null> | ConversationCompactionState | null;
  persistCheckpoint: (state: ConversationCompactionState | null) => Promise<void> | void;
  deleteCheckpoint: (conversationId: string) => Promise<void> | void;
  recordCompactionAuditEvent: (event: {
    conversationId: string;
    trigger: ConversationCompactionState['lastTrigger'] | ContextCompactionKind;
    providerId?: string | null;
    modelId?: string | null;
    modelContextWindowTokens?: number | null;
    tokensBefore?: number | null;
    tokensAfter?: number | null;
    status: CompactionEventStatus;
    errorCode?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void> | void;
  generateSummary: (input: SummaryGenerationInput) => Promise<string | null>;
  estimateSerializedPayloadTokens?: (
    messages: StreamMessage[],
  ) => number | null | undefined;
  publishRuntimeStatus?: (
    conversationId: string,
    state: ConversationCompactionState | null,
  ) => Promise<void> | void;
}

export interface PendingToolBoundaryCompaction {
  conversationId: string;
  assistantMessageId: string;
  providerId?: string | null;
  providerType?: string | null;
  modelId?: string | null;
  createdAt: string;
  compactionState: ConversationCompactionState;
  footprintBefore: ContextFootprint;
  footprintAfter: ContextFootprint;
  messages: StreamMessage[];
}

export type ToolBoundaryCompactionConsolidationResult =
  | {
      outcome: 'skipped';
      reason:
        | 'no_pending_compaction'
        | 'already_durable'
        | 'assistant_message_missing'
        | 'no_checkpoint_created';
    }
  | {
      outcome: 'failed';
      reason:
        | 'blocked'
        | 'manual_required'
        | 'synthetic_boundary_survived'
        | 'consolidation_error';
      error?: unknown;
      preflightFootprint?: ContextFootprint;
      evaluation?: ContextCompactionEvaluation;
    }
  | {
      outcome: 'consolidated';
      preflightFootprint: ContextFootprint;
      evaluation: ContextCompactionEvaluation;
      result: MaybeCompactConversationResult;
      shouldPersistCompaction: boolean;
    };

export const isSyntheticCompactionBoundaryState = (
  state: ConversationCompactionState | null | undefined,
): boolean => Boolean(state?.upToMessageId?.startsWith(SYNTHETIC_STREAM_BOUNDARY_PREFIX));

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
  baseUrl?: string | null;
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
  countProviderInputItems?: boolean;
  onCompactionStarted?: () => void;
  generateSummary?: (input: SummaryGenerationInput) => Promise<string | null>;
  syntheticBoundary?: boolean;
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
    providerType: params.providerType,
    providerId: params.providerId,
    baseUrl: params.baseUrl,
    modelId: params.modelId,
    estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
    countProviderInputItems: params.countProviderInputItems,
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
    syntheticBoundary: params.syntheticBoundary,
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
  const shouldForcePrune =
    params.buildForceCompaction === true
      ? evaluation.decision === 'compact' && params.forcePrune === true
      : params.forcePrune;
  const result = await buildCompactedMessagesForRequest({
    systemMessage: params.systemMessage,
    preparedMessages: params.preparedMessages,
    orderedMessages: params.orderedMessages,
    citations: params.citations,
    toolDefinitions: params.toolDefinitions,
    ...params.footprintFields,
    previousModelContextWindowTokens: params.previousModelContextWindowTokens,
    providerType: params.providerType,
    providerId: params.providerId,
    baseUrl: params.baseUrl,
    modelId: params.modelId,
    currentCompactionState: params.currentCompactionState,
    estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
    countProviderInputItems: params.countProviderInputItems,
    mode: params.mode,
    budgetPolicy,
    forceCompaction: shouldForceBuildCompaction,
    forcePrune: shouldForcePrune,
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

export const consolidateCompletedAssistantTurnCompaction = async (params: {
  pending?: PendingToolBoundaryCompaction | null;
  systemMessage: string;
  preparedMessages: StreamMessage[];
  orderedMessages: ChatMessage[];
  citations: Citation[];
  toolDefinitions: MacroToolRegistryEntry[];
  footprintFields: ContextLimitFootprintFields;
  providerId?: string | null;
  providerType?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
  currentCompactionState?: ConversationCompactionState | null;
  budgetPolicy?: ContextBudgetPolicy | null;
  estimateSerializedPayloadTokens?: (
    messages: StreamMessage[],
  ) => number | null | undefined;
  countProviderInputItems?: boolean;
  generateSummary?: (input: SummaryGenerationInput) => Promise<string | null>;
}): Promise<ToolBoundaryCompactionConsolidationResult> => {
  const pending = params.pending;
  if (!pending?.compactionState) {
    return { outcome: 'skipped', reason: 'no_pending_compaction' };
  }
  if (!isSyntheticCompactionBoundaryState(pending.compactionState)) {
    return { outcome: 'skipped', reason: 'already_durable' };
  }
  if (!params.orderedMessages.some((message) => message.id === pending.assistantMessageId)) {
    return { outcome: 'skipped', reason: 'assistant_message_missing' };
  }

  try {
    const orchestration = await runContextCompactionOrchestration({
      boundary: 'post_tool_batch',
      mode: 'safety_prestream',
      systemMessage: params.systemMessage,
      preparedMessages: params.preparedMessages,
      orderedMessages: params.orderedMessages,
      citations: params.citations,
      toolDefinitions: params.toolDefinitions,
      footprintFields: params.footprintFields,
      providerId: params.providerId ?? pending.providerId,
      providerType: params.providerType ?? pending.providerType,
      baseUrl: params.baseUrl,
      modelId: params.modelId ?? pending.modelId,
      currentCompactionState: params.currentCompactionState ?? null,
      budgetPolicy: params.budgetPolicy,
      estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
      countProviderInputItems: params.countProviderInputItems,
      forceCompaction: true,
      buildForceCompaction: true,
      forcePrune: true,
      generateSummary: async (input) => {
        const reusableSummary = pending.compactionState.summaryText?.trim();
        if (reusableSummary) {
          return reusableSummary;
        }
        return (await params.generateSummary?.(input)) ?? null;
      },
    });

    if (orchestration.outcome === 'blocked') {
      return {
        outcome: 'failed',
        reason: 'blocked',
        preflightFootprint: orchestration.preflightFootprint,
        evaluation: orchestration.evaluation,
      };
    }
    if (orchestration.outcome === 'manual_required') {
      return {
        outcome: 'failed',
        reason: 'manual_required',
        preflightFootprint: orchestration.preflightFootprint,
        evaluation: orchestration.evaluation,
      };
    }

    const nextState = orchestration.result.compactionState;
    if (!nextState) {
      return { outcome: 'skipped', reason: 'no_checkpoint_created' };
    }
    if (isSyntheticCompactionBoundaryState(nextState)) {
      return {
        outcome: 'failed',
        reason: 'synthetic_boundary_survived',
        preflightFootprint: orchestration.preflightFootprint,
        evaluation: orchestration.evaluation,
      };
    }

    return {
      outcome: 'consolidated',
      preflightFootprint: orchestration.preflightFootprint,
      evaluation: orchestration.evaluation,
      result: orchestration.result,
      shouldPersistCompaction: orchestration.shouldPersistCompaction,
    };
  } catch (error) {
    return {
      outcome: 'failed',
      reason: 'consolidation_error',
      error,
    };
  }
};
