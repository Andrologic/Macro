import type { Conversation } from '../../types';
import { matchesLocalSearchQuery } from '../../services/localModeSearch';

export const normalizeConversationIdList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedIds = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return Array.from(new Set(normalizedIds));
};

export const canApplyArchivedConversationHydration = (
  hydrationVersion: number,
  currentVersion: number
): boolean => hydrationVersion === currentVersion;

export const resolveArchivedConversationHydration = async (
  load: () => Promise<unknown>
): Promise<{ ok: true; ids: string[] } | { ok: false; error: unknown }> => {
  try {
    return { ok: true, ids: normalizeConversationIdList(await load()) };
  } catch (error) {
    return { ok: false, error };
  }
};

export const commitArchivedConversationMutation = async ({
  write,
  onCommitted,
  onFailure,
}: {
  write: () => Promise<void>;
  onCommitted: () => Promise<void> | void;
  onFailure: (error: unknown) => Promise<void> | void;
}): Promise<boolean> => {
  try {
    await write();
    await onCommitted();
    return true;
  } catch (error) {
    await onFailure(error);
    return false;
  }
};

export const areConversationIdSetsEqual = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const id of left) {
    if (!right.has(id)) {
      return false;
    }
  }

  return true;
};

export const getChatOnlyConversations = (conversations: Conversation[]): Conversation[] =>
  [...conversations]
    .filter((conversation) => conversation.scope_mode === 'Chat')
    .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime());

export const getArchiveViewConversations = (
  conversations: Conversation[],
  archivedIds: ReadonlySet<string>,
  showArchived: boolean
): Conversation[] =>
  conversations.filter((conversation) =>
    showArchived ? archivedIds.has(conversation.id) : !archivedIds.has(conversation.id)
  );

export const filterConversationsByQuery = (
  conversations: Conversation[],
  searchQuery: string
): Conversation[] => {
  return conversations.filter((conversation) =>
    matchesLocalSearchQuery(searchQuery, [
      conversation.title,
      conversation.description,
    ])
  );
};

export const partitionPinnedConversations = (
  conversations: Conversation[],
  pinnedIds: ReadonlySet<string>
): {
  pinnedConversations: Conversation[];
  regularConversations: Conversation[];
} => ({
  pinnedConversations: conversations.filter((conversation) => pinnedIds.has(conversation.id)),
  regularConversations: conversations.filter((conversation) => !pinnedIds.has(conversation.id)),
});

export const toggleConversationIdInSet = (
  current: ReadonlySet<string>,
  conversationId: string
): Set<string> => {
  const next = new Set(current);
  if (next.has(conversationId)) {
    next.delete(conversationId);
  } else {
    next.add(conversationId);
  }
  return next;
};

export const toggleAllConversationIds = (
  current: ReadonlySet<string>,
  visibleConversationIds: string[]
): Set<string> => {
  const next = new Set(current);
  if (visibleConversationIds.length === 0) {
    return next;
  }

  const allVisibleSelected = visibleConversationIds.every((conversationId) =>
    next.has(conversationId)
  );

  visibleConversationIds.forEach((conversationId) => {
    if (allVisibleSelected) {
      next.delete(conversationId);
      return;
    }
    next.add(conversationId);
  });

  return next;
};

export const pruneConversationIdSet = (
  current: ReadonlySet<string>,
  validConversationIds: Iterable<string>
): Set<string> => {
  const validIds = new Set(validConversationIds);
  return new Set([...current].filter((conversationId) => validIds.has(conversationId)));
};
