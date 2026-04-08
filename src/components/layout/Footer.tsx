import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { createMacroSyncService, getMacroSyncDescription } from '../../services/macroSyncService';
import { getGlobalProjectById, getSubProjectsForGroup } from '../../services/globalProjects';
import { NotificationCenterPopover } from './NotificationCenterPopover';
import { cn } from '../../utils/cn';

type FooterSyncAction = 'fetch' | 'pull' | 'push';
type MacroConflictContext = FooterSyncAction | 'refresh';
type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string;

interface ScopedProject {
  id: string;
  name: string;
  path: string;
}

interface CodeStatusSnapshot {
  branch: string | null;
  ahead: number;
  behind: number;
}

interface RepositorySyncResult {
  projectName: string;
  success: boolean;
  message: string;
}

const ALL_PROJECTS_OPTION = '__all__';
const DEFAULT_CODE_STATUS: CodeStatusSnapshot = { branch: null, ahead: 0, behind: 0 };

const formatGitOutput = (output: string | null | undefined, t: TranslateFn): string => {
  const normalized = (output || '').trim();
  if (!normalized) return t('footer.sync.done', 'Done.');
  return normalized.split('\n').map((line) => line.trim()).filter(Boolean).slice(-2).join(' | ');
};

const unavailableGitStatus = (branch: string): tauriIpc.GitStatusDto => ({
  branch,
  head_commit: null,
  staged_files: [],
  unstaged_files: [],
  untracked_files: [],
  conflicted_files: [],
  merge_in_progress: false,
  conflictedFiles: [],
  mergeInProgress: false,
  is_clean: false,
  has_origin: false,
  has_upstream: false,
  ahead: 0,
  behind: 0,
});

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

  const [codeStatus, setCodeStatus] = useState(DEFAULT_CODE_STATUS);
  const [macroSnapshot, setMacroSnapshot] = useState<tauriIpc.MacroBranchSyncDto | null>(null);
  const [syncAction, setSyncAction] = useState<FooterSyncAction | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);

  const refreshRef = useRef<Promise<void> | null>(null);
  const notificationCenterButtonRef = useRef<HTMLButtonElement>(null);
  const lastConflictToastAtRef = useRef(0);
  const lastMacroConflictActionRef = useRef<MacroConflictContext | null>(null);

  const selectedGlobalProject = useMemo(
    () => getGlobalProjectById(projectGroups, selectedGroupId),
    [projectGroups, selectedGroupId]
  );
  const focusProjects = useMemo(
    () => getSubProjectsForGroup(projectGroups, selectedGroupId),
    [projectGroups, selectedGroupId]
  );
  const scopeProjects = useMemo<ScopedProject[]>(
    () => (selectedProjectId ? focusProjects.filter((project) => project.id === selectedProjectId) : focusProjects),
    [focusProjects, selectedProjectId]
  );
  const selectedProjectLabel = useMemo(
    () => (selectedProjectId
      ? focusProjects.find((project) => project.id === selectedProjectId)?.name ?? ''
      : t('footer.scope.allProjects', 'Tout le projet')),
    [focusProjects, selectedProjectId, t]
  );
  const scopedMacroSyncService = useMemo(
    () => createMacroSyncService({
      tauriIpc,
      getAppState: () => useAppStore.getState(),
      toServiceError,
      resolveTargets: async () => scopeProjects.map((project) => ({ repoPath: project.path, projectId: project.id })),
    }),
    [scopeProjects]
  );

  const totalBehind = codeStatus.behind + (macroSnapshot?.behind ?? 0);
  const totalAhead = codeStatus.ahead + (macroSnapshot?.ahead ?? 0);
  const hasUnreadNotificationDot = useMemo(() => hasUnreadNotifications(notificationItems), [notificationItems]);

  const presentConflictIfNeeded = useCallback((result: tauriIpc.MacroBranchSyncDto, context: MacroConflictContext) => {
    if (result.state !== 'conflict') return;
    lastMacroConflictActionRef.current = context;
    setShowConflictModal(true);
    if (Date.now() - lastConflictToastAtRef.current < 12000) return;
    toast.error(t('footer.sync.macroConflictDetected', '@macro conflict detected'), {
      description: t('footer.sync.macroConflictGenericDescription', '@macro has unresolved conflicts. Resolve them, then retry the same sync step.'),
      notification: { category: 'git_sync_attention_required' },
    });
    lastConflictToastAtRef.current = Date.now();
  }, [t]);

  const refreshCodeStatus = useCallback(async () => {
    if (!isTauriRuntime || scopeProjects.length === 0) {
      setCodeStatus(DEFAULT_CODE_STATUS);
      return;
    }

    const unavailableLabel = t('footer.sync.branchUnavailable', 'unavailable');
    const detachedLabel = t('footer.sync.branchDetached', 'detached');
    const statuses = await Promise.all(scopeProjects.map(async (project) => {
      try {
        return await tauriIpc.gitStatus(project.path);
      } catch {
        return unavailableGitStatus(unavailableLabel);
      }
    }));

    setCodeStatus({
      branch: selectedProjectId ? (statuses[0]?.branch || detachedLabel) : null,
      ahead: statuses.reduce((sum, status) => sum + status.ahead, 0),
      behind: statuses.reduce((sum, status) => sum + status.behind, 0),
    });
  }, [isTauriRuntime, scopeProjects, selectedProjectId, t]);

  const refreshMacroStatus = useCallback(async (ensure = false) => {
    if (!isTauriRuntime) {
      setMacroSnapshot(null);
      return null;
    }
    const result = await scopedMacroSyncService.refreshMacroSyncStatus({ ensure });
    if (result) {
      setMacroSnapshot(result);
      presentConflictIfNeeded(result, 'refresh');
    }
    return result;
  }, [isTauriRuntime, presentConflictIfNeeded, scopedMacroSyncService]);

  const refreshFooterStatus = useCallback(async (options?: { ensureMacro?: boolean; showBusy?: boolean }) => {
    if (refreshRef.current) return refreshRef.current;
    const run = (async () => {
      if (options?.showBusy) setIsRefreshing(true);
      try {
        await Promise.all([refreshCodeStatus(), refreshMacroStatus(Boolean(options?.ensureMacro))]);
      } finally {
        if (options?.showBusy) setIsRefreshing(false);
      }
    })().finally(() => {
      if (refreshRef.current === run) refreshRef.current = null;
    });
    refreshRef.current = run;
    return run;
  }, [refreshCodeStatus, refreshMacroStatus]);

  useEffect(() => {
    void refreshFooterStatus({ ensureMacro: true });
  }, [refreshFooterStatus]);

  useEffect(() => {
    if (metadataSyncState === 'conflict') setShowConflictModal(true);
  }, [metadataSyncState]);

  const runCodeAction = useCallback(async (action: FooterSyncAction): Promise<RepositorySyncResult[]> => {
    const results: RepositorySyncResult[] = [];
    for (const project of scopeProjects) {
      try {
        const result = action === 'fetch'
          ? await tauriIpc.gitFetch({ repoPath: project.path })
          : action === 'pull'
            ? await tauriIpc.gitPull({ repoPath: project.path })
            : await tauriIpc.gitPush({ repoPath: project.path });
        results.push({ projectName: project.name, success: true, message: formatGitOutput(result.output, translate) });
      } catch (error) {
        results.push({ projectName: project.name, success: false, message: toServiceError(error).message });
      }
    }
    return results;
  }, [scopeProjects, translate]);

  const describeMacroResultForToast = useCallback((action: FooterSyncAction, result: tauriIpc.MacroBranchSyncDto | null) => {
    if (!result) {
      return '';
    }

    if (result.reason === 'dirty') {
      return action === 'fetch'
        ? t(
          'footer.sync.fetchDirtyDescription',
          'Le fetch du code est terminé. @macro a encore des changements locaux a enregistrer.'
        )
        : t(
          'footer.sync.macroDirtyDescription',
          '@macro a encore des changements locaux a enregistrer avant le pull ou le push.'
        );
    }

    return `@macro: ${getMacroSyncDescription(result) || formatGitOutput(result.output, translate)}`;
  }, [t, translate]);

  const handleCommitMacroMetadata = useCallback(async () => {
    if (!isTauriRuntime || syncAction || scopeProjects.length === 0) {
      return;
    }

    setIsRefreshing(true);
    try {
      const result = await scopedMacroSyncService.commitMacroMetadata();
      if (result) {
        setMacroSnapshot(result);
        presentConflictIfNeeded(result, 'refresh');
      }

      const description = describeMacroResultForToast('fetch', result);
      const hasErrors = result?.state === 'failed' || result?.state === 'conflict';
      if (hasErrors) {
        toast.error(t('footer.sync.macroCommitFailed', '@macro commit failed'), {
          description,
          notification: { category: 'git_sync_attention_required' },
        });
      } else {
        toast.success(t('footer.sync.macroCommitComplete', '@macro commit complete'), {
          description,
          notification: {
            category: result?.state === 'pending' ? 'git_sync_attention_required' : 'git_sync_completed',
          },
        });
      }
    } finally {
      await refreshFooterStatus({ ensureMacro: true });
      setIsRefreshing(false);
    }
  }, [describeMacroResultForToast, isTauriRuntime, presentConflictIfNeeded, refreshFooterStatus, scopeProjects.length, scopedMacroSyncService, syncAction, t]);

  const handleSyncAction = useCallback(async (action: FooterSyncAction) => {
    if (!isTauriRuntime || syncAction || scopeProjects.length === 0) return;
    setSyncAction(action);
    lastMacroConflictActionRef.current = action;
    try {
      const codeResults = await runCodeAction(action);
      const macroResult = action === 'fetch'
        ? await scopedMacroSyncService.refreshMacroSyncStatus({ ensure: true })
        : action === 'pull'
          ? await scopedMacroSyncService.pullMacroMetadata()
          : await scopedMacroSyncService.pushMacroMetadata();
      if (macroResult) {
        setMacroSnapshot(macroResult);
        presentConflictIfNeeded(macroResult, action);
      }

      const successes = codeResults.filter((result) => result.success).length;
      const failures = codeResults.filter((result) => !result.success);
      const codeSummary = codeResults.length > 0
        ? [`${successes}/${codeResults.length} repos`, ...failures.slice(0, 2).map((result) => `${result.projectName}: ${result.message}`)].join(' | ')
        : '';
      const macroSummary = describeMacroResultForToast(action, macroResult);
      const description = [codeSummary, macroSummary].filter(Boolean).join(' | ');
      const hasErrors = failures.length > 0 || macroResult?.state === 'failed' || macroResult?.state === 'conflict';
      const hasPending = macroResult?.state === 'pending';
      const pendingActions = macroResult?.next_action === 'commit'
        ? [{
          label: t('footer.sync.macroSaveAction', 'Enregistrer @macro'),
          variant: 'primary' as const,
          onClick: async () => {
            await handleCommitMacroMetadata();
          },
        }]
        : undefined;
      if (hasErrors) {
        toast.error(t(`footer.sync.${action}Incomplete`, `${action} incomplete`), { description, notification: { category: 'git_sync_attention_required' } });
      } else if (hasPending) {
        toast.info(t(`footer.sync.${action}Pending`, `${action} requires attention`), {
          description,
          actions: pendingActions,
          notification: { category: 'git_sync_attention_required' },
        });
      } else {
        toast.success(t(`footer.sync.${action}Complete`, `${action} complete`), { description, notification: { category: 'git_sync_completed' } });
      }
    } finally {
      await refreshFooterStatus({ ensureMacro: action === 'fetch' });
      setSyncAction(null);
    }
  }, [describeMacroResultForToast, handleCommitMacroMetadata, isTauriRuntime, presentConflictIfNeeded, refreshFooterStatus, runCodeAction, scopeProjects.length, scopedMacroSyncService, syncAction, t]);

  const macroConflictEntries = useMemo<ConflictResolutionEntry[]>(() => {
    const repositories = metadataSyncRepositories.length > 0 ? metadataSyncRepositories : scopeProjects.map((project) => ({
      repoPath: project.path,
      projectId: project.id,
      worktreePath: macroSnapshot?.worktree_path || null,
      state: metadataSyncState,
      error: metadataSyncError,
      reason: metadataSyncReason,
      nextAction: metadataSyncNextAction,
      conflictFiles: metadataConflictFiles,
    }));
    return toMacroConflictResolutionEntries(repositories);
  }, [macroSnapshot, metadataConflictFiles, metadataSyncError, metadataSyncNextAction, metadataSyncReason, metadataSyncRepositories, metadataSyncState, scopeProjects]);

  const openAiConflictAssistant = async () => {
    const repositories = metadataSyncRepositories.length > 0 ? metadataSyncRepositories : scopeProjects.map((project) => ({
      repoPath: project.path,
      projectId: project.id,
      worktreePath: macroSnapshot?.worktree_path || null,
      state: metadataSyncState,
      error: metadataSyncError,
      reason: metadataSyncReason,
      nextAction: metadataSyncNextAction,
      conflictFiles: metadataConflictFiles,
    }));
    try {
      await openConflictAssistant(buildMacroConflictAssistantPrompt({ repositories }));
      toast.success(t('footer.sync.aiConflictAssistantStarted', 'AI conflict assistant started'));
      setShowConflictModal(false);
    } catch (error) {
      toast.error(t('footer.sync.aiConflictAssistantStartFailed', 'Failed to start AI assistant'), { description: toServiceError(error).message });
    }
  };

  const handleRetryMacroSync = async () => {
    const action = lastMacroConflictActionRef.current;
    if (action === 'fetch' || action === 'pull' || action === 'push') {
      await handleSyncAction(action);
      return;
    }
    await refreshFooterStatus({ ensureMacro: true, showBusy: true });
    if (useAppStore.getState().metadataSyncState !== 'conflict') setShowConflictModal(false);
  };

  return (
    <>
      <footer className="h-8 overflow-hidden border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
        <div className="flex h-full min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center overflow-hidden">
            <span className="flex h-6 min-w-0 max-w-[12rem] items-center gap-1.5" title={selectedGlobalProject?.name || undefined}>
              <Icon name="layers" size={12} className="block translate-x-[0.25px] -translate-y-[0.5px] shrink-0 text-primary" />
              <span className="truncate leading-none text-foreground">{selectedGlobalProject?.name || t('project.noGroup', 'No global project')}</span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-2 h-6 w-6 shrink-0 px-0 text-[11px]"
              disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
              onClick={() => void handleSyncAction('fetch')}
            >
              <Icon
                name="refresh-cw"
                size={12}
                className={cn(
                  'block translate-x-[0.25px] -translate-y-[0.5px]',
                  (syncAction === 'fetch' || isRefreshing) && 'animate-spin'
                )}
              />
            </Button>
            {(focusProjects.length > 0 || codeStatus.branch || totalAhead > 0 || totalBehind > 0) && (
              <div className="flex min-w-0 items-center overflow-hidden">
                <span aria-hidden="true" className="mx-2 h-4 w-px shrink-0 bg-border/70" />
                <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                {focusProjects.length > 0 && (
                  <div className="ml-1 grid shrink-0">
                    <span
                      aria-hidden="true"
                      className="invisible col-start-1 row-start-1 h-6 whitespace-pre rounded border border-transparent px-2 pr-6 text-[11px]"
                    >
                      {selectedProjectLabel}
                    </span>
                    <select
                      className="col-start-1 row-start-1 h-6 min-w-0 rounded border border-border bg-card px-2 pr-6 text-[11px] text-foreground"
                      value={selectedProjectId ?? ALL_PROJECTS_OPTION}
                      onChange={(event) => void switchProjectContext(event.target.value === ALL_PROJECTS_OPTION ? null : event.target.value)}
                    >
                      <option value={ALL_PROJECTS_OPTION}>{t('footer.scope.allProjects', 'Tout le projet')}</option>
                      {focusProjects.map((project) => (
                        <option key={project.id} value={project.id}>{project.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {selectedProjectId && codeStatus.branch && (
                  <span className="flex min-w-0 max-w-[10rem] items-center gap-1.5" title={codeStatus.branch}>
                    <Icon name="git-branch" size={12} className="shrink-0 text-blue-400" />
                    <span className="truncate">{codeStatus.branch}</span>
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 shrink-0 gap-1 px-2 text-[11px] font-medium',
                    totalBehind > 0 ? 'text-amber-400 hover:text-amber-300' : 'text-muted-foreground/80'
                  )}
                  disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
                  onClick={() => void handleSyncAction('pull')}
                >
                  <Icon name="arrow-down" size={12} className={cn(syncAction === 'pull' && 'animate-bounce')} />
                  <span>{totalBehind}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 shrink-0 gap-1 px-2 text-[11px] font-medium',
                    totalAhead > 0 ? 'text-emerald-400 hover:text-emerald-300' : 'text-muted-foreground/80'
                  )}
                  disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
                  onClick={() => void handleSyncAction('push')}
                >
                  <Icon name="arrow-up" size={12} className={cn(syncAction === 'push' && 'animate-bounce')} />
                  <span>{totalAhead}</span>
                </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {metadataSyncState === 'conflict' && (
              <Button size="sm" variant="error" className="h-6 px-2 text-[11px]" onClick={() => setShowConflictModal(true)}>
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
              className={cn('relative h-6 w-6 px-0 text-[11px]', isNotificationCenterOpen && 'bg-accent text-foreground hover:bg-accent')}
              onClick={() => setNotificationCenterOpen(!isNotificationCenterOpen)}
            >
              <Icon name="bell" size={12} />
              {hasUnreadNotificationDot && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full border border-card bg-primary" />}
            </Button>
          </div>
        </div>
      </footer>

      {showConflictModal && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowConflictModal(false)} />
          <div className="relative w-full max-w-3xl rounded-xl border border-border bg-card p-4 shadow-2xl">
            <ConflictResolutionPanel
              title={t('footer.sync.macroConflictTitle', '@macro sync conflict')}
              description={t('footer.sync.macroConflictDescription', 'Resolve the reported metadata blockers, then retry the same sync step.')}
              repositories={macroConflictEntries}
              error={metadataSyncError}
              retryLabel={t('footer.sync.retrySync', 'Retry sync')}
              retryDisabled={Boolean(syncAction)}
              retryLoading={Boolean(syncAction) || isRefreshing}
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
