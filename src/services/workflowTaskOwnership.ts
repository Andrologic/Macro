/** Engine-owned Tasks are projections, not independent chat/Git jobs. */
export function assertLegacyTaskOwnership(task: { id: string; task_source?: string } | undefined, taskId = task?.id): void {
  if (task?.task_source === 'agsdl' || taskId?.startsWith('task:agsdl:v1:')) {
    throw Object.assign(new Error('This Agent is controlled by its workflow.'), { code: 'NATIVE_WORKFLOW_OWNED' });
  }
}
