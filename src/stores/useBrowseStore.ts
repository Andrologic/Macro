import { create } from 'zustand';

interface BrowseStoreState {
  changesPanelOpen: boolean;
  setChangesPanelOpen: (open: boolean) => void;
}

export const useBrowseStore = create<BrowseStoreState>((set) => ({
  changesPanelOpen: false,
  setChangesPanelOpen: (open) => set({ changesPanelOpen: open }),
}));
