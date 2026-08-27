import { create } from 'zustand';
import { loadPreference, PREF_KEYS } from '../services/preferences';

let archiveMutationVersion = 0;
let archiveHydrationPromise: Promise<void> | null = null;

interface ConversationArchiveState {
  archivedConversationIds: ReadonlySet<string>;
  hydrateArchivedConversationIds: () => Promise<void>;
  replaceArchivedConversationIds: (ids: Iterable<string>) => void;
}

export const useConversationArchiveStore = create<ConversationArchiveState>((set) => ({
  archivedConversationIds: new Set<string>(),
  hydrateArchivedConversationIds: async () => {
    if (archiveHydrationPromise) {
      return archiveHydrationPromise;
    }
    const hydrationVersion = archiveMutationVersion;
    archiveHydrationPromise = loadPreference<string[]>(
      PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS
    )
      .then((ids) => {
        if (archiveMutationVersion === hydrationVersion) {
          set({ archivedConversationIds: new Set(ids) });
        }
      })
      .finally(() => {
        archiveHydrationPromise = null;
      });
    return archiveHydrationPromise;
  },
  replaceArchivedConversationIds: (ids) => {
    archiveMutationVersion += 1;
    set({ archivedConversationIds: new Set(ids) });
  },
}));
