import React from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../stores/useEditorStore';
import { DiffViewer } from '../editor/DiffViewer';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export const DiffModal: React.FC = () => {
  const { t } = useTranslation();
  const { isOpen, codeDiff, closeDiffViewer } = useEditorStore();

  if (!isOpen || !codeDiff) return null;

  return (
    <Dialog title={t('git.reviewDiff', 'Review Diff')} onClose={closeDiffViewer}>
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="h-12 shrink-0 px-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="code" size={16} className="text-primary" />
            <span className="text-sm text-foreground">{t('git.reviewDiff', 'Review Diff')}</span>
          </div>
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            onClick={closeDiffViewer}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <DiffViewer diff={codeDiff} />
        </div>

        <footer className="h-12 shrink-0 border-t border-border px-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={closeDiffViewer}>
            {t('common.close', 'Close')}
          </Button>
        </footer>
      </div>
    </Dialog>
  );
};

// Export both named and default for lazy loading compatibility
export default DiffModal;
