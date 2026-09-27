import type { TaskExecutionTarget } from '../types';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import type * as tauriIpc from './tauriIpc';
import type { TaskWorkflowPorts, TaskMergeWorkflowPorts, TaskWorkflowTarget } from './taskPortsWorkflow';
import {
  buildMergeWorkflowRepositoryBlockingState, resolveMergeWorkflowPhaseFromRepositories,
  resolveMergeWorkflowTaskStatus, resolveMergeWorkflowStrategy, isMergeWorkflowSourcePublished,
  shouldCheckMergeWorkflowRebase, resolveMergeWorkflowExecutionAction,
  type MergeWorkflowRepositoryResult, type MergeWorkflowRuntimeState, type MergeWorkflowResolutionAction,
} from './mergeWorkflow';

export const integratedWorkflowRepository = (
  target: TaskExecutionTarget & { repoPath: string },
  repoPath: string,
  integrationWorktreePath: string | null,
  workflowSession: tauriIpc.GitWorkflowSessionDto,
): MergeWorkflowRepositoryResult => ({
  id: `${target.projectId}::${repoPath}`, projectId: target.projectId,
  repoPath, repositoryRootPath: target.repoPath, integrationWorktreePath,
  sourceBranchName: workflowSession.sourceBranch, targetBranchName: workflowSession.targetBranch,
  workflowSession, progressState: 'merged', hadChangesAtStart: true,
  mergeAppliedAt: null, isClean: true, hasChanges: false, ahead: 0, behind: 0,
  mergeable: true, conflictFiles: [], dirtyFiles: [], mergeInProgress: false,
  diff: '', checkStatus: 'passed', blockingKind: null, nextAction: null, blockingReason: null,
  isSourcePublished: false, mergeStrategy: 'no_source_changes', recommendedAction: null, availableActions: [],
});

export const buildTaskCompletionMergeWorkflowRuntime = async (ports: TaskWorkflowPorts, params: {
  task: CatalogedImplementTask;
  executionTargets: TaskWorkflowTarget[];
  prepareTargetBranches?: boolean;
  syncStandaloneTargets?: boolean;
}): Promise<MergeWorkflowRuntimeState> => {
  const tTask = ports.translate;
  const repositories: MergeWorkflowRepositoryResult[] = [];

  for (const target of params.executionTargets) {
    const integrationBranchName = ports.getTaskIntegrationBranch(params.task, target);
    if (!integrationBranchName) {
      throw new Error(
        tTask(
          'implement.errors.missingIntegrationBranch',
          'Cannot determine the integration branch for task {{taskId}}.',
          { taskId: params.task.id }
        )
      );
    }

    const repositoryRootPath = target.repoPath;
    const existingSession = await ports.git.gitWorkflow({
      repoPath: repositoryRootPath, taskId: params.task.id,
      sourceBranch: target.branchName, targetBranch: integrationBranchName, action: 'inspect',
    });
    if (existingSession?.status === 'integrated') {
      repositories.push(integratedWorkflowRepository(target, repositoryRootPath, null, existingSession));
      continue;
    }
    const integrationWorktreePath = await ports.ensureIntegrationWorktree(
      params.task,
      target,
      integrationBranchName
    );
    const operationRepoPath = integrationWorktreePath || repositoryRootPath;

    let status = await ports.git.gitStatus(operationRepoPath);
    const hasRepoConflicts = Boolean(
      (status.conflicted_files?.length || 0) + (status.conflictedFiles?.length || 0)
    );
    const mergeInProgress = Boolean(
      status.mergeInProgress ?? status.merge_in_progress
    );

    if (
      params.prepareTargetBranches &&
      status.branch !== integrationBranchName &&
      !hasRepoConflicts &&
      !mergeInProgress &&
      status.is_clean
    ) {
      await ports.git.gitCheckout({
        repoPath: operationRepoPath,
        branchOrCommit: integrationBranchName,
        create: false,
      });
      status = await ports.git.gitStatus(operationRepoPath);
    }

    if (
      params.prepareTargetBranches &&
      params.syncStandaloneTargets &&
      (!existingSession || existingSession.status === 'aborted') &&
      params.task.task_source === 'standalone' &&
      status.branch === integrationBranchName &&
      status.is_clean &&
      !hasRepoConflicts &&
      !mergeInProgress
    ) {
      await ports.syncIntegrationBranch(operationRepoPath, integrationBranchName);
      status = await ports.git.gitStatus(operationRepoPath);
    }

    const workflowSession = await ports.git.gitWorkflow({
      repoPath: operationRepoPath, taskId: params.task.id,
      sourceBranch: target.branchName, targetBranch: integrationBranchName, action: 'inspect',
    });
    if (workflowSession?.status === 'integrated') {
      repositories.push(integratedWorkflowRepository(target, operationRepoPath, integrationWorktreePath, workflowSession));
      continue;
    }

    const diff = await ports.git.gitDiff({
      repoPath: operationRepoPath,
      base: integrationBranchName,
      head: target.branchName,
      contextLines: 3,
    });

    const mergeCheck = status.is_clean
      ? await ports.git.gitMergeCheck({
          repoPath: operationRepoPath,
          branchName: target.branchName,
          intoBranch: integrationBranchName,
        })
      : {
          mergeable: false,
          conflictFiles: [],
          hasChanges: diff.trim().length > 0,
          ahead: 0,
          behind: 0,
        };
    const branches = await ports.git.gitBranchList(repositoryRootPath).catch(() => null);
    const isSourcePublished = branches
      ? isMergeWorkflowSourcePublished(branches, target.branchName)
      : true;
    const rebaseCheck =
      shouldCheckMergeWorkflowRebase({
        status,
        mergeCheck,
        isSourcePublished,
      })
        ? await ports.git.gitRebaseCheck({
            repoPath: operationRepoPath,
            branchName: target.branchName,
            ontoBranch: integrationBranchName,
          }).catch(() => null)
        : null;
    const strategy = resolveMergeWorkflowStrategy({
      status,
      mergeCheck,
      isSourcePublished,
      rebaseCheck,
    });
    const blocking = buildMergeWorkflowRepositoryBlockingState({
      repositoryPath: operationRepoPath,
      status,
      mergeCheck,
    });

    repositories.push({
      workflowSession: workflowSession ?? undefined,
      id: `${target.projectId}::${operationRepoPath}`,
      projectId: target.projectId,
      repoPath: operationRepoPath,
      repositoryRootPath,
      integrationWorktreePath,
      sourceBranchName: target.branchName,
      targetBranchName: integrationBranchName,
      progressState: strategy.mergeStrategy === 'no_source_changes' ? 'no_changes' : 'pending',
      hadChangesAtStart: strategy.mergeStrategy !== 'no_source_changes' && mergeCheck.hasChanges,
      mergeAppliedAt: null,
      isClean: status.is_clean,
      hasChanges: strategy.mergeStrategy !== 'no_source_changes' && mergeCheck.hasChanges,
      ahead: strategy.ahead,
      behind: strategy.behind,
      mergeable: mergeCheck.mergeable,
      conflictFiles: blocking.conflictFiles,
      dirtyFiles: strategy.dirtyFiles,
      mergeInProgress: blocking.mergeInProgress,
      diff,
      checkStatus: status.is_clean
        ? mergeCheck.mergeable
          ? 'passed'
          : 'failed'
        : 'not_run',
      blockingKind: blocking.blockingKind,
      nextAction: blocking.nextAction,
      blockingReason: blocking.blockingReason,
      isSourcePublished,
      mergeStrategy: strategy.mergeStrategy,
      recommendedAction: strategy.recommendedAction,
      availableActions: strategy.availableActions,
    });
  }

  const blockedRepositories = repositories.filter((repository) =>
    Boolean(repository.blockingReason)
  );
  const phase = blockedRepositories.length > 0 ? 'blocked' : 'ready';

  return {
    taskId: params.task.id,
    kind: 'task_completion',
    phase,
    taskStatus: resolveMergeWorkflowTaskStatus(phase, {
      kind: 'task_completion',
    }),
    review: {
      taskId: params.task.id,
      title: params.task.title,
      taskSource: params.task.task_source,
      planId: params.task.plan_id,
      planTitle: params.task.plan_title,
      targetBranch:
        ports.getReviewTargetBranch(params.task),
    },
    repositories,
    blockedRepositories,
    message:
      blockedRepositories.length > 0
        ? 'Resolve the repository blockers before retrying the merge.'
        : null,
    lastLoadedAt: new Date().toISOString(),
  };
};

export const evolveMergeWorkflowRuntimeRepository = (params: {
  runtime: MergeWorkflowRuntimeState;
  repositoryId: string;
  update: (
    repository: MergeWorkflowRepositoryResult
  ) => MergeWorkflowRepositoryResult;
  message?: string | null;
}): MergeWorkflowRuntimeState => {
  const repositories = params.runtime.repositories.map((repository) =>
    repository.id === params.repositoryId ? params.update(repository) : repository
  );
  const blockedRepositories = repositories.filter(
    (repository) =>
      repository.progressState === 'blocked' || Boolean(repository.blockingReason)
  );
  const phase = resolveMergeWorkflowPhaseFromRepositories(repositories);

  return {
    ...params.runtime,
    phase,
    taskStatus: resolveMergeWorkflowTaskStatus(phase, {
      kind: params.runtime.kind,
    }),
    repositories,
    blockedRepositories,
    message:
      params.message !== undefined
        ? params.message
        : phase === 'partial'
          ? 'Some repositories were already merged. Resolve the remaining blockers, then retry.'
          : blockedRepositories.length > 0
            ? 'Resolve the repository blockers before retrying the merge.'
            : null,
    lastLoadedAt: new Date().toISOString(),
  };
};

export const markMergeWorkflowRepositoryMerged = (
  repository: MergeWorkflowRepositoryResult
): MergeWorkflowRepositoryResult => ({
  ...repository,
  progressState: 'merged',
  mergeAppliedAt: new Date().toISOString(),
  hasChanges: false,
  isClean: true,
  mergeable: true,
  conflictFiles: [],
  mergeInProgress: false,
  blockingKind: null,
  nextAction: null,
  blockingReason: null,
  checkStatus: 'passed',
  diff: '',
});


export const runRepositoryMergeStrategy = async (
  ports: TaskMergeWorkflowPorts,
  taskId: string,
  repository: MergeWorkflowRepositoryResult,
  preferredAction: MergeWorkflowResolutionAction | null | undefined
): Promise<string | undefined> => {
  const action = resolveMergeWorkflowExecutionAction(repository, {
    preferredAction, completionMergePolicy: ports.completionMergePolicy(repository.projectId),
  });
  if (!action) return undefined;
  return ports.serializeRepositoryOperation(repository, async () => {
    const result = await ports.git.gitWorkflow({
      repoPath: repository.repoPath, taskId,
      sourceBranch: repository.sourceBranchName, targetBranch: repository.targetBranchName, action: action === 'complete_merge' ? 'complete' : action,
      expectedSessionId: repository.workflowSession?.sessionId,
    });
    if (result?.status !== 'integrated') throw new Error('Merge integration was not confirmed. Resolve the remaining conflicts.');
    return result.output || 'Merge integrated.';
  });
};


export const cleanupTaskExecutionTargets = async (
  ports: TaskMergeWorkflowPorts,
  executionTargets: Array<TaskExecutionTarget & { repoPath: string }>,
  task: CatalogedImplementTask,
): Promise<string[]> => {
  const removedWorktreeKeys: string[] = [];

  for (const target of executionTargets) {
    const branches = await ports.git.gitBranchList(target.repoPath);
    const session = await ports.git.gitWorkflow({
      repoPath: target.repoPath, taskId: task.id, sourceBranch: target.branchName,
      targetBranch: ports.getTaskIntegrationBranch(task, target)!,
      action: 'inspect',
    });
    if (session?.status !== 'integrated') throw new Error('Cleanup requires a verified integrated merge.');
    const inspection = await ports.git.gitWorktreeInspect({
      repoPath: target.repoPath, taskId: target.worktreeKey, branchName: target.branchName, readOnly: true,
    });
    await ports.git.gitWorkflowCleanup({
      repoPath: target.repoPath,
      identity: {
        taskId: session.taskId,
        sessionId: session.sessionId,
        sourceBranch: session.sourceBranch,
        targetBranch: session.targetBranch,
      },
      worktreeKey: target.worktreeKey,
      removeRemote: (branches.remote || []).some(
        (branch) => branch.name === `origin/${target.branchName}`,
      ),
      expectedWorktreePath: inspection.status === 'absent' ? null : inspection.worktreePath,
    });
    removedWorktreeKeys.push(target.worktreeKey);
  }

  return removedWorktreeKeys;
};
