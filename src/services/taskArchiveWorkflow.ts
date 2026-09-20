import type { TaskMergeWorkflowPorts, TaskWorkflowTask, TaskCompletionRepositoryRecord } from './taskPortsWorkflow';
import { isPlanMetadataMissingError, toServiceError } from './contracts/errors';

/** Apply completion to the latest plan under its mutation lock, then persist the execution receipt. */
export async function archiveTaskMergeWorkflow(
  ports: TaskMergeWorkflowPorts, task: TaskWorkflowTask,
  repositories: TaskCompletionRepositoryRecord[], allowWithoutCodeChanges: boolean,
): Promise<void> {
  const tTask = ports.translate;
  const completedAt = new Date().toISOString();
  if ((task.task_source === 'standalone' && task.standalone_kind === 'manual_feature') && !task.draft) {
    await ports.git.workspaceArchiveManualFeature({
      taskId: task.id,
      reason: 'merged',
      mergedAt: completedAt,
    });
    await ports.refreshCatalog();
    const archivedTask: TaskWorkflowTask = ports.findTask(task.id) ?? {
      ...task, status: 'Completed', archived_at: completedAt,
      archive_reason: 'merged', merged_at: completedAt,
    };
    await ports.syncManualFeatureTaskMetadata(archivedTask, (message) => {
      ports.reportError(message);
    });
    await ports.commitManualFeatureTaskMetadata(
      archivedTask,
      `chore(metadata): complete manual feature ${task.id}`,
      (message) => {
        ports.reportError(message);
      }
    );
    ports.deselectTaskIfSelected(task.id);
    return;
  }

  if (task.task_source === 'architect' && (task.plan_storage_branch || task.plan_target_branch)) {
    try {
      const targetBranch = ports.getTaskPlanStorageBranch(task);
      const plan = await ports.mutateArchitectPlanTaskStatus({ branchName: targetBranch, planId: task.plan_id }, (current) => {
        if (current.status === 'deleted') {
          throw new Error(tTask('implement.errors.unknownTaskPlan', 'Cannot update plan metadata for task {{taskId}}.', { taskId: task.id }));
        }
        const update = ports.deriveCompletedPlanStatus(current, task);
        return { ...update, nodes: (update.nodes || []).map((node) => node.id === ports.getTaskBusinessId(task)
          ? { ...node, status: 'completed' as const, archivedAt: completedAt, archiveReason: 'merged', mergedAt: completedAt }
          : node) };
      });
      ports.publishCompletedPlan(plan);
      await ports.refreshCatalog();
      ports.deselectTaskIfSelected(task.id);
    } catch (error) {
      const normalized = toServiceError(error);
      const failure = isPlanMetadataMissingError(error)
        ? {
            ...normalized,
            message: tTask('implement.errors.unknownTaskPlan', 'Cannot update plan metadata for task {{taskId}}.', { taskId: task.id }),
          }
        : normalized;
      ports.reportError(failure.message);
      throw failure;
    }

    try {
      await ports.writeArchitectTaskExecution({
        branchName: ports.getTaskPlanStorageBranch(task),
        planId: task.plan_id,
        execution: {
          taskId: task.id,
          title: task.title,
          completedAt,
          summary: allowWithoutCodeChanges
            ? 'Completed without code changes.'
            : undefined,
          repositories,
        },
      });
    } catch (error) {
      const normalized = toServiceError(error);
      ports.reportError(normalized.message);
      throw normalized;
    }

    await ports.commitArchitectPlanMetadataForTask(
      task,
      `chore(metadata): complete architect task ${task.id}`,
      (message) => {
        ports.reportError(message);
      }
    );
  }

}
