import React from 'react';
import { useEditorStore } from '../../stores/useEditorStore';
import { DiffViewer } from '../editor/DiffViewer';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';

export const DiffModal: React.FC = () => {
  const { isOpen, codeDiff, closeDiffViewer } = useEditorStore();

  if (!isOpen || !codeDiff) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[92vw] max-w-5xl max-h-[90vh] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="h-12 px-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="code" size={16} className="text-primary" />
            <span className="text-sm text-foreground">Review Diff</span>
          </div>
          <button
            onClick={closeDiffViewer}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <DiffViewer diff={codeDiff} />
        </div>

        <footer className="h-12 border-t border-border px-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={closeDiffViewer}>
            Close
          </Button>
          <Button variant="success" size="sm">
            Accept changes
          </Button>
        </footer>
      </div>
    </div>
  );
};
