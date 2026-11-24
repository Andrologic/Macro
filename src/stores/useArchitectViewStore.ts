import { create } from "zustand";

export type ArchitectView = "flow" | "agents" | "skills" | "tools" | "launch" | "files";

const FILES_KEY = "macro_architect_show_files_v1";
const readFilesPreference = () => {
  try { return localStorage.getItem(FILES_KEY) === "1"; } catch { return false; }
};

interface ArchitectViewState {
  /** The view being shown, per opened draft or version. Kept for the session only. */
  views: Record<string, ArchitectView>;
  /** The Files view is opt-in. The choice follows the person, not the blueprint. */
  filesVisible: boolean;
  setView: (key: string, view: ArchitectView) => void;
  setFilesVisible: (visible: boolean) => void;
}

export const useArchitectViewStore = create<ArchitectViewState>(set => ({
  views: {},
  filesVisible: readFilesPreference(),
  setView: (key, view) => set(state => ({ views: { ...state.views, [key]: view } })),
  setFilesVisible: visible => {
    try { localStorage.setItem(FILES_KEY, visible ? "1" : "0"); } catch { /* A comfort setting: it still applies for this session. */ }
    set(state => ({
      filesVisible: visible,
      // Hiding the view while it is shown returns every blueprint to the flow.
      views: visible ? state.views : Object.fromEntries(Object.entries(state.views).map(([key, view]) => [key, view === "files" ? "flow" : view])),
    }));
  },
}));
