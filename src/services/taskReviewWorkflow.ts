import type { TaskWorkflowPorts } from './taskPortsWorkflow';
import { toServiceError } from './contracts/errors';
import { buildTaskCompletionMergeWorkflowRuntime } from './taskRepositoryWorkflow';
import {
  type MergeWorkflowKind, type MergeWorkflowRuntimeState,
  mergeMergeWorkflowRuntimeState, resolveMergeWorkflowTaskStatus,
  buildMergeWorkflowFailureState, toPlanFinalizationMergeWorkflowRuntimeState,
} from './mergeWorkflow';
import { overlayPersistedMergeWorkflowSession } from './mergeWorkflowPersistence';
import { assertLegacyTaskOwnership } from './workflowTaskOwnership';

export async function loadTaskPlanFinalizationReview(
  ports: Pick<TaskWorkflowPorts, 'loadPlanReview'>,
  input: { taskId: string; summary: { id: string; storageBranch: string } },
): Promise<MergeWorkflowRuntimeState> {
  const review = await ports.loadPlanReview({ branchName: input.summary.storageBranch, planId: input.summary.id, syncBaseBranches: false });
  return toPlanFinalizationMergeWorkflowRuntimeState({ taskId: input.taskId, review });
}

/** One instance per task catalog; forced loads supersede earlier in-flight loads. */
export function createTaskReviewWorkflow(ports: TaskWorkflowPorts) {
  const tTask = ports.translate;
  const mergeWorkflowReviewLoads = new Map<string, { token: symbol; promise: Promise<MergeWorkflowRuntimeState | null> }>();
  // A catalog removal or terminal task/plan ends the lifetime of a review load.
  const findActiveTask = (taskId: string) => {
    const task = ports.findTask(taskId);
    return task && task.status !== 'Completed' && !task.archived_at &&
      task.plan_status !== 'completed' && task.plan_status !== 'archived'
      ? task
      : undefined;
  };
  const load = async (taskId: string, options?: { force?: boolean }): Promise<MergeWorkflowRuntimeState | null> => {
    const task = findActiveTask(taskId);
    if (!task) {
      return null;
    }
    assertLegacyTaskOwnership(task);

    const kind: MergeWorkflowKind = task.task_source === 'plan_finalization'
      ? 'plan_finalization'
      : 'task_completion';
    const existingRuntime = ports.readRuntime(taskId);
    if (!options?.force && existingRuntime?.review) {
      return existingRuntime;
    }

    const existingLoad = mergeWorkflowReviewLoads.get(taskId);
    if (!options?.force && existingLoad) {
      return existingLoad.promise;
    }

    const loadToken = Symbol(taskId);
    const loadPromise = Promise.resolve().then(async (): Promise<MergeWorkflowRuntimeState | null> => {
      const loadingTask = findActiveTask(taskId);
      if (!loadingTask) return null;

      ports.publishRuntime(taskId, mergeMergeWorkflowRuntimeState(ports.readRuntime(taskId) ?? undefined, {
        taskId, kind, phase: 'loading_review',
        taskStatus: loadingTask.status === 'AwaitingResponse' ? 'AwaitingResponse' : resolveMergeWorkflowTaskStatus('loading_review', { kind }),
        message: null,
      }));
      ports.reportError(null);

      try {
        let nextRuntime: MergeWorkflowRuntimeState | null = null;
        if (kind === 'plan_finalization') {
          const summary = ports.findPlanSummary(task);
          if (!summary) {
            return null;
          }
          nextRuntime = await loadTaskPlanFinalizationReview(ports, {
            taskId,
            summary,
          });
        } else {
          const executionTargets = ports.getExecutionTargetsWithRepoPaths(task);
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
          const gitExecutionTargets = executionTargets.filter(ports.isGitExecutionTarget);
          nextRuntime = await buildTaskCompletionMergeWorkflowRuntime(ports, {
            task,
            executionTargets: gitExecutionTargets,
          });
        }

        if (!nextRuntime) {
          return null;
        }

        if (kind === 'plan_finalization') {
          for (const repository of nextRuntime.repositories) {
            const session = await ports.git.gitWorkflow({
              repoPath: repository.repoPath, taskId,
              sourceBranch: repository.sourceBranchName, targetBranch: repository.targetBranchName,
              action: 'inspect',
            });
            repository.workflowSession = session ?? undefined;
          }
        }

        const currentTask = findActiveTask(taskId);
        if (!currentTask) return null;
        if (mergeWorkflowReviewLoads.get(taskId)?.token !== loadToken) {
          return ports.readRuntime(taskId) ?? null;
        }
        const currentRuntime = ports.readRuntime(taskId);
        if (currentRuntime?.phase === 'merging' || currentRuntime?.phase === 'archiving') {
          return currentRuntime;
        }

        const persistedSession = currentTask.merge_workflow ?? null;
        const mergedRuntime = overlayPersistedMergeWorkflowSession({
          runtime: nextRuntime,
          session: persistedSession,
        });
        if (currentTask.status === 'AwaitingResponse') {
          mergedRuntime.taskStatus = 'AwaitingResponse';
        }

        await ports.persistRuntime(currentTask, mergedRuntime);
        if (!findActiveTask(taskId)) return null;
        if (mergeWorkflowReviewLoads.get(taskId)?.token === loadToken) {
          ports.reportError(null);
        }

        return mergedRuntime;
      } catch (error) {
        const currentTask = findActiveTask(taskId);
        if (!currentTask) return null;
        if (mergeWorkflowReviewLoads.get(taskId)?.token !== loadToken) {
          throw toServiceError(error);
        }
        const currentRuntime = ports.readRuntime(taskId);
        if (currentRuntime?.phase === 'merging' || currentRuntime?.phase === 'archiving') {
          return currentRuntime;
        }
        const failureState = buildMergeWorkflowFailureState(error, {
          taskId,
          kind,
        });
        const nextRuntime = mergeMergeWorkflowRuntimeState(
          currentRuntime ?? undefined,
          {
            taskId,
            kind,
            ...failureState.runtimePatch,
          }
        );
        await ports.persistRuntime(currentTask, nextRuntime);
        if (!findActiveTask(taskId)) return null;
        if (mergeWorkflowReviewLoads.get(taskId)?.token === loadToken) {
          ports.reportError(failureState.lastError);
        }
        throw toServiceError(error);
      }
    });

    mergeWorkflowReviewLoads.set(taskId, {
      token: loadToken,
      promise: loadPromise,
    });

    try {
      return await loadPromise;
    } finally {
      if (mergeWorkflowReviewLoads.get(taskId)?.token === loadToken) {
        mergeWorkflowReviewLoads.delete(taskId);
      }
    }
  };
  return { load };
};
