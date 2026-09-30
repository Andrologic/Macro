import { describe, expect, it } from 'bun:test';
import type { PersistedContextReference } from '../types';
import type { DbConversation, DbConversationSourceSnapshot, DbMessage } from './ipc/conversations.types';
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

const snapshot = (
  messages: DbMessage[], sourceProjectId: string | null = 'project-1', targetProjectId: string | null = 'project-1',
): DbConversationSourceSnapshot => ({
  target_project_id: targetProjectId,
  conversation: conversation('source', sourceProjectId), messages,
});

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

  it('centers the excerpt on a whole word, not a substring in an earlier word', () => {
    const selected = selectConversationPassages([
      message('match', `prerelease ${'x'.repeat(900)} release approved`),
    ], 'release');
    expect(selected).toContain('release approved');
    expect(selected).not.toContain('prerelease');
  });

  it('does not count a word cut at the search boundary as a complete match', () => {
    const selected = selectConversationPassages([
      message('boundary', `${'a'.repeat(3992)} releaseX`),
    ], 'release');
    expect(selected).toContain('recent_fallback=true');
  });

  it('uses the current transcript and freezes its cited text on the reference', async () => {
    const transcript = [message('first', 'The current deployment decision is to review releases.')];
    const ports = {
      getConversation: async (id: string) => conversation(id),
      getConversationSourceSnapshot: async () => snapshot(transcript),
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
      getConversation: async (id: string) => conversation(id),
      getConversationSourceSnapshot: async () => snapshot([message('first', 'Relevant text')], 'other-project'),
      isSourceActive: () => false,
    };
    await expect(resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef], ports,
    })).rejects.toThrow('outside this project');
    await expect(resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef],
      ports: { ...ports, isSourceActive: () => true },
    })).rejects.toThrow('unavailable');
  });

  it('compares source and destination projects from the same native snapshot', async () => {
    await expect(resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef],
      ports: {
        getConversation: async (id) => conversation(id),
        getConversationSourceSnapshot: async () => snapshot([message('first', 'Relevant text')], 'project-1', 'project-2'),
        isSourceActive: () => false,
      },
    })).rejects.toThrow('outside this project');
  });

  it('rejects a deleted source instead of silently dropping the reference', async () => {
    await expect(resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef],
      ports: {
        getConversation: async (id) => conversation(id),
        getConversationSourceSnapshot: async () => null,
        isSourceActive: () => false,
      },
    })).rejects.toThrow('unavailable');
  });

  it('uses the native snapshot even when the conversation timestamp is unchanged after an edit', async () => {
    const resolved = await resolveConversationContextSources({
      targetConversationId: 'target', request: 'Relevant', refs: [sourceRef],
      ports: {
        getConversation: async (id) => conversation(id),
        getConversationSourceSnapshot: async () => snapshot([message('first', 'Relevant edited text')]),
        isSourceActive: () => false,
      },
    });
    expect(resolved?.[0]?.sourceUpdatedAt).toBe('2026-09-28T12:00:00Z');
    expect(resolved?.[0]?.snippet).toContain('Relevant edited text');
  });
});
