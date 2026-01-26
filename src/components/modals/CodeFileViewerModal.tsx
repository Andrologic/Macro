import React from 'react';
import { useCodeFileStore } from '../../stores/useCodeFileStore';
import { CodeViewer } from '../ui/CodeViewer';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';

export const CodeFileViewerModal: React.FC = () => {
  const { isOpen, filePath, content, language, closeFileViewer } = useCodeFileStore();

  if (!isOpen || !content) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[92vw] max-w-5xl h-[80vh] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="h-12 px-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="file-code" size={16} className="text-indigo-400" />
            <span className="text-sm font-medium text-zinc-100 truncate max-w-md">
              {filePath}
            </span>
          </div>
          <button
            onClick={closeFileViewer}
            className="p-1.5 rounded-lg hover:bg-zinc-900 transition-colors"
          >
            <Icon name="x" size={14} className="text-zinc-500" />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-4 bg-[#282c34]">
          <CodeViewer 
            code={content} 
            language={language as any || 'typescript'} 
            className="h-full border-none"
          />
        </div>

        <footer className="h-12 border-t border-zinc-800 px-4 flex items-center justify-end gap-2 shrink-0">
          <Button variant="ghost" size="sm" onClick={closeFileViewer}>
            Fermer
          </Button>
          <Button variant="primary" size="sm">
            Copier le code
          </Button>
        </footer>
      </div>
    </div>
  );
};
