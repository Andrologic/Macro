import { describe, expect, it } from 'bun:test';
import type { Conversation } from '../../types';
import {
  areConversationIdSetsEqual,
  filterConversationsByQuery,
  getArchiveViewConversations,
  getChatOnlyConversations,
  normalizeConversationIdList,
  partitionPinnedConversations,
  pruneConversationIdSet,
  toggleAllConversationIds,
  toggleConversationIdInSet,
} from './conversationArchiveState';

const createConversation = (overrides: Partial<Conversation>): Conversation => ({
  id: overrides.id || 'conversation-1',
  title: overrides.title || 'Conversation',
  description: overrides.description || '',
  scope_mode:
    overrides.scope_mode ??
    (overrides.task_id
      ? 'Implement'
      : overrides.group_id || overrides.project_id
        ? 'Architect'
        : 'Chat'),
  task_id: overrides.task_id ?? null,
  group_id: overrides.group_id ?? null,
  project_id: overrides.project_id ?? null,
  last_message: overrides.last_message || '',
  message_count: overrides.message_count ?? 0,
  updated_at: overrides.updated_at || '2026-03-25T00:00:00.000Z',
  is_unread: overrides.is_unread ?? false,
});

describe('conversationArchiveState', () => {
  it('normalizes stored conversation ids', () => {
    expect(normalizeConversationIdList([' alpha ', '', 'beta', 'alpha', 12, null])).toEqual([
      'alpha',
      'beta',
    ]);
    expect(normalizeConversationIdList('invalid')).toEqual([]);
  });

  it('filters to chat-only conversations sorted by most recent update', () => {
    const conversations = getChatOnlyConversations([
      createConversation({
        id: 'chat-old',
        updated_at: '2026-03-20T00:00:00.000Z',
      }),
      createConversation({
        id: 'architect',
        scope_mode: 'Architect',
        group_id: 'group-1',
        project_id: 'project-1',
      }),
      createConversation({
        id: 'implement',
        scope_mode: 'Implement',
        task_id: 'task-1',
      }),
      createConversation({
        id: 'chat-new',
        updated_at: '2026-03-22T00:00:00.000Z',
      }),
    ]);

    expect(conversations.map((conversation) => conversation.id)).toEqual(['chat-new', 'chat-old']);
  });

  it('builds archive and active views from archived ids', () => {
    const conversations = [
      createConversation({ id: 'active-1' }),
      createConversation({ id: 'archived-1' }),
      createConversation({ id: 'active-2' }),
    ];
    const archivedIds = new Set(['archived-1']);

    expect(
      getArchiveViewConversations(conversations, archivedIds, false).map((conversation) => conversation.id)
    ).toEqual(['active-1', 'active-2']);
    expect(
      getArchiveViewConversations(conversations, archivedIds, true).map((conversation) => conversation.id)
    ).toEqual(['archived-1']);
  });

  it('filters conversations by query and keeps pinned partitioning', () => {
    const conversations = [
      createConversation({ id: '1', title: 'Release planning' }),
      createConversation({ id: '2', title: 'Bug triage' }),
      createConversation({ id: '3', title: 'Customer notes' }),
    ];

    const filtered = filterConversationsByQuery(conversations, 'bug');
    const partition = partitionPinnedConversations(filtered, new Set(['2']));

    expect(filtered.map((conversation) => conversation.id)).toEqual(['2']);
    expect(partition.pinnedConversations.map((conversation) => conversation.id)).toEqual(['2']);
    expect(partition.regularConversations).toHaveLength(0);
  });

  it('toggles single and bulk selection safely', () => {
    const singleToggle = toggleConversationIdInSet(new Set(['a']), 'b');
    expect(Array.from(singleToggle)).toEqual(['a', 'b']);

    const allSelected = toggleAllConversationIds(new Set(['a']), ['a', 'b']);
    expect(Array.from(allSelected).sort()).toEqual(['a', 'b']);

    const cleared = toggleAllConversationIds(new Set(['a', 'b', 'c']), ['a', 'b']);
    expect(Array.from(cleared).sort()).toEqual(['c']);
  });

  it('prunes orphaned ids and can compare set equality', () => {
    const current = new Set(['a', 'b', 'c']);
    const next = pruneConversationIdSet(current, ['b', 'c', 'd']);

    expect(Array.from(next).sort()).toEqual(['b', 'c']);
    expect(areConversationIdSetsEqual(new Set(['b', 'c']), next)).toBe(true);
    expect(areConversationIdSetsEqual(new Set(['a']), next)).toBe(false);
  });
});
