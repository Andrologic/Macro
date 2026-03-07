import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toaster';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { toServiceError } from '../../services/contracts/errors';
import * as tauriIpc from '../../services/tauriIpc';
import {
  pullMacroMetadata,
  pushMacroMetadata,
  refreshMacroSyncStatus,
} from '../../services/macroSyncService';

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
  const setMode = useAppStore((state) => state.setMode);
  const metadataSyncState = useAppStore((state) => state.metadataSyncState);
  const metadataSyncError = useAppStore((state) => state.metadataSyncError);
  const metadataConflictFiles = useAppStore((state) => state.metadataConflictFiles);

  const [codeStatus, setCodeStatus] = useState<CodeStatusSnapshot>(DEFAULT_CODE_STATUS);
  const [codeAction, setCodeAction] = useState<'pull' | 'push' | null>(null);
  const [macroAction, setMacroAction] = useState<'pull' | 'push' | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [showConflictModal, setShowConflictModal] = useState<boolean>(false);
  const [macroSnapshot, setMacroSnapshot] = useState<tauriIpc.MacroBranchSyncDto | null>(null);

  const lastConflictToastAtRef = useRef(0);

  const selectedProject = useMemo(
    () => (selectedProjectId ? getProjectById(selectedProjectId) : undefined),
    [getProjectById, selectedProjectId]
  );
  const repoPath = selectedProject?.path || null;

  const presentConflictIfNeeded = useCallback(
    (result: tauriIpc.MacroBranchSyncDto, context: 'pull' | 'push' | 'refresh') => {
      if (result.state !== 'conflict') {
        return;
      }

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

  const handleMacroPull = async () => {
    if (!isTauriRuntime || macroAction) {
      return;
    }

    setMacroAction('pull');
    try {
      const result = await pullMacroMetadata();
      if (!result) {
        return;
      }

      setMacroSnapshot(result);
      if (result.state === 'conflict') {
        presentConflictIfNeeded(result, 'pull');
      } else if (result.state === 'failed') {
        toast.error('@macro pull failed', {
          description: result.error || 'Unknown metadata sync error.',
        });
      } else {
        toast.success('@macro pull complete', {
          description: formatGitOutput(result.output),
        });
      }
    } finally {
      setMacroAction(null);
    }
  };

  const handleMacroPush = async () => {
    if (!isTauriRuntime || macroAction) {
      return;
    }

    setMacroAction('push');
    try {
      const result = await pushMacroMetadata({
        commitMessage: 'chore(metadata): manual sync from footer controls',
      });
      if (!result) {
        return;
      }

      setMacroSnapshot(result);
      if (result.state === 'conflict') {
        presentConflictIfNeeded(result, 'push');
      } else if (result.state === 'failed') {
        toast.error('@macro push failed', {
          description: result.error || 'Unknown metadata sync error.',
        });
      } else if (result.state === 'pending') {
        toast.info('@macro push partially complete', {
          description:
            result.error ||
            result.output ||
            'Metadata sync still has pending local or remote differences.',
        });
      } else {
        toast.success('@macro push complete', {
          description: formatGitOutput(result.output),
        });
      }
    } finally {
      setMacroAction(null);
    }
  };

  const openAiConflictAssistant = async () => {
    const worktreePath = macroSnapshot?.worktree_path || '(unknown worktree path)';
    const conflictFilesBlock = metadataConflictFiles.length
      ? metadataConflictFiles.map((file) => `- ${file}`).join('\n')
      : '- (none reported)';

    const prompt = [
      'I have conflicts on the @macro metadata branch after pull.',
      'Please help me resolve them safely without touching code branch history.',
      '',
      `Metadata worktree: ${worktreePath}`,
      '',
      'Conflicted files:',
      conflictFilesBlock,
      '',
      'Provide a short plan first, then run safe git commands to resolve conflicts.',
    ].join('\n');

    try {
      setMode('Debug');
      const chatStore = useChatStore.getState();
      const conversationId = await chatStore.ensureConversationForCurrentMode();
      if (!conversationId) {
        toast.error('Cannot open AI assistant', {
          description: 'No Debug conversation available.',
        });
        return;
      }

      await chatStore.sendMessage({ conversationId, content: prompt });
      toast.success('AI conflict assistant started', {
        description: 'Switched to Debug mode and posted the conflict context.',
      });
      setShowConflictModal(false);
    } catch (error) {
      const message = toServiceError(error).message;
      toast.error('Failed to start AI assistant', { description: message });
    }
  };

  const metadataLabel =
    macroStateLabel[metadataSyncState as tauriIpc.MacroSyncState] || '@macro unknown';
  const metadataLabelClass =
    macroStateClass[metadataSyncState as tauriIpc.MacroSyncState] || 'text-muted-foreground';
  const codeStateClass = codeStatus.isClean ? 'text-emerald-400' : 'text-amber-400';
  const codeStateLabel = codeStatus.isClean ? 'clean' : `${codeStatus.changedCount} changes`;
  const macroDivergenceLabel = useMemo(() => {
    if (!macroSnapshot) {
      return '';
    }
    if (!macroSnapshot.has_upstream) {
      return 'no upstream';
    }
    if (macroSnapshot.ahead === 0 && macroSnapshot.behind === 0) {
      return 'up to date';
    }

    const parts: string[] = [];
    if (macroSnapshot.ahead > 0) {
      parts.push(`ahead ${macroSnapshot.ahead}`);
    }
    if (macroSnapshot.behind > 0) {
      parts.push(`behind ${macroSnapshot.behind}`);
    }
    return parts.join(', ');
  }, [macroSnapshot]);

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
            <span className={`flex items-center gap-1 min-w-0 ${metadataLabelClass}`}>
              <Icon name="folder-git-2" size={12} className="shrink-0" />
              <span className="truncate">{metadataLabel}</span>
            </span>
            {macroDivergenceLabel && (
              <span className="truncate text-muted-foreground/80">{macroDivergenceLabel}</span>
            )}

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

          <div className="relative w-full max-w-xl rounded-xl border border-border bg-card p-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-foreground">@macro sync conflict</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Pulling metadata produced merge conflicts. Resolve files in the metadata worktree,
              then run @macro pull/push again.
            </p>

            {macroSnapshot?.worktree_path && (
              <p className="mt-2 text-xs text-muted-foreground">
                Worktree: <span className="text-foreground/90">{macroSnapshot.worktree_path}</span>
              </p>
            )}

            {metadataSyncError && (
              <p className="mt-2 text-xs text-red-400">{metadataSyncError}</p>
            )}

            <div className="mt-3 max-h-36 overflow-auto rounded border border-border bg-background/40 p-2 text-xs">
              {metadataConflictFiles.length > 0 ? (
                metadataConflictFiles.map((file) => (
                  <div key={file} className="truncate text-foreground/90">
                    {file}
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground">No conflict file list returned.</div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  toast.info('Manual resolution selected', {
                    description:
                      'Resolve conflicted files in the metadata worktree, commit, then use @macro pull/push.',
                  });
                  setShowConflictModal(false);
                }}
              >
                Resolve Manually
              </Button>

              <Button
                variant="primary"
                size="sm"
                onClick={() => void openAiConflictAssistant()}
              >
                Use AI Assistant
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
