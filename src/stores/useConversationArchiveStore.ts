import { create } from 'zustand';
import { loadPreference, PREF_KEYS } from '../services/preferences';

let archiveMutationVersion = 0;
let archiveHydrationPromise: Promise<void> | null = null;

interface ConversationArchiveState {
  archivedConversationIds: ReadonlySet<string>;
  isArchiveHydrated: boolean;
  archiveHydrationError: unknown | null;
  hydrateArchivedConversationIds: () => Promise<void>;
  replaceArchivedConversationIds: (ids: Iterable<string>) => void;
}

export const useConversationArchiveStore = create<ConversationArchiveState>((set) => ({
  archivedConversationIds: new Set<string>(),
  isArchiveHydrated: false,
  archiveHydrationError: null,
  hydrateArchivedConversationIds: async () => {
    if (archiveHydrationPromise) {
      return archiveHydrationPromise;
    }
    const hydrationVersion = archiveMutationVersion;
    set({ archiveHydrationError: null });
    archiveHydrationPromise = loadPreference<string[]>(
      PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS
    )
      .then((ids) => {
        if (archiveMutationVersion === hydrationVersion) {
          set({
            archivedConversationIds: new Set(ids),
            isArchiveHydrated: true,
            archiveHydrationError: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (archiveMutationVersion === hydrationVersion) {
          set({ archiveHydrationError: error, isArchiveHydrated: false });
        }
      })
      .finally(() => {
        archiveHydrationPromise = null;
      });
    return archiveHydrationPromise;
  },
  replaceArchivedConversationIds: (ids) => {
    archiveMutationVersion += 1;
    set({
      archivedConversationIds: new Set(ids),
      isArchiveHydrated: true,
      archiveHydrationError: null,
    });
  },
}));
