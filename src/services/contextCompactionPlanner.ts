import type {
  ContextCompactionDecisionAudit,
  ContextCompactionKind,
  ContextCompactionTrigger,
  ContextFootprint,
  ConversationCompactionState,
} from '../types';
import {
  buildContextCompactionDecisionAudit,
  isContextFootprintOverUsableBudget,
  type ContextBudgetPolicy,
} from './contextCompaction';

export type ContextCompactionBoundary =
  | 'pre_send'
  | 'post_tool_batch'
  | 'model_switch'
  | 'overflow_recovery'
  | 'manual'
  | 'diagnostics';

export type ContextCompactionPlannerDecision =
  | 'send'
  | 'compact'
  | 'reuse_checkpoint'
  | 'manual_required'
  | 'block';

export interface ContextBudgetSnapshot {
  modelContextWindowTokens: number;
  inputLimitTokens?: number | null;
  outputLimitTokens?: number | null;
  outputReserveTokens?: number | null;
  reservedTokens: number;
  usableContextTokens: number;
  source?: ContextFootprint['contextLimitSource'];
  confidence?: ContextFootprint['contextLimitConfidence'];
  isAuthoritative?: boolean;
  formula?: string | null;
}

export interface ContextPressureSnapshot {
  totalEstimatedTokens: number;
  usableContextRatio: number;
  totalContextRatio: number;
  marginTokens?: number;
  threshold: ContextFootprint['threshold'];
  reason: ContextFootprint['reason'];
}

export interface ContextCompactionEvaluation {
  decision: ContextCompactionPlannerDecision;
  boundary: ContextCompactionBoundary;
  trigger: ContextCompactionTrigger | null;
  compactionKind: ContextCompactionKind | null;
  reason: string;
  audit: ContextCompactionDecisionAudit;
  budget: ContextBudgetSnapshot;
  pressure: ContextPressureSnapshot;
  persistenceEligibility:
    | 'durable'
    | 'transient_synthetic_boundary'
    | 'not_applicable';
  syntheticBoundary: boolean;
  shouldCreateOrRefreshCheckpoint: boolean;
  shouldReuseCheckpoint: boolean;
  currentCompactionState: ConversationCompactionState | null;
}

const triggerForBoundary = (
  boundary: ContextCompactionBoundary,
): ContextCompactionTrigger | null => {
  switch (boundary) {
    case 'manual':
      return 'manual';
    case 'model_switch':
      return 'model_switch';
    case 'overflow_recovery':
      return 'stream_overflow';
    case 'pre_send':
    case 'post_tool_batch':
      return 'safety_prestream';
    case 'diagnostics':
    default:
      return null;
  }
};

const kindForBoundary = (
  boundary: ContextCompactionBoundary,
): ContextCompactionKind | null => {
  switch (boundary) {
    case 'manual':
      return 'manual';
    case 'model_switch':
      return 'model_switch';
    case 'overflow_recovery':
      return 'overflow_recovery';
    case 'pre_send':
    case 'post_tool_batch':
      return 'safety_prestream';
    case 'diagnostics':
    default:
      return null;
  }
};

const buildBudgetSnapshot = (
  footprint: ContextFootprint,
  audit: ContextCompactionDecisionAudit,
): ContextBudgetSnapshot => ({
  modelContextWindowTokens: footprint.modelContextWindowTokens,
  inputLimitTokens: footprint.inputLimitTokens ?? null,
  outputLimitTokens: footprint.outputLimitTokens ?? null,
  outputReserveTokens: footprint.outputReserveTokens ?? audit.outputReserveTokens ?? null,
  reservedTokens: footprint.reservedTokens,
  usableContextTokens: footprint.usableContextTokens,
  source: footprint.contextLimitSource,
  confidence: footprint.contextLimitConfidence,
  isAuthoritative: footprint.isContextLimitAuthoritative,
  formula: audit.formula ?? null,
});

const buildPressureSnapshot = (
  footprint: ContextFootprint,
): ContextPressureSnapshot => ({
  totalEstimatedTokens: footprint.totalEstimatedTokens,
  usableContextRatio: footprint.usableContextRatio,
  totalContextRatio: footprint.totalContextRatio,
  marginTokens: footprint.marginTokens,
  threshold: footprint.threshold,
  reason: footprint.reason,
});

export const evaluateContextCompaction = (params: {
  boundary: ContextCompactionBoundary;
  footprint: ContextFootprint;
  budgetPolicy?: ContextBudgetPolicy | null;
  currentCompactionState?: ConversationCompactionState | null;
  forceCompaction?: boolean;
  latestBoundaryPayloadTokens?: number | null;
  providerId?: string | null;
  providerType?: string | null;
  modelId?: string | null;
  syntheticBoundary?: boolean;
}): ContextCompactionEvaluation => {
  const trigger = triggerForBoundary(params.boundary);
  const compactionKind = kindForBoundary(params.boundary);
  const autoCompactionEnabled = params.budgetPolicy?.auto !== false;
  const forceCompaction = Boolean(params.forceCompaction);
  const overUsableBudget = isContextFootprintOverUsableBudget(params.footprint);
  const currentCompactionState = params.currentCompactionState ?? null;
  const latestBoundaryPayloadTokens =
    typeof params.latestBoundaryPayloadTokens === 'number' &&
    Number.isFinite(params.latestBoundaryPayloadTokens)
      ? params.latestBoundaryPayloadTokens
      : params.footprint.latestUserContextTokens;
  const latestPayloadTooLarge =
    typeof latestBoundaryPayloadTokens === 'number' &&
    latestBoundaryPayloadTokens >= params.footprint.usableContextTokens;

  let decision: ContextCompactionPlannerDecision;
  let reason: string;

  if (latestPayloadTooLarge && overUsableBudget) {
    decision = 'block';
    reason =
      params.boundary === 'post_tool_batch'
        ? 'latest_tool_batch_exceeds_usable_budget'
        : 'latest_message_exceeds_usable_budget';
  } else if (params.boundary === 'manual' || forceCompaction) {
    decision = 'compact';
    reason = params.boundary === 'manual' ? 'manual_compaction_requested' : 'forced_compaction';
  } else if (overUsableBudget) {
    if (!autoCompactionEnabled) {
      decision = 'manual_required';
      reason = 'auto_compaction_disabled';
    } else {
      decision = 'compact';
      reason = params.footprint.reason;
    }
  } else if (currentCompactionState) {
    decision = 'reuse_checkpoint';
    reason = 'checkpoint_valid_for_projected_payload';
  } else {
    decision = 'send';
    reason = params.footprint.reason;
  }

  const audit = buildContextCompactionDecisionAudit({
    providerId: params.providerId,
    providerType: params.providerType,
    modelId: params.modelId,
    trigger: trigger ?? compactionKind,
    result: decision,
    reason,
    footprint: params.footprint,
    budgetPolicy: params.budgetPolicy ?? undefined,
  });
  const syntheticBoundary = Boolean(params.syntheticBoundary);
  const persistenceEligibility = syntheticBoundary
    ? 'transient_synthetic_boundary'
    : decision === 'compact' || decision === 'reuse_checkpoint'
      ? 'durable'
      : 'not_applicable';

  return {
    decision,
    boundary: params.boundary,
    trigger,
    compactionKind,
    reason,
    audit,
    budget: buildBudgetSnapshot(params.footprint, audit),
    pressure: buildPressureSnapshot(params.footprint),
    persistenceEligibility,
    syntheticBoundary,
    shouldCreateOrRefreshCheckpoint: decision === 'compact',
    shouldReuseCheckpoint: decision === 'reuse_checkpoint',
    currentCompactionState,
  };
};
