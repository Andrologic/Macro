import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { DiffViewer } from './DiffViewer';
import { mockAuthPlan } from '../../mock-data/auth-scenario';

interface LiveCodePreviewProps {
  className?: string;
}

interface FileTab {
  id: string;
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

const mockModifiedFiles: FileTab[] = [
  { id: 'file-1', path: 'src/components/auth/LoginPage.tsx', status: 'added' },
  { id: 'file-2', path: 'src/hooks/useAuth.ts', status: 'added' },
  { id: 'file-3', path: 'src/services/authService.ts', status: 'modified' },
  { id: 'file-4', path: 'src/types/auth.ts', status: 'added' },
];

const statusColors = {
  added: 'text-emerald-500',
  modified: 'text-amber-500',
  deleted: 'text-red-400',
};

const statusIcons: Record<string, IconName> = {
  added: 'plus',
  modified: 'edit',
  deleted: 'minus',
};

export const LiveCodePreview: React.FC<LiveCodePreviewProps> = ({ className }) => {
  const { t } = useTranslation();
  const { selectedGroupId, selectedTaskId } = useAppStore();
  const [selectedFileId, setSelectedFileId] = useState<string | null>(mockModifiedFiles[0]?.id || null);
  const [viewMode, setViewMode] = useState<'diff' | 'preview'>('diff');

  // Get current task
  const currentTask = mockAuthPlan.tasks.find(t => t.id === selectedTaskId);

  // Get code diff for selected file
  const selectedFile = mockModifiedFiles.find(f => f.id === selectedFileId);
  const codeDiff = currentTask?.code_diff;

  if (!selectedGroupId) {
    return (
      <aside
        className={cn("h-full w-full bg-card border-l border-border flex items-center justify-center", className)}
      >
        <div className="text-center px-6">
          <Icon name="code" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">
            {t('implement.selectProject', 'Select a project to view code changes')}
          </p>
        </div>
      </aside>
    );
  }

  if (!selectedTaskId) {
    return (
      <aside
        className={cn("h-full w-full bg-card border-l border-border flex items-center justify-center", className)}
      >
        <div className="text-center px-6">
          <Icon name="file-code" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">
            {t('implement.selectTask', 'Select a task to view code changes')}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="code" size={16} className="text-primary" />
          {t('implement.codePreview', 'Code Preview')}
        </h1>
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">
            {mockModifiedFiles.length} fichier{mockModifiedFiles.length > 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* View Toggle */}
      <div className="h-10 border-b border-border flex items-center px-4 gap-2">
        <button
          onClick={() => setViewMode('diff')}
          className={cn(
            'flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200',
            viewMode === 'diff'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon name="git-compare" size={12} className="inline mr-1.5" />
          Diff
        </button>
        <button
          onClick={() => setViewMode('preview')}
          className={cn(
            'flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200',
            viewMode === 'preview'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon name="eye" size={12} className="inline mr-1.5" />
          Preview
        </button>
      </div>

      {/* File Tabs */}
      <div className="border-b border-border overflow-x-auto">
        <div className="flex px-2 py-1.5 gap-1">
          {mockModifiedFiles.map((file) => {
            const fileName = file.path.split('/').pop() || file.path;
            const isSelected = selectedFileId === file.id;

            return (
              <button
                key={file.id}
                onClick={() => setSelectedFileId(file.id)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors',
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )}
              >
                <Icon
                  name={statusIcons[file.status]}
                  size={10}
                  className={statusColors[file.status]}
                />
                <span>{fileName}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* File Path */}
      {selectedFile && (
        <div className="px-4 py-2 border-b border-border bg-muted/30">
          <p className="text-xs text-muted-foreground font-mono truncate">
            {selectedFile.path}
          </p>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {codeDiff ? (
          <DiffViewer diff={codeDiff} />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center px-6">
              <Icon name="file-code" size={32} className="text-muted-foreground/50 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {t('implement.noDiff', 'No code changes for this task yet')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="h-14 border-t border-border flex items-center justify-between px-4 bg-card gap-2">
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
          <Icon name="rotate-ccw" size={12} />
          Revert
        </button>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-foreground hover:bg-accent transition-colors border border-border">
            <Icon name="plus-square" size={12} />
            Stage
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
            <Icon name="git-commit" size={12} />
            Commit
          </button>
        </div>
      </div>
    </aside>
  );
};
