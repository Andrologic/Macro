import { describe, expect, it } from 'bun:test';
import type { PersistedContextReference } from '../types';
import type { DbConversation, DbMessage } from './ipc/conversations.types';
import {
  resolveConversationContextSources,
  selectConversationPassages,
} from './conversationContextSource';

const conversation = (id: string, projectId: string | null = 'project-1'): DbConversation => ({
  id, title: `Conversation ${id}`, project_id: projectId,
  updated_at: '2026-09-28T12:00:00Z',
} as DbConversation);

const message = (
  id: string, content: string, role: 'user' | 'assistant' = 'user', completionReason: string | null = null,
): DbMessage => ({
  id, conversation_id: 'source', role, content,
  created_at: '2026-09-28T10:00:00Z', completion_reason: completionReason,
} as DbMessage);

const sourceRef: PersistedContextReference = {
  id: 'source', conversationId: 'source', kind: 'conversation', title: 'Old title',
};

describe('conversation context sources', () => {
  it('selects relevant completed passages with stable message citations and a bounded excerpt', () => {
    const selected = selectConversationPassages([
      message('old', 'A previous decision about colors.'),
      message('partial', 'The unfinished decision is to remove sandboxing.', 'assistant'),
      message('match', `${'Unrelated. '.repeat(100)}The deployment decision is to review every release.`, 'assistant', 'completed'),
      message('recent', 'A newer unrelated message.'),
    ], 'What is the deployment decision?');
    expect(selected).toContain('message_id=match');
    expect(selected).toContain('deployment decision');
    expect(selected).not.toContain('message_id=partial');
    expect(selected.length).toBeLessThan(3_000);
  });

  it('does not pad matches with unrelated recent messages or lose older matches', () => {
    const messages = [message('important', 'The deployment decision requires review.')];
    for (let index = 0; index < 600; index += 1) {
      messages.push(message(`noise-${index}`, 'Unrelated weather update.'));
    }
    const selected = selectConversationPassages(messages, 'deployment decision');
    expect(selected).toContain('message_id=important');
    expect(selected).not.toContain('message_id=noise-');
  });

  it('uses the current transcript and freezes its cited text on the reference', async () => {
    const transcript = [message('first', 'The current deployment decision is to review releases.')];
    const ports = {
      getConversation: async (id: string) => conversation(id),
      listMessages: async () => transcript,
      isSourceActive: () => false,
    };
    const resolved = await resolveConversationContextSources({
      targetConversationId: 'target', request: 'deployment decision', refs: [sourceRef],
      ports,
    });
    expect(resolved?.[0]).toMatchObject({
      id: 'source', title: 'Conversation source', sourceUpdatedAt: '2026-09-28T12:00:00Z',
    });
    expect(resolved?.[0]?.snippet).toContain('message_id=first');
    transcript[0] = message('second', 'The decision was withdrawn.');
    expect(resolved?.[0]?.snippet).not.toContain('withdrawn');
    const next = await resolveConversationContextSources({
      targetConversationId: 'target', request: 'decision', refs: [sourceRef], ports,
    });
    expect(next?.[0]?.snippet).toContain('message_id=second');
    expect(next?.[0]?.snippet).not.toContain('message_id=first');
  });

  it('rejects a source outside the destination project and an active source', async () => {
    const ports = {
      getConversation: async (id: string) => conversation(id, id === 'source' ? 'other-project' : 'project-1'),
      listMessages: async () => [message('first', 'Relevant text')],
      isSourceActive: () => false,
    };
    await expect(resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef], ports,
    })).rejects.toThrow('outside this project');
    await expect(resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef],
      ports: { ...ports, getConversation: async (id) => conversation(id), isSourceActive: () => true },
    })).rejects.toThrow('unavailable');
  });

  it('rejects a deleted source instead of silently dropping the reference', async () => {
    await expect(resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef],
      ports: {
        getConversation: async (id) => id === 'source' ? null : conversation(id),
        listMessages: async () => [message('first', 'Relevant text')],
        isSourceActive: () => false,
      },
    })).rejects.toThrow('unavailable');
  });

  it('refuses to cite a transcript that changes during selection', async () => {
    let reads = 0;
    await expect(resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef],
      ports: {
        getConversation: async (id) => ({
          ...conversation(id),
          updated_at: id === 'source' && ++reads > 1 ? '2026-09-28T12:01:00Z' : '2026-09-28T12:00:00Z',
        }),
        listMessages: async () => [message('first', 'Relevant text')],
        isSourceActive: () => false,
      },
    })).rejects.toThrow('changed while selecting');
  });
});
