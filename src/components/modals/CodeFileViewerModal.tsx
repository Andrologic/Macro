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
      <div className="w-[92vw] max-w-5xl h-[80vh] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="h-12 px-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="file-code" size={16} className="text-primary" />
            <span className="text-sm font-medium text-foreground truncate max-w-md">
              {filePath}
            </span>
          </div>
          <button
            onClick={closeFileViewer}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-4 bg-card">
          <CodeViewer 
            code={content} 
            language={language as any || 'typescript'} 
            className="h-full border-none"
          />
        </div>

        <footer className="h-12 border-t border-border px-4 flex items-center justify-end gap-2 shrink-0">
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
