import { create } from 'zustand';
import { CodeDiff } from '../types';

interface EditorStore {
  isOpen: boolean;
  codeDiff: CodeDiff | null;
  openDiffViewer: (diff: CodeDiff) => void;
  closeDiffViewer: () => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
  isOpen: false,
  codeDiff: null,

  openDiffViewer: (diff) =>
    set({
      isOpen: true,
      codeDiff: diff,
    }),

  closeDiffViewer: () =>
    set({
      isOpen: false,
      codeDiff: null,
    }),
}));
