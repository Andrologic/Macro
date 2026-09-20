import type { TaskMergeWorkflowPorts, CompleteTaskOptions, TaskWorkflowTask } from './taskPortsWorkflow';
import type { MergeWorkflowRuntimeState } from './mergeWorkflow';
import { createMergeWorkflowBlockedError, isMergeWorkflowMergeExecutionAction } from './mergeWorkflow';
import { overlayPersistedMergeWorkflowSession } from './mergeWorkflowPersistence';
import { loadTaskPlanFinalizationReview } from './taskReviewWorkflow';
import { evolveMergeWorkflowRuntimeRepository, markMergeWorkflowRepositoryMerged, runRepositoryMergeStrategy } from './taskRepositoryWorkflow';

/** Resume the existing saga before attempting another strategy. Already merged repositories stay merged. */
export async function runTaskPlanFinalizationWorkflow(
  ports: TaskMergeWorkflowPorts,
  task: TaskWorkflowTask,
  options: CompleteTaskOptions | undefined,
  progress: {
    persist(runtime: MergeWorkflowRuntimeState | null): Promise<void>;
    reloadAfterFailure(error: unknown): Promise<MergeWorkflowRuntimeState>;
  },
): Promise<void> {
  const taskId = task.id;
  const tTask = ports.translate;
  let currentRuntime: MergeWorkflowRuntimeState | null = null;
  const persistRuntime = async (runtime: MergeWorkflowRuntimeState | null) => {
    currentRuntime = runtime;
    await progress.persist(runtime);
  };
  const reloadAfterMergeFailure = progress.reloadAfterFailure;
  const summary = ports.findPlanSummary(task);
  if (!summary) {
    throw new Error(
      tTask(
        'implement.errors.unknownTaskPlan',
        'Cannot update plan metadata for task {{taskId}}.',
        { taskId: task.plan_id }
      )
    );
  }

  const branchName = ports.resolveTargetBranch(summary.storageBranch);
  const reviewRuntime = overlayPersistedMergeWorkflowSession({
    runtime: await loadTaskPlanFinalizationReview(ports, {
      taskId: task.id,
      summary,
    }),
    session: task.merge_workflow ?? null,
  });
  for (const repository of reviewRuntime.repositories) {
    repository.workflowSession = await ports.git.gitWorkflow({
      repoPath: repository.repoPath, taskId,
      sourceBranch: repository.sourceBranchName, targetBranch: repository.targetBranchName,
      action: 'inspect',
    }) ?? undefined;
  }
  await persistRuntime(reviewRuntime);

  const preferredAction = options?.mergeStrategyAction;
  const pendingFinalizationSaga = (await ports.loadPlanLifecycleSagas()).some(
    (saga) =>
      saga.operation === 'finalize' &&
      saga.planId === task.plan_id &&
      saga.branchName === branchName
  );
  if (
    pendingFinalizationSaga &&
    isMergeWorkflowMergeExecutionAction(preferredAction) &&
    preferredAction !== 'complete_merge'
  ) {
    throw new Error(tTask(
      'implement.errors.finalizationStrategyLocked',
      'Finalization has already started. Complete the pending merge or resume without changing its strategy.'
    ));
  }
  if (!pendingFinalizationSaga && isMergeWorkflowMergeExecutionAction(preferredAction)) {
    for (const repository of reviewRuntime.repositories.filter(
      (candidate) =>
        candidate.progressState === 'pending' ||
        candidate.progressState === 'blocked'
    )) {
      if (!repository.availableActions.includes(preferredAction)) {
        continue;
      }

      try {
        const mergeOutput = await runRepositoryMergeStrategy(
          ports,
          task.id,
          repository,
          preferredAction
        );
        if (!mergeOutput) {
          continue;
        }
        currentRuntime = evolveMergeWorkflowRuntimeRepository({
          runtime: currentRuntime || reviewRuntime,
          repositoryId: repository.id,
          update: markMergeWorkflowRepositoryMerged,
        });
        await persistRuntime(currentRuntime);
      } catch (error) {
        await reloadAfterMergeFailure(error);
        throw error;
      }
    }
  }

  const resolvedRuntime = currentRuntime || reviewRuntime;
  if (
    resolvedRuntime.blockedRepositories.length > 0 &&
    !(pendingFinalizationSaga && preferredAction === 'complete_merge')
  ) {
    throw createMergeWorkflowBlockedError({
      taskId: task.id,
      kind: 'plan_finalization',
      repositories: resolvedRuntime.repositories,
      message: resolvedRuntime.message || undefined,
    });
  }

  await persistRuntime({
    ...resolvedRuntime,
    phase: 'merging',
    taskStatus: 'InProgress',
    message: null,
  });

  let finalizedPlan: Awaited<ReturnType<typeof ports.finalizePlanIntoBaseBranch>>;
  try {
    // Checkpoint an assistant-completed merge before the plan saga can remove
    // its source branch. Explicit completion keeps the same native ownership.
    for (const repository of resolvedRuntime.repositories) {
      const session = await ports.git.gitWorkflow({
        repoPath: repository.repoPath, taskId,
        sourceBranch: repository.sourceBranchName, targetBranch: repository.targetBranchName,
        action: 'inspect',
      });
      if (session?.status === 'conflicted' && preferredAction === 'complete_merge') {
        await ports.git.gitWorkflow({
          repoPath: repository.repoPath, taskId,
          sourceBranch: repository.sourceBranchName, targetBranch: repository.targetBranchName,
          action: 'complete', expectedSessionId: session.sessionId,
        });
      }
    }
    finalizedPlan = await ports.finalizePlanIntoBaseBranch({
      branchName,
      planId: task.plan_id,
      ...(pendingFinalizationSaga && preferredAction === 'complete_merge' ? { completePendingMerges: true } : {}),
    });
  } catch (error) {
    await reloadAfterMergeFailure(error);
    throw error;
  }

  const finalizedByRepository = new Map(
    finalizedPlan.repositories.map((repository) => [
      `${repository.projectId}::${repository.repoPath}`,
      repository,
    ])
  );
  const finalizedRuntime = (currentRuntime || reviewRuntime).repositories.reduce(
    (runtime, repository) => {
      const finalized = finalizedByRepository.get(repository.id);
      if (!finalized) return runtime;
      return evolveMergeWorkflowRuntimeRepository({
        runtime,
        repositoryId: repository.id,
        update: (currentRepository) => {
          const mergedRepository = markMergeWorkflowRepositoryMerged(currentRepository);
          return finalized.mergeOutput
            ? mergedRepository
            : {
                ...mergedRepository,
                mergeAppliedAt: currentRepository.mergeAppliedAt,
              };
        },
      });
    },
    currentRuntime || reviewRuntime,
  );
  await persistRuntime({
    ...finalizedRuntime,
    phase: 'archiving',
    taskStatus: 'InProgress',
    message: null,
  });
  await ports.refreshCatalog();
  await persistRuntime(null);
  ports.clearPlanRuntime({
    planId: finalizedPlan.plan.id,
    deletedWorktreeKeys: finalizedPlan.cleanup.flatMap((repository) =>
      repository.deletedWorktrees.map((worktree) => worktree.worktreeKey)
    ),
  });
  return;
}
