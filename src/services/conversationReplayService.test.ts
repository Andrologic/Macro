import { describe, expect, it } from 'bun:test';

import type { ChatMessage, ConversationCompactionState } from '../types';
import {
  buildConversationReplayPlan,
  executeConversationReplay,
  pruneSessionCompactionEventsForReplay,
  shouldDeleteContextCompactionForReplay,
} from './conversationReplayService';

const message = (
  id: string,
  role: 'user' | 'assistant',
  minute: number,
): ChatMessage => ({
  id,
  task_id: 'task-1',
  conversation_id: 'conv-1',
  role,
  content: id,
  timestamp: `2026-05-16T10:${String(minute).padStart(2, '0')}:00.000Z`,
});

const messages = [
  message('u1', 'user', 0),
  message('a1', 'assistant', 1),
  message('u2', 'user', 2),
  message('a2', 'assistant', 3),
  message('u3', 'user', 4),
];

const state = (upToMessageId: string): ConversationCompactionState => ({
  conversationId: 'conv-1',
  upToMessageId,
  summaryText: 'summary',
  toolDigest: [],
  usedSourcePassageIds: [],
  interestingSourcePassageIds: [],
  estimatedTokensBefore: 100,
  estimatedTokensAfter: 50,
  fingerprint: 'fp',
  version: 1,
  createdAt: '2026-05-16T10:00:00.000Z',
  updatedAt: '2026-05-16T10:00:00.000Z',
});

describe('conversationReplayService', () => {
  it('keeps visual compaction markers strictly before the replay point', () => {
    const events = pruneSessionCompactionEventsForReplay(
      [
        { id: 'before', displayAfterMessageId: 'a1' },
        { id: 'at', displayAfterMessageId: 'u2' },
        { id: 'after', displayAfterMessageId: 'a2' },
        { id: 'missing', displayAfterMessageId: null },
      ],
      messages,
      'u2',
    );

    expect(events).toEqual([{ id: 'before', displayAfterMessageId: 'a1' }]);
  });

  it('keeps context checkpoints strictly before the replay point', () => {
    const afterReplay = messages.slice(0, 3);

    expect(
      shouldDeleteContextCompactionForReplay(state('a1'), afterReplay, 'u2'),
    ).toBe(false);
    expect(
      shouldDeleteContextCompactionForReplay(state('u2'), afterReplay, 'u2'),
    ).toBe(true);
    expect(
      shouldDeleteContextCompactionForReplay(state('a2'), afterReplay, 'u2'),
    ).toBe(true);
  });

  it('builds a replay plan that trims messages, markers, and stale context checkpoint together', () => {
    const plan = buildConversationReplayPlan({
      conversationId: 'conv-1',
      replayMessageId: 'u2',
      conversationMessages: messages,
      contextCompactionState: state('u2'),
      sessionCompactionEvents: [
        { id: 'before', displayAfterMessageId: 'a1' },
        { id: 'after', displayAfterMessageId: 'a2' },
      ],
    });

    expect(Array.from(plan.keptMessageIds)).toEqual(['u1', 'a1', 'u2']);
    expect(plan.sessionCompactionEvents).toEqual([
      { id: 'before', displayAfterMessageId: 'a1' },
    ]);
    expect(plan.removedSessionCompactionEventCount).toBe(1);
    expect(plan.shouldDeleteContextCompactionState).toBe(true);
    expect(plan.contextCompactionAction).toBe('delete');
    expect(plan.diagnosticMessages).toEqual([
      'Les compactages de contexte après ce message seront recalculés.',
      'Les marqueurs visuels de compaction après ce message seront retirés.',
    ]);
  });

  it('diagnoses a replay that keeps an earlier context checkpoint', () => {
    const plan = buildConversationReplayPlan({
      conversationId: 'conv-1',
      replayMessageId: 'u3',
      conversationMessages: messages,
      contextCompactionState: state('a1'),
      sessionCompactionEvents: [{ id: 'before', displayAfterMessageId: 'a1' }],
    });

    expect(plan.shouldDeleteContextCompactionState).toBe(false);
    expect(plan.contextCompactionAction).toBe('keep');
    expect(plan.diagnosticMessages).toEqual([]);
  });

  it('executes replay operations in the safe checkpoint order', async () => {
    const calls: string[] = [];

    const result = await executeConversationReplay({
      conversationId: 'conv-1',
      replayMessageId: 'u2',
      conversationMessages: messages,
      contextCompactionState: state('u2'),
      sessionCompactionEvents: [{ id: 'after', displayAfterMessageId: 'a2' }],
      adapters: {
        previewCodeCheckpoints: () => {
          calls.push('preview');
          return { affectedFileCount: 1 };
        },
        confirmCodeRestore: () => {
          calls.push('confirm');
          return true;
        },
        restoreCodeCheckpoint: () => {
          calls.push('restore-code');
        },
        trimMessages: () => {
          calls.push('trim');
        },
        pruneCodeCheckpoints: () => {
          calls.push('prune-code');
        },
        deleteContextCompactionState: () => {
          calls.push('delete-context-checkpoint');
        },
        applySessionCompactionEvents: () => {
          calls.push('prune-markers');
        },
        restartAssistant: () => {
          calls.push('restart');
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(calls).toEqual([
      'preview',
      'confirm',
      'restore-code',
      'trim',
      'prune-code',
      'delete-context-checkpoint',
      'prune-markers',
      'restart',
    ]);
  });

  it('cancels replay before mutations when code restore is refused', async () => {
    const calls: string[] = [];

    const result = await executeConversationReplay({
      conversationId: 'conv-1',
      replayMessageId: 'u2',
      conversationMessages: messages,
      contextCompactionState: state('u2'),
      adapters: {
        previewCodeCheckpoints: () => {
          calls.push('preview');
          return { affectedFiles: ['src/app.ts'] };
        },
        confirmCodeRestore: () => {
          calls.push('confirm');
          return false;
        },
        trimMessages: () => {
          calls.push('trim');
        },
      },
    });

    expect(result.status).toBe('cancelled');
    expect(calls).toEqual(['preview', 'confirm']);
  });
});
