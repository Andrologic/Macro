import { archiveTaskMergeWorkflow } from './taskArchiveWorkflow';
import type { TaskExecutionTarget } from '../types';
import type * as tauriIpc from './tauriIpc';
import type { TaskMergeWorkflowPorts, CompleteTaskOptions, TaskCompletionRepositoryRecord } from './taskPortsWorkflow';
import type { createTaskReviewWorkflow } from './taskReviewWorkflow';
import { runTaskPlanFinalizationWorkflow } from './taskPlanFinalizationWorkflow';
import { toServiceError } from './contracts/errors';
import {
  type MergeWorkflowKind, type MergeWorkflowRuntimeState,
  buildInitialMergeWorkflowRuntimeState, buildMergeWorkflowFailureState,
  createMergeWorkflowBlockedError, mergeMergeWorkflowRuntimeState,
  resolveMergeWorkflowPhaseFromRepositories,
} from './mergeWorkflow';
import { buildMergeWorkflowRuntimeFromPersistedSession, overlayPersistedMergeWorkflowSession } from './mergeWorkflowPersistence';
import {
  buildTaskCompletionMergeWorkflowRuntime, integratedWorkflowRepository, cleanupTaskExecutionTargets,
  evolveMergeWorkflowRuntimeRepository, markMergeWorkflowRepositoryMerged, runRepositoryMergeStrategy,
} from './taskRepositoryWorkflow';

/** Git receipts are durable. Failure resumes forward; no repository rollback is promised. */
export function createTaskMergeWorkflow(ports: TaskMergeWorkflowPorts, review: Pick<ReturnType<typeof createTaskReviewWorkflow>, 'load'>) {
  const activeMergeWorkflowRuns = new Map<string, Promise<void>>();
  const tTask = ports.translate;
  const isCompletableMergeWorkflowRepository = (repository: import('./mergeWorkflow').MergeWorkflowRepositoryResult) =>
    repository.mergeInProgress && repository.conflictFiles.length === 0 && repository.blockingKind !== 'repository_dirty';
  const runMerge = async (taskId: string, options?: CompleteTaskOptions): Promise<void> => {
    const activeRun = activeMergeWorkflowRuns.get(taskId);
    if (activeRun) {
      await activeRun;
      return;
    }

    let ownsOperation = false;
    const run = Promise.resolve().then(async () => {
      const task = ports.findTask(taskId);
      if (!task) {
        const error = toServiceError(
          tTask('implement.errors.unknownTask', 'Unknown task: {{taskId}}', { taskId })
        );
        ports.reportError(error.message);
        throw error;
      }
      const hasPendingCompletion = Boolean(ports.readRuntime(task.id) || task.merge_workflow);
      if (task.status === 'Completed' && !hasPendingCompletion) {
        ports.reportError(null);
        return;
      }
      if (task.plan_id && ports.isPlanMutationActive(task.plan_id)) {
        const error = new Error(ports.mutationBlockedMessage());
        ports.reportError(error.message);
        throw error;
      }

      if (ports.isTaskCommandRunActive(taskId) || !(ownsOperation = ports.acquireOperation(taskId))) {
        const error = new Error(ports.mutationBlockedMessage());
        ports.reportError(error.message);
        throw error;
      }

      const kind: MergeWorkflowKind = task.task_source === 'plan_finalization'
        ? 'plan_finalization'
        : 'task_completion';
      ports.validatePlanFinalization(task);
      if (kind === 'task_completion') {
        const todoError = await ports.createTaskTodosBlockedErrorFromPlan(task);
        if (todoError) {
          ports.reportError(todoError.message);
          throw todoError;
        }
        const artifactError = await ports.createTaskArtifactsBlockedErrorFromPlan(task);
        if (artifactError) {
          ports.reportError(artifactError.message);
          throw artifactError;
        }
      }

      const allowWithoutCodeChanges = options?.allowWithoutCodeChanges === true;
      let currentRuntime: MergeWorkflowRuntimeState | null =
        ports.readRuntime(task.id) ??
        (task.merge_workflow
          ? buildMergeWorkflowRuntimeFromPersistedSession({
              taskId: task.id,
              session: task.merge_workflow,
            })
          : null);

      const persistRuntime = async (
        runtime: MergeWorkflowRuntimeState | null
      ): Promise<void> => {
        // Keep the recovery receipt until its removal is acknowledged.
        if (runtime !== null) currentRuntime = runtime;
        await ports.persistRuntime(task, runtime);
        currentRuntime = runtime;
      };

      const completeTaskAndClearRuntime = async (): Promise<void> => {
        // Completion may have committed even when its ACK is lost. Retain the
        // workflow until completion is acknowledged so a restart can retry it.
        await ports.completeTask(task);
        await persistRuntime(null);
      };

      const reloadAfterMergeFailure = async (
        repositoryError: unknown
      ): Promise<MergeWorkflowRuntimeState> => {
        const refreshedRuntime = await review.load(task.id, {
          force: true,
        });
        if (refreshedRuntime) {
          currentRuntime = refreshedRuntime;
          if (
            refreshedRuntime.phase === 'partial' ||
            refreshedRuntime.blockedRepositories.length > 0
          ) {
            throw createMergeWorkflowBlockedError({
              taskId: task.id,
              kind,
              repositories: refreshedRuntime.repositories,
              message: refreshedRuntime.message || undefined,
            });
          }
          if (kind === 'plan_finalization') {
            const failureState = buildMergeWorkflowFailureState(repositoryError, {
              taskId: task.id,
              kind,
            });
            const nextRuntime = mergeMergeWorkflowRuntimeState(
              currentRuntime,
              {
                taskId: task.id,
                kind,
                ...failureState.runtimePatch,
              }
            );
            await persistRuntime(nextRuntime);
            return nextRuntime;
          }
          return refreshedRuntime;
        }

        const failureState = buildMergeWorkflowFailureState(repositoryError, {
          taskId: task.id,
          kind,
        });
        const nextRuntime = mergeMergeWorkflowRuntimeState(
          currentRuntime ||
            buildInitialMergeWorkflowRuntimeState({
              taskId: task.id,
              kind,
            }),
          {
            taskId: task.id,
            kind,
            ...failureState.runtimePatch,
          }
        );
        await persistRuntime(nextRuntime);
        return nextRuntime;
      };

      try {
        if (kind === 'plan_finalization') {
          await runTaskPlanFinalizationWorkflow(ports, task, options, {
            persist: persistRuntime, reloadAfterFailure: reloadAfterMergeFailure,
          });
          return;
        }

        ports.assertTaskBranchExclusive(task);

        if (
          task.status !== 'InReview' &&
          task.status !== 'InProgress' &&
          task.status !== 'Blocked' &&
          task.status !== 'Failed' &&
          !(task.status === 'Completed' && hasPendingCompletion)
        ) {
          throw new Error(
            tTask(
              'implement.errors.completeRequiresActiveStatus',
              'Task can only be completed from Validation.'
            )
          );
        }

        const executionTargets = ports.getExecutionTargets(task);
        if (executionTargets.length === 0) {
          throw new Error(
            tTask(
              'implement.errors.cannotResolveTaskProject',
              'Cannot resolve project for task {{taskId}}',
              { taskId }
            )
          );
        }
        executionTargets.forEach(ports.assertExecutionTargetRunnable);
        const hasDirectTargets = executionTargets.some(ports.isDirectEditTarget);

        const integratedTargets = new Map<string, tauriIpc.GitWorkflowSessionDto>();
        const allGitTargets = ports.getExecutionTargetsWithRepoPaths(task).filter(ports.isGitExecutionTarget);
        for (const target of allGitTargets) {
          const targetBranch = ports.getTaskIntegrationBranch(task, target);
          if (!targetBranch) throw new Error('Missing integration branch.');
          const session = await ports.git.gitWorkflow({
            repoPath: target.repoPath, taskId, sourceBranch: target.branchName,
            targetBranch, action: 'inspect',
          });
          if (session?.status === 'integrated') integratedTargets.set(target.worktreeKey, session);
        }
        let executionTargetsWithRepoPaths: Array<
          TaskExecutionTarget & { repoPath: string; worktreePath: string }
        > = [];
        executionTargetsWithRepoPaths = (await ports.prepareExecutionTargets(task, new Set(integratedTargets.keys()))).filter(ports.isGitExecutionTarget);

        for (const target of executionTargetsWithRepoPaths) {
          const status = await ports.git.gitStatus(target.worktreePath);
          if (!status.is_clean) {
            throw new Error(
              tTask(
                'implement.errors.repositoryNotCleanForComplete',
                'Cannot complete task while repository has uncommitted changes. Commit or stash changes first.'
              )
            );
          }
        }

        const reviewRuntime = overlayPersistedMergeWorkflowSession({
          runtime: await buildTaskCompletionMergeWorkflowRuntime(ports, {
            task,
            executionTargets: executionTargetsWithRepoPaths,
            prepareTargetBranches: true,
            syncStandaloneTargets: !allowWithoutCodeChanges,
          }),
          session: task.merge_workflow ?? null,
        });
        for (const target of allGitTargets) {
          const session = integratedTargets.get(target.worktreeKey);
          if (session) reviewRuntime.repositories.push(integratedWorkflowRepository(target, target.repoPath, null, session));
        }
        reviewRuntime.phase = resolveMergeWorkflowPhaseFromRepositories(reviewRuntime.repositories);
        await persistRuntime(reviewRuntime);

        if (reviewRuntime.blockedRepositories.length > 0) {
          throw createMergeWorkflowBlockedError({
            taskId: task.id,
            kind,
            repositories: reviewRuntime.repositories,
            message: reviewRuntime.message || undefined,
          });
        }

        await persistRuntime({
          ...reviewRuntime,
          phase: 'merging',
          taskStatus: 'InProgress',
          message: null,
        });

        const repositories: TaskCompletionRepositoryRecord[] = [
          ...(options?.repositories || []),
          ...reviewRuntime.repositories.filter((repository) => repository.progressState === 'merged').map((repository) => ({
            projectId: repository.projectId,
            repoPath: repository.repositoryRootPath,
            branchName: repository.sourceBranchName,
            planBranchName: repository.targetBranchName,
            mergeOutput: repository.workflowSession?.output,
          })),
        ];
        let mergedRepositoryCount = reviewRuntime.repositories.filter(
          (repository) => repository.progressState === 'merged'
        ).length;

        for (const repository of reviewRuntime.repositories.filter(
          (candidate) =>
            candidate.progressState === 'pending' ||
            candidate.progressState === 'blocked'
        )) {
          if (allowWithoutCodeChanges && repository.diff.trim()) {
            throw new Error(
              tTask(
                'implement.errors.completeWithoutCodeChangesHasDiff',
                'Cannot complete without code changes because {{branchName}} still contains branch changes.',
                { branchName: repository.targetBranchName }
              )
            );
          }

          if (
            !allowWithoutCodeChanges &&
            !repository.hasChanges &&
            !isCompletableMergeWorkflowRepository(repository)
          ) {
            currentRuntime = evolveMergeWorkflowRuntimeRepository({
              runtime: currentRuntime || reviewRuntime,
              repositoryId: repository.id,
              update: (currentRepository) => ({
                ...currentRepository,
                progressState: 'no_changes',
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
              }),
            });
            await persistRuntime(currentRuntime);
            repositories.push({
              projectId: repository.projectId,
              repoPath: repository.repositoryRootPath,
              branchName: repository.sourceBranchName,
              planBranchName: repository.targetBranchName,
            });
            continue;
          }

          try {
            const mergeOutput = allowWithoutCodeChanges
              ? undefined
              : await runRepositoryMergeStrategy(
                  ports,
                  task.id,
                  repository,
                  options?.mergeStrategyAction
                );
            if (mergeOutput) {
              mergedRepositoryCount += 1;
            }

            currentRuntime = evolveMergeWorkflowRuntimeRepository({
              runtime: currentRuntime || reviewRuntime,
              repositoryId: repository.id,
              update: (currentRepository) => {
                const mergedRepository = markMergeWorkflowRepositoryMerged(currentRepository);
                return allowWithoutCodeChanges
                  ? {
                      ...mergedRepository,
                      progressState: 'no_changes',
                      mergeAppliedAt: currentRepository.mergeAppliedAt,
                    }
                  : mergedRepository;
              },
            });
            await persistRuntime(currentRuntime);

            repositories.push({
              projectId: repository.projectId,
              repoPath: repository.repositoryRootPath,
              branchName: repository.sourceBranchName,
              planBranchName: repository.targetBranchName,
              mergeOutput,
            });
          } catch (error) {
            await reloadAfterMergeFailure(error);
            throw error;
          }
        }

        if (!allowWithoutCodeChanges && mergedRepositoryCount === 0 && !hasDirectTargets) {
          throw new Error(
            tTask(
              'implement.errors.noIntegratedChanges',
              'Cannot complete task because there are no branch changes to integrate.'
            )
          );
        }

        await persistRuntime({
          ...(currentRuntime || reviewRuntime),
          phase: 'archiving',
          taskStatus: 'InProgress',
          message: null,
        });

        for (const repository of (currentRuntime || reviewRuntime).repositories) {
          if (repository.progressState !== 'no_changes') continue;
          const receipt = await ports.git.gitWorkflow({
            repoPath: repository.repoPath, taskId,
            sourceBranch: repository.sourceBranchName, targetBranch: repository.targetBranchName,
            action: 'no_changes', expectedSessionId: repository.workflowSession?.sessionId,
          });
          if (receipt?.status !== 'integrated') throw new Error('The source branch is not integrated. Cleanup was stopped.');
        }

        const removedWorktreeKeys = ports.git.isTauriAvailable()
          ? await cleanupTaskExecutionTargets(ports, allGitTargets, task)
          : [];

        await ports.applyTaskCleanup(task, removedWorktreeKeys);

        await archiveTaskMergeWorkflow(ports, task, repositories, allowWithoutCodeChanges);

        await completeTaskAndClearRuntime();
      } catch (error) {
        const normalized = toServiceError(error);

        if (
          !(ports.isMissingBaseBranchError(error)) &&
          !(kind === 'plan_finalization' && currentRuntime?.phase === 'failed')
        ) {
          try {
            const refreshedRuntime = await review.load(task.id, { force: true });
            if (
              refreshedRuntime &&
              (refreshedRuntime.phase === 'partial' ||
                refreshedRuntime.blockedRepositories.length > 0)
            ) {
              ports.reportError(normalized.message);
            }
          } catch {
            const failureState = buildMergeWorkflowFailureState(error, {
              taskId: task.id,
              kind,
            });
            await persistRuntime(
              mergeMergeWorkflowRuntimeState(
                currentRuntime ||
                  buildInitialMergeWorkflowRuntimeState({
                    taskId: task.id,
                    kind,
                  }),
                {
                  taskId: task.id,
                  kind,
                  ...failureState.runtimePatch,
                }
              )
            );
            ports.reportError(failureState.lastError);
          }
        }

        ports.reportError(normalized.message);
        throw normalized;
      }
    });

    activeMergeWorkflowRuns.set(taskId, run);
    try {
      await run;
    } finally {
      if (ownsOperation) ports.releaseOperation(taskId);
      if (activeMergeWorkflowRuns.get(taskId) === run) {
        activeMergeWorkflowRuns.delete(taskId);
      }
    }
  };
  return { run: runMerge };
};
