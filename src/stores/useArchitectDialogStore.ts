import { create } from "zustand";
import type { VersionKey } from "../services/ipc/architectLibrary";

/**
 * Dialogs that the library tree and the blueprint panel both open.
 * One host renders them, so a menu action and a header button behave the same.
 */
export type ArchitectDialog =
  | { kind: "saveVersion"; blueprintId: string }
  | { kind: "adapt"; source: { kind: "version"; key: VersionKey } | { kind: "recoveryDraft"; blueprintId: string };
      name: string; projectId: string; repair: boolean }
  | { kind: "export"; target: { kind: "version"; key: VersionKey } | { kind: "draft"; blueprintId: string }; name: string;
      format?: "archive" | "project" }
  | { kind: "deleteVersion"; key: VersionKey }
  | { kind: "import"; path: string; projectId: string };

interface ArchitectDialogState {
  dialog: ArchitectDialog | null;
  open: (dialog: ArchitectDialog) => void;
  close: () => void;
}

export const useArchitectDialogStore = create<ArchitectDialogState>(set => ({
  dialog: null,
  open: dialog => set({ dialog }),
  close: () => set({ dialog: null }),
}));
