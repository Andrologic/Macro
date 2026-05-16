import type {
  CompactionSummarySource,
  ContextCompactionKind,
  ContextFootprint,
  ContextFootprintReason,
  ConversationCompactionState,
} from '../types';

export type ConversationCompactionPhase =
  | 'idle'
  | 'compacting'
  | 'safety_compacting'
  | 'model_switch_compacting'
  | 'recovering_overflow'
  | 'compacted'
  | 'degraded'
  | 'too_large'
  | 'needs_manual_compaction'
  | 'blocked';

export interface ConversationCompactionStatus {
  phase: ConversationCompactionPhase;
  upToMessageId?: string;
  summaryText?: string;
  updatedAt?: string;
  reason?: ContextFootprintReason | null;
  kind?: ContextCompactionKind;
  footprintAfter?: ContextFootprint;
  recoveredFromOverflow?: boolean;
  summaryFormatVersion?: number;
  summarySource?: CompactionSummarySource;
  checkpointHealth?: ConversationCompactionState['checkpointHealth'];
}

export type SessionCompactionEventStatus = 'running' | 'completed';

export interface SessionCompactionEvent {
  id: string;
  status: SessionCompactionEventStatus;
  displayAfterMessageId: string | null;
  logicalUpToMessageId?: string;
  kind?: ContextCompactionKind;
  startedAt: string;
  completedAt?: string;
}

export const getCompactionEventTrigger = (
  mode: ContextCompactionKind,
): ConversationCompactionState['lastTrigger'] | ContextCompactionKind =>
  mode === 'overflow_recovery' ? 'stream_overflow' : mode;

export const isTransientCompactionStatus = (
  status: ConversationCompactionStatus | null | undefined,
): status is ConversationCompactionStatus =>
  status?.phase === 'compacting' ||
  status?.phase === 'safety_compacting' ||
  status?.phase === 'model_switch_compacting' ||
  status?.phase === 'recovering_overflow';

export const resolveCompactionActivityPhase = (
  kind: ContextCompactionKind,
): ConversationCompactionPhase =>
  kind === 'overflow_recovery' || kind === 'stream_overflow'
    ? 'recovering_overflow'
    : kind === 'model_switch'
      ? 'model_switch_compacting'
      : kind === 'safety_prestream'
        ? 'safety_compacting'
        : 'compacting';

export const buildCompactionActivityStatus = (params: {
  kind: ContextCompactionKind;
  previous?: ConversationCompactionStatus | null;
  updatedAt?: string;
}): ConversationCompactionStatus => ({
  ...params.previous,
  phase: resolveCompactionActivityPhase(params.kind),
  updatedAt: params.updatedAt ?? new Date().toISOString(),
  kind: params.kind,
});

export const resolveCompactionStatusFromState = (
  state: ConversationCompactionState,
): ConversationCompactionStatus => {
  const footprintAfter = state.footprintAfter;
  const phase: ConversationCompactionPhase =
    footprintAfter?.isHardStop === true
      ? 'too_large'
      : state.degradedReason
        ? 'degraded'
        : 'compacted';

  return {
    phase,
    upToMessageId: state.upToMessageId,
    summaryText: state.summaryText,
    updatedAt: state.updatedAt,
    reason: state.degradedReason ?? null,
    kind: state.compactionKind,
    summaryFormatVersion: state.summaryFormatVersion,
    summarySource: state.summarySource,
    checkpointHealth: state.checkpointHealth,
    footprintAfter,
  };
};

export const createSessionCompactionEventId = (
  conversationId: string,
  kind: ContextCompactionKind,
  displayAfterMessageId: string | null,
  startedAt: string,
): string =>
  [
    'compaction',
    conversationId,
    kind,
    displayAfterMessageId ?? 'end',
    startedAt,
  ].join(':');

export const startSessionCompactionEvent = (params: {
  conversationId: string;
  kind: ContextCompactionKind;
  displayAfterMessageId: string | null;
  existingEvents?: SessionCompactionEvent[];
  startedAt?: string;
}): SessionCompactionEvent[] => {
  const startedAt = params.startedAt ?? new Date().toISOString();
  const event: SessionCompactionEvent = {
    id: createSessionCompactionEventId(
      params.conversationId,
      params.kind,
      params.displayAfterMessageId,
      startedAt,
    ),
    status: 'running',
    displayAfterMessageId: params.displayAfterMessageId,
    kind: params.kind,
    startedAt,
  };
  const withoutObsoleteEvents = (params.existingEvents ?? []).filter((item) => {
    if (item.displayAfterMessageId === params.displayAfterMessageId) {
      return false;
    }
    return !(item.status === 'running' && item.kind === params.kind);
  });
  return [...withoutObsoleteEvents, event];
};

export const completeLatestSessionCompactionEvent = (params: {
  existingEvents?: SessionCompactionEvent[];
  state: ConversationCompactionState;
  kind?: ContextCompactionKind;
}): SessionCompactionEvent[] | undefined => {
  const existing = params.existingEvents ?? [];
  const runningIndex = [...existing]
    .reverse()
    .findIndex(
      (event) =>
        event.status === 'running' &&
        (params.kind === undefined || event.kind === params.kind),
    );
  if (runningIndex < 0) {
    return existing.length > 0 ? existing : undefined;
  }

  const targetIndex = existing.length - 1 - runningIndex;
  return existing.map((event, index) =>
    index === targetIndex
      ? {
          ...event,
          status: 'completed' as const,
          logicalUpToMessageId: params.state.upToMessageId,
          completedAt: params.state.updatedAt,
        }
      : event,
  );
};

export const clearLatestRunningSessionCompactionEvent = (params: {
  existingEvents?: SessionCompactionEvent[];
  kind?: ContextCompactionKind;
}): SessionCompactionEvent[] | undefined => {
  const existing = params.existingEvents ?? [];
  const runningIndex = [...existing]
    .reverse()
    .findIndex(
      (event) =>
        event.status === 'running' &&
        (params.kind === undefined || event.kind === params.kind),
    );
  if (runningIndex < 0) {
    return existing.length > 0 ? existing : undefined;
  }

  const targetIndex = existing.length - 1 - runningIndex;
  const nextEvents = existing.filter((_, index) => index !== targetIndex);
  return nextEvents.length > 0 ? nextEvents : undefined;
};

