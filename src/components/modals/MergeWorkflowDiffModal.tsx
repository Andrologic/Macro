import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MergeWorkflowRepositoryResult } from '../../services/mergeWorkflow';
import {
  parseUnifiedDiff,
  parseUnifiedDiffFiles,
  type ParsedUnifiedDiffFile,
  type ParsedUnifiedDiffFileStatus,
} from '../../services/gitDiffParser';
import { Button } from '../ui/Button';
import { DiffMergeView } from '../ui/DiffMergeView';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

interface MergeWorkflowDiffModalProps {
  repository: MergeWorkflowRepositoryResult;
  onClose: () => void;
}

const MAX_RENDERED_MERGE_DIFF_CHARS = 100_000;

const getRepositoryDisplayName = (repository: MergeWorkflowRepositoryResult): string => {
  const normalized = repository.repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || repository.repoPath;
};

const getRepositoryBranchLabel = (repository: MergeWorkflowRepositoryResult): string =>
  `${repository.sourceBranchName} -> ${repository.targetBranchName}`;

const getFileLabel = (path: string): string => path.split('/').filter(Boolean).pop() || path;

const getFileDir = (path: string): string => {
  const parts = path.split('/');
  return parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
};

const statusMeta = (status: ParsedUnifiedDiffFileStatus) => {
  switch (status) {
    case 'added':
      return {
        label: '+',
        className: 'bg-emerald-500/10 text-emerald-500',
      };
    case 'deleted':
      return {
        label: '-',
        className: 'bg-destructive/10 text-destructive',
      };
    case 'renamed':
      return {
        label: 'R',
        className: 'bg-primary/10 text-primary',
      };
    case 'modified':
    default:
      return {
        label: 'M',
        className: 'bg-amber-500/10 text-amber-500',
      };
  }
};

const fileKey = (file: ParsedUnifiedDiffFile, index: number): string =>
  `${file.oldPath ?? ''}->${file.path}:${index}`;

const inferLanguageFromPath = (path: string): string => {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'rs':
      return 'rust';
    default:
      return 'text';
  }
};

export const MergeWorkflowDiffModal: React.FC<MergeWorkflowDiffModalProps> = ({
  repository,
  onClose,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const diffTooLarge = repository.diff.length > MAX_RENDERED_MERGE_DIFF_CHARS;
  const files = useMemo(
    () => (diffTooLarge ? [] : parseUnifiedDiffFiles(repository.diff)),
    [diffTooLarge, repository.diff]
  );
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [presentationMode, setPresentationMode] = useState<'focused' | 'full'>('focused');

  useEffect(() => {
    if (files.length === 0) {
      setSelectedFileKey(null);
      return;
    }

    const hasSelectedFile = files.some((file, index) => fileKey(file, index) === selectedFileKey);
    if (!hasSelectedFile) {
      setSelectedFileKey(fileKey(files[0]!, 0));
    }
  }, [files, selectedFileKey]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const selectedFile = files.find((file, index) => fileKey(file, index) === selectedFileKey) ?? files[0] ?? null;
  const selectedParsedDiff = selectedFile ? parseUnifiedDiff(selectedFile.patch) : null;
  const diffLayout: 'split' | 'left-only' | 'right-only' = selectedFile?.status === 'added'
    ? 'right-only'
    : selectedFile?.status === 'deleted'
      ? 'left-only'
      : 'split';
  const showPresentationControls = diffLayout === 'split' && Boolean(selectedParsedDiff?.hunks.length);
  const effectivePresentationMode = showPresentationControls ? presentationMode : 'full';
  const hasRenderableTextDiff = Boolean(
    selectedParsedDiff &&
    (
      selectedParsedDiff.hunks.length > 0 ||
      selectedParsedDiff.additions > 0 ||
      selectedParsedDiff.deletions > 0
    )
  );
  const contextOptions: Array<{ mode: 'focused' | 'full'; label: string }> = [
    { mode: 'focused', label: t('implement.context.default', 'Focused diff') },
    { mode: 'full', label: t('implement.context.full', 'Full file context') },
  ];

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-background/50 p-4 pt-12 backdrop-blur-sm sm:p-6 sm:pt-14"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-merge-workflow-diff-modal="true"
      data-repository-id={repository.id}
    >
      <div className="relative z-0 flex h-[calc(100vh-4rem)] w-[calc(100vw-2rem)] max-h-[min(940px,calc(100vh-4rem))] max-w-[1800px] overflow-hidden rounded-xl bg-background shadow-2xl ring-1 ring-border/10 sm:h-[calc(100vh-5rem)] sm:w-[calc(100vw-3rem)]">
        <aside className="flex w-[200px] shrink-0 flex-col bg-muted/10">
          <div className="p-4">
            <h3 id={titleId} className="truncate text-sm font-semibold tracking-tight" title={repository.repoPath}>
              {getRepositoryDisplayName(repository)}
            </h3>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={getRepositoryBranchLabel(repository)}>
              {getRepositoryBranchLabel(repository)}
            </p>
            {!diffTooLarge && (
              <p className="mt-3 text-xs text-muted-foreground">
                {t('implement.mergeWorkflowDiffFileCount', '{{count}} changed file(s)', {
                  count: files.length,
                })}
              </p>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" data-merge-diff-file-list="true">
            {diffTooLarge ? (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                {t(
                  'implement.mergeWorkflowDiffTooLargeSidebar',
                  'This diff is too large for file navigation.'
                )}
              </div>
            ) : files.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-muted-foreground">
                {t('implement.mergeWorkflowNoTextualDiffFiles', 'No textual file diff found.')}
              </div>
            ) : (
              <>
                {files.map((file, index) => {
                  const key = fileKey(file, index);
                  const isCurrent = key === (selectedFileKey ?? fileKey(files[0]!, 0));
                  const meta = statusMeta(file.status);

                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedFileKey(key)}
                      className={cn(
                        'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                        isCurrent
                          ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      )}
                      title={file.path}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold',
                          meta.className
                        )}
                      >
                        {meta.label}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{getFileLabel(file.path)}</span>
                        <span className="block truncate text-[11px] opacity-70">{getFileDir(file.path) || '/'}</span>
                      </span>

                      <span className="mt-1 shrink-0 text-[11px] text-muted-foreground">
                        <span className="text-emerald-500">+{file.additions}</span>
                        <span className="px-1">/</span>
                        <span className="text-destructive">-{file.deletions}</span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex shrink-0 items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3 pr-4">
              <div className="min-w-0">
                {selectedFile ? (
                  <>
                    <h2 className="truncate text-sm font-medium leading-tight" title={selectedFile.path}>
                      <span className="text-muted-foreground">{getFileDir(selectedFile.path) || '/'}</span>
                      <span className="text-foreground">{getFileLabel(selectedFile.path)}</span>
                    </h2>
                    {selectedFile.status === 'renamed' && selectedFile.oldPath && selectedFile.oldPath !== selectedFile.path && (
                      <p className="mt-1 truncate text-xs text-muted-foreground" title={selectedFile.oldPath}>
                        {t('implement.mergeWorkflowDiffRenamedFrom', 'Renamed from {{path}}', {
                          path: selectedFile.oldPath,
                        })}
                      </p>
                    )}
                  </>
                ) : (
                  <h2 className="text-sm font-medium text-foreground">
                    {t('implement.mergeWorkflowDiffTitle', 'Repository diff')}
                  </h2>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-4">
              {showPresentationControls && (
                <div className="flex items-center rounded-lg border border-border bg-muted/20 p-1">
                  {contextOptions.map((option) => (
                    <Button
                      key={option.mode}
                      variant={presentationMode === option.mode ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => setPresentationMode(option.mode)}
                      className={cn(
                        'h-7 px-2.5 text-xs',
                        presentationMode === option.mode ? 'shadow-sm' : ''
                      )}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label={t('common.close', 'Close')}>
                <Icon name="x" size={16} />
              </Button>
            </div>
          </header>

          <div
            className="relative min-h-0 flex-1 bg-muted/5"
            data-merge-diff-viewer="true"
            data-selected-file-path={selectedFile?.path ?? ''}
          >
            {diffTooLarge ? (
              <div className="h-full p-4">
                <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/30">
                  <div className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
                    {t(
                      'implement.mergeWorkflowDiffTooLarge',
                      'Diff too large to render fully. Showing a preview.'
                    )}
                  </div>
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 text-xs text-foreground">
                    {repository.diff.slice(0, MAX_RENDERED_MERGE_DIFF_CHARS)}
                  </pre>
                </div>
              </div>
            ) : selectedFile && selectedParsedDiff && hasRenderableTextDiff ? (
              <DiffMergeView
                key={fileKey(selectedFile, files.indexOf(selectedFile))}
                original={selectedParsedDiff.originalContent}
                modified={selectedParsedDiff.modifiedContent}
                language={inferLanguageFromPath(selectedFile.path)}
                layout={diffLayout}
                presentationMode={effectivePresentationMode}
                className="h-full w-full border-none md:border-none"
                editable={false}
                autoFocus={false}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {t(
                  'implement.mergeWorkflowNoTextualDiff',
                  'No textual diff is available for this repository.'
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
