import { create } from 'zustand';

interface ConversationArchiveState {
  archivedConversationIds: ReadonlySet<string>;
  replaceArchivedConversationIds: (ids: Iterable<string>) => void;
}

export const useConversationArchiveStore = create<ConversationArchiveState>((set) => ({
  archivedConversationIds: new Set<string>(),
  replaceArchivedConversationIds: (ids) => {
    set({ archivedConversationIds: new Set(ids) });
  },
}));
