import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '../../types';
import {
  buildChatTranscriptItems,
  buildTranscriptMessageIndex,
  buildTranscriptBootstrapWindow,
  CHAT_TRANSCRIPT_BOOTSTRAP_LIMIT,
  getTranscriptMessageIndexById,
  type ChatTranscriptCompactionEventInput,
} from './transcriptItems';

const makeMessage = (id: string): ChatMessage => ({
  id,
  task_id: 'task-1',
  conversation_id: 'conv-1',
  role: id.startsWith('u') ? 'user' : 'assistant',
  content: `Message ${id}`,
  timestamp: '2026-05-09T00:00:00.000Z',
});

const makeCompactionEvent = (
  event: Partial<ChatTranscriptCompactionEventInput> = {},
): ChatTranscriptCompactionEventInput => ({
  id: 'compaction-1',
  status: 'completed',
  displayAfterMessageId: 'a1',
  logicalUpToMessageId: 'older-a1',
  kind: 'manual',
  startedAt: '2026-05-09T10:00:00.000Z',
  completedAt: '2026-05-09T10:01:00.000Z',
  ...event,
});

describe('buildChatTranscriptItems', () => {
  it('inserts a running compaction event after its visual anchor', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      {
        compactionEvents: [
          makeCompactionEvent({
            status: 'running',
            displayAfterMessageId: 'u1',
            kind: 'safety_prestream',
          }),
        ],
      },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'compaction_progress',
      'message',
    ]);
    expect(items[1]).toMatchObject({
      kind: 'compaction_progress',
      key: 'compaction-event:compaction-1',
      eventId: 'compaction-1',
      afterMessageId: 'u1',
      phase: 'safety_compacting',
    });
  });

  it('keeps the same key and index when a running event completes', () => {
    const runningItems = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      {
        compactionEvents: [
          makeCompactionEvent({
            status: 'running',
            displayAfterMessageId: 'u1',
          }),
        ],
      },
    );
    const completedItems = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      {
        compactionEvents: [
          makeCompactionEvent({
            status: 'completed',
            displayAfterMessageId: 'u1',
            logicalUpToMessageId: 'a0',
          }),
        ],
      },
    );

    expect(runningItems[1]?.key).toBe('compaction-event:compaction-1');
    expect(completedItems[1]).toMatchObject({
      kind: 'compaction_boundary',
      key: 'compaction-event:compaction-1',
      eventId: 'compaction-1',
      afterMessageId: 'u1',
      logicalUpToMessageId: 'a0',
    });
  });

  it('inserts multiple completed compaction events', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2'), makeMessage('a2')],
      {
        compactionEvents: [
          makeCompactionEvent({
            id: 'compaction-1',
            displayAfterMessageId: 'a1',
            completedAt: '2026-05-09T10:00:00.000Z',
          }),
          makeCompactionEvent({
            id: 'compaction-2',
            displayAfterMessageId: 'a2',
            completedAt: '2026-05-09T11:00:00.000Z',
          }),
        ],
      },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction_boundary',
      'message',
      'message',
      'compaction_boundary',
    ]);
    expect(items.filter((item) => item.kind === 'compaction_boundary')).toEqual([
      {
        kind: 'compaction_boundary',
        key: 'compaction-event:compaction-1',
        eventId: 'compaction-1',
        afterMessageId: 'a1',
        logicalUpToMessageId: 'older-a1',
        updatedAt: '2026-05-09T10:00:00.000Z',
      },
      {
        kind: 'compaction_boundary',
        key: 'compaction-event:compaction-2',
        eventId: 'compaction-2',
        afterMessageId: 'a2',
        logicalUpToMessageId: 'older-a1',
        updatedAt: '2026-05-09T11:00:00.000Z',
      },
    ]);
  });

  it('renders an event at the end when its visual anchor is absent', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      {
        compactionEvents: [
          makeCompactionEvent({
            displayAfterMessageId: 'missing',
          }),
        ],
      },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction_boundary',
    ]);
    expect(items.at(-1)).toMatchObject({
      kind: 'compaction_boundary',
      key: 'compaction-event:compaction-1',
    });
  });

  it('maps message focus indexes after compaction event rows shift the transcript', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2')],
      {
        compactionEvents: [
          makeCompactionEvent({
            displayAfterMessageId: 'a1',
          }),
        ],
      },
    );

    expect(getTranscriptMessageIndexById(items, 'u2')).toBe(3);
  });

  it('does not model compaction events as chat messages', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      {
        compactionEvents: [makeCompactionEvent()],
      },
    );
    const boundary = items.find((item) => item.kind === 'compaction_boundary');

    expect(boundary).toBeDefined();
    expect('message' in boundary!).toBe(false);
  });

  it('deduplicates compaction events by id using the latest event', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      {
        compactionEvents: [
          makeCompactionEvent({
            id: 'compaction-1',
            status: 'running',
            displayAfterMessageId: 'u1',
          }),
          makeCompactionEvent({
            id: 'compaction-1',
            status: 'completed',
            displayAfterMessageId: 'a1',
          }),
        ],
      },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction_boundary',
    ]);
  });

  it('keeps only the latest compaction event for the same visual anchor', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      {
        compactionEvents: [
          makeCompactionEvent({
            id: 'previous-compaction',
            status: 'completed',
            displayAfterMessageId: 'a1',
          }),
          makeCompactionEvent({
            id: 'current-compaction',
            status: 'running',
            displayAfterMessageId: 'a1',
          }),
        ],
      },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction_progress',
    ]);
    expect(items.at(-1)).toMatchObject({
      kind: 'compaction_progress',
      eventId: 'current-compaction',
    });
  });
});

describe('transcript navigation and bootstrap', () => {
  it('indexes messages in one traversal, retaining first matches around compaction rows', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2'), makeMessage('u1')],
      { compactionEvents: [makeCompactionEvent()] },
    );
    const index = buildTranscriptMessageIndex(items);
    expect([...index]).toEqual([['u1', 0], ['a1', 1], ['u2', 3]]);
    expect(index.has('compaction-1')).toBe(false);
    expect(index.get('missing')).toBeUndefined();
    expect(buildTranscriptMessageIndex([]).size).toBe(0);
  });

  it('bounds bootstrap rows while preserving full offsets, compaction and source messages', () => {
    const messages = Array.from({ length: 10_000 }, (_, i) => makeMessage(`a${i}`));
    const items = buildChatTranscriptItems(messages, { compactionEvents: [
      makeCompactionEvent({ displayAfterMessageId: 'a9998' }),
    ] });
    const window = buildTranscriptBootstrapWindow(items, (item) => item.kind === 'message' ? 220 : 48, 16);
    expect(window.rows).toHaveLength(CHAT_TRANSCRIPT_BOOTSTRAP_LIMIT);
    expect(window.rows[0].index).toBe(items.length - CHAT_TRANSCRIPT_BOOTSTRAP_LIMIT);
    expect(window.rows[0].start).toBe(window.rows[0].index * 236);
    expect(window.rows.at(-2)?.item.kind).toBe('compaction_boundary');
    expect(window.rows.at(-1)?.key).toBe('message:a9999');
    expect(window.totalSize).toBe(10_000 * 220 + 48 + 10_000 * 16);
    expect(window.rows.at(-1)!.start + window.rows.at(-1)!.size).toBe(window.totalSize);
    expect(messages).toHaveLength(10_000);
    expect(items.filter((item) => item.kind === 'message')).toHaveLength(10_000);
    expect(buildTranscriptBootstrapWindow([], () => 220, 16)).toEqual({ rows: [], totalSize: 0 });
  });
});
