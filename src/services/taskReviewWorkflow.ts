import type { TaskWorkflowPorts } from './taskPortsWorkflow';
import { toServiceError } from './contracts/errors';
import { buildTaskCompletionMergeWorkflowRuntime } from './taskRepositoryWorkflow';
import {
  type MergeWorkflowKind, type MergeWorkflowRuntimeState,
  mergeMergeWorkflowRuntimeState, resolveMergeWorkflowTaskStatus,
  buildMergeWorkflowFailureState, toPlanFinalizationMergeWorkflowRuntimeState,
} from './mergeWorkflow';
import { overlayPersistedMergeWorkflowSession } from './mergeWorkflowPersistence';

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
  const load = async (taskId: string, options?: { force?: boolean }): Promise<MergeWorkflowRuntimeState | null> => {
    const task = ports.findTask(taskId);
    if (!task) {
      return null;
    }

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

      ports.publishRuntime(taskId, mergeMergeWorkflowRuntimeState(ports.readRuntime(taskId) ?? undefined, {
        taskId, kind, phase: 'loading_review',
        taskStatus: task.status === 'AwaitingResponse' ? 'AwaitingResponse' : resolveMergeWorkflowTaskStatus('loading_review', { kind }),
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

        const persistedSession = task.merge_workflow ?? null;
        const resolvedRuntime = {
          ...nextRuntime,
          taskStatus:
            task.status === 'AwaitingResponse'
              ? 'AwaitingResponse'
              : nextRuntime.taskStatus,
        };
        const mergedRuntime = overlayPersistedMergeWorkflowSession({
          runtime: resolvedRuntime,
          session: persistedSession,
        });

        if (mergeWorkflowReviewLoads.get(taskId)?.token !== loadToken) {
          return ports.readRuntime(taskId) ?? null;
        }

        await ports.persistRuntime(task, mergedRuntime);
        ports.reportError(null);

        return mergedRuntime;
      } catch (error) {
        if (mergeWorkflowReviewLoads.get(taskId)?.token !== loadToken) {
          throw toServiceError(error);
        }
        const failureState = buildMergeWorkflowFailureState(error, {
          taskId,
          kind,
        });
        const nextRuntime = mergeMergeWorkflowRuntimeState(
          ports.readRuntime(taskId) ?? undefined,
          {
            taskId,
            kind,
            ...failureState.runtimePatch,
          }
        );
        await ports.persistRuntime(task, nextRuntime);
        ports.reportError(failureState.lastError);
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
