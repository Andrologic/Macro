import { describe, expect, it } from 'bun:test';
import type { ChatMessage } from '../types';
import { resolveTaskQueueAttention, resolveTaskQueueSupervision, selectTaskQueueRequestSignature } from './taskQueueAttention';

const question = (conversationId: string): ChatMessage => ({
  id: `question-${conversationId}`, conversation_id: conversationId, role: 'assistant',
  content: 'Choose a target', timestamp: '2026-09-04T10:00:00Z', task_id: 'task',
  questionnaire: { source: 'tool', questions: [{ id: 'target', prompt: 'Which target?', choices: ['A', 'B', 'C'] }] },
});
const base = () => ({
  tasks: [{ id: 'task', node_id: 'node', status: 'InProgress' as const, conversation_id: 'conversation' }],
  conversations: [{ id: 'conversation', task_id: 'node', scope_mode: 'Implement' }],
  messages: [], messagesByConversationId: {}, questionnaireDraftsByConversationId: {},
  pendingToolApprovalByConversationId: {}, runningTaskIds: new Set<string>(),
});

describe('resolveTaskQueueAttention', () => {
  it('recognizes a live approval during streaming and restored approvals before hydration', () => {
    const state = base();
    for (const approval of [undefined, { toolCallId: 'call' }, { toolCallId: 'call', recoveryState: 'interrupted' }]) {
      expect(resolveTaskQueueAttention({ ...state, conversations: [], runningTaskIds: new Set(['task']),
        pendingToolApprovalByConversationId: { conversation: approval },
      }).get('task')).toEqual({ kind: 'approval', conversationId: 'conversation' });
    }
    expect(resolveTaskQueueAttention({ ...state, runningTaskIds: new Set(['task']) }).size).toBe(0);
  });

  it('keeps unloaded durable waits, but excludes stale waits during streaming or after a loaded reply', () => {
    const state = { ...base(), tasks: [{ ...base().tasks[0]!, status: 'AwaitingResponse' as const }] };
    expect(resolveTaskQueueAttention(state).get('task')?.kind).toBe('reply');
    expect(resolveTaskQueueAttention({ ...state, runningTaskIds: new Set(['task']) }).size).toBe(0);
    expect(resolveTaskQueueAttention({ ...state, messagesByConversationId: { conversation: [
      question('conversation'), { ...question('conversation'), id: 'answer', role: 'user', content: 'A', questionnaire: undefined },
    ] } }).size).toBe(0);
  });

  it('preserves durable waits for ordinary loaded messages and records only evidenced replies', () => {
    const state = { ...base(), tasks: [{ ...base().tasks[0]!, status: 'AwaitingResponse' as const }] };
    const ordinary = { ...question('conversation'), questionnaire: undefined };
    expect(resolveTaskQueueAttention({ ...state, messages: [ordinary] }).get('task')?.kind).toBe('reply');
    expect(resolveTaskQueueAttention({ ...state, messages: [{ ...ordinary, role: 'user' }] }).get('task')?.kind).toBe('reply');
    const resolved = resolveTaskQueueSupervision({ ...state, messages: [question('conversation'), { ...ordinary, role: 'user' }] });
    expect(resolved.attentionByTaskId.size).toBe(0);
    expect(resolved.resolvedWaitTaskIds.has('task')).toBe(true);
  });

  it('keeps its subscription signature stable for streaming text and reacts to requests and replies', () => {
    const ordinary = { ...question('conversation'), questionnaire: undefined };
    const signature = (messages: ChatMessage[]) => selectTaskQueueRequestSignature({ ...base(), messages });
    expect(signature([ordinary])).toBe(signature([{ ...ordinary, content: 'another fragment' }]));
    expect(signature([question('conversation')])).not.toBe(signature([ordinary]));
    expect(signature([question('conversation'), { ...ordinary, role: 'user' }])).not.toBe(signature([question('conversation')]));
  });

  it('deduplicates mixed requests and removes resolved questionnaires and approvals', () => {
    const state = { ...base(), messagesByConversationId: { conversation: [question('conversation')] } };
    expect(resolveTaskQueueAttention(state).get('task')?.kind).toBe('questionnaire');
    const both = resolveTaskQueueAttention({ ...state, pendingToolApprovalByConversationId: { conversation: { toolCallId: 'call' } } });
    expect(both.size).toBe(1);
    expect(both.get('task')?.kind).toBe('approval');
    expect(resolveTaskQueueAttention({ ...state, messagesByConversationId: { conversation: [] } }).size).toBe(0);
  });

  it('does not classify completed or archived tasks and dependency-only blocks as attention', () => {
    const tasks = [
      { id: 'completed', status: 'Completed' as const, conversation_id: 'completed' },
      { id: 'archived', status: 'InReview' as const, archived_at: 'today', conversation_id: 'archived' },
      { id: 'blocked', status: 'InReview' as const, is_blocked: true },
      { id: 'review', status: 'InReview' as const },
    ];
    expect([...resolveTaskQueueAttention({ ...base(), tasks, conversations: [],
      pendingToolApprovalByConversationId: { completed: {}, archived: {} },
    }).keys()]).toEqual(['review']);
    expect(resolveTaskQueueAttention({ ...base(), tasks: [{ ...base().tasks[0]!, is_blocked: true }],
      pendingToolApprovalByConversationId: { conversation: {} },
    }).get('task')?.kind).toBe('approval');
  });

  it('rejects conflicting conversation links and non-Implement scopes', () => {
    for (const conversation of [
      { id: 'conversation', task_id: 'other', scope_mode: 'Implement' },
      { id: 'conversation', task_id: 'task', scope_mode: 'Chat' },
    ]) {
      expect(resolveTaskQueueAttention({ ...base(), conversations: [conversation],
        pendingToolApprovalByConversationId: { conversation: {} },
      }).size).toBe(0);
    }
  });
});
