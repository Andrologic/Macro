import { describe, expect, it } from 'bun:test';

import type { ConversationCompactionState } from '../types';
import {
  buildCompactionActivityStatus,
  clearLatestRunningSessionCompactionEvent,
  completeLatestSessionCompactionEvent,
  isTransientCompactionStatus,
  resolveCompactionStatusFromState,
  startSessionCompactionEvent,
  type SessionCompactionEvent,
} from './contextCompactionSession';

const state = (overrides: Partial<ConversationCompactionState> = {}): ConversationCompactionState => ({
  conversationId: 'conv-1',
  upToMessageId: 'u1',
  summaryText: 'summary',
  toolDigest: [],
  usedSourcePassageIds: [],
  interestingSourcePassageIds: [],
  estimatedTokensBefore: 10_000,
  estimatedTokensAfter: 2_000,
  fingerprint: 'fp',
  version: 1,
  createdAt: '2026-05-16T10:00:00.000Z',
  updatedAt: '2026-05-16T10:01:00.000Z',
  prunedToolContextMessageIds: [],
  reservedTokens: 0,
  ...overrides,
});

describe('contextCompactionSession', () => {
  it('starts a running event and replaces obsolete events at the same anchor', () => {
    const existing: SessionCompactionEvent[] = [
      {
        id: 'old',
        status: 'completed',
        displayAfterMessageId: 'u1',
        kind: 'manual',
        startedAt: '2026-05-16T09:00:00.000Z',
        completedAt: '2026-05-16T09:01:00.000Z',
      },
      {
        id: 'older',
        status: 'completed',
        displayAfterMessageId: 'a1',
        kind: 'manual',
        startedAt: '2026-05-16T09:02:00.000Z',
        completedAt: '2026-05-16T09:03:00.000Z',
      },
    ];

    const events = startSessionCompactionEvent({
      conversationId: 'conv-1',
      kind: 'manual',
      displayAfterMessageId: 'u1',
      existingEvents: existing,
      startedAt: '2026-05-16T10:00:00.000Z',
    });

    expect(events.map((event) => event.id)).toEqual([
      'older',
      'compaction:conv-1:manual:u1:2026-05-16T10:00:00.000Z',
    ]);
    expect(events.at(-1)?.status).toBe('running');
  });

  it('completes the latest matching running event without moving it', () => {
    const running = startSessionCompactionEvent({
      conversationId: 'conv-1',
      kind: 'safety_prestream',
      displayAfterMessageId: 'u2',
      startedAt: '2026-05-16T10:00:00.000Z',
    });

    const completed = completeLatestSessionCompactionEvent({
      existingEvents: running,
      state: state({ upToMessageId: 'a1', updatedAt: '2026-05-16T10:02:00.000Z' }),
      kind: 'safety_prestream',
    });

    expect(completed).toHaveLength(1);
    expect(completed?.[0]).toMatchObject({
      id: running[0].id,
      status: 'completed',
      displayAfterMessageId: 'u2',
      logicalUpToMessageId: 'a1',
      completedAt: '2026-05-16T10:02:00.000Z',
    });
  });

  it('clears only the latest matching running event', () => {
    const existing: SessionCompactionEvent[] = [
      {
        id: 'running-manual',
        status: 'running',
        displayAfterMessageId: 'u1',
        kind: 'manual',
        startedAt: '2026-05-16T10:00:00.000Z',
      },
      {
        id: 'running-safety',
        status: 'running',
        displayAfterMessageId: 'u2',
        kind: 'safety_prestream',
        startedAt: '2026-05-16T10:01:00.000Z',
      },
    ];

    const events = clearLatestRunningSessionCompactionEvent({
      existingEvents: existing,
      kind: 'manual',
    });

    expect(events?.map((event) => event.id)).toEqual(['running-safety']);
  });

  it('maps compaction activity and persisted state into UI status', () => {
    const active = buildCompactionActivityStatus({
      kind: 'overflow_recovery',
      previous: { phase: 'compacted', upToMessageId: 'a1' },
      updatedAt: '2026-05-16T10:00:00.000Z',
    });

    expect(active).toMatchObject({
      phase: 'recovering_overflow',
      upToMessageId: 'a1',
      kind: 'overflow_recovery',
    });
    expect(isTransientCompactionStatus(active)).toBe(true);

    expect(resolveCompactionStatusFromState(state()).phase).toBe('compacted');
    expect(
      resolveCompactionStatusFromState(
        state({ degradedReason: 'post_compaction_overflow' }),
      ).phase,
    ).toBe('degraded');
    expect(
      resolveCompactionStatusFromState(
        state({ footprintAfter: { isHardStop: true } as ConversationCompactionState['footprintAfter'] }),
      ).phase,
    ).toBe('too_large');
  });
});
