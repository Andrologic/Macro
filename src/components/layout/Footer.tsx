import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/toastService';
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
type FooterActionMode = 'full' | 'icon' | 'hidden';

interface CodeStatusSnapshot {
  branch: string;
  isClean: boolean;
  changedCount: number;
}

interface FooterAdaptiveLayout {
  showProjectName: boolean;
  showProjectSelector: boolean;
  showCodeState: boolean;
  showMetadataLabel: boolean;
  showMacroHint: boolean;
  codeActionMode: FooterActionMode;
  macroActionMode: FooterActionMode;
}

const DEFAULT_CODE_STATUS: CodeStatusSnapshot = {
  branch: '',
  isClean: true,
  changedCount: 0,
};

const FOOTER_ADAPTIVE_LAYOUTS: FooterAdaptiveLayout[] = [
  {
    showProjectName: true,
    showProjectSelector: true,
    showCodeState: true,
    showMetadataLabel: true,
    showMacroHint: true,
    codeActionMode: 'full',
    macroActionMode: 'full',
  },
  {
    showProjectName: true,
    showProjectSelector: false,
    showCodeState: true,
    showMetadataLabel: true,
    showMacroHint: true,
    codeActionMode: 'full',
    macroActionMode: 'full',
  },
  {
    showProjectName: true,
    showProjectSelector: false,
    showCodeState: true,
    showMetadataLabel: true,
    showMacroHint: false,
    codeActionMode: 'full',
    macroActionMode: 'full',
  },
  {
    showProjectName: true,
    showProjectSelector: false,
    showCodeState: true,
    showMetadataLabel: true,
    showMacroHint: false,
    codeActionMode: 'icon',
    macroActionMode: 'full',
  },
  {
    showProjectName: true,
    showProjectSelector: false,
    showCodeState: true,
    showMetadataLabel: true,
    showMacroHint: false,
    codeActionMode: 'icon',
    macroActionMode: 'icon',
  },
  {
    showProjectName: false,
    showProjectSelector: false,
    showCodeState: true,
    showMetadataLabel: true,
    showMacroHint: false,
    codeActionMode: 'icon',
    macroActionMode: 'icon',
  },
  {
    showProjectName: false,
    showProjectSelector: false,
    showCodeState: false,
    showMetadataLabel: true,
    showMacroHint: false,
    codeActionMode: 'icon',
    macroActionMode: 'icon',
  },
  {
    showProjectName: false,
    showProjectSelector: false,
    showCodeState: false,
    showMetadataLabel: false,
    showMacroHint: false,
    codeActionMode: 'icon',
    macroActionMode: 'icon',
  },
  {
    showProjectName: false,
    showProjectSelector: false,
    showCodeState: false,
    showMetadataLabel: false,
    showMacroHint: false,
    codeActionMode: 'hidden',
    macroActionMode: 'icon',
  },
  {
    showProjectName: false,
    showProjectSelector: false,
    showCodeState: false,
    showMetadataLabel: false,
    showMacroHint: false,
    codeActionMode: 'hidden',
    macroActionMode: 'hidden',
  },
];

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
  const {
    selectedGroupId,
    selectedProjectId,
    projectGroups,
    switchProjectContext,
    metadataSyncState,
    metadataSyncError,
    metadataSyncReason,
    metadataSyncNextAction,
    metadataConflictFiles,
    metadataSyncRepositories,
  } = useAppStore(useShallow((state) => ({
    selectedGroupId: state.selectedGroupId,
    selectedProjectId: state.selectedProjectId,
    projectGroups: state.projectGroups,
    switchProjectContext: state.switchProjectContext,
    metadataSyncState: state.metadataSyncState,
    metadataSyncError: state.metadataSyncError,
    metadataSyncReason: state.metadataSyncReason,
    metadataSyncNextAction: state.metadataSyncNextAction,
    metadataConflictFiles: state.metadataConflictFiles,
    metadataSyncRepositories: state.metadataSyncRepositories,
  })));
  const notificationItems = useNotificationCenterStore((state) => state.items);
  const isNotificationCenterOpen = useNotificationCenterStore((state) => state.isCenterOpen);
  const setNotificationCenterOpen = useNotificationCenterStore((state) => state.setCenterOpen);

  const [codeStatus, setCodeStatus] = useState<CodeStatusSnapshot>(DEFAULT_CODE_STATUS);
  const [codeAction, setCodeAction] = useState<'pull' | 'push' | null>(null);
  const [macroAction, setMacroAction] = useState<'commit' | 'pull' | 'push' | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [showConflictModal, setShowConflictModal] = useState<boolean>(false);
  const [macroSnapshot, setMacroSnapshot] = useState<tauriIpc.MacroBranchSyncDto | null>(null);
  const [adaptiveLayoutIndex, setAdaptiveLayoutIndex] = useState(0);

  const lastConflictToastAtRef = useRef(0);
  const lastMacroConflictActionRef = useRef<MacroConflictContext | null>(null);
  const refreshFooterStatusRef = useRef<Promise<void> | null>(null);
  const notificationCenterButtonRef = useRef<HTMLButtonElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const footerContentRef = useRef<HTMLDivElement>(null);
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
      toast.error(t('footer.sync.macroConflictDetected', '@macro conflict detected'), {
        description,
        notification: {
          category: 'git_sync_attention_required',
        },
      });
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
      if (refreshFooterStatusRef.current) {
        return refreshFooterStatusRef.current;
      }

      const run = (async () => {
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
      })().finally(() => {
        if (refreshFooterStatusRef.current === run) {
          refreshFooterStatusRef.current = null;
        }
      });

      refreshFooterStatusRef.current = run;
      return run;
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

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleRefresh = (delayMs: number) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => {
        if (disposed) {
          return;
        }

        if (document.visibilityState === 'visible') {
          void refreshFooterStatus();
        }

        scheduleRefresh(20000);
      }, delayMs);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshFooterStatus();
      }
      scheduleRefresh(20000);
    };

    scheduleRefresh(20000);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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
        notification: {
          category: 'git_sync_completed',
        },
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
        notification: {
          category: 'git_sync_completed',
        },
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
          notification: {
            category: 'git_sync_attention_required',
          },
        });
      } else if (result.state === 'pending') {
        toast.info(t('footer.sync.macroPullBlocked', '@macro pull blocked'), {
          description: getMacroSyncDescription(result) || t('footer.sync.macroSyncRequiresAction', 'Metadata sync still requires another action first.'),
          notification: {
            category: 'git_sync_attention_required',
          },
        });
      } else {
        toast.success(t('footer.sync.macroPullComplete', '@macro pull complete'), {
          description: formatGitOutput(result.output, translate),
          notification: {
            category: 'git_sync_completed',
          },
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
          notification: {
            category: 'git_sync_completed',
          },
        });
      } else if (result.state === 'failed') {
        toast.error(t('footer.sync.macroCommitFailed', '@macro commit failed'), {
          description: getMacroSyncDescription(result) || t('footer.sync.macroCommitFailedDescription', 'Metadata commit failed.'),
          notification: {
            category: 'git_sync_attention_required',
          },
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
          notification: {
            category: 'git_sync_attention_required',
          },
        });
      } else if (result.state === 'pending') {
        toast.info(t('footer.sync.macroPushPartiallyComplete', '@macro push partially complete'), {
          description:
            getMacroSyncDescription(result) ||
            formatGitOutput(result.output, translate) ||
            t('footer.sync.macroPendingDifferences', 'Metadata sync still has pending local or remote differences.'),
          notification: {
            category: 'git_sync_attention_required',
          },
        });
      } else {
        toast.success(t('footer.sync.macroPushComplete', '@macro push complete'), {
          description: formatGitOutput(result.output, translate),
          notification: {
            category: 'git_sync_completed',
          },
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
  const adaptiveLayout = FOOTER_ADAPTIVE_LAYOUTS[adaptiveLayoutIndex] || FOOTER_ADAPTIVE_LAYOUTS[FOOTER_ADAPTIVE_LAYOUTS.length - 1];
  const adaptiveResetKey = useMemo(
    () => [
      selectedGlobalProject?.name || '',
      focusProjects.length > 1 ? 'multiple-projects' : 'single-project',
      focusedProject?.id || '',
      codeStatus.branch,
      codeStateLabel,
      metadataLabel,
      macroHint,
      metadataSyncState,
      metadataSyncState === 'conflict' ? 'conflict' : 'ok',
      codeAction || 'idle',
      macroAction || 'idle',
    ].join('|'),
    [
      selectedGlobalProject?.name,
      focusProjects.length,
      focusedProject?.id,
      codeStatus.branch,
      codeStateLabel,
      metadataLabel,
      macroHint,
      metadataSyncState,
      codeAction,
      macroAction,
    ]
  );

  const controlsDisabled = !isTauriRuntime;
  const showProjectSelector = adaptiveLayout.showProjectSelector && focusProjects.length > 1;
  const showScopedProjectContext = showProjectSelector || adaptiveLayout.showCodeState || Boolean(codeStatus.branch);

  useLayoutEffect(() => {
    setAdaptiveLayoutIndex(0);
  }, [adaptiveResetKey]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const footerElement = footerRef.current;
    if (!footerElement) {
      return;
    }

    let frameId = 0;
    const resetLayout = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        setAdaptiveLayoutIndex(0);
      });
    };

    const observer = new ResizeObserver(() => {
      resetLayout();
    });
    observer.observe(footerElement);

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const footerContent = footerContentRef.current;
    if (!footerContent) {
      return;
    }

    if (footerContent.scrollWidth <= footerContent.clientWidth + 1) {
      return;
    }

    if (adaptiveLayoutIndex >= FOOTER_ADAPTIVE_LAYOUTS.length - 1) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      setAdaptiveLayoutIndex((currentIndex) => Math.min(currentIndex + 1, FOOTER_ADAPTIVE_LAYOUTS.length - 1));
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [adaptiveLayoutIndex, adaptiveResetKey]);

  return (
    <>
      <footer ref={footerRef} className="h-8 overflow-hidden border-t border-border bg-card pr-2 pl-4 text-[11px] text-muted-foreground sm:pr-3 sm:pl-4">
        <div
          ref={footerContentRef}
          className="grid h-full w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 overflow-hidden"
        >
          <div className="flex min-w-0 items-center overflow-hidden">
            {adaptiveLayout.showProjectName && (
              <span className="flex min-w-0 max-w-[11rem] items-center gap-1.5" title={selectedGlobalProject?.name || undefined}>
                <Icon name="layers" size={12} className="text-primary shrink-0" />
                <span className="truncate text-foreground">
                  {selectedGlobalProject?.name || t('project.noGroup', 'No global project')}
                </span>
              </span>
            )}

            {showScopedProjectContext && (
              <div
                className={cn(
                  'flex min-w-0 items-center gap-2 overflow-hidden',
                  adaptiveLayout.showProjectName && 'ml-2 border-l border-border/70 pl-2.5'
                )}
              >
                {showProjectSelector && (
                  <select
                    className="h-6 w-32 shrink-0 rounded border border-border bg-card px-2 text-[11px] text-foreground"
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

                <span className="flex min-w-0 max-w-[10rem] items-center gap-1.5" title={codeStatus.branch}>
                  <Icon name="git-branch" size={12} className="text-blue-400 shrink-0" />
                  <span className="truncate">{codeStatus.branch}</span>
                </span>

                {adaptiveLayout.showCodeState && (
                  <span className={`shrink-0 whitespace-nowrap ${codeStateClass}`}>{codeStateLabel}</span>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-center gap-1 px-1">
            <div className="flex shrink-0 items-center gap-0.5">
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
            </div>

            {adaptiveLayout.codeActionMode !== 'hidden' && (
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 text-[11px]',
                    adaptiveLayout.codeActionMode === 'icon' ? 'w-6 px-0' : 'px-2'
                  )}
                  title={codeAction === 'pull'
                    ? t('footer.sync.pulling', 'Pulling...')
                    : t('footer.sync.pull', 'Pull')}
                  disabled={controlsDisabled || !repoPath || !!codeAction}
                  onClick={() => void handleCodePull()}
                >
                  {adaptiveLayout.codeActionMode === 'icon' ? (
                    <Icon
                      name="download"
                      size={12}
                      className={codeAction === 'pull' ? 'animate-pulse' : ''}
                    />
                  ) : (
                    codeAction === 'pull'
                      ? t('footer.sync.pulling', 'Pulling...')
                      : t('footer.sync.pull', 'Pull')
                  )}
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 text-[11px]',
                    adaptiveLayout.codeActionMode === 'icon' ? 'w-6 px-0' : 'px-2'
                  )}
                  title={codeAction === 'push'
                    ? t('footer.sync.pushing', 'Pushing...')
                    : t('footer.sync.push', 'Push')}
                  disabled={controlsDisabled || !repoPath || !!codeAction}
                  onClick={() => void handleCodePush()}
                >
                  {adaptiveLayout.codeActionMode === 'icon' ? (
                    <Icon
                      name="upload"
                      size={12}
                      className={codeAction === 'push' ? 'animate-pulse' : ''}
                    />
                  ) : (
                    codeAction === 'push'
                      ? t('footer.sync.pushing', 'Pushing...')
                      : t('footer.sync.push', 'Push')
                  )}
                </Button>
              </div>
            )}
          </div>

          <div className="flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
            <div className="flex min-w-0 items-center justify-end gap-1 overflow-hidden">
              {adaptiveLayout.showMetadataLabel && (
                <span className={`flex min-w-0 flex-[0_1_11rem] items-center gap-1 max-w-[14rem] ${metadataLabelClass}`} title={macroTooltip || undefined}>
                  <Icon name="folder-git-2" size={12} className="shrink-0" />
                  <span className="truncate">{metadataLabel}</span>
                </span>
              )}
              {adaptiveLayout.showMacroHint && macroHint && (
                <span className="min-w-0 flex-[0_1_12rem] truncate text-muted-foreground/80 max-w-[14rem]" title={macroTooltip || undefined}>
                  {macroHint}
                </span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              {adaptiveLayout.macroActionMode !== 'hidden' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 text-[11px]',
                    adaptiveLayout.macroActionMode === 'icon' ? 'w-6 px-0' : 'px-2'
                  )}
                  title={macroAction === 'commit'
                    ? t('footer.sync.macroCommitting', '@macro committing...')
                    : t('footer.sync.macroCommit', '@macro commit')}
                  disabled={controlsDisabled || !!macroAction}
                  onClick={() => void handleMacroCommit()}
                >
                  {adaptiveLayout.macroActionMode === 'icon' ? (
                    <Icon
                      name="git-commit"
                      size={12}
                      className={macroAction === 'commit' ? 'animate-pulse' : ''}
                    />
                  ) : (
                    macroAction === 'commit'
                      ? t('footer.sync.macroCommitting', '@macro committing...')
                      : t('footer.sync.macroCommit', '@macro commit')
                  )}
                </Button>
              )}

              {adaptiveLayout.macroActionMode !== 'hidden' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 text-[11px]',
                    adaptiveLayout.macroActionMode === 'icon' ? 'w-6 px-0' : 'px-2'
                  )}
                  title={macroAction === 'pull'
                    ? t('footer.sync.macroPulling', '@macro pulling...')
                    : t('footer.sync.macroPull', '@macro pull')}
                  disabled={controlsDisabled || !!macroAction}
                  onClick={() => void handleMacroPull()}
                >
                  {adaptiveLayout.macroActionMode === 'icon' ? (
                    <Icon
                      name="download"
                      size={12}
                      className={macroAction === 'pull' ? 'animate-pulse' : ''}
                    />
                  ) : (
                    macroAction === 'pull'
                      ? t('footer.sync.macroPulling', '@macro pulling...')
                      : t('footer.sync.macroPull', '@macro pull')
                  )}
                </Button>
              )}

              {adaptiveLayout.macroActionMode !== 'hidden' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 text-[11px]',
                    adaptiveLayout.macroActionMode === 'icon' ? 'w-6 px-0' : 'px-2'
                  )}
                  title={macroAction === 'push'
                    ? t('footer.sync.macroPushing', '@macro pushing...')
                    : t('footer.sync.macroPush', '@macro push')}
                  disabled={controlsDisabled || !!macroAction}
                  onClick={() => void handleMacroPush()}
                >
                  {adaptiveLayout.macroActionMode === 'icon' ? (
                    <Icon
                      name="upload"
                      size={12}
                      className={macroAction === 'push' ? 'animate-pulse' : ''}
                    />
                  ) : (
                    macroAction === 'push'
                      ? t('footer.sync.macroPushing', '@macro pushing...')
                      : t('footer.sync.macroPush', '@macro push')
                  )}
                </Button>
              )}

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
            </div>

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
