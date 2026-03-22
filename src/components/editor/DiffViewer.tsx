import React from 'react';
import { useTranslation } from 'react-i18next';
import { CodeViewer } from '../ui/CodeViewer';
import type { CodeDiff } from '../../types';
import { Icon } from '../ui/Icon';

interface DiffViewerProps {
  diff: CodeDiff;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diff }) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Icon name="file-code" size={14} className="text-primary" />
          <span className="font-mono text-xs text-muted-foreground">{diff.file_path}</span>
        </div>
        <span className="text-xs text-muted-foreground">{diff.language}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-muted-foreground mb-2">{t('diffViewer.before', 'Before')}</div>
          <CodeViewer code={diff.old_content || t('diffViewer.empty', '// empty')} language={diff.language as any} />
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-2">{t('diffViewer.after', 'After')}</div>
          <CodeViewer code={diff.new_content || t('diffViewer.empty', '// empty')} language={diff.language as any} />
        </div>
      </div>
    </div>
  );
};
