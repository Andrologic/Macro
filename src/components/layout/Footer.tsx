import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toaster';
import { useAppStore } from '../../stores/useAppStore';
import { hasUnreadNotifications, useNotificationCenterStore } from '../../stores/useNotificationCenterStore';
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
import { getFocusedProjectForGroup, getGlobalProjectById, getSubProjectsForGroup } from '../../services/globalProjects';
import { NotificationCenterPopover } from './NotificationCenterPopover';
import { cn } from '../../utils/cn';

type MacroConflictContext = 'commit' | 'pull' | 'push' | 'refresh';
type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

interface CodeStatusSnapshot {
  branch: string;
  isClean: boolean;
  changedCount: number;
}

const DEFAULT_CODE_STATUS: CodeStatusSnapshot = {
  branch: '',
  isClean: true,
  changedCount: 0,
};

const formatGitOutput = (output: string | null | undefined, t: TranslateFn): string => {
  const normalized = (output || '').trim();
  if (!normalized) return t('footer.sync.done', 'Done.');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-2).join(' | ');
};

const macroStateClass: Record<tauriIpc.MacroSyncState, string> = {
  clean: 'text-emerald-400',
  pending: 'text-amber-400',
  failed: 'text-red-400',
  conflict: 'text-red-400',
};

const formatMacroHint = (snapshot: tauriIpc.MacroBranchSyncDto | null, t: TranslateFn): string => {
  if (!snapshot) {
    return '';
  }

  switch (snapshot.reason) {
    case 'dirty':
      return t('footer.sync.hintCommitRequired', 'commit required');
    case 'ahead':
      return snapshot.ahead > 0
        ? t('footer.sync.hintAhead', 'ahead {{count}}', { count: snapshot.ahead })
        : t('footer.sync.hintPushRequired', 'push required');
    case 'behind':
      return snapshot.behind > 0
        ? t('footer.sync.hintBehind', 'behind {{count}}', { count: snapshot.behind })
        : t('footer.sync.hintPullRequired', 'pull required');
    case 'diverged':
      return [
        snapshot.ahead > 0 ? t('footer.sync.hintAhead', 'ahead {{count}}', { count: snapshot.ahead }) : '',
        snapshot.behind > 0 ? t('footer.sync.hintBehind', 'behind {{count}}', { count: snapshot.behind }) : '',
      ].filter(Boolean).join(', ') || t('footer.sync.hintDiverged', 'diverged');
    case 'missing_origin':
      return t('footer.sync.hintOriginMissing', 'origin missing');
    case 'missing_upstream':
      return t('footer.sync.hintUpstreamMissing', 'upstream missing');
    case 'auth_required':
      return t('footer.sync.hintAuthRequired', 'auth required');
    case 'network_error':
      return t('footer.sync.hintNetworkIssue', 'network issue');
    case 'merge_conflict':
      return t('footer.sync.hintResolveConflicts', 'resolve conflicts');
    default:
      return '';
  }
};

const toCodeStatusSnapshot = (
  status: tauriIpc.GitStatusDto,
  detachedLabel: string
): CodeStatusSnapshot => {
  const changedCount =
    status.staged_files.length +
    status.unstaged_files.length +
    status.untracked_files.length;

  return {
    branch: status.branch || detachedLabel,
    isClean: status.is_clean,
    changedCount,
  };
};

export const Footer: React.FC = () => {
  const { t } = useTranslation();
  const translate = useCallback<TranslateFn>(
    (key, fallback, options) => String(t(key, { defaultValue: fallback, ...(options || {}) })),
    [t]
  );
  const isTauriRuntime = tauriIpc.isTauriAvailable();
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const switchProjectContext = useAppStore((state) => state.switchProjectContext);
  const metadataSyncState = useAppStore((state) => state.metadataSyncState);
  const metadataSyncError = useAppStore((state) => state.metadataSyncError);
  const metadataSyncReason = useAppStore((state) => state.metadataSyncReason);
  const metadataSyncNextAction = useAppStore((state) => state.metadataSyncNextAction);
  const metadataConflictFiles = useAppStore((state) => state.metadataConflictFiles);
  const metadataSyncRepositories = useAppStore((state) => state.metadataSyncRepositories);
  const notificationItems = useNotificationCenterStore((state) => state.items);
  const isNotificationCenterOpen = useNotificationCenterStore((state) => state.isCenterOpen);
  const setNotificationCenterOpen = useNotificationCenterStore((state) => state.setCenterOpen);

  const [codeStatus, setCodeStatus] = useState<CodeStatusSnapshot>(DEFAULT_CODE_STATUS);
  const [codeAction, setCodeAction] = useState<'pull' | 'push' | null>(null);
  const [macroAction, setMacroAction] = useState<'commit' | 'pull' | 'push' | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [showConflictModal, setShowConflictModal] = useState<boolean>(false);
  const [macroSnapshot, setMacroSnapshot] = useState<tauriIpc.MacroBranchSyncDto | null>(null);

  const lastConflictToastAtRef = useRef(0);
  const lastMacroConflictActionRef = useRef<MacroConflictContext | null>(null);
  const notificationCenterButtonRef = useRef<HTMLButtonElement>(null);
  const macroStateLabel = useMemo<Record<tauriIpc.MacroSyncState, string>>(
    () => ({
      clean: t('footer.sync.macroClean', '@macro clean'),
      pending: t('footer.sync.macroPending', '@macro pending'),
      failed: t('footer.sync.macroFailed', '@macro failed'),
      conflict: t('footer.sync.macroConflict', '@macro conflict'),
    }),
    [t]
  );

  const selectedGlobalProject = useMemo(
    () => getGlobalProjectById(projectGroups, selectedGroupId),
    [projectGroups, selectedGroupId]
  );
  const focusProjects = useMemo(
    () => getSubProjectsForGroup(projectGroups, selectedGroupId),
    [projectGroups, selectedGroupId]
  );
  const focusedProject = useMemo(
    () => getFocusedProjectForGroup(projectGroups, selectedGroupId, selectedProjectId),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const repoPath = focusedProject?.path || null;

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
          ? t(
            'footer.sync.macroConflictPullDescription',
            '@macro pull reported merge conflicts. Resolve files then re-run sync.'
          )
          : t(
            'footer.sync.macroConflictGenericDescription',
            '@macro has unresolved conflicts. Resolve manually or launch AI guidance.'
          );
      toast.error(t('footer.sync.macroConflictDetected', '@macro conflict detected'), { description });
      lastConflictToastAtRef.current = now;
    },
    [t]
  );

  const refreshCodeStatus = useCallback(async () => {
    if (!isTauriRuntime) {
      setCodeStatus({
        branch: t('footer.sync.branchDesktopOnly', 'desktop only'),
        isClean: true,
        changedCount: 0,
      });
      return;
    }

    if (!repoPath) {
      setCodeStatus({
        branch: t('footer.sync.branchNoProject', 'no project'),
        isClean: true,
        changedCount: 0,
      });
      return;
    }

    try {
      const status = await tauriIpc.gitStatus(repoPath);
      setCodeStatus(toCodeStatusSnapshot(status, t('footer.sync.branchDetached', 'detached')));
    } catch {
      setCodeStatus({
        branch: t('footer.sync.branchUnavailable', 'unavailable'),
        isClean: false,
        changedCount: 0,
      });
    }
  }, [isTauriRuntime, repoPath, t]);

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
      toast.success(t('footer.sync.codePullComplete', 'Code pull complete'), {
        description: formatGitOutput(result.output, translate),
      });
    } catch (error) {
      const message = toServiceError(error).message;
      toast.error(t('footer.sync.codePullFailed', 'Code pull failed'), { description: message });
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
      toast.success(t('footer.sync.codePushComplete', 'Code push complete'), {
        description: formatGitOutput(result.output, translate),
      });
    } catch (error) {
      const message = toServiceError(error).message;
      toast.error(t('footer.sync.codePushFailed', 'Code push failed'), { description: message });
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
        toast.error(t('footer.sync.macroPullFailed', '@macro pull failed'), {
          description: getMacroSyncDescription(result) || t('footer.sync.macroUnknownSyncError', 'Unknown metadata sync error.'),
        });
      } else if (result.state === 'pending') {
        toast.info(t('footer.sync.macroPullBlocked', '@macro pull blocked'), {
          description: getMacroSyncDescription(result) || t('footer.sync.macroSyncRequiresAction', 'Metadata sync still requires another action first.'),
        });
      } else {
        toast.success(t('footer.sync.macroPullComplete', '@macro pull complete'), {
          description: formatGitOutput(result.output, translate),
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
        toast.success(t('footer.sync.macroCommitComplete', '@macro commit complete'), {
          description: formatGitOutput(result.output, translate),
        });
      } else if (result.state === 'failed') {
        toast.error(t('footer.sync.macroCommitFailed', '@macro commit failed'), {
          description: getMacroSyncDescription(result) || t('footer.sync.macroCommitFailedDescription', 'Metadata commit failed.'),
        });
      } else {
        toast.info(t('footer.sync.macroCommitNotNeeded', '@macro commit not needed'), {
          description: formatGitOutput(result.output, translate) || t('footer.sync.macroAlreadyUpToDate', 'Metadata branch is already up to date.'),
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
        toast.error(t('footer.sync.macroPushFailed', '@macro push failed'), {
          description: getMacroSyncDescription(result) || t('footer.sync.macroUnknownSyncError', 'Unknown metadata sync error.'),
        });
      } else if (result.state === 'pending') {
        toast.info(t('footer.sync.macroPushPartiallyComplete', '@macro push partially complete'), {
          description:
            getMacroSyncDescription(result) ||
            formatGitOutput(result.output, translate) ||
            t('footer.sync.macroPendingDifferences', 'Metadata sync still has pending local or remote differences.'),
        });
      } else {
        toast.success(t('footer.sync.macroPushComplete', '@macro push complete'), {
          description: formatGitOutput(result.output, translate),
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
        projectId: focusedProject?.id ?? selectedProjectId,
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
      toast.success(t('footer.sync.aiConflictAssistantStarted', 'AI conflict assistant started'), {
        description: t(
          'footer.sync.aiConflictAssistantDescription',
          'Switched to Debug mode and posted the conflict context.'
        ),
      });
      setShowConflictModal(false);
    } catch (error) {
      const message = toServiceError(error).message;
      toast.error(t('footer.sync.aiConflictAssistantStartFailed', 'Failed to start AI assistant'), { description: message });
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
    macroStateLabel[metadataSyncState as tauriIpc.MacroSyncState] || t('footer.sync.macroUnknown', '@macro unknown');
  const metadataLabelClass =
    macroStateClass[metadataSyncState as tauriIpc.MacroSyncState] || 'text-muted-foreground';
  const codeStateClass = codeStatus.isClean ? 'text-emerald-400' : 'text-amber-400';
  const codeStateLabel = codeStatus.isClean
    ? t('footer.sync.clean', 'clean')
    : t('footer.sync.codeChanges', '{{count}} changes', { count: codeStatus.changedCount });
  const macroConflictEntries = useMemo<ConflictResolutionEntry[]>(() => {
    const repositories = metadataSyncRepositories.length > 0
      ? metadataSyncRepositories
      : [{
        repoPath: repoPath || '@macro',
        projectId: focusedProject?.id ?? selectedProjectId,
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
    focusedProject?.id,
  ]);
  const macroHint = useMemo(() => {
    const baseHint = formatMacroHint(macroSnapshot, translate);
    if (metadataSyncRepositories.length <= 1) {
      return baseHint;
    }
    return [
      baseHint,
      t('footer.sync.repositoriesCount', '{{count}} repos', { count: metadataSyncRepositories.length }),
    ].filter(Boolean).join(' | ');
  }, [macroSnapshot, metadataSyncRepositories.length, t, translate]);
  const macroTooltip = useMemo(() => {
    const description = getMacroSyncDescription(macroSnapshot ?? {
      error: metadataSyncError,
      reason: metadataSyncReason,
    });
    const nextAction = metadataSyncNextAction
      ? t('footer.sync.nextAction', 'Next action: {{action}}.', {
        action: metadataSyncNextAction.replace(/_/g, ' '),
      })
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
    t,
  ]);
  const hasUnreadNotificationDot = useMemo(
    () => hasUnreadNotifications(notificationItems),
    [notificationItems]
  );

  const controlsDisabled = !isTauriRuntime;

  return (
    <>
      <footer className="h-8 bg-card border-t border-border px-2 sm:px-3 text-[11px] text-muted-foreground overflow-x-auto">
        <div className="h-full w-full min-w-[940px] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="flex items-center gap-1 min-w-0" title={selectedGlobalProject?.name || undefined}>
              <Icon name="layers" size={12} className="text-primary shrink-0" />
              <span className="truncate text-foreground">
                {selectedGlobalProject?.name || t('project.noGroup', 'No global project')}
              </span>
            </span>
            <span className="flex items-center gap-1 min-w-0" title={codeStatus.branch}>
              <Icon name="git-branch" size={12} className="text-blue-400 shrink-0" />
              <span className="truncate">{codeStatus.branch}</span>
            </span>
            <span className={`truncate ${codeStateClass}`}>{codeStateLabel}</span>
            {focusProjects.length > 1 && (
              <select
                className="h-6 max-w-[180px] bg-card border border-border rounded px-2 text-[11px] text-foreground"
                value={focusedProject?.id ?? ''}
                onChange={(event) => void switchProjectContext(event.target.value || null)}
              >
                {focusProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              title={t('footer.sync.refreshTitle', 'Refresh code and @macro sync status')}
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
              {codeAction === 'pull'
                ? t('footer.sync.pulling', 'Pulling...')
                : t('footer.sync.pull', 'Pull')}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={controlsDisabled || !repoPath || !!codeAction}
              onClick={() => void handleCodePush()}
            >
              {codeAction === 'push'
                ? t('footer.sync.pushing', 'Pushing...')
                : t('footer.sync.push', 'Push')}
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
              {macroAction === 'commit'
                ? t('footer.sync.macroCommitting', '@macro committing...')
                : t('footer.sync.macroCommit', '@macro commit')}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={controlsDisabled || !!macroAction}
              onClick={() => void handleMacroPull()}
            >
              {macroAction === 'pull'
                ? t('footer.sync.macroPulling', '@macro pulling...')
                : t('footer.sync.macroPull', '@macro pull')}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={controlsDisabled || !!macroAction}
              onClick={() => void handleMacroPush()}
            >
              {macroAction === 'push'
                ? t('footer.sync.macroPushing', '@macro pushing...')
                : t('footer.sync.macroPush', '@macro push')}
            </Button>

            {metadataSyncState === 'conflict' && (
              <Button
                size="sm"
                variant="error"
                className="h-6 px-2 text-[11px]"
                onClick={() => setShowConflictModal(true)}
              >
                {t('footer.sync.resolve', 'Resolve')}
              </Button>
            )}

            <Button
              ref={notificationCenterButtonRef}
              type="button"
              size="sm"
              variant="ghost"
              aria-haspopup="dialog"
              aria-expanded={isNotificationCenterOpen}
              aria-label={
                isNotificationCenterOpen
                  ? t('notifications.closeCenter', 'Close notifications')
                  : t('notifications.openCenter', 'Open notifications')
              }
              title={
                isNotificationCenterOpen
                  ? t('notifications.closeCenter', 'Close notifications')
                  : t('notifications.openCenter', 'Open notifications')
              }
              className={cn(
                'relative h-6 w-6 px-0 text-[11px]',
                isNotificationCenterOpen && 'bg-accent text-foreground hover:bg-accent'
              )}
              onClick={() => setNotificationCenterOpen(!isNotificationCenterOpen)}
            >
              <Icon name="bell" size={12} />
              {hasUnreadNotificationDot && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full border border-card bg-primary" />
              )}
            </Button>
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
              title={t('footer.sync.macroConflictTitle', '@macro sync conflict')}
              description={t(
                'footer.sync.macroConflictDescription',
                'Resolve the reported metadata blockers, then retry the same @macro sync step explicitly.'
              )}
              repositories={macroConflictEntries}
              error={metadataSyncError}
              retryLabel={t('footer.sync.retrySync', 'Retry sync')}
              retryDisabled={Boolean(macroAction)}
              retryLoading={Boolean(macroAction) || isRefreshing}
              onDismiss={() => setShowConflictModal(false)}
              dismissLabel={t('common.close', 'Close')}
              onRetry={() => void handleRetryMacroSync()}
              onUseAiAssistant={() => void openAiConflictAssistant()}
            />
          </div>
        </div>
      )}

      <NotificationCenterPopover
        isOpen={isNotificationCenterOpen}
        anchorRef={notificationCenterButtonRef}
        onClose={() => setNotificationCenterOpen(false)}
      />
    </>
  );
};
