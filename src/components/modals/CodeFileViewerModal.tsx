import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCodeFileStore } from '../../stores/useCodeFileStore';
import { CodeViewer } from '../ui/CodeViewer';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export const CodeFileViewerModal: React.FC = () => {
  const { t } = useTranslation();
  const { isOpen, filePath, content, language, closeFileViewer } = useCodeFileStore();
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    if (isOpen) {
      setCopyStatus('idle');
    }
  }, [filePath, isOpen]);

  if (!isOpen || content === null) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  return (
    <Dialog title={filePath || t('codeViewer.title', 'Code file')} onClose={closeFileViewer}>
      <div className="flex h-[min(80vh,calc(100vh-2rem))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="h-12 px-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="file-code" size={16} className="text-primary" />
            <span className="text-sm font-medium text-foreground truncate max-w-md">
              {filePath}
            </span>
          </div>
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
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
            {t('common.close', 'Close')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void handleCopy()}>
            {copyStatus === 'copied'
              ? t('codeViewer.copied', 'Copied')
              : t('codeViewer.copyCode', 'Copy code')}
          </Button>
          {copyStatus === 'error' && (
            <span className="text-sm text-destructive" role="alert">
              {t('codeViewer.copyFailed', 'Unable to copy the code.')}
            </span>
          )}
        </footer>
      </div>
    </Dialog>
  );
};

// Export both named and default for lazy loading compatibility
export default CodeFileViewerModal;
