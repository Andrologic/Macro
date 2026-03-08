import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toaster';
import { useAppStore } from '../../stores/useAppStore';
import { toServiceError } from '../../services/contracts/errors';
import * as tauriIpc from '../../services/tauriIpc';
import {
  buildMacroConflictAssistantPrompt,
  toMacroConflictResolutionEntries,
  type ConflictResolutionEntry,
} from '../../services/conflictResolution';
import { openConflictAssistant } from '../../services/conflictAssistantService';
import { ConflictResolutionPanel } from '../conflicts/ConflictResolutionPanel';
import { commitMacroMetadata, getMacroSyncDescription, pullMacroMetadata, pushMacroMetadata, refreshMacroSyncStatus } from '../../services/macroSyncService';

type MacroConflictContext = 'commit' | 'pull' | 'push' | 'refresh';

interface CodeStatusSnapshot {
  branch: string;
  isClean: boolean;
  changedCount: number;
}

const DEFAULT_CODE_STATUS: CodeStatusSnapshot = {
  branch: 'detached',
  isClean: true,
  changedCount: 0,
};

const formatGitOutput = (output: string | null | undefined): string => {
  const normalized = (output || '').trim();
  if (!normalized) return 'Done.';
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-2).join(' | ');
};

const macroStateLabel: Record<tauriIpc.MacroSyncState, string> = {
  clean: '@macro clean',
  pending: '@macro pending',
  failed: '@macro failed',
  conflict: '@macro conflict',
};

const macroStateClass: Record<tauriIpc.MacroSyncState, string> = {
  clean: 'text-emerald-400',
  pending: 'text-amber-400',
  failed: 'text-red-400',
  conflict: 'text-red-400',
};

const formatMacroHint = (snapshot: tauriIpc.MacroBranchSyncDto | null): string => {
  if (!snapshot) {
    return '';
  }

  switch (snapshot.reason) {
    case 'dirty':
      return 'commit required';
    case 'ahead':
      return snapshot.ahead > 0 ? `ahead ${snapshot.ahead}` : 'push required';
    case 'behind':
      return snapshot.behind > 0 ? `behind ${snapshot.behind}` : 'pull required';
    case 'diverged':
      return [snapshot.ahead > 0 ? `ahead ${snapshot.ahead}` : '', snapshot.behind > 0 ? `behind ${snapshot.behind}` : '']
        .filter(Boolean)
        .join(', ') || 'diverged';
    case 'missing_origin':
      return 'origin missing';
    case 'missing_upstream':
      return 'upstream missing';
    case 'auth_required':
      return 'auth required';
    case 'network_error':
      return 'network issue';
    case 'merge_conflict':
      return 'resolve conflicts';
    default:
      return '';
  }
};

const toCodeStatusSnapshot = (status: tauriIpc.GitStatusDto): CodeStatusSnapshot => {
  const changedCount =
    status.staged_files.length +
    status.unstaged_files.length +
    status.untracked_files.length;

  return {
    branch: status.branch || 'detached',
    isClean: status.is_clean,
    changedCount,
  };
};

export const Footer: React.FC = () => {
  const isTauriRuntime = tauriIpc.isTauriAvailable();
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const getProjectById = useAppStore((state) => state.getProjectById);
  const metadataSyncState = useAppStore((state) => state.metadataSyncState);
  const metadataSyncError = useAppStore((state) => state.metadataSyncError);
  const metadataSyncReason = useAppStore((state) => state.metadataSyncReason);
  const metadataSyncNextAction = useAppStore((state) => state.metadataSyncNextAction);
  const metadataConflictFiles = useAppStore((state) => state.metadataConflictFiles);
  const metadataSyncRepositories = useAppStore((state) => state.metadataSyncRepositories);

  const [codeStatus, setCodeStatus] = useState<CodeStatusSnapshot>(DEFAULT_CODE_STATUS);
  const [codeAction, setCodeAction] = useState<'pull' | 'push' | null>(null);
  const [macroAction, setMacroAction] = useState<'commit' | 'pull' | 'push' | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [showConflictModal, setShowConflictModal] = useState<boolean>(false);
  const [macroSnapshot, setMacroSnapshot] = useState<tauriIpc.MacroBranchSyncDto | null>(null);

  const lastConflictToastAtRef = useRef(0);
  const lastMacroConflictActionRef = useRef<MacroConflictContext | null>(null);

  const selectedProject = useMemo(
    () => (selectedProjectId ? getProjectById(selectedProjectId) : undefined),
    [getProjectById, selectedProjectId]
  );
  const repoPath = selectedProject?.path || null;

  const presentConflictIfNeeded = useCallback(
    (result: tauriIpc.MacroBranchSyncDto, context: MacroConflictContext) => {
      if (result.state !== 'conflict') {
        return;
      }

      lastMacroConflictActionRef.current = context;
      setShowConflictModal(true);

      const now = Date.now();
      const elapsed = now - lastConflictToastAtRef.current;
      if (elapsed < 12000) {
        return;
      }

      const description =
        context === 'pull'
          ? '@macro pull reported merge conflicts. Resolve files then re-run sync.'
          : '@macro has unresolved conflicts. Resolve manually or launch AI guidance.';
      toast.error('@macro conflict detected', { description });
      lastConflictToastAtRef.current = now;
    },
    []
  );

  const refreshCodeStatus = useCallback(async () => {
    if (!isTauriRuntime) {
      setCodeStatus({
        branch: 'desktop only',
        isClean: true,
        changedCount: 0,
      });
      return;
    }

    if (!repoPath) {
      setCodeStatus({
        branch: 'no project',
        isClean: true,
        changedCount: 0,
      });
      return;
    }

    try {
      const status = await tauriIpc.gitStatus(repoPath);
      setCodeStatus(toCodeStatusSnapshot(status));
    } catch {
      setCodeStatus({
        branch: 'unavailable',
        isClean: false,
        changedCount: 0,
      });
    }
  }, [isTauriRuntime, repoPath]);

  const refreshMacroStatus = useCallback(
    async (ensure = false) => {
      if (!isTauriRuntime) {
        setMacroSnapshot(null);
        return null;
      }

      const result = await refreshMacroSyncStatus({ ensure });
      if (!result) {
        return null;
      }

      setMacroSnapshot(result);
      presentConflictIfNeeded(result, 'refresh');
      return result;
    },
    [isTauriRuntime, presentConflictIfNeeded]
  );

  const refreshFooterStatus = useCallback(
    async (options?: { ensureMacro?: boolean; showBusy?: boolean }) => {
      if (options?.showBusy) {
        setIsRefreshing(true);
      }

      try {
        await Promise.all([
          refreshCodeStatus(),
          refreshMacroStatus(Boolean(options?.ensureMacro)),
        ]);
      } finally {
        if (options?.showBusy) {
          setIsRefreshing(false);
        }
      }
    },
    [refreshCodeStatus, refreshMacroStatus]
  );

  useEffect(() => {
    void refreshFooterStatus({ ensureMacro: true });
  }, [refreshFooterStatus]);

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshFooterStatus();
    }, 20000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isTauriRuntime, refreshFooterStatus]);

  useEffect(() => {
    if (metadataSyncState === 'conflict') {
      setShowConflictModal(true);
    }
  }, [metadataSyncState]);

  const handleCodePull = async () => {
    if (!repoPath || !isTauriRuntime || codeAction) {
      return;
    }

    setCodeAction('pull');
    try {
      const result = await tauriIpc.gitPull({ repoPath });
      toast.success('Code pull complete', {
        description: formatGitOutput(result.output),
      });
    } catch (error) {
      const message = toServiceError(error).message;
      toast.error('Code pull failed', { description: message });
    } finally {
      await refreshCodeStatus();
      setCodeAction(null);
    }
  };

  const handleCodePush = async () => {
    if (!repoPath || !isTauriRuntime || codeAction) {
      return;
    }

    setCodeAction('push');
    try {
      const result = await tauriIpc.gitPush({ repoPath });
      toast.success('Code push complete', {
        description: formatGitOutput(result.output),
      });
    } catch (error) {
      const message = toServiceError(error).message;
      toast.error('Code push failed', { description: message });
    } finally {
      await refreshCodeStatus();
      setCodeAction(null);
    }
  };

  const handleMacroPull = async (): Promise<tauriIpc.MacroBranchSyncDto | null> => {
    if (!isTauriRuntime || macroAction) {
      return null;
    }

    lastMacroConflictActionRef.current = 'pull';
    setMacroAction('pull');
    try {
      const result = await pullMacroMetadata();
      if (!result) {
        return null;
      }

      setMacroSnapshot(result);
      if (result.state === 'conflict') {
        presentConflictIfNeeded(result, 'pull');
      } else if (result.state === 'failed') {
        toast.error('@macro pull failed', {
          description: getMacroSyncDescription(result) || 'Unknown metadata sync error.',
        });
      } else if (result.state === 'pending') {
        toast.info('@macro pull blocked', {
          description: getMacroSyncDescription(result) || 'Metadata sync still requires another action first.',
        });
      } else {
        toast.success('@macro pull complete', {
          description: formatGitOutput(result.output),
        });
      }
      return result;
    } finally {
      setMacroAction(null);
    }
  };

  const handleMacroCommit = async (): Promise<tauriIpc.MacroBranchSyncDto | null> => {
    if (!isTauriRuntime || macroAction) {
      return null;
    }

    lastMacroConflictActionRef.current = 'commit';
    setMacroAction('commit');
    try {
      const result = await commitMacroMetadata({
        commitMessage: 'chore(metadata): manual commit from footer controls',
      });
      if (!result) {
        return null;
      }

      setMacroSnapshot(result);
      if (result.state === 'conflict') {
        presentConflictIfNeeded(result, 'commit');
      } else if (result.committed) {
        toast.success('@macro commit complete', {
          description: formatGitOutput(result.output),
        });
      } else if (result.state === 'failed') {
        toast.error('@macro commit failed', {
          description: getMacroSyncDescription(result) || 'Metadata commit failed.',
        });
      } else {
        toast.info('@macro commit not needed', {
          description: formatGitOutput(result.output) || 'Metadata branch is already up to date.',
        });
      }
      return result;
    } finally {
      setMacroAction(null);
    }
  };

  const handleMacroPush = async (): Promise<tauriIpc.MacroBranchSyncDto | null> => {
    if (!isTauriRuntime || macroAction) {
      return null;
    }

    lastMacroConflictActionRef.current = 'push';
    setMacroAction('push');
    try {
      const result = await pushMacroMetadata();
      if (!result) {
        return null;
      }

      setMacroSnapshot(result);
      if (result.state === 'conflict') {
        presentConflictIfNeeded(result, 'push');
      } else if (result.state === 'failed') {
        toast.error('@macro push failed', {
          description: getMacroSyncDescription(result) || 'Unknown metadata sync error.',
        });
      } else if (result.state === 'pending') {
        toast.info('@macro push partially complete', {
          description:
            getMacroSyncDescription(result) ||
            formatGitOutput(result.output) ||
            'Metadata sync still has pending local or remote differences.',
        });
      } else {
        toast.success('@macro push complete', {
          description: formatGitOutput(result.output),
        });
      }
      return result;
    } finally {
      setMacroAction(null);
    }
  };

  const openAiConflictAssistant = async () => {
    const fallbackRepositories = metadataSyncRepositories.length > 0
      ? metadataSyncRepositories
      : [{
        repoPath: repoPath || '@macro',
        projectId: selectedProjectId,
        worktreePath: macroSnapshot?.worktree_path || null,
        state: metadataSyncState,
        error: metadataSyncError,
        reason: metadataSyncReason,
        nextAction: metadataSyncNextAction,
        conflictFiles: metadataConflictFiles,
      }];
    const prompt = buildMacroConflictAssistantPrompt({
      repositories: fallbackRepositories,
    });

    try {
      await openConflictAssistant(prompt);
      toast.success('AI conflict assistant started', {
        description: 'Switched to Debug mode and posted the conflict context.',
      });
      setShowConflictModal(false);
    } catch (error) {
      const message = toServiceError(error).message;
      toast.error('Failed to start AI assistant', { description: message });
    }
  };

  const handleRetryMacroSync = async () => {
    const action = lastMacroConflictActionRef.current;
    let result: tauriIpc.MacroBranchSyncDto | null = null;

    if (action === 'commit') {
      result = await handleMacroCommit();
    } else if (action === 'pull') {
      result = await handleMacroPull();
    } else if (action === 'push') {
      result = await handleMacroPush();
    } else {
      setIsRefreshing(true);
      try {
        result = await refreshMacroStatus(true);
      } finally {
        setIsRefreshing(false);
      }
    }

    if (result && result.state !== 'conflict') {
      setShowConflictModal(false);
    }
  };

  const metadataLabel =
    macroStateLabel[metadataSyncState as tauriIpc.MacroSyncState] || '@macro unknown';
  const metadataLabelClass =
    macroStateClass[metadataSyncState as tauriIpc.MacroSyncState] || 'text-muted-foreground';
  const codeStateClass = codeStatus.isClean ? 'text-emerald-400' : 'text-amber-400';
  const codeStateLabel = codeStatus.isClean ? 'clean' : `${codeStatus.changedCount} changes`;
  const macroConflictEntries = useMemo<ConflictResolutionEntry[]>(() => {
    const repositories = metadataSyncRepositories.length > 0
      ? metadataSyncRepositories
      : [{
        repoPath: repoPath || '@macro',
        projectId: selectedProjectId,
        worktreePath: macroSnapshot?.worktree_path || null,
        state: metadataSyncState,
        error: metadataSyncError,
        reason: metadataSyncReason,
        nextAction: metadataSyncNextAction,
        conflictFiles: metadataConflictFiles,
      }];

    return toMacroConflictResolutionEntries(repositories);
  }, [
    macroSnapshot,
    metadataConflictFiles,
    metadataSyncError,
    metadataSyncNextAction,
    metadataSyncReason,
    metadataSyncRepositories,
    metadataSyncState,
    repoPath,
    selectedProjectId,
  ]);
  const macroHint = useMemo(() => {
    const baseHint = formatMacroHint(macroSnapshot);
    if (metadataSyncRepositories.length <= 1) {
      return baseHint;
    }
    return [baseHint, `${metadataSyncRepositories.length} repos`].filter(Boolean).join(' | ');
  }, [macroSnapshot, metadataSyncRepositories.length]);
  const macroTooltip = useMemo(() => {
    const description = getMacroSyncDescription(macroSnapshot ?? {
      error: metadataSyncError,
      reason: metadataSyncReason,
    });
    const nextAction = metadataSyncNextAction
      ? `Next action: ${metadataSyncNextAction.replace(/_/g, ' ')}.`
      : null;
    const repositorySummary = metadataSyncRepositories
      .map((repository) => {
        const repoName = repository.repoPath.split(/[\\/]/).filter(Boolean).pop() || repository.repoPath;
        const reason = repository.error || repository.reason || repository.state;
        return `${repoName}: ${reason}`;
      })
      .join(' | ');
    return [description, nextAction, repositorySummary].filter(Boolean).join(' ');
  }, [
    macroSnapshot,
    metadataSyncError,
    metadataSyncNextAction,
    metadataSyncReason,
    metadataSyncRepositories,
  ]);

  const controlsDisabled = !isTauriRuntime;

  return (
    <>
      <footer className="h-8 bg-card border-t border-border px-2 sm:px-3 text-[11px] text-muted-foreground overflow-x-auto">
        <div className="h-full w-full min-w-[940px] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="flex items-center gap-1 min-w-0" title={codeStatus.branch}>
              <Icon name="git-branch" size={12} className="text-blue-400 shrink-0" />
              <span className="truncate">{codeStatus.branch}</span>
            </span>
            <span className={`truncate ${codeStateClass}`}>{codeStateLabel}</span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              title="Refresh code and @macro sync status"
              disabled={controlsDisabled || isRefreshing || !!codeAction || !!macroAction}
              onClick={() => void refreshFooterStatus({ showBusy: true })}
            >
              <Icon
                name="refresh-cw"
                size={12}
                className={isRefreshing ? 'animate-spin' : ''}
              />
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={controlsDisabled || !repoPath || !!codeAction}
              onClick={() => void handleCodePull()}
            >
              {codeAction === 'pull' ? 'Pulling...' : 'Pull'}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={controlsDisabled || !repoPath || !!codeAction}
              onClick={() => void handleCodePush()}
            >
              {codeAction === 'push' ? 'Pushing...' : 'Push'}
            </Button>
          </div>

          <div className="flex items-center gap-1 min-w-0 flex-1 justify-end">
            <span className={`flex items-center gap-1 min-w-0 ${metadataLabelClass}`} title={macroTooltip || undefined}>
              <Icon name="folder-git-2" size={12} className="shrink-0" />
              <span className="truncate">{metadataLabel}</span>
            </span>
            {macroHint && (
              <span className="truncate text-muted-foreground/80" title={macroTooltip || undefined}>
                {macroHint}
              </span>
            )}

            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={controlsDisabled || !!macroAction}
              onClick={() => void handleMacroCommit()}
            >
              {macroAction === 'commit' ? '@macro committing...' : '@macro commit'}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={controlsDisabled || !!macroAction}
              onClick={() => void handleMacroPull()}
            >
              {macroAction === 'pull' ? '@macro pulling...' : '@macro pull'}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={controlsDisabled || !!macroAction}
              onClick={() => void handleMacroPush()}
            >
              {macroAction === 'push' ? '@macro pushing...' : '@macro push'}
            </Button>

            {metadataSyncState === 'conflict' && (
              <Button
                size="sm"
                variant="error"
                className="h-6 px-2 text-[11px]"
                onClick={() => setShowConflictModal(true)}
              >
                Resolve
              </Button>
            )}
          </div>
        </div>
      </footer>

      {showConflictModal && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowConflictModal(false)}
          />

          <div className="relative w-full max-w-3xl rounded-xl border border-border bg-card p-4 shadow-2xl">
            <ConflictResolutionPanel
              title="@macro sync conflict"
              description="Resolve the reported metadata blockers, then retry the same @macro sync step explicitly."
              repositories={macroConflictEntries}
              error={metadataSyncError}
              retryLabel="Retry sync"
              retryDisabled={Boolean(macroAction)}
              retryLoading={Boolean(macroAction) || isRefreshing}
              onDismiss={() => setShowConflictModal(false)}
              dismissLabel="Close"
              onRetry={() => void handleRetryMacroSync()}
              onUseAiAssistant={() => void openAiConflictAssistant()}
            />
          </div>
        </div>
      )}
    </>
  );
};
