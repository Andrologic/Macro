import { createLifecycleScope } from '../services/lifecycleScope';
import { beforeEach, describe, expect, it } from 'bun:test';
import { PREF_KEYS, savePreference } from '../services/preferences';
import { useConversationArchiveStore } from './useConversationArchiveStore';

describe('useConversationArchiveStore', () => {
  beforeEach(() => {
    useConversationArchiveStore
      .getState()
      .replaceArchivedConversationIds([]);
  });

  it('hydrates persisted archive ids without mounting the archive panel', async () => {
    await savePreference(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS, [
      'conversation-archived',
    ]);

    await useConversationArchiveStore
      .getState()
      .hydrateArchivedConversationIds();

    expect(
      useConversationArchiveStore
        .getState()
        .archivedConversationIds.has('conversation-archived')
    ).toBe(true);
    expect(useConversationArchiveStore.getState().isArchiveHydrated).toBe(true);
  });
  it('does not publish an archive read after its application retires', async () => {
    await savePreference(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS, ['retired']);
    const owner = createLifecycleScope();
    const pending = useConversationArchiveStore.getState().hydrateArchivedConversationIds(owner);
    owner.stop();
    await pending;
    expect(useConversationArchiveStore.getState().archivedConversationIds.has('retired')).toBe(false);
  });

});
