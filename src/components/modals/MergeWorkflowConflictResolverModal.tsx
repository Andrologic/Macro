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
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { DiffMergeView } from '../ui/DiffMergeView';
import { Icon } from '../ui/Icon';
import { notify } from '../ui/toastService';
import { loadPreference, PREF_KEYS, savePreference } from '../../services/preferences';

interface MergeWorkflowConflictResolverModalProps {
  taskId: string;
  repository: MergeWorkflowRepositoryResult;
  onClose: () => void;
}

type ConflictReferenceSide = 'ours' | 'theirs';
type ConflictPresentationMode = 'focused' | 'full';
type PendingDiscardAction =
  | { type: 'close' }
  | { type: 'select_file'; path: string };
const CONFLICT_OPERATION_TIMEOUT_MS = 15_000;
const GIT_CONFLICT_MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m;

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
  return file.theirs.content;
};

const hasGitConflictMarkers = (content: string): boolean =>
  GIT_CONFLICT_MARKER_PATTERN.test(content);

const createInitialDraft = (file: GitConflictFileDto | null): string => {
  if (!file) return '';
  if (file.worktree.exists && !hasGitConflictMarkers(file.worktree.content)) {
    return file.worktree.content;
  }
  if (file.ours.exists) return file.ours.content;
  if (file.theirs.exists) return file.theirs.content;
  return '';
};

const shouldPrepareManualMerge = (repository: MergeWorkflowRepositoryResult): boolean =>
  !(repository.mergeInProgress && repository.conflictFiles.length > 0);

const getNonRenderableFileMessage = (
  file: GitConflictFileDto | null,
  translate: ReturnType<typeof useTranslation>['t']
): string => {
  if (file?.isBinary) {
    return translate(
      'implement.binaryConflictFile',
      'This is a binary conflict. Choose the full Current or Incoming version to resolve it.'
    );
  }
  if (file?.tooLarge) {
    return translate(
      'implement.largeConflictFile',
      'This file is too large to edit here. Choose the full Current or Incoming version to resolve it.'
    );
  }
  return translate('implement.noTextualDiff', 'No textual diff is available for this file.');
};

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
  const [presentationMode, setPresentationMode] = useState<ConflictPresentationMode>('focused');
  const [draft, setDraft] = useState('');
  const [savedDraft, setSavedDraft] = useState('');
  const [resolvedPaths, setResolvedPaths] = useState<Set<string>>(() => new Set());
  const [isPreparing, setIsPreparing] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false);
  const [pendingDiscardAction, setPendingDiscardAction] = useState<PendingDiscardAction | null>(null);
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
  const resultContainsConflictMarkers = canRenderFile && hasGitConflictMarkers(draft);
  const isDraftDirty = canRenderFile && !selectedResolved && draft !== savedDraft;
  const referenceOptions: Array<{ side: ConflictReferenceSide; label: string }> = [
    { side: 'ours', label: t('implement.conflictCurrent', 'Current') },
    { side: 'theirs', label: t('implement.conflictIncoming', 'Incoming') },
  ];
  const contextOptions: Array<{ mode: ConflictPresentationMode; label: string }> = [
    { mode: 'focused', label: t('implement.context.default', 'Focused diff') },
    { mode: 'full', label: t('implement.context.full', 'Full file context') },
  ];
  const chunkActionLabel = referenceSide === 'ours'
    ? t('implement.useCurrentBlock', 'Use current block')
    : t('implement.useIncomingBlock', 'Use incoming block');
  const conflictFileSummary = allFilesResolved
    ? t('implement.allConflictFilesResolvedShort', 'All files staged')
    : t('implement.remainingConflictFileCount', '{{remaining}} of {{total}} file(s) left', {
      remaining: files.length || listedFiles.length,
      total: listedFiles.length,
    });

  useEffect(() => {
    knownFilesRef.current = Array.from(new Set([...knownFilesRef.current, ...repository.conflictFiles, ...files]));
  }, [files, repository.conflictFiles]);

  useEffect(() => {
    let cancelled = false;

    void loadPreference<ConflictPresentationMode>(PREF_KEYS.IMPLEMENT_DIFF_PRESENTATION_MODE)
      .then((value) => {
        if (!cancelled && (value === 'focused' || value === 'full')) {
          setPresentationMode(value);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
      setSavedDraft('');
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
        const initialDraft = createInitialDraft(file);
        setCurrentFile(file);
        setDraft(initialDraft);
        setSavedDraft(initialDraft);
        setReferenceSide(file.ours.exists ? 'ours' : 'theirs');
      } catch (cause) {
        if (!cancelled) {
          setCurrentFile(null);
          setDraft('');
          setSavedDraft('');
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

  const attemptClose = useCallback(() => {
    if (isDraftDirty) {
      setPendingDiscardAction({ type: 'close' });
      setIsConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [isDraftDirty, onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      attemptClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [attemptClose]);

  const handleSelectPath = useCallback((path: string) => {
    if (path === selectedPath) return;
    if (isDraftDirty) {
      setPendingDiscardAction({ type: 'select_file', path });
      setIsConfirmingDiscard(true);
      return;
    }
    setSelectedPath(path);
  }, [isDraftDirty, selectedPath]);

  const handleConfirmDiscard = useCallback(() => {
    const action = pendingDiscardAction;
    setIsConfirmingDiscard(false);
    setPendingDiscardAction(null);
    setDraft(savedDraft);

    if (action?.type === 'close') {
      onClose();
      return;
    }
    if (action?.type === 'select_file') {
      setSelectedPath(action.path);
    }
  }, [onClose, pendingDiscardAction, savedDraft]);

  const handleCancelDiscard = useCallback(() => {
    setIsConfirmingDiscard(false);
    setPendingDiscardAction(null);
  }, []);

  const handlePresentationModeChange = useCallback((nextMode: ConflictPresentationMode) => {
    if (isBusy || isDraftDirty || presentationMode === nextMode) {
      return;
    }

    setPresentationMode(nextMode);
    void savePreference(PREF_KEYS.IMPLEMENT_DIFF_PRESENTATION_MODE, nextMode);
  }, [isBusy, isDraftDirty, presentationMode]);

  const handleRetryFile = useCallback(() => {
    setError(null);
    setFileLoadRetryToken((current) => current + 1);
  }, []);

  const handleResetDraft = useCallback(() => {
    if (isBusy || !canRenderFile) return;
    setDraft(savedDraft);
    setError(null);
  }, [canRenderFile, isBusy, savedDraft]);

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
    if (hasGitConflictMarkers(draft)) {
      setError(t(
        'implement.conflictMarkersStillPresent',
        'The result still contains Git conflict markers. Choose Current or Incoming blocks before saving.'
      ));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await gitWriteConflictResolution({
        repoPath: repository.repoPath,
        path: selectedPath,
        content: draft,
        stage: true,
      });
      setSavedDraft(draft);
      setResolvedPaths((previous) => new Set(previous).add(selectedPath));
      await refreshConflictStatus();
    } catch (cause) {
      setError(toServiceError(cause).message);
    } finally {
      setIsSaving(false);
    }
  }, [currentFile, draft, isBusy, refreshConflictStatus, repository.repoPath, selectedPath, t]);

  const handleUseSide = useCallback(async (side: ConflictReferenceSide) => {
    if (!selectedPath || isBusy) return;

    if (canRenderFile && currentFile && !selectedResolved) {
      setReferenceSide(side);
      setDraft(sideContent(currentFile, side));
      setError(null);
      return;
    }

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
  }, [canRenderFile, currentFile, isBusy, refreshConflictStatus, repository.repoPath, selectedPath, selectedResolved]);

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
        if (event.target === event.currentTarget) attemptClose();
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
            <p className={cn(
              'mt-3 text-xs',
              allFilesResolved ? 'text-emerald-500' : 'text-muted-foreground'
            )}>
              {conflictFileSummary}
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
                  onClick={() => handleSelectPath(path)}
                  disabled={isBusy || isCurrent}
                  className={cn(
                    'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    isCurrent
                      ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                  title={path}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm',
                      isResolved
                        ? 'bg-emerald-500/10 text-emerald-500'
                        : 'bg-red-500/10 text-red-400'
                    )}
                    title={isResolved
                      ? t('implement.resolvedConflictFile', 'Resolved')
                      : t('implement.unresolvedConflictFile', 'Unresolved')}
                  >
                    <Icon
                      name={isResolved ? 'check' : 'alert-circle'}
                      size={11}
                    />
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
                {isDraftDirty && (
                  <span className="mt-1 inline-flex rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-300">
                    {t('implement.unsavedDraftBadge', 'Unsaved draft')}
                  </span>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-4">
              {canRenderFile && (
                <>
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
                  <div className="flex items-center rounded-lg border border-border bg-muted/20 p-1">
                    {contextOptions.map((option) => (
                      <Button
                        key={option.mode}
                        variant={presentationMode === option.mode ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => handlePresentationModeChange(option.mode)}
                        disabled={isBusy || isDraftDirty}
                        className={cn('h-7 px-2.5 text-xs', presentationMode === option.mode ? 'shadow-sm' : '')}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={attemptClose} aria-label={t('common.close', 'Close')}>
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
              <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
                <div className="max-w-lg rounded-xl border border-border bg-card px-4 py-4 text-center shadow-sm">
                  <Icon name="file-text" size={24} className="mx-auto mb-3 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {getNonRenderableFileMessage(currentFile, t)}
                  </p>
                </div>
              </div>
            ) : resultContainsConflictMarkers ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
                <div className="max-w-lg rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-4 text-center">
                  <Icon name="triangle-alert" size={24} className="mx-auto mb-3 text-amber-600 dark:text-amber-300" />
                  <p className="text-sm font-medium text-amber-700 dark:text-amber-200">
                    {t('implement.conflictMarkersStillPresent', 'The result still contains Git conflict markers. Choose Current or Incoming blocks before saving.')}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleUseSide('ours')}
                      disabled={isBusy || !selectedPath}
                    >
                      {t('implement.useAllCurrent', 'Use all current')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleUseSide('theirs')}
                      disabled={isBusy || !selectedPath}
                    >
                      {t('implement.useAllIncoming', 'Use all incoming')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="grid shrink-0 grid-cols-2 border-b border-border/50 bg-card/50 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <div className="border-r border-border/50 px-4 py-2">
                    {t('implement.conflictSourceLabel', 'Source')}: {referenceSide === 'ours'
                      ? t('implement.conflictCurrent', 'Current')
                      : t('implement.conflictIncoming', 'Incoming')}
                  </div>
                  <div className="px-4 py-2">
                    {t('implement.conflictResultLabel', 'Result')}
                  </div>
                </div>
                <DiffMergeView
                  key={`${selectedPath}:${referenceSide}`}
                  original={selectedReferenceContent}
                  modified={draft}
                  language={inferLanguageFromPath(selectedPath ?? '')}
                  layout="split"
                  presentationMode={presentationMode}
                  className="min-h-0 flex-1 border-none md:border-none"
                  editable
                  autoFocus
                  onChange={setDraft}
                  revertControls="a-to-b"
                  revertControlLabel={chunkActionLabel}
                />
              </div>
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 bg-card/95 px-6 py-4">
            <div className="text-xs text-muted-foreground">
              {allFilesResolved ? (
                <span className="font-medium text-emerald-500">
                  {t('implement.allConflictsResolved', 'All conflicts are staged. Complete the merge to continue.')}
                </span>
              ) : isDraftDirty ? (
                <span className="font-medium text-amber-500">
                  {t('implement.unsavedDraft', 'Unsaved draft. Save to validate it.')}
                </span>
              ) : resultContainsConflictMarkers ? (
                <span className="font-medium text-amber-500">
                  {t('implement.conflictMarkersFooter', 'Choose a clean Current or Incoming result before saving.')}
                </span>
              ) : (
                t('implement.resolveConflictFileHint', 'Choose blocks, use a full side, or edit the resolved result, then save the resolution.')
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => void handleAbort()} disabled={isBusy}>
                {t('implement.abortMerge', 'Abort merge')}
              </Button>
              {!allFilesResolved && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => void handleUseSide('ours')} disabled={isBusy || !selectedPath}>
                    {t('implement.useAllCurrent', 'Use all current')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void handleUseSide('theirs')} disabled={isBusy || !selectedPath}>
                    {t('implement.useAllIncoming', 'Use all incoming')}
                  </Button>
                  {isDraftDirty && (
                    <Button variant="ghost" size="sm" onClick={handleResetDraft} disabled={isBusy || !canRenderFile}>
                      {t('implement.resetDraft', 'Reset draft')}
                    </Button>
                  )}
                  <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={isBusy || !canRenderFile || resultContainsConflictMarkers}>
                    {t('implement.saveResolution', 'Save resolution')}
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
      {isConfirmingDiscard && (
        <ConfirmPromptModal
          isOpen={isConfirmingDiscard}
          title={t('implement.discardChangesTitle', 'Discard unsaved changes?')}
          description={t(
            'implement.discardChangesDesc',
            'You have made edits to this file. Are you sure you want to discard them?'
          )}
          confirmLabel={t('implement.discardButton', 'Discard changes')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onConfirm={handleConfirmDiscard}
          onCancel={handleCancelDiscard}
          confirmVariant="error"
        />
      )}
    </div>
  );
};
