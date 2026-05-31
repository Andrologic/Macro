import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { notify } from '../ui/toastService';
import { useAppStore, type MetadataSyncRepositoryStatus } from '../../stores/useAppStore';
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
import { presentMetadataSyncIssue } from '../../services/degradedErrorPresentation';
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

interface FooterMetadataSyncState {
  state: tauriIpc.MacroSyncState;
  error: string | null;
  reason: tauriIpc.MacroSyncReason | null;
  nextAction: tauriIpc.MacroSyncNextAction | null;
  conflictFiles: string[];
  repositories: MetadataSyncRepositoryStatus[];
}

interface PushRemoteResolutionEntry {
  projectId: string | null;
  projectName: string;
  repoPath: string;
  url: string;
  source: 'code' | 'metadata' | 'code_and_metadata';
}

interface PushPreflightCodeEntry {
  project: ScopedProject;
  status: tauriIpc.GitStatusDto | null;
  error: string | null;
}

interface MetadataOriginCandidate {
  repoPath: string;
  projectId: string | null;
  reason: tauriIpc.MacroSyncReason | null;
  nextAction: tauriIpc.MacroSyncNextAction | null;
}

type MacroSyncResultWithRepositories = tauriIpc.MacroBranchSyncDto & {
  repositories?: MetadataSyncRepositoryStatus[];
};

interface PushMissingOriginResolution {
  kind: 'missing_origin';
  scopeProjects: ScopedProject[];
  readyProjects: ScopedProject[];
  entries: PushRemoteResolutionEntry[];
  error: string | null;
}

interface PushMissingUpstreamResolution {
  kind: 'missing_upstream';
  macroResult: tauriIpc.MacroBranchSyncDto;
  scopeProjects: ScopedProject[];
  context: 'push' | 'resolve';
}

type PushResolutionState = PushMissingOriginResolution | PushMissingUpstreamResolution;

const ALL_PROJECTS_OPTION = '__all__';
const DEFAULT_CODE_STATUS: CodeStatusSnapshot = { branch: null, ahead: 0, behind: 0 };
const DEFAULT_FOOTER_METADATA_SYNC: FooterMetadataSyncState = {
  state: 'clean',
  error: null,
  reason: null,
  nextAction: null,
  conflictFiles: [],
  repositories: [],
};

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
    standaloneProjects,
    projectGroups,
    getProjectById,
    metadataMissingUpstreamPolicy,
    setMetadataMissingUpstreamPolicy,
  } = useAppStore(useShallow((state) => ({
    selectedGroupId: state.selectedGroupId,
    selectedProjectId: state.selectedProjectId,
    standaloneProjects: state.standaloneProjects ?? [],
    projectGroups: state.projectGroups,
    getProjectById: state.getProjectById,
    metadataMissingUpstreamPolicy: state.metadataMissingUpstreamPolicy,
    setMetadataMissingUpstreamPolicy: state.setMetadataMissingUpstreamPolicy,
  })));
  const notificationItems = useNotificationCenterStore((state) => state.items);
  const isNotificationCenterOpen = useNotificationCenterStore((state) => state.isCenterOpen);
  const setNotificationCenterOpen = useNotificationCenterStore((state) => state.setCenterOpen);

  const [gitScopeProjectId, setGitScopeProjectId] = useState<string | null>(null);
  const [codeStatus, setCodeStatus] = useState(DEFAULT_CODE_STATUS);
  const [focusedProjectBranch, setFocusedProjectBranch] = useState<string | null>(null);
  const [macroSnapshot, setMacroSnapshot] = useState<tauriIpc.MacroBranchSyncDto | null>(null);
  const [footerMetadataSync, setFooterMetadataSync] = useState<FooterMetadataSyncState>(
    DEFAULT_FOOTER_METADATA_SYNC
  );
  const [syncAction, setSyncAction] = useState<FooterSyncAction | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [pushResolution, setPushResolution] = useState<PushResolutionState | null>(null);
  const [isConfiguringRemote, setIsConfiguringRemote] = useState(false);

  const refreshRef = useRef<Promise<void> | null>(null);
  const notificationCenterButtonRef = useRef<HTMLButtonElement>(null);
  const lastConflictToastAtRef = useRef(0);
  const lastMacroConflictActionRef = useRef<MacroConflictContext | null>(null);
  const footerMetadataSyncRef = useRef(footerMetadataSync);

  const selectedGlobalProject = useMemo(
    () => getGlobalProjectById(projectGroups, selectedGroupId),
    [projectGroups, selectedGroupId]
  );
  const allProjectsById = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.projects.map((project) => [project.id, project] as const)
        ).concat(standaloneProjects.map((project) => [project.id, project] as const))
      ),
    [projectGroups, standaloneProjects]
  );
  const focusProjects = useMemo<ScopedProject[]>(() => {
    if (selectedGroupId) {
      return getSubProjectsForGroup(projectGroups, selectedGroupId);
    }

    if (selectedProjectId) {
      const selectedProject = getProjectById(selectedProjectId);
      return selectedProject ? [selectedProject] : [];
    }

    return [];
  }, [getProjectById, projectGroups, selectedGroupId, selectedProjectId]);
  const focusedProject = useMemo(
    () => (selectedProjectId ? allProjectsById.get(selectedProjectId) ?? null : null),
    [allProjectsById, selectedProjectId]
  );
  const scopeProjects = useMemo<ScopedProject[]>(
    () => (gitScopeProjectId ? focusProjects.filter((project) => project.id === gitScopeProjectId) : focusProjects),
    [focusProjects, gitScopeProjectId]
  );
  const selectedProjectLabel = useMemo(
    () => (gitScopeProjectId
      ? focusProjects.find((project) => project.id === gitScopeProjectId)?.name ?? ''
      : t('footer.scope.allProjects', 'Tout le projet')),
    [focusProjects, gitScopeProjectId, t]
  );
  const setFooterMetadataSyncStatus = useCallback((params: {
    state: tauriIpc.MacroSyncState;
    error?: string | null;
    reason?: tauriIpc.MacroSyncReason | null;
    nextAction?: tauriIpc.MacroSyncNextAction | null;
    conflictFiles?: string[];
    repositories?: MetadataSyncRepositoryStatus[];
  }) => {
    setFooterMetadataSync({
      state: params.state,
      error: params.error ?? null,
      reason: params.reason ?? null,
      nextAction: params.nextAction ?? null,
      conflictFiles: params.state === 'conflict' ? (params.conflictFiles ?? []) : [],
      repositories: params.repositories ?? [],
    });
  }, []);
  const createMacroSyncServiceForProjects = useCallback((projects: ScopedProject[]) =>
    createMacroSyncService({
      tauriIpc,
      getAppState: () => ({
        ...useAppStore.getState(),
        setMetadataSyncStatus: setFooterMetadataSyncStatus,
      }),
      toServiceError,
      resolveTargets: async () => projects.map((project) => ({ repoPath: project.path, projectId: project.id })),
    }), [setFooterMetadataSyncStatus]);
  const scopedMacroSyncService = useMemo(
    () => createMacroSyncServiceForProjects(scopeProjects),
    [createMacroSyncServiceForProjects, scopeProjects]
  );

  const codeBehind = codeStatus.behind;
  const codeAhead = codeStatus.ahead;
  const macroBehind = macroSnapshot?.behind ?? 0;
  const macroAhead = macroSnapshot?.ahead ?? 0;
  const pullCountLabel = macroBehind > 0 ? `${codeBehind}@${macroBehind}` : String(codeBehind);
  const pushCountLabel = macroAhead > 0 ? `${codeAhead}@${macroAhead}` : String(codeAhead);
  const hasPullWork = codeBehind > 0 || macroBehind > 0;
  const hasPushWork = codeAhead > 0 || macroAhead > 0;
  const hasUnreadNotificationDot = useMemo(() => hasUnreadNotifications(notificationItems), [notificationItems]);
  const hasMissingUpstream =
    footerMetadataSync.reason === 'missing_upstream' &&
    footerMetadataSync.nextAction === 'push';
  const hasMissingOrigin =
    footerMetadataSync.reason === 'missing_origin' ||
    footerMetadataSync.nextAction === 'configure_remote';
  const shouldPromptForMissingUpstream =
    hasMissingUpstream && metadataMissingUpstreamPolicy !== 'ignore';
  const macroNeedsAttention =
    !hasMissingOrigin &&
    (
      footerMetadataSync.state === 'conflict' ||
      footerMetadataSync.state === 'failed' ||
      shouldPromptForMissingUpstream
    );
  const isMissingUpstreamResolution = shouldPromptForMissingUpstream && footerMetadataSync.state !== 'conflict';
  const canUseMacroAssistant =
    !isMissingUpstreamResolution &&
    (
      footerMetadataSync.state === 'conflict' ||
      footerMetadataSync.reason === 'merge_conflict' ||
      footerMetadataSync.reason === 'diverged' ||
      footerMetadataSync.reason === 'unknown_error'
    );

  const presentConflictIfNeeded = useCallback((result: tauriIpc.MacroBranchSyncDto, context: MacroConflictContext) => {
    if (result.state !== 'conflict') return;
    lastMacroConflictActionRef.current = context;
    setShowConflictModal(true);
    if (Date.now() - lastConflictToastAtRef.current < 12000) return;
    notify.error(t('footer.sync.macroConflictDetected', '@macro conflict detected'), {
      description: t('footer.sync.macroConflictGenericDescription', '@macro has unresolved conflicts. Resolve them, then retry the same sync step.'),
      category: 'git_sync_attention_required',
    });
    lastConflictToastAtRef.current = Date.now();
  }, [t]);

  useEffect(() => {
    setGitScopeProjectId(null);
  }, [selectedGroupId, selectedProjectId]);

  useEffect(() => {
    if (!gitScopeProjectId) return;
    if (!focusProjects.some((project) => project.id === gitScopeProjectId)) {
      setGitScopeProjectId(null);
    }
  }, [focusProjects, gitScopeProjectId]);

  useEffect(() => {
    footerMetadataSyncRef.current = footerMetadataSync;
  }, [footerMetadataSync]);

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
      branch: gitScopeProjectId ? (statuses[0]?.branch || detachedLabel) : null,
      ahead: statuses.reduce((sum, status) => sum + status.ahead, 0),
      behind: statuses.reduce((sum, status) => sum + status.behind, 0),
    });
  }, [gitScopeProjectId, isTauriRuntime, scopeProjects, t]);

  const focusedProjectPath = focusedProject?.path ?? null;

  const refreshFocusedProjectBranch = useCallback(async () => {
    if (!isTauriRuntime || !focusedProjectPath) {
      setFocusedProjectBranch(null);
      return;
    }

    const unavailableLabel = t('footer.sync.branchUnavailable', 'unavailable');
    const detachedLabel = t('footer.sync.branchDetached', 'detached');
    try {
      const status = await tauriIpc.gitStatus(focusedProjectPath);
      setFocusedProjectBranch(status.branch || detachedLabel);
    } catch {
      setFocusedProjectBranch(unavailableLabel);
    }
  }, [focusedProjectPath, isTauriRuntime, t]);

  const readScopedCodeStatuses = useCallback(async (projects: ScopedProject[] = scopeProjects) => {
    const entries: PushPreflightCodeEntry[] = [];
    for (const project of projects) {
      try {
        entries.push({ project, status: await tauriIpc.gitStatus(project.path), error: null });
      } catch (error) {
        entries.push({ project, status: null, error: toServiceError(error).message });
      }
    }
    return entries;
  }, [scopeProjects]);

  const buildMissingOriginResolution = useCallback((
    codeEntries: PushPreflightCodeEntry[],
    macroResult: tauriIpc.MacroBranchSyncDto | null,
    projects: ScopedProject[] = scopeProjects
  ): PushMissingOriginResolution | null => {
    const entriesByPath = new Map<string, PushRemoteResolutionEntry>();
    const addEntry = (
      project: { id: string | null; name: string; path: string },
      source: PushRemoteResolutionEntry['source']
    ) => {
      const existing = entriesByPath.get(project.path);
      if (existing) {
        existing.source = existing.source === source ? source : 'code_and_metadata';
        return;
      }
      entriesByPath.set(project.path, {
        projectId: project.id,
        projectName: project.name,
        repoPath: project.path,
        url: '',
        source,
      });
    };

    for (const entry of codeEntries) {
      if (entry.status && !entry.status.has_origin) {
        addEntry(entry.project, 'code');
      }
    }

    const macroRepositories = (macroResult as MacroSyncResultWithRepositories | null)?.repositories ?? [];
    const metadataRepositories: MetadataOriginCandidate[] = macroRepositories.length
      ? macroRepositories
      : macroResult?.reason === 'missing_origin'
        ? projects.map((project) => ({
            repoPath: project.path,
            projectId: project.id,
            reason: macroResult.reason,
            nextAction: macroResult.next_action,
          }))
        : [];

    for (const repository of metadataRepositories) {
      if (repository.reason !== 'missing_origin' && repository.nextAction !== 'configure_remote') {
        continue;
      }
      const project = projects.find((candidate) => candidate.path === repository.repoPath);
      addEntry({
        id: repository.projectId ?? project?.id ?? null,
        name: project?.name ?? repository.repoPath,
        path: repository.repoPath,
      }, 'metadata');
    }

    const entries = Array.from(entriesByPath.values());
    if (entries.length === 0) return null;
    const missingPaths = new Set(entries.map((entry) => entry.repoPath));
    const readyProjects = codeEntries
      .filter((entry) => entry.status?.has_origin && !missingPaths.has(entry.project.path))
      .map((entry) => entry.project);

    return {
      kind: 'missing_origin',
      scopeProjects: projects,
      readyProjects,
      entries,
      error: null,
    };
  }, [scopeProjects]);

  const refreshMacroStatus = useCallback(async (ensure = false) => {
    if (!isTauriRuntime) {
      setMacroSnapshot(null);
      setFooterMetadataSync(DEFAULT_FOOTER_METADATA_SYNC);
      return null;
    }
    const result = await scopedMacroSyncService.refreshMacroSyncStatus({ ensure });
    if (result) {
      setMacroSnapshot(result);
    }
    return result;
  }, [isTauriRuntime, scopedMacroSyncService]);

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
    void refreshFocusedProjectBranch();
  }, [refreshFocusedProjectBranch]);

  const runCodeAction = useCallback(async (
    action: FooterSyncAction,
    projects: ScopedProject[] = scopeProjects
  ): Promise<RepositorySyncResult[]> => {
    const results: RepositorySyncResult[] = [];
    for (const project of projects) {
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
          'Le fetch du code est terminé. @macro sera enregistré automatiquement au prochain pull ou push du code.'
        )
        : t(
          'footer.sync.macroDirtyDescription',
          '@macro sera enregistré automatiquement avant la synchronisation du code.'
        );
    }

    return `@macro: ${getMacroSyncDescription(result) || formatGitOutput(result.output, translate)}`;
  }, [t, translate]);

  const runPushPreflight = useCallback(async (projects: ScopedProject[]) => {
    const macroSyncService = createMacroSyncServiceForProjects(projects);
    const [codePreflight, preflight] = await Promise.all([
      readScopedCodeStatuses(projects),
      macroSyncService.refreshMacroSyncStatus({ ensure: true }),
    ]);
    if (preflight) {
      setMacroSnapshot(preflight);
    }
    const missingOriginResolution = buildMissingOriginResolution(codePreflight, preflight, projects);
    return {
      codePreflight,
      macroResult: preflight,
      missingOriginResolution,
      pushableProjects: missingOriginResolution?.readyProjects ?? projects,
    };
  }, [buildMissingOriginResolution, createMacroSyncServiceForProjects, readScopedCodeStatuses]);

  const handleSyncAction = useCallback(async (
    action: FooterSyncAction,
    options?: {
      publishMissingUpstream?: boolean;
      skipMissingUpstreamPrompt?: boolean;
      projects?: ScopedProject[];
    }
  ) => {
    const actionProjects = options?.projects ?? scopeProjects;
    if (!isTauriRuntime || syncAction || actionProjects.length === 0) return;
    const actionMacroSyncService = options?.projects
      ? createMacroSyncServiceForProjects(actionProjects)
      : scopedMacroSyncService;
    setSyncAction(action);
    lastMacroConflictActionRef.current = action;
    try {
      if (action === 'push') {
        const { macroResult: preflight, missingOriginResolution } = await runPushPreflight(actionProjects);

        if (missingOriginResolution) {
          setPushResolution(missingOriginResolution);
          return;
        }

        if (
          metadataMissingUpstreamPolicy !== 'ignore' &&
          !options?.publishMissingUpstream &&
          !options?.skipMissingUpstreamPrompt &&
          preflight?.reason === 'missing_upstream' &&
          preflight.next_action === 'push'
        ) {
          setPushResolution({ kind: 'missing_upstream', macroResult: preflight, scopeProjects: actionProjects, context: 'push' });
          return;
        }
      }

      const codeResults = await runCodeAction(action, actionProjects);
      let macroResult = action === 'fetch'
        ? await actionMacroSyncService.refreshMacroSyncStatus({ ensure: true })
        : await actionMacroSyncService.syncMacroMetadataForCodeAction({ action });
      if (
        action === 'push' &&
        macroResult?.reason === 'missing_upstream' &&
        macroResult.next_action === 'push'
      ) {
        if (options?.publishMissingUpstream) {
          macroResult = await actionMacroSyncService.pushMacroMetadata();
        } else if (
          metadataMissingUpstreamPolicy !== 'ignore' &&
          !options?.skipMissingUpstreamPrompt
        ) {
          setPushResolution({ kind: 'missing_upstream', macroResult, scopeProjects: actionProjects, context: 'push' });
        }
      }
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
      const hasMacroBlocker =
        macroResult?.state === 'failed' ||
        macroResult?.state === 'conflict' ||
        macroResult?.next_action === 'configure_auth' ||
        macroResult?.next_action === 'configure_remote' ||
        macroResult?.next_action === 'resolve_conflict' ||
        (action === 'push' && macroResult?.next_action === 'pull');
      const hasErrors = failures.length > 0 || macroResult?.state === 'failed' || macroResult?.state === 'conflict';
      const hasPending = macroResult?.state === 'pending' && hasMacroBlocker;
      if (hasErrors) {
        notify.error(t(`footer.sync.${action}Incomplete`, `${action} incomplete`), {
          description,
          category: 'git_sync_attention_required',
        });
      } else if (hasPending) {
        notify.info(t(`footer.sync.${action}Pending`, `${action} requires attention`), {
          description,
          category: 'git_sync_attention_required',
        });
      } else {
        notify.success(t(`footer.sync.${action}Complete`, `${action} complete`), {
          description,
          category: 'git_sync_completed',
        });
      }
    } finally {
      await refreshFooterStatus({ ensureMacro: action === 'fetch' });
      setSyncAction(null);
    }
  }, [createMacroSyncServiceForProjects, describeMacroResultForToast, isTauriRuntime, metadataMissingUpstreamPolicy, presentConflictIfNeeded, refreshFooterStatus, runCodeAction, runPushPreflight, scopeProjects, scopedMacroSyncService, syncAction, t]);

  const macroConflictEntries = useMemo<ConflictResolutionEntry[]>(() => {
    const repositories = footerMetadataSync.repositories.length > 0 ? footerMetadataSync.repositories : scopeProjects.map((project) => ({
      repoPath: project.path,
      projectId: project.id,
      worktreePath: macroSnapshot?.worktree_path || null,
      state: footerMetadataSync.state,
      error: footerMetadataSync.error,
      reason: footerMetadataSync.reason,
      nextAction: footerMetadataSync.nextAction,
      conflictFiles: footerMetadataSync.conflictFiles,
    }));
    return toMacroConflictResolutionEntries(repositories);
  }, [footerMetadataSync, macroSnapshot, scopeProjects]);
  const metadataSyncPresentation = useMemo(
    () =>
      presentMetadataSyncIssue({
        reason: footerMetadataSync.reason,
        nextAction: footerMetadataSync.nextAction,
        error: footerMetadataSync.error,
        repoPath: macroSnapshot?.worktree_path || null,
      }),
    [footerMetadataSync.error, footerMetadataSync.nextAction, footerMetadataSync.reason, macroSnapshot?.worktree_path]
  );

  const openAiConflictAssistant = async () => {
    const repositories = footerMetadataSync.repositories.length > 0 ? footerMetadataSync.repositories : scopeProjects.map((project) => ({
      repoPath: project.path,
      projectId: project.id,
      worktreePath: macroSnapshot?.worktree_path || null,
      state: footerMetadataSync.state,
      error: footerMetadataSync.error,
      reason: footerMetadataSync.reason,
      nextAction: footerMetadataSync.nextAction,
      conflictFiles: footerMetadataSync.conflictFiles,
    }));
    try {
      await openConflictAssistant(buildMacroConflictAssistantPrompt({ repositories }));
      notify.success(t('footer.sync.aiConflictAssistantStarted', 'AI conflict assistant started'));
      setShowConflictModal(false);
    } catch (error) {
      notify.error(t('footer.sync.aiConflictAssistantStartFailed', 'Failed to start AI assistant'), {
        description: toServiceError(error).message,
      });
    }
  };

  const handleRetryMacroSync = async () => {
    if (isMissingUpstreamResolution) {
      const result = await scopedMacroSyncService.pushMacroMetadata();
      if (result) {
        setMacroSnapshot(result);
        if (result.state !== 'pending' || result.reason !== 'missing_upstream') {
          setShowConflictModal(false);
        }
      }
      await refreshFooterStatus({ showBusy: true });
      return;
    }

    const action = lastMacroConflictActionRef.current;
    if (action === 'fetch' || action === 'pull' || action === 'push') {
      await handleSyncAction(action);
      return;
    }
    await refreshFooterStatus({ ensureMacro: true, showBusy: true });
    if (footerMetadataSyncRef.current.state !== 'conflict') setShowConflictModal(false);
  };

  const continuePushAfterMissingUpstreamChoice = async (
    choice: 'push_macro' | 'ignore_forever' | 'ask_next_time'
  ) => {
    if (!pushResolution || pushResolution.kind !== 'missing_upstream') return;
    const projects = pushResolution.scopeProjects;
    setPushResolution(null);
    if (choice === 'ignore_forever') {
      setMetadataMissingUpstreamPolicy('ignore');
    }
    await handleSyncAction('push', {
      projects,
      publishMissingUpstream: choice === 'push_macro',
      skipMissingUpstreamPrompt: choice !== 'push_macro',
    });
  };

  const resolveMissingUpstreamChoice = async (
    choice: 'push_macro' | 'ignore_forever'
  ) => {
    if (!pushResolution || pushResolution.kind !== 'missing_upstream') return;
    const macroSyncService = createMacroSyncServiceForProjects(pushResolution.scopeProjects);
    setPushResolution(null);
    if (choice === 'ignore_forever') {
      setMetadataMissingUpstreamPolicy('ignore');
      return;
    }

    const result = await macroSyncService.pushMacroMetadata();
    if (result) {
      setMacroSnapshot(result);
    }
    await refreshFooterStatus({ showBusy: true });
  };

  const updatePushResolutionRemoteUrl = (repoPath: string, url: string) => {
    setPushResolution((current) => {
      if (!current || current.kind !== 'missing_origin') return current;
      return {
        ...current,
        error: null,
        entries: current.entries.map((entry) =>
          entry.repoPath === repoPath ? { ...entry, url } : entry
        ),
      };
    });
  };

  const configureMissingOriginsAndContinue = async () => {
    if (!pushResolution || pushResolution.kind !== 'missing_origin') return;
    const entries = pushResolution.entries;
    const entriesToConfigure = entries.filter((entry) => entry.url.trim().length > 0);
    if (pushResolution.readyProjects.length === 0 && entriesToConfigure.length === 0) {
      setPushResolution({
        ...pushResolution,
        error: t(
          'footer.sync.remoteUrlRequired',
          'Enter at least one origin URL, or cancel to keep every repository local.'
        ),
      });
      return;
    }

    setIsConfiguringRemote(true);
    try {
      for (const entry of entriesToConfigure) {
        await tauriIpc.gitRemoteAddOrigin({
          repoPath: entry.repoPath,
          url: entry.url.trim(),
        });
      }
      const { missingOriginResolution, pushableProjects } = await runPushPreflight(pushResolution.scopeProjects);
      if (pushableProjects.length === 0) {
        setPushResolution({
          ...(missingOriginResolution ?? pushResolution),
          error: t(
            'footer.sync.remoteUrlRequired',
            'Enter at least one origin URL, or cancel to keep every repository local.'
          ),
        });
        return;
      }
      setPushResolution(null);
      await refreshFooterStatus({ ensureMacro: true, showBusy: true });
      await handleSyncAction('push', { projects: pushableProjects });
    } catch (error) {
      setPushResolution({
        ...pushResolution,
        error: toServiceError(error).message,
      });
    } finally {
      setIsConfiguringRemote(false);
    }
  };

  const ignoreMissingUpstreamFromResolve = () => {
    setMetadataMissingUpstreamPolicy('ignore');
    setShowConflictModal(false);
  };

  const openPushResolution = () => {
    if (footerMetadataSync.reason === 'missing_origin' || footerMetadataSync.nextAction === 'configure_remote') {
      const repositories: MetadataOriginCandidate[] = footerMetadataSync.repositories.length > 0
        ? footerMetadataSync.repositories
        : scopeProjects.map((project) => ({
            repoPath: project.path,
            projectId: project.id,
            reason: footerMetadataSync.reason,
            nextAction: footerMetadataSync.nextAction,
          }));
      const entriesByPath = new Map<string, PushRemoteResolutionEntry>();
      for (const repository of repositories) {
        if (repository.reason !== 'missing_origin' && repository.nextAction !== 'configure_remote') continue;
        const project = scopeProjects.find((candidate) => candidate.path === repository.repoPath);
        entriesByPath.set(repository.repoPath, {
          projectId: repository.projectId ?? project?.id ?? null,
          projectName: project?.name ?? repository.repoPath,
          repoPath: repository.repoPath,
          url: '',
          source: 'metadata',
        });
      }
      if (entriesByPath.size > 0) {
        setPushResolution({
          kind: 'missing_origin',
          scopeProjects,
          readyProjects: [],
          entries: Array.from(entriesByPath.values()),
          error: null,
        });
        return;
      }
    }

    if (shouldPromptForMissingUpstream && macroSnapshot) {
      setPushResolution({ kind: 'missing_upstream', macroResult: macroSnapshot, scopeProjects, context: 'resolve' });
      return;
    }

    setShowConflictModal(true);
  };

  return (
    <>
      <footer
        className="h-8 overflow-hidden border-t border-border bg-card px-3 text-[11px] text-muted-foreground"
        data-tour-id="footer-status-bar"
      >
        <div className="flex h-full min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center overflow-hidden">
            <span className="flex h-6 min-w-0 max-w-[12rem] items-center gap-1.5" title={selectedGlobalProject?.name || focusedProject?.name || undefined}>
              <Icon name={selectedGlobalProject ? 'layers' : 'folder-git-2'} size={12} className="block translate-x-[0.25px] -translate-y-[0.5px] shrink-0 text-primary" />
              <span className="truncate leading-4 text-foreground">{selectedGlobalProject?.name || focusedProject?.name || t('project.noGroup', 'No group')}</span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-2 h-6 w-6 shrink-0 px-0 text-[11px]"
              disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
              onClick={() => void handleSyncAction('fetch')}
              data-tour-id="footer-fetch"
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
            {(focusProjects.length > 0 || codeStatus.branch || hasPushWork || hasPullWork) && (
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
                      className="col-start-1 row-start-1 h-6 min-w-0 rounded border border-border bg-card px-2 pr-6 text-[11px] leading-6 text-foreground"
                      value={gitScopeProjectId ?? ALL_PROJECTS_OPTION}
                      data-tour-id="footer-project-scope"
                      onChange={(event) => setGitScopeProjectId(
                        event.target.value === ALL_PROJECTS_OPTION ? null : event.target.value
                      )}
                    >
                      <option value={ALL_PROJECTS_OPTION}>{t('footer.scope.allProjects', 'Tout le projet')}</option>
                      {focusProjects.map((project) => (
                        <option key={project.id} value={project.id}>{project.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {selectedProjectId && focusedProjectBranch && (
                  <span className="flex min-w-0 max-w-[10rem] items-center gap-1.5" title={focusedProjectBranch}>
                    <Icon name="git-branch" size={12} className="shrink-0 text-blue-400" />
                    <span className="truncate">{focusedProjectBranch}</span>
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 shrink-0 gap-1 px-2 text-[11px] font-medium',
                    hasPullWork ? 'text-amber-400 hover:text-amber-300' : 'text-muted-foreground/80'
                  )}
                  disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
                  onClick={() => void handleSyncAction('pull')}
                  data-tour-id="footer-pull"
                >
                  <Icon name="arrow-down" size={12} className={cn(syncAction === 'pull' && 'animate-bounce')} />
                  <span>{pullCountLabel}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 shrink-0 gap-1 px-2 text-[11px] font-medium',
                    hasPushWork ? 'text-emerald-400 hover:text-emerald-300' : 'text-muted-foreground/80'
                  )}
                  disabled={!isTauriRuntime || scopeProjects.length === 0 || Boolean(syncAction) || isRefreshing}
                  onClick={() => void handleSyncAction('push')}
                  data-tour-id="footer-push"
                >
                  <Icon name="arrow-up" size={12} className={cn(syncAction === 'push' && 'animate-bounce')} />
                  <span>{pushCountLabel}</span>
                </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {macroNeedsAttention && (
              <Button
                size="sm"
                variant="error"
                className="h-6 px-2 text-[11px]"
                onClick={openPushResolution}
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
              className={cn('relative h-6 w-6 px-0 text-[11px]', isNotificationCenterOpen && 'bg-accent text-foreground hover:bg-accent')}
              onClick={() => setNotificationCenterOpen(!isNotificationCenterOpen)}
              data-tour-id="notification-center"
            >
              <Icon name="bell" size={12} />
              {hasUnreadNotificationDot && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full border border-card bg-primary" />}
            </Button>
          </div>
        </div>
      </footer>

      {showConflictModal && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowConflictModal(false)} />
          <div className="relative max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-2xl">
            <ConflictResolutionPanel
              title={metadataSyncPresentation.title}
              description={metadataSyncPresentation.nextStep || metadataSyncPresentation.body}
              repositories={macroConflictEntries}
              error={metadataSyncPresentation.technicalDetails}
              retryLabel={
                isMissingUpstreamResolution
                  ? t('footer.sync.pushMacroBranch', 'Push @macro')
                  : t('footer.sync.retrySync', 'Retry sync')
              }
              retryDisabled={Boolean(syncAction)}
              retryLoading={Boolean(syncAction) || isRefreshing}
              showConflictFiles={footerMetadataSync.state === 'conflict'}
              onDismiss={
                isMissingUpstreamResolution
                  ? ignoreMissingUpstreamFromResolve
                  : () => setShowConflictModal(false)
              }
              dismissLabel={
                isMissingUpstreamResolution
                  ? t('footer.sync.ignoreMissingUpstream', 'Ignore missing upstream')
                  : t('common.close', 'Close')
              }
              onRetry={() => void handleRetryMacroSync()}
              onUseAiAssistant={canUseMacroAssistant ? () => void openAiConflictAssistant() : undefined}
            />
          </div>
        </div>
      )}

      {pushResolution && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setPushResolution(null)} />
          <div
            className="relative w-full max-w-lg rounded-lg border border-border bg-card p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="push-resolution-title"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md bg-amber-500/10 p-2 text-amber-500">
                <Icon name="git-branch" size={16} />
              </div>
              <div className="min-w-0">
                <h3 id="push-resolution-title" className="text-sm font-semibold text-foreground">
                  {pushResolution.kind === 'missing_origin'
                    ? t('footer.sync.missingOriginPromptTitle', 'Remote origin is missing')
                    : t('footer.sync.missingUpstreamPromptTitle', '@macro has no remote branch yet')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {pushResolution.kind === 'missing_origin'
                    ? t(
                        'footer.sync.missingOriginPromptDescription',
                        'Add origins for repositories you want to publish now. Leave a field blank to keep that repository local for this push.'
                      )
                    : t(
                        'footer.sync.missingUpstreamPromptDescription',
                        'Choose whether this push should publish the @macro metadata branch or keep it local.'
                      )}
                </p>
              </div>
            </div>
            {pushResolution.kind === 'missing_origin' ? (
              <>
                <p className="mt-4 rounded border border-border/80 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {t(
                    'footer.sync.missingOriginPromptSummary',
                    `${pushResolution.readyProjects.length} repositories ready to push. ${pushResolution.entries.length} need an origin.`
                  )}
                </p>
                <div className="mt-4 space-y-3">
                  {pushResolution.entries.map((entry) => (
                    <label key={entry.repoPath} className="block space-y-1.5">
                      <span className="flex items-center justify-between gap-2 text-xs font-medium text-foreground">
                        <span className="truncate">{entry.projectName}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {entry.source === 'code_and_metadata'
                            ? t('footer.sync.remoteNeededCodeAndMetadata', 'code + @macro')
                            : entry.source === 'metadata'
                              ? t('footer.sync.remoteNeededMetadata', '@macro')
                              : t('footer.sync.remoteNeededCode', 'code')}
                        </span>
                      </span>
                      <input
                        className="h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                        value={entry.url}
                        placeholder="https://github.com/org/repo.git"
                        disabled={isConfiguringRemote}
                        onChange={(event) => updatePushResolutionRemoteUrl(entry.repoPath, event.target.value)}
                      />
                      <span className="block truncate text-[11px] text-muted-foreground">{entry.repoPath}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {t('footer.sync.remoteUrlOptional', 'Leave blank to skip this repository for this push.')}
                      </span>
                    </label>
                  ))}
                </div>
                {pushResolution.error && (
                  <p className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                    {pushResolution.error}
                  </p>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isConfiguringRemote}
                    onClick={() => setPushResolution(null)}
                  >
                    {t('common.cancel', 'Cancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={Boolean(syncAction) || isConfiguringRemote}
                    isLoading={isConfiguringRemote}
                    onClick={() => void configureMissingOriginsAndContinue()}
                  >
                    {t('footer.sync.pushAvailableRepositories', 'Push available repositories')}
                  </Button>
                </div>
              </>
            ) : (
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {pushResolution.context === 'push' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(syncAction)}
                    onClick={() => void continuePushAfterMissingUpstreamChoice('ask_next_time')}
                  >
                    {t('footer.sync.askNextTime', 'Ask next time')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(syncAction)}
                  onClick={() => void (
                    pushResolution.context === 'resolve'
                      ? resolveMissingUpstreamChoice('ignore_forever')
                      : continuePushAfterMissingUpstreamChoice('ignore_forever')
                  )}
                >
                  {pushResolution.context === 'resolve'
                    ? t('footer.sync.ignoreMissingUpstream', 'Ignore missing upstream')
                    : t('footer.sync.doNotAskAgain', "Don't ask again")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={Boolean(syncAction)}
                  onClick={() => void (
                    pushResolution.context === 'resolve'
                      ? resolveMissingUpstreamChoice('push_macro')
                      : continuePushAfterMissingUpstreamChoice('push_macro')
                  )}
                >
                  {t('footer.sync.pushMacroBranch', 'Push @macro')}
                </Button>
              </div>
            )}
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
