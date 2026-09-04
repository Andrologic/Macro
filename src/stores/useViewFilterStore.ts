import { create } from 'zustand';
import {
  loadPersistedPreference,
  type PrefKey,
  PREF_KEYS,
  savePreference,
} from '../services/preferences';
import {
  DEFAULT_ARCHITECT_VIEW_FILTERS,
  DEFAULT_CHAT_VIEW_FILTERS,
  DEFAULT_IMPLEMENT_VIEW_FILTERS,
  normalizeArchivedViewFilter,
  normalizeImplementViewFilters,
  type ArchivedViewFilter,
  type ImplementViewFilters,
  type TaskQueueStatusFilter,
} from '../services/viewFilterPreferences';

const jsonEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

type FilterField =
  | 'implementProjectId'
  | 'implementStatus'
  | 'implementShowArchived'
  | 'architectShowArchived'
  | 'chatShowArchived';

const mutationVersions: Record<FilterField, number> = {
  implementProjectId: 0,
  implementStatus: 0,
  implementShowArchived: 0,
  architectShowArchived: 0,
  chatShowArchived: 0,
};
let hydrationPromise: Promise<void> | null = null;
const persistenceQueues = new Map<PrefKey, Promise<void>>();

interface ViewFilterStore {
  implement: ImplementViewFilters;
  architect: ArchivedViewFilter;
  chat: ArchivedViewFilter;
  isHydrated: boolean;
  hydrate: () => Promise<void>;
  setImplementProjectFilter: (projectId: string) => void;
  setImplementStatusFilter: (status: TaskQueueStatusFilter) => void;
  setImplementShowArchived: (showArchived: boolean) => void;
  resetImplementFilters: () => void;
  setArchitectShowArchived: (showArchived: boolean) => void;
  resetArchitectFilters: () => void;
  setChatShowArchived: (showArchived: boolean) => void;
  resetChatFilters: () => void;
}

const persist = <T,>(key: PrefKey, value: T): void => {
  const previous = persistenceQueues.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => savePreference(key, value));
  persistenceQueues.set(key, operation);
  void operation
    .finally(() => {
      if (persistenceQueues.get(key) === operation) {
        persistenceQueues.delete(key);
      }
    })
    .catch(() => undefined);
};

export const waitForViewFilterPersistence = async (): Promise<void> => {
  for (;;) {
    const pendingHydration = hydrationPromise;
    if (pendingHydration) {
      await pendingHydration.catch(() => undefined);
    }
    await Promise.resolve();
    const operations = Array.from(
      persistenceQueues.values(),
      (operation) => operation.catch(() => undefined),
    );
    if (!hydrationPromise && operations.length === 0) return;
    await Promise.all(operations);
  }
};

export const useViewFilterStore = create<ViewFilterStore>((set, get) => {
  const updateImplement = (
    changedFields: FilterField[],
    update: (current: ImplementViewFilters) => ImplementViewFilters,
  ) => {
    const pendingHydration = get().isHydrated ? null : get().hydrate();
    changedFields.forEach((field) => {
      mutationVersions[field] += 1;
    });
    set((state) => ({ implement: update(state.implement) }));
    if (pendingHydration) {
      void pendingHydration.then(() => {
        persist(PREF_KEYS.IMPLEMENT_VIEW_FILTERS, get().implement);
      });
      return;
    }
    persist(PREF_KEYS.IMPLEMENT_VIEW_FILTERS, get().implement);
  };

  const updateArchitect = (next: ArchivedViewFilter) => {
    const pendingHydration = get().isHydrated ? null : get().hydrate();
    mutationVersions.architectShowArchived += 1;
    set({ architect: next });
    if (pendingHydration) {
      void pendingHydration.then(() => {
        persist(PREF_KEYS.ARCHITECT_VIEW_FILTERS, get().architect);
      });
      return;
    }
    persist(PREF_KEYS.ARCHITECT_VIEW_FILTERS, next);
  };

  const updateChat = (next: ArchivedViewFilter) => {
    const pendingHydration = get().isHydrated ? null : get().hydrate();
    mutationVersions.chatShowArchived += 1;
    set({ chat: next });
    if (pendingHydration) {
      void pendingHydration.then(() => {
        persist(PREF_KEYS.CHAT_VIEW_FILTERS, get().chat);
      });
      return;
    }
    persist(PREF_KEYS.CHAT_VIEW_FILTERS, next);
  };

  return {
    implement: { ...DEFAULT_IMPLEMENT_VIEW_FILTERS },
    architect: { ...DEFAULT_ARCHITECT_VIEW_FILTERS },
    chat: { ...DEFAULT_CHAT_VIEW_FILTERS },
    isHydrated: false,
    hydrate: async () => {
      if (get().isHydrated) return;
      if (hydrationPromise) return hydrationPromise;

      const versions = { ...mutationVersions };
      hydrationPromise = Promise.all([
        loadPersistedPreference(PREF_KEYS.IMPLEMENT_VIEW_FILTERS),
        loadPersistedPreference(PREF_KEYS.ARCHITECT_VIEW_FILTERS),
        loadPersistedPreference(PREF_KEYS.CHAT_VIEW_FILTERS),
      ])
        .then(([persistedImplement, persistedArchitect, persistedChat]) => {
          const implement = normalizeImplementViewFilters(persistedImplement);
          const architect = normalizeArchivedViewFilter(
            persistedArchitect,
            DEFAULT_ARCHITECT_VIEW_FILTERS,
          );
          const chat = normalizeArchivedViewFilter(
            persistedChat,
            DEFAULT_CHAT_VIEW_FILTERS,
          );

          set((state) => ({
            implement: {
              version: 1,
              projectId:
                mutationVersions.implementProjectId === versions.implementProjectId
                  ? implement.projectId
                  : state.implement.projectId,
              status:
                mutationVersions.implementStatus === versions.implementStatus
                  ? implement.status
                  : state.implement.status,
              showArchived:
                mutationVersions.implementShowArchived === versions.implementShowArchived
                  ? implement.showArchived
                  : state.implement.showArchived,
            },
            architect: mutationVersions.architectShowArchived === versions.architectShowArchived
              ? architect
              : state.architect,
            chat: mutationVersions.chatShowArchived === versions.chatShowArchived
              ? chat
              : state.chat,
            isHydrated: true,
          }));

          if (
            persistedImplement !== undefined &&
            mutationVersions.implementProjectId === versions.implementProjectId &&
            mutationVersions.implementStatus === versions.implementStatus &&
            mutationVersions.implementShowArchived === versions.implementShowArchived &&
            !jsonEqual(persistedImplement, implement)
          ) {
            persist(PREF_KEYS.IMPLEMENT_VIEW_FILTERS, implement);
          }
          if (
            persistedArchitect !== undefined &&
            mutationVersions.architectShowArchived === versions.architectShowArchived &&
            !jsonEqual(persistedArchitect, architect)
          ) {
            persist(PREF_KEYS.ARCHITECT_VIEW_FILTERS, architect);
          }
          if (
            persistedChat !== undefined &&
            mutationVersions.chatShowArchived === versions.chatShowArchived &&
            !jsonEqual(persistedChat, chat)
          ) {
            persist(PREF_KEYS.CHAT_VIEW_FILTERS, chat);
          }
        })
        .finally(() => {
          hydrationPromise = null;
        });

      return hydrationPromise;
    },
    setImplementProjectFilter: (projectId) => {
      updateImplement(['implementProjectId'], (current) =>
        normalizeImplementViewFilters({ ...current, projectId }));
    },
    setImplementStatusFilter: (status) => {
      updateImplement(['implementStatus'], (current) =>
        normalizeImplementViewFilters({ ...current, status }));
    },
    setImplementShowArchived: (showArchived) => {
      updateImplement(
        ['implementShowArchived'],
        (current) => ({ ...current, showArchived }),
      );
    },
    resetImplementFilters: () => updateImplement(
      ['implementProjectId', 'implementStatus', 'implementShowArchived'],
      () => ({ ...DEFAULT_IMPLEMENT_VIEW_FILTERS }),
    ),
    setArchitectShowArchived: (showArchived) => {
      updateArchitect({ version: 1, showArchived });
    },
    resetArchitectFilters: () => updateArchitect({ ...DEFAULT_ARCHITECT_VIEW_FILTERS }),
    setChatShowArchived: (showArchived) => {
      updateChat({ version: 1, showArchived });
    },
    resetChatFilters: () => updateChat({ ...DEFAULT_CHAT_VIEW_FILTERS }),
  };
});
