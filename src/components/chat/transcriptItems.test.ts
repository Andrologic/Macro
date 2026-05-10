import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '../../types';
import {
  buildChatTranscriptItems,
  getTranscriptMessageIndexById,
} from './transcriptItems';

const makeMessage = (id: string): ChatMessage => ({
  id,
  task_id: 'task-1',
  conversation_id: 'conv-1',
  role: id.startsWith('u') ? 'user' : 'assistant',
  content: `Message ${id}`,
  timestamp: '2026-05-09T00:00:00.000Z',
});

describe('buildChatTranscriptItems', () => {
  it('inserts the compaction boundary immediately after upToMessageId', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2')],
      { upToMessageId: 'a1', updatedAt: '2026-05-09T10:00:00.000Z' },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction_boundary',
      'message',
    ]);
    expect(items[2]).toMatchObject({
      kind: 'compaction_boundary',
      key: 'compaction-boundary:a1',
      afterMessageId: 'a1',
    });
  });

  it('does not insert a boundary when the compacted message is absent', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2')],
      { upToMessageId: 'missing' },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);
  });

  it('inserts a boundary even when the compacted message is at the end of the conversation', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      { upToMessageId: 'a1' },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction_boundary',
    ]);
  });

  it('keeps stable virtualization keys', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2')],
      { upToMessageId: 'a1', updatedAt: '2026-05-09T10:00:00.000Z' },
    );
    const nextItems = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2')],
      { upToMessageId: 'a1', updatedAt: '2026-05-09T11:00:00.000Z' },
    );

    expect(items.map((item) => item.key)).toEqual(nextItems.map((item) => item.key));
  });

  it('maps message focus indexes after the boundary shift', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2')],
      { upToMessageId: 'a1' },
    );

    expect(getTranscriptMessageIndexById(items, 'u2')).toBe(3);
  });

  it('does not model the boundary as a chat message', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('u2')],
      { upToMessageId: 'a1' },
    );
    const boundary = items.find((item) => item.kind === 'compaction_boundary');

    expect(boundary).toBeDefined();
    expect('message' in boundary!).toBe(false);
  });

  it('adds a transient compaction progress item while compaction is running', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1'), makeMessage('a1')],
      {
        conversationId: 'conv-1',
        upToMessageId: 'a1',
        phase: 'compacting',
        updatedAt: '2026-05-09T10:00:00.000Z',
      },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction_boundary',
      'compaction_progress',
    ]);
    expect(items[3]).toMatchObject({
      kind: 'compaction_progress',
      key: 'compaction-progress:conv-1',
      phase: 'compacting',
    });
    expect('message' in items[3]).toBe(false);
  });

  it('uses a stable progress key across compaction updates', () => {
    const items = buildChatTranscriptItems(
      [makeMessage('u1')],
      { conversationId: 'conv-1', phase: 'compacting', updatedAt: '2026-05-09T10:00:00.000Z' },
    );
    const nextItems = buildChatTranscriptItems(
      [makeMessage('u1')],
      { conversationId: 'conv-1', phase: 'overflow_recovery', updatedAt: '2026-05-09T11:00:00.000Z' },
    );

    expect(items.at(-1)?.key).toBe('compaction-progress:conv-1');
    expect(nextItems.at(-1)?.key).toBe('compaction-progress:conv-1');
  });
});
