type ManualDraftInitializationTask = {
  draft?: boolean | null;
  task_source?: string | null;
  standalone_kind?: 'legacy' | 'manual_feature' | null;
  branch_name?: string | null;
};

export const isManualDraftPendingInitialization = (
  task: ManualDraftInitializationTask | null | undefined
): boolean =>
  task?.draft === true &&
  task?.task_source === 'standalone' &&
  task?.standalone_kind === 'manual_feature' &&
  !task.branch_name?.trim();
