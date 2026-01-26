import { create } from 'zustand';

interface CodeFileStore {
  isOpen: boolean;
  filePath: string | null;
  content: string | null;
  language: string | null;
  openFileViewer: (path: string, content: string, language?: string) => void;
  closeFileViewer: () => void;
}

export const useCodeFileStore = create<CodeFileStore>((set) => ({
  isOpen: false,
  filePath: null,
  content: null,
  language: null,

  openFileViewer: (path, content, language = 'typescript') =>
    set({
      isOpen: true,
      filePath: path,
      content,
      language: language || 'typescript',
    }),

  closeFileViewer: () =>
    set({
      isOpen: false,
      filePath: null,
      content: null,
      language: null,
    }),
}));
