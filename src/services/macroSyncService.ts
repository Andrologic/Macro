import type { AppMode, Project, ProjectGroup } from '../types';
import type { MetadataSyncRepositoryStatus } from '../stores/useAppStore';
import { toServiceError } from './contracts/errors';
import * as tauriIpc from './tauriIpc';
import { useAppStore } from '../stores/useAppStore';
import {
  getProjectGroupByProjectId,
  getScopedProjectIds,
  isProjectGitActionable,
} from './globalProjects';
import {
  flushMacroMetadata,
  recordMacroMetadataMutation,
} from './macroMetadataCoordinator';
import {
  getArchitectPlan,
  getArchitectPlanVisibleProjectIds,
  getGitFlowBaseBranch,
  resolveTargetBranch,
  syncArchitectPlanChatFromConversation,
} from './architectPlanService';
import { isWslProjectPath } from './wslPaths';

type MacroSyncResult = tauriIpc.MacroBranchSyncDto & {
  repositories?: MetadataSyncRepositoryStatus[];
};
type ManualMacroAction = 'commit' | 'pull' | 'push';

interface StreamMetadataSyncParams {
  mode: AppMode;
  conversationId: string;
  trigger: 'send' | 'edit';
}

interface FallbackMacroFailure {
  state: tauriIpc.MacroSyncState;
  reason: tauriIpc.MacroSyncReason;
  nextAction: tauriIpc.MacroSyncNextAction | null;
  message: string;
}

interface MetadataSyncTarget {
  repoPath: string;
  projectId: string | null;
}

interface MacroSyncAppState {
  metadataAutoPush: boolean;
  metadataMissingUpstreamPolicy: 'ask' | 'ignore';
  activeArchitectPlanId: string | null;
  activePlanContext: { targetBranch: string } | null;
  selectedGroupId: string | null;
  selectedProjectId: string | null;
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  getProjectById: (projectId: string) => Project | undefined;
  setMetadataSyncStatus: (params: {
    state: tauriIpc.MacroSyncState;
    error?: string | null;
    reason?: tauriIpc.MacroSyncReason | null;
    nextAction?: tauriIpc.MacroSyncNextAction | null;
    conflictFiles?: string[];
    repositories?: MetadataSyncRepositoryStatus[];
  }) => void;
}

export interface MacroSyncServiceDependencies {
  tauriIpc: Pick<
    typeof tauriIpc,
    | 'isTauriAvailable'
    | 'macroBranchEnsure'
    | 'macroBranchStatus'
    | 'macroBranchCommitIfDirty'
    | 'macroBranchPull'
    | 'macroBranchPush'
  >;
  getAppState: () => MacroSyncAppState;
  toServiceError: typeof toServiceError;
  resolveTargets?: (appState: MacroSyncAppState) => Promise<MetadataSyncTarget[]>;
}

export interface MacroSyncService {
  refreshMacroSyncStatus: (options?: { ensure?: boolean }) => Promise<MacroSyncResult | null>;
  commitMacroMetadata: (options?: { commitMessage?: string }) => Promise<MacroSyncResult | null>;
  pullMacroMetadata: () => Promise<MacroSyncResult | null>;
  pushMacroMetadata: () => Promise<MacroSyncResult | null>;
  syncMacroMetadataForCodeAction: (params: { action: 'pull' | 'push' }) => Promise<MacroSyncResult | null>;
  syncMacroMetadataAfterStream: (params: StreamMetadataSyncParams) => Promise<MacroSyncResult | null>;
}

const MACRO_REASON_MESSAGES: Record<tauriIpc.MacroSyncReason, string | null> = {
  clean: null,
  dirty: '@macro has local changes and will be saved automatically before sync.',
  ahead: '@macro has local commits ready to push.',
  behind: '@macro needs a code pull before it can be pushed.',
  diverged: '@macro needs conflict resolution before syncing.',
  merge_conflict: '@macro has unresolved conflicts. Resolve the conflicted files first.',
  missing_origin: 'Remote origin is not configured.',
  missing_upstream: '@macro has no upstream yet. Push @macro to publish it or keep it local.',
  auth_required: 'Git authentication for origin is required.',
  network_error: 'Network error while syncing @macro.',
  unknown_error: '@macro sync failed.',
};

const STATE_PRIORITY: Record<tauriIpc.MacroSyncState, number> = {
  clean: 0,
  pending: 1,
  failed: 2,
  conflict: 3,
};

const ACTION_PRIORITY: Record<NonNullable<tauriIpc.MacroSyncNextAction>, number> = {
  resolve_conflict: 6,
  configure_auth: 5,
  configure_remote: 4,
  commit: 3,
  pull: 2,
  push: 1,
  retry: 0,
};

const describeMacroReason = (reason: tauriIpc.MacroSyncReason | null | undefined): string | null =>
  reason ? MACRO_REASON_MESSAGES[reason] ?? null : null;

export const getMacroSyncDescription = (
  result: Pick<MacroSyncResult, 'error' | 'reason'>
): string | null => {
  const explicit = result.error?.trim();
  if (explicit) {
    return explicit;
  }
  return describeMacroReason(result.reason);
};

const normalizeRepoPath = (repoPath?: string | null): string | null => {
  const normalized = (repoPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : null;
};

const dedupeTargets = (targets: MetadataSyncTarget[]): MetadataSyncTarget[] =>
  Array.from(
    new Map(
      targets
        .map((target) => ({
          ...target,
          repoPath: normalizeRepoPath(target.repoPath) || target.repoPath,
        }))
        .filter((target) => target.repoPath.trim().length > 0)
        .filter((target) => !isWslProjectPath(target.repoPath))
        .map((target) => [target.repoPath, target] as const)
    ).values()
  );

const resolveProjectPath = (
  appState: MacroSyncAppState,
  projectId: string | null | undefined
): string | null => {
  if (!projectId) {
    return null;
  }

  const fromLookup = appState.getProjectById(projectId)?.path;
  if (typeof fromLookup === 'string' && fromLookup.trim().length > 0) {
    return fromLookup;
  }

  return (
    appState.projectGroups
      .flatMap((group) => group.projects)
      .find((project) => project.id === projectId)
      ?.path ?? null
  );
};

const resolveProject = (
  appState: MacroSyncAppState,
  projectId: string | null | undefined
): Project | null => {
  if (!projectId) return null;

  return (
    appState.getProjectById(projectId) ??
    appState.standaloneProjects?.find((project) => project.id === projectId) ??
    appState.projectGroups
      .flatMap((group) => group.projects)
      .find((project) => project.id === projectId) ??
    null
  );
};

const isGitActionableTarget = (
  appState: MacroSyncAppState,
  target: MetadataSyncTarget
): boolean => {
  if (!target.projectId) return false;

  const project = resolveProject(appState, target.projectId);
  return project ? isProjectGitActionable(project) : false;
};

const resolveMacroSyncTargets = async (appState: MacroSyncAppState): Promise<MetadataSyncTarget[]> => {
  const scopedProjectIds = getScopedProjectIds(
    {
      standaloneProjects: appState.standaloneProjects ?? [],
      projectGroups: appState.projectGroups,
    },
    appState.selectedGroupId,
    appState.selectedProjectId
  );
  const scopedTargets = scopedProjectIds
    .map((projectId) => ({
      repoPath: resolveProjectPath(appState, projectId) || '',
      projectId,
    }))
    .filter((target) => target.repoPath.trim().length > 0)
    .sort((left, right) => {
      if (left.projectId === appState.selectedProjectId) {
        return -1;
      }
      if (right.projectId === appState.selectedProjectId) {
        return 1;
      }
      return 0;
    });
  const scopedProjectIdSet = new Set(scopedTargets.map((target) => target.projectId));
  const scopedRepoPathSet = new Set(
    scopedTargets
      .map((target) => normalizeRepoPath(target.repoPath))
      .filter((value): value is string => Boolean(value))
  );

  const activePlanId = appState.activeArchitectPlanId;
  if (activePlanId) {
    try {
      const branchName = resolveTargetBranch(appState.activePlanContext?.targetBranch || getGitFlowBaseBranch());
      const plan = await getArchitectPlan(branchName, activePlanId);
      if (plan) {
        const replicaTargets = (plan.replicas || [])
          .filter((replica) => Boolean(replica.repoPath))
          .map((replica) => ({
            repoPath: replica.repoPath as string,
            projectId: replica.projectId,
          }));
        const projectTargets = getArchitectPlanVisibleProjectIds(plan)
          .map((projectId) => ({
            repoPath: resolveProjectPath(appState, projectId) || '',
            projectId,
          }))
          .filter((target) => target.repoPath.trim().length > 0);
        const targets = dedupeTargets([...replicaTargets, ...projectTargets]).filter((target) => {
          if (scopedTargets.length === 0) {
            return true;
          }
          const normalizedRepoPath = normalizeRepoPath(target.repoPath);
          return (
            (target.projectId !== null && scopedProjectIdSet.has(target.projectId)) ||
            (normalizedRepoPath !== null && scopedRepoPathSet.has(normalizedRepoPath))
          );
        });
        if (targets.length > 0) {
          return targets;
        }
      }
    } catch {
      // Fall back to the selected project scope below.
    }
  }

  if (scopedTargets.length > 0) {
    return dedupeTargets(scopedTargets);
  }

  const selectedProjectGroup = getProjectGroupByProjectId(
    appState.projectGroups,
    appState.selectedProjectId
  );
  if (selectedProjectGroup) {
    const orderedProjects = [
      ...selectedProjectGroup.projects.filter((project) => project.id === appState.selectedProjectId),
      ...selectedProjectGroup.projects.filter((project) => project.id !== appState.selectedProjectId),
    ];

    const groupTargets = orderedProjects
      .map((project) => ({
        repoPath: resolveProjectPath(appState, project.id) || '',
        projectId: project.id,
      }))
      .filter((target) => target.repoPath.trim().length > 0);

    if (groupTargets.length > 0) {
      return dedupeTargets(groupTargets);
    }
  }

  const selectedProjectPath = appState.selectedProjectId
    ? resolveProjectPath(appState, appState.selectedProjectId)
    : null;
  return selectedProjectPath
    ? [{ repoPath: selectedProjectPath, projectId: appState.selectedProjectId }]
    : [];
};

const classifyFallbackMacroFailure = (message: string): FallbackMacroFailure => {
  const normalized = message.trim() || 'Metadata sync failed.';
  const lower = normalized.toLowerCase();

  if (
    lower.includes('authentication failed') ||
    lower.includes('permission denied') ||
    lower.includes('could not read from remote repository')
  ) {
    return {
      state: 'failed',
      reason: 'auth_required',
      nextAction: 'configure_auth',
      message: describeMacroReason('auth_required') || normalized,
    };
  }

  if (
    lower.includes('could not resolve host') ||
    lower.includes('failed to connect') ||
    lower.includes('network') ||
    lower.includes('timed out')
  ) {
    return {
      state: 'failed',
      reason: 'network_error',
      nextAction: 'retry',
      message: describeMacroReason('network_error') || normalized,
    };
  }

  if (
    lower.includes('no such remote') ||
    lower.includes("'origin'") ||
    (lower.includes('remote origin') && lower.includes('not found'))
  ) {
    return {
      state: 'failed',
      reason: 'missing_origin',
      nextAction: 'configure_remote',
      message: describeMacroReason('missing_origin') || normalized,
    };
  }

  if (
    lower.includes('non-fast-forward') ||
    lower.includes('fetch first') ||
    lower.includes('rejected')
  ) {
    return {
      state: 'pending',
      reason: 'diverged',
      nextAction: 'pull',
      message: describeMacroReason('diverged') || normalized,
    };
  }

  if (lower.includes('merge conflict') || lower.includes('automatic merge failed')) {
    return {
      state: 'conflict',
      reason: 'merge_conflict',
      nextAction: 'resolve_conflict',
      message: describeMacroReason('merge_conflict') || normalized,
    };
  }

  return {
    state: 'failed',
    reason: 'unknown_error',
    nextAction: 'retry',
    message: normalized,
  };
};

const toFailedMacroResult = (message: string): MacroSyncResult => {
  const failure = classifyFallbackMacroFailure(message);
  return {
    branch: '@macro',
    state: failure.state,
    worktree_path: '',
    is_dirty: false,
    has_origin: false,
    has_upstream: false,
    ahead: 0,
    behind: 0,
    conflicted_files: [],
    committed: false,
    commit_hash: null,
    reason: failure.reason,
    next_action: failure.nextAction,
    output: null,
    error: failure.message,
  };
};

const shouldBlockMacroAction = (
  result: MacroSyncResult,
  action: ManualMacroAction
): boolean => {
  if (result.state === 'conflict') {
    return true;
  }

  const nextAction = result.next_action;
  if (!nextAction) {
    return false;
  }

  if (action === 'commit') {
    return nextAction === 'resolve_conflict';
  }

  if (action === 'pull') {
    return (
      nextAction === 'commit' ||
      nextAction === 'resolve_conflict' ||
      nextAction === 'configure_remote' ||
      nextAction === 'configure_auth'
    );
  }

  return (
    nextAction === 'commit' ||
    nextAction === 'pull' ||
    nextAction === 'resolve_conflict' ||
    nextAction === 'configure_remote' ||
    nextAction === 'configure_auth'
  );
};

const shouldBlockMacroCodeAction = (
  result: MacroSyncResult,
  action: 'pull' | 'push',
  options?: { allowCommitFlush?: boolean }
): boolean => {
  if (result.state === 'conflict') {
    return true;
  }

  const nextAction = result.next_action;
  if (!nextAction) {
    return false;
  }

  if (nextAction === 'commit') {
    return options?.allowCommitFlush !== true;
  }

  if (
    nextAction === 'resolve_conflict' ||
    nextAction === 'configure_remote' ||
    nextAction === 'configure_auth'
  ) {
    return true;
  }

  return action === 'push' && nextAction === 'pull';
};

const isMissingUpstreamResult = (result: MacroSyncResult): boolean =>
  result.reason === 'missing_upstream' && result.next_action === 'push';

const toRepositoryStatus = (
  target: MetadataSyncTarget,
  result: MacroSyncResult
): MetadataSyncRepositoryStatus => ({
  repoPath: target.repoPath,
  projectId: target.projectId,
  state: result.state,
  error:
    result.error?.trim() ||
    (result.state === 'failed' || result.state === 'conflict'
      ? describeMacroReason(result.reason)
      : null),
  reason: result.reason,
  nextAction: result.next_action,
  conflictFiles: result.conflicted_files,
  worktreePath: result.worktree_path?.trim() ? result.worktree_path : null,
});

const compareMacroResults = (left: MacroSyncResult, right: MacroSyncResult): number => {
  const stateDelta = STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state];
  if (stateDelta !== 0) {
    return stateDelta;
  }
  const leftAction = left.next_action ? ACTION_PRIORITY[left.next_action] : -1;
  const rightAction = right.next_action ? ACTION_PRIORITY[right.next_action] : -1;
  if (leftAction !== rightAction) {
    return leftAction - rightAction;
  }
  return (left.error || '').localeCompare(right.error || '');
};

const createAggregateMacroResult = (
  entries: Array<{ target: MetadataSyncTarget; result: MacroSyncResult }>
): MacroSyncResult => {
  if (entries.length === 0) {
    return {
      branch: '@macro',
      state: 'clean',
      worktree_path: '',
      is_dirty: false,
      has_origin: true,
      has_upstream: true,
      ahead: 0,
      behind: 0,
      conflicted_files: [],
      committed: false,
      commit_hash: null,
      reason: 'clean',
      next_action: null,
      output: null,
      error: null,
    };
  }

  const dominant = [...entries].sort((left, right) => compareMacroResults(right.result, left.result))[0]!.result;
  const conflictFiles = Array.from(
    new Set(entries.flatMap(({ result }) => result.conflicted_files))
  );
  const outputs = entries
    .map(({ target, result }) => {
      const output = result.output?.trim();
      if (!output) return null;
      return entries.length === 1 ? output : `${target.repoPath}: ${output}`;
    })
    .filter((value): value is string => Boolean(value));
  const errors = entries
    .map(({ target, result }) => {
      const message = result.error?.trim() ||
        (result.state === 'failed' || result.state === 'conflict'
          ? describeMacroReason(result.reason)
          : null);
      if (!message) return null;
      return entries.length === 1 ? message : `${target.repoPath}: ${message}`;
    })
    .filter((value): value is string => Boolean(value));
  const committedEntries = entries.filter(({ result }) => result.committed && result.commit_hash);

  return {
    branch: '@macro',
    state: dominant.state,
    worktree_path: entries
      .map(({ target, result }) =>
        result.worktree_path.trim().length > 0
          ? (entries.length === 1 ? result.worktree_path : `${target.repoPath} => ${result.worktree_path}`)
          : null
      )
      .filter((value): value is string => Boolean(value))
      .join('; '),
    is_dirty: entries.some(({ result }) => result.is_dirty),
    has_origin: entries.every(({ result }) => result.has_origin),
    has_upstream: entries.every(({ result }) => result.has_upstream),
    ahead: entries.reduce((sum, { result }) => sum + result.ahead, 0),
    behind: entries.reduce((sum, { result }) => sum + result.behind, 0),
    conflicted_files: conflictFiles,
    committed: entries.some(({ result }) => result.committed),
    commit_hash: committedEntries.length === 1 ? committedEntries[0]!.result.commit_hash : null,
    reason: dominant.reason,
    next_action: dominant.next_action,
    output: outputs.length > 0 ? outputs.join('\n') : dominant.output,
    error: errors.length > 0 ? errors.join('\n') : dominant.error,
  };
};

const defaultMacroSyncServiceDependencies: MacroSyncServiceDependencies = {
  // Keep cross-chunk imports lazy. The production bundle intentionally groups
  // workflow services separately from generic services, which creates a
  // circular module graph during startup.
  get tauriIpc() {
    return tauriIpc;
  },
  getAppState: () => useAppStore.getState(),
  get toServiceError() {
    return toServiceError;
  },
};

export const createMacroSyncService = (
  dependencies: MacroSyncServiceDependencies = defaultMacroSyncServiceDependencies
): MacroSyncService => {
  let macroSyncQueueTail: Promise<void> = Promise.resolve();

  const runWithMacroSyncLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = macroSyncQueueTail;
    let release: () => void = () => {};
    macroSyncQueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const applyMacroSyncResult = (
    result: MacroSyncResult,
    repositories: MetadataSyncRepositoryStatus[]
  ): MacroSyncResult => {
    dependencies.getAppState().setMetadataSyncStatus({
      state: result.state,
      error:
        result.error?.trim() ||
        (result.state === 'failed' || result.state === 'conflict'
          ? describeMacroReason(result.reason)
          : null),
      reason: result.reason,
      nextAction: result.next_action,
      conflictFiles: result.conflicted_files,
      repositories,
    });
    return {
      ...result,
      repositories,
    };
  };

  const applyMacroSyncFailure = (
    error: unknown,
    targets: MetadataSyncTarget[]
  ): MacroSyncResult => {
    const result = toFailedMacroResult(dependencies.toServiceError(error).message);
    return applyMacroSyncResult(
      result,
      targets.map((target) => toRepositoryStatus(target, result))
    );
  };

  const setMacroSyncPending = (targets: MetadataSyncTarget[]) => {
    dependencies.getAppState().setMetadataSyncStatus({
      state: 'pending',
      error: null,
      reason: null,
      nextAction: null,
      conflictFiles: [],
      repositories: targets.map((target) => ({
        repoPath: target.repoPath,
        projectId: target.projectId,
        worktreePath: null,
        state: 'pending',
        error: null,
        reason: null,
        nextAction: null,
        conflictFiles: [],
      })),
    });
  };

  const resolveTargets = async (): Promise<MetadataSyncTarget[]> => {
    const appState = dependencies.getAppState();
    const resolver = dependencies.resolveTargets || resolveMacroSyncTargets;
    return dedupeTargets(await resolver(appState)).filter((target) =>
      isGitActionableTarget(appState, target)
    );
  };

  const runTargetOperations = async (
    targets: MetadataSyncTarget[],
    operation: (target: MetadataSyncTarget) => Promise<MacroSyncResult>
  ): Promise<Array<{ target: MetadataSyncTarget; result: MacroSyncResult }>> => {
    const entries = new Array<{ target: MetadataSyncTarget; result: MacroSyncResult }>(targets.length);
    const repositoryQueues = new Map<string, Promise<unknown>>();

    await Promise.all(
      targets.map((target, index) => {
        const repositoryKey = normalizeRepoPath(target.repoPath) || target.repoPath;
        const previous = repositoryQueues.get(repositoryKey) ?? Promise.resolve();
        const queued = previous.then(async () => {
          try {
            entries[index] = {
              target,
              result: await operation(target),
            };
          } catch (error) {
            entries[index] = {
              target,
              result: toFailedMacroResult(dependencies.toServiceError(error).message),
            };
          }
        });
        repositoryQueues.set(repositoryKey, queued);
        return queued;
      })
    );

    return entries;
  };

  const runAcrossTargets = async (
    targets: MetadataSyncTarget[],
    operation: (target: MetadataSyncTarget) => Promise<MacroSyncResult>,
    preservedResults: ReadonlyMap<string, MacroSyncResult> = new Map()
  ): Promise<MacroSyncResult> => {
    const entries = await runTargetOperations(targets, async (target) =>
      preservedResults.get(target.repoPath) ?? operation(target)
    );

    return applyMacroSyncResult(
      createAggregateMacroResult(entries),
      entries.map(({ target, result }) => toRepositoryStatus(target, result))
    );
  };

  const ensureTargets = (targets: MetadataSyncTarget[]) =>
    runTargetOperations(targets, (target) =>
      dependencies.tauriIpc.macroBranchEnsure({
        workspacePath: target.repoPath,
      })
    );

  const ensureTargetsForAction = async (
    targets: MetadataSyncTarget[],
    action: ManualMacroAction
  ): Promise<{
    blocked: boolean;
    entries: Array<{ target: MetadataSyncTarget; result: MacroSyncResult }>;
  }> => {
    const entries = await ensureTargets(targets);

    return {
      blocked: entries.some(({ result }) => shouldBlockMacroAction(result, action)),
      entries,
    };
  };

  const refreshMacroSyncStatus = async (options?: {
    ensure?: boolean;
  }): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      const targets = await resolveTargets();
      if (targets.length === 0) {
        return applyMacroSyncResult(createAggregateMacroResult([]), []);
      }

      try {
        return await runAcrossTargets(targets, (target) =>
          options?.ensure
            ? dependencies.tauriIpc.macroBranchEnsure({ workspacePath: target.repoPath })
            : dependencies.tauriIpc.macroBranchStatus({ workspacePath: target.repoPath })
        );
      } catch (error) {
        return applyMacroSyncFailure(error, targets);
      }
    });
  };

  const commitMacroMetadata = async (options?: {
    commitMessage?: string;
  }): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      const targets = await resolveTargets();
      if (targets.length === 0) {
        return applyMacroSyncResult(createAggregateMacroResult([]), []);
      }

      try {
        const preflight = await ensureTargetsForAction(targets, 'commit');
        if (preflight.blocked) {
          return applyMacroSyncResult(
            createAggregateMacroResult(preflight.entries),
            preflight.entries.map(({ target, result }) => toRepositoryStatus(target, result))
          );
        }

        setMacroSyncPending(targets);
        return await runAcrossTargets(targets, (target) =>
          dependencies.tauriIpc.macroBranchCommitIfDirty({
            message: options?.commitMessage,
            workspacePath: target.repoPath,
          })
        );
      } catch (error) {
        return applyMacroSyncFailure(error, targets);
      }
    });
  };

  const pullMacroMetadata = async (): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      const targets = await resolveTargets();
      if (targets.length === 0) {
        return applyMacroSyncResult(createAggregateMacroResult([]), []);
      }

      try {
        const preflight = await ensureTargetsForAction(targets, 'pull');
        if (preflight.blocked) {
          return applyMacroSyncResult(
            createAggregateMacroResult(preflight.entries),
            preflight.entries.map(({ target, result }) => toRepositoryStatus(target, result))
          );
        }

        const missingUpstreamResults = new Map(
          preflight.entries
            .filter(({ result }) => isMissingUpstreamResult(result))
            .map(({ target, result }) => [target.repoPath, result] as const)
        );
        setMacroSyncPending(targets);
        return await runAcrossTargets(
          targets,
          (target) => dependencies.tauriIpc.macroBranchPull({
              workspacePath: target.repoPath,
            }),
          missingUpstreamResults
        );
      } catch (error) {
        return applyMacroSyncFailure(error, targets);
      }
    });
  };

  const pushMacroMetadata = async (): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      const targets = await resolveTargets();
      if (targets.length === 0) {
        return applyMacroSyncResult(createAggregateMacroResult([]), []);
      }

      try {
        const preflight = await ensureTargetsForAction(targets, 'push');
        if (preflight.blocked) {
          return applyMacroSyncResult(
            createAggregateMacroResult(preflight.entries),
            preflight.entries.map(({ target, result }) => toRepositoryStatus(target, result))
          );
        }

        setMacroSyncPending(targets);
        return await runAcrossTargets(targets, (target) =>
          dependencies.tauriIpc.macroBranchPush({
            workspacePath: target.repoPath,
          })
        );
      } catch (error) {
        return applyMacroSyncFailure(error, targets);
      }
    });
  };

  const syncMacroMetadataForCodeAction = async (
    params: { action: 'pull' | 'push' }
  ): Promise<MacroSyncResult | null> => {
    if (!dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      const targets = await resolveTargets();
      if (targets.length === 0) {
        return applyMacroSyncResult(createAggregateMacroResult([]), []);
      }

      try {
        const preflightEntries = await ensureTargets(targets);
        if (
          preflightEntries.some(({ result }) =>
            shouldBlockMacroCodeAction(result, params.action, { allowCommitFlush: true })
          )
        ) {
          return applyMacroSyncResult(
            createAggregateMacroResult(preflightEntries),
            preflightEntries.map(({ target, result }) => toRepositoryStatus(target, result))
          );
        }

        setMacroSyncPending(targets);
        await flushMacroMetadata({
          trigger: params.action === 'pull' ? 'code_pull' : 'code_push',
          workspacePaths: targets.map((target) => target.repoPath),
        }, {
          tauri: dependencies.tauriIpc,
        });

        const postFlushEntries = await ensureTargets(targets);
        if (
          params.action === 'push' &&
          postFlushEntries.some(({ result }) => isMissingUpstreamResult(result))
        ) {
          return applyMacroSyncResult(
            createAggregateMacroResult(postFlushEntries),
            postFlushEntries.map(({ target, result }) => toRepositoryStatus(target, result))
          );
        }

        if (
          postFlushEntries.some(({ result }) =>
            shouldBlockMacroCodeAction(result, params.action)
          )
        ) {
          return applyMacroSyncResult(
            createAggregateMacroResult(postFlushEntries),
            postFlushEntries.map(({ target, result }) => toRepositoryStatus(target, result))
          );
        }

        const missingUpstreamResults = params.action === 'pull'
          ? new Map(
              postFlushEntries
                .filter(({ result }) => isMissingUpstreamResult(result))
                .map(({ target, result }) => [target.repoPath, result] as const)
            )
          : new Map<string, MacroSyncResult>();
        setMacroSyncPending(targets);
        return await runAcrossTargets(
          targets,
          (target) => params.action === 'pull'
              ? dependencies.tauriIpc.macroBranchPull({
                  workspacePath: target.repoPath,
                })
              : dependencies.tauriIpc.macroBranchPush({
                  workspacePath: target.repoPath,
                }),
          missingUpstreamResults
        );
      } catch (error) {
        return applyMacroSyncFailure(error, targets);
      }
    });
  };

  const syncMacroMetadataAfterStream = async (
    params: StreamMetadataSyncParams
  ): Promise<MacroSyncResult | null> => {
    if (params.mode !== 'Architect' || !dependencies.tauriIpc.isTauriAvailable()) {
      return null;
    }

    return runWithMacroSyncLock(async () => {
      const targets = await resolveTargets();
      if (targets.length === 0) {
        return applyMacroSyncResult(createAggregateMacroResult([]), []);
      }

      try {
        const appState = dependencies.getAppState();
        if (appState.activeArchitectPlanId && appState.activePlanContext?.targetBranch) {
          try {
            await syncArchitectPlanChatFromConversation({
              branchName: resolveTargetBranch(appState.activePlanContext.targetBranch),
              planId: appState.activeArchitectPlanId,
              conversationId: params.conversationId,
            });
          } catch (error) {
            console.warn(
              JSON.stringify({
                scope: 'macro_sync_service',
                event: 'architect_plan_chat_sync_failed',
                at: new Date().toISOString(),
                planId: appState.activeArchitectPlanId,
                conversationId: params.conversationId,
                trigger: params.trigger,
                error: dependencies.toServiceError(error).message,
              })
            );
          }
        }

        for (const target of targets) {
          recordMacroMetadataMutation({
            workspacePath: target.repoPath,
            kind: 'chat_synced',
            entityId: appState.activeArchitectPlanId,
            importance: 'light',
          }, {
            tauri: dependencies.tauriIpc,
          });
        }

        return await runAcrossTargets(targets, (target) =>
          dependencies.tauriIpc.macroBranchStatus({
            workspacePath: target.repoPath,
          })
        );
      } catch (error) {
        return applyMacroSyncFailure(error, targets);
      }
    });
  };

  return {
    refreshMacroSyncStatus,
    commitMacroMetadata,
    pullMacroMetadata,
    pushMacroMetadata,
    syncMacroMetadataForCodeAction,
    syncMacroMetadataAfterStream,
  };
};

const defaultMacroSyncService = createMacroSyncService();

export const refreshMacroSyncStatus = defaultMacroSyncService.refreshMacroSyncStatus;
export const commitMacroMetadata = defaultMacroSyncService.commitMacroMetadata;
export const pullMacroMetadata = defaultMacroSyncService.pullMacroMetadata;
export const pushMacroMetadata = defaultMacroSyncService.pushMacroMetadata;
export const syncMacroMetadataForCodeAction = defaultMacroSyncService.syncMacroMetadataForCodeAction;
export const syncMacroMetadataAfterStream = defaultMacroSyncService.syncMacroMetadataAfterStream;
