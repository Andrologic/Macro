import { create } from "zustand";
import type { VersionKey } from "../services/ipc/architectLibrary";
import { useAppStore } from "./useAppStore";

interface ArchitectLaunchState {
  window: { version?: VersionKey } | null;
  open: (version?: VersionKey) => void;
  close: () => void;
}

export const useArchitectLaunchStore = create<ArchitectLaunchState>(set => ({
  window: null,
  open: version => {
    set({ window: { version } });
    useAppStore.getState().setMode("Implement");
  },
  close: () => set({ window: null }),
}));
