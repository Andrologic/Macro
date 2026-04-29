import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MergeWorkflowRepositoryResult } from '../../services/mergeWorkflow';
import {
  gitAcceptConflictSide,
  gitReadConflictFile,
  gitStatus,
  gitWriteConflictResolution,
  type GitConflictFileDto,
} from '../../services/tauriIpc';
import { toServiceError } from '../../services/contracts/errors';
import { useTaskStore } from '../../stores/useTaskStore';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { DiffMergeView } from '../ui/DiffMergeView';
import { Icon } from '../ui/Icon';
import { notify } from '../ui/toastService';

interface MergeWorkflowConflictResolverModalProps {
  taskId: string;
  repository: MergeWorkflowRepositoryResult;
  onClose: () => void;
}

type ConflictReferenceSide = 'ours' | 'theirs' | 'base';
const CONFLICT_OPERATION_TIMEOUT_MS = 15_000;

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

const sideContent = (file: GitConflictFileDto | null, side: ConflictReferenceSide): string => {
  if (!file) return '';
  if (side === 'ours') return file.ours.content;
  if (side === 'theirs') return file.theirs.content;
  return file.base.content;
};

const createInitialDraft = (file: GitConflictFileDto | null): string =>
  file?.worktree.content || file?.theirs.content || file?.ours.content || '';

const shouldPrepareManualMerge = (repository: MergeWorkflowRepositoryResult): boolean =>
  !(repository.mergeInProgress && repository.conflictFiles.length > 0);

const withTimeout = async <T,>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export const MergeWorkflowConflictResolverModal: React.FC<MergeWorkflowConflictResolverModalProps> = ({
  taskId,
  repository,
  onClose,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const startManualResolution = useTaskStore((state) => state.startMergeWorkflowManualResolution);
  const completeManualResolution = useTaskStore((state) => state.completeMergeWorkflowManualResolution);
  const abortManualResolution = useTaskStore((state) => state.abortMergeWorkflowManualResolution);
  const loadMergeWorkflowReview = useTaskStore((state) => state.loadMergeWorkflowReview);
  const [files, setFiles] = useState<string[]>(() => repository.conflictFiles);
  const [selectedPath, setSelectedPath] = useState<string | null>(() => repository.conflictFiles[0] ?? null);
  const [currentFile, setCurrentFile] = useState<GitConflictFileDto | null>(null);
  const [referenceSide, setReferenceSide] = useState<ConflictReferenceSide>('ours');
  const [draft, setDraft] = useState('');
  const [resolvedPaths, setResolvedPaths] = useState<Set<string>>(() => new Set());
  const [isPreparing, setIsPreparing] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileLoadRetryToken, setFileLoadRetryToken] = useState(0);
  const knownFilesRef = useRef<string[]>(repository.conflictFiles);

  const isBusy = isPreparing || isLoadingFile || isSaving || isCompleting;
  const listedFiles = useMemo(
    () => Array.from(new Set([...repository.conflictFiles, ...files])),
    [files, repository.conflictFiles]
  );
  const allFilesResolved =
    listedFiles.length > 0 &&
    files.length === 0 &&
    listedFiles.every((file) => resolvedPaths.has(file));
  const selectedResolved = selectedPath ? resolvedPaths.has(selectedPath) : false;
  const canRenderFile = Boolean(currentFile && !currentFile.isBinary && !currentFile.tooLarge);
  const referenceOptions: Array<{ side: ConflictReferenceSide; label: string }> = [
    { side: 'ours', label: t('implement.conflictCurrent', 'Current') },
    { side: 'theirs', label: t('implement.conflictIncoming', 'Incoming') },
    { side: 'base', label: t('implement.conflictBase', 'Base') },
  ];

  useEffect(() => {
    knownFilesRef.current = Array.from(new Set([...knownFilesRef.current, ...repository.conflictFiles, ...files]));
  }, [files, repository.conflictFiles]);

  const refreshConflictStatus = useCallback(async () => {
    const status = await gitStatus(repository.repoPath);
    const nextFiles = status.conflictedFiles ?? status.conflicted_files ?? [];
    setFiles(nextFiles);
    setResolvedPaths((previous) => {
      const next = new Set(previous);
      for (const path of knownFilesRef.current) {
        if (!nextFiles.includes(path)) next.add(path);
      }
      return next;
    });
    setSelectedPath((current) =>
      current && nextFiles.includes(current) ? current : nextFiles[0] ?? null
    );
    await loadMergeWorkflowReview(taskId, { force: true });
  }, [loadMergeWorkflowReview, repository.repoPath, taskId]);

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

  useEffect(() => {
    let cancelled = false;

    const prepare = async () => {
      setError(null);
      if (!shouldPrepareManualMerge(repository)) {
        setFiles(repository.conflictFiles);
        setSelectedPath((current) => current ?? repository.conflictFiles[0] ?? null);
        return;
      }

      setIsPreparing(true);
      try {
        const result = await withTimeout(
          startManualResolution(taskId, repository.id),
          CONFLICT_OPERATION_TIMEOUT_MS,
          t(
            'implement.prepareConflictResolutionTimeout',
            'Preparing conflict resolution is taking too long. Refresh the conflicts or try again.'
          )
        );
        if (cancelled) return;
        if (result?.status === 'merged') {
          notify.success(t('implement.mergeCompleted', 'Merge completed.'));
          onClose();
          return;
        }
        if (result?.conflictFiles?.length) {
          setFiles(result.conflictFiles);
          setSelectedPath((current) => current ?? result.conflictFiles[0] ?? null);
        } else {
          await refreshConflictStatus();
        }
      } catch (cause) {
        if (!cancelled) setError(toServiceError(cause).message);
      } finally {
        if (!cancelled) setIsPreparing(false);
      }
    };

    void prepare();
    return () => {
      cancelled = true;
    };
  }, [
    onClose,
    refreshConflictStatus,
    repository,
    repository.id,
    repository.conflictFiles,
    repository.mergeInProgress,
    startManualResolution,
    t,
    taskId,
  ]);

  useEffect(() => {
    if (!selectedPath || resolvedPaths.has(selectedPath)) {
      setCurrentFile(null);
      setDraft('');
      return;
    }

    let cancelled = false;
    const loadFile = async () => {
      setIsLoadingFile(true);
      setError(null);
      try {
        const file = await withTimeout(
          gitReadConflictFile({
            repoPath: repository.repoPath,
            path: selectedPath,
          }),
          CONFLICT_OPERATION_TIMEOUT_MS,
          t(
            'implement.loadConflictFileTimeout',
            'Loading this conflict file is taking too long. Retry the file or refresh conflicts.'
          )
        );
        if (cancelled) return;
        setCurrentFile(file);
        setDraft(createInitialDraft(file));
        setReferenceSide(file.ours.exists ? 'ours' : file.theirs.exists ? 'theirs' : 'base');
      } catch (cause) {
        if (!cancelled) {
          setCurrentFile(null);
          setDraft('');
          setError(toServiceError(cause).message);
        }
      } finally {
        if (!cancelled) setIsLoadingFile(false);
      }
    };

    void loadFile();
    return () => {
      cancelled = true;
    };
  }, [fileLoadRetryToken, repository.repoPath, resolvedPaths, selectedPath, t]);

  const handleRetryFile = useCallback(() => {
    setError(null);
    setFileLoadRetryToken((current) => current + 1);
  }, []);

  const handleRefreshConflicts = useCallback(async () => {
    if (isBusy) return;
    setIsLoadingFile(true);
    setError(null);
    try {
      await refreshConflictStatus();
    } catch (cause) {
      setError(toServiceError(cause).message);
    } finally {
      setIsLoadingFile(false);
    }
  }, [isBusy, refreshConflictStatus]);

  const handleSave = useCallback(async () => {
    if (!selectedPath || !currentFile || isBusy) return;
    setIsSaving(true);
    setError(null);
    try {
      await gitWriteConflictResolution({
        repoPath: repository.repoPath,
        path: selectedPath,
        content: draft,
        stage: true,
      });
      setResolvedPaths((previous) => new Set(previous).add(selectedPath));
      await refreshConflictStatus();
    } catch (cause) {
      setError(toServiceError(cause).message);
    } finally {
      setIsSaving(false);
    }
  }, [currentFile, draft, isBusy, refreshConflictStatus, repository.repoPath, selectedPath]);

  const handleAcceptSide = useCallback(async (side: 'ours' | 'theirs') => {
    if (!selectedPath || isBusy) return;
    setIsSaving(true);
    setError(null);
    try {
      await gitAcceptConflictSide({
        repoPath: repository.repoPath,
        path: selectedPath,
        side,
      });
      setResolvedPaths((previous) => new Set(previous).add(selectedPath));
      await refreshConflictStatus();
    } catch (cause) {
      setError(toServiceError(cause).message);
    } finally {
      setIsSaving(false);
    }
  }, [isBusy, refreshConflictStatus, repository.repoPath, selectedPath]);

  const handleComplete = useCallback(async () => {
    if (isBusy || !allFilesResolved) return;
    setIsCompleting(true);
    setError(null);
    try {
      await completeManualResolution(taskId, repository.id);
      notify.success(t('implement.mergeCompleted', 'Merge completed.'));
      onClose();
    } catch (cause) {
      setError(toServiceError(cause).message);
    } finally {
      setIsCompleting(false);
    }
  }, [allFilesResolved, completeManualResolution, isBusy, onClose, repository.id, t, taskId]);

  const handleAbort = useCallback(async () => {
    if (isBusy) return;
    setIsSaving(true);
    setError(null);
    try {
      await abortManualResolution(taskId, repository.id);
      onClose();
    } catch (cause) {
      setError(toServiceError(cause).message);
    } finally {
      setIsSaving(false);
    }
  }, [abortManualResolution, isBusy, onClose, repository.id, taskId]);

  const selectedReferenceContent = useMemo(
    () => sideContent(currentFile, referenceSide),
    [currentFile, referenceSide]
  );

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-background/50 p-4 pt-12 backdrop-blur-sm sm:p-6 sm:pt-14"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-merge-conflict-resolver-modal="true"
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
            <p className="mt-3 text-xs text-muted-foreground">
              {t('implement.conflictFileCount', '{{count}} conflicted file(s)', {
                count: files.length || repository.conflictFiles.length,
              })}
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" data-merge-conflict-file-list="true">
            {listedFiles.map((path) => {
              const isCurrent = path === selectedPath;
              const isResolved = resolvedPaths.has(path);
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => setSelectedPath(path)}
                  disabled={isBusy || isCurrent}
                  className={cn(
                    'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    isCurrent
                      ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                  title={path}
                >
                  <span className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold',
                    isResolved
                      ? 'bg-emerald-500/10 text-emerald-500'
                      : 'bg-red-500/10 text-red-400'
                  )}>
                    {isResolved ? 'R' : '!'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{getFileLabel(path)}</span>
                    <span className="block truncate text-[11px] opacity-70">{getFileDir(path) || '/'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex shrink-0 items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3 pr-4">
              <div className="min-w-0">
                {selectedPath ? (
                  <h2 className="truncate text-sm font-medium leading-tight" title={selectedPath}>
                    <span className="text-muted-foreground">{getFileDir(selectedPath) || '/'}</span>
                    <span className="text-foreground">{getFileLabel(selectedPath)}</span>
                  </h2>
                ) : (
                  <h2 className="text-sm font-medium text-foreground">
                    {t('implement.manualConflictResolution', 'Manual conflict resolution')}
                  </h2>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-4">
              {canRenderFile && (
                <div className="flex items-center rounded-lg border border-border bg-muted/20 p-1">
                  {referenceOptions.map((option) => (
                    <Button
                      key={option.side}
                      variant={referenceSide === option.side ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => setReferenceSide(option.side)}
                      disabled={isBusy}
                      className={cn('h-7 px-2.5 text-xs', referenceSide === option.side ? 'shadow-sm' : '')}
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

          <div className="relative min-h-0 flex-1 bg-muted/5" data-merge-conflict-viewer="true" data-selected-file-path={selectedPath ?? ''}>
            {isPreparing || isLoadingFile ? (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 p-6">
                <div className="flex items-center gap-3">
                  <Icon name="loader" size={20} className="animate-spin text-primary" />
                  <span className="text-sm font-medium text-muted-foreground">
                    {isPreparing
                      ? t('implement.preparingConflictResolution', 'Preparing merge conflicts...')
                      : t('implement.loadingFileDiff', 'Loading file diff...')}
                  </span>
                </div>
              </div>
            ) : error ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
                <div className="max-w-lg rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-center">
                  <p className="text-sm text-destructive">{error}</p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleRetryFile}
                      disabled={!selectedPath}
                    >
                      {t('implement.retryFile', 'Retry file')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleRefreshConflicts()}
                    >
                      {t('implement.refreshConflicts', 'Refresh conflicts')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : selectedResolved ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {t('implement.conflictFileResolved', 'This file is resolved and staged.')}
              </div>
            ) : !canRenderFile ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {t('implement.noTextualDiff', 'No textual diff is available for this file.')}
              </div>
            ) : (
              <DiffMergeView
                key={`${selectedPath}:${referenceSide}`}
                original={selectedReferenceContent}
                modified={draft}
                language={inferLanguageFromPath(selectedPath ?? '')}
                layout="split"
                presentationMode="full"
                className="h-full w-full border-none md:border-none"
                editable
                autoFocus
                onChange={setDraft}
              />
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 bg-card/95 px-6 py-4">
            <div className="text-xs text-muted-foreground">
              {allFilesResolved ? (
                <span className="font-medium text-emerald-500">
                  {t('implement.allConflictsResolved', 'All conflicts are staged. Complete the merge to continue.')}
                </span>
              ) : (
                t('implement.resolveConflictFileHint', 'Choose a side or edit the resolved result, then stage the file.')
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => void handleAbort()} disabled={isBusy}>
                {t('implement.abortMerge', 'Abort merge')}
              </Button>
              {!allFilesResolved && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => void handleAcceptSide('ours')} disabled={isBusy || !selectedPath}>
                    {t('implement.acceptCurrentChange', 'Accept current')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void handleAcceptSide('theirs')} disabled={isBusy || !selectedPath}>
                    {t('implement.acceptIncomingChange', 'Accept incoming')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={isBusy || !canRenderFile}>
                    {t('implement.markResolved', 'Mark resolved')}
                  </Button>
                </>
              )}
              {allFilesResolved && (
                <Button variant="primary" size="sm" onClick={() => void handleComplete()} disabled={isBusy || !allFilesResolved} isLoading={isCompleting}>
                  {t('implement.completeMerge', 'Complete merge')}
                </Button>
              )}
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
};
