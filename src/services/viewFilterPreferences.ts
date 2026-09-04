export const ALL_PROJECTS_FILTER = '__all_projects__';
export const TASK_QUEUE_STATUS_FILTERS = [
  'all',
  'attention',
  'ready',
  'in_progress',
  'waiting',
  'blocked',
  'failed',
] as const;

export type TaskQueueStatusFilter = (typeof TASK_QUEUE_STATUS_FILTERS)[number];

export interface ImplementViewFilters {
  version: 1;
  projectId: string;
  status: TaskQueueStatusFilter;
  showArchived: boolean;
}

export interface ArchivedViewFilter {
  version: 1;
  showArchived: boolean;
}

export const DEFAULT_IMPLEMENT_VIEW_FILTERS: ImplementViewFilters = {
  version: 1,
  projectId: ALL_PROJECTS_FILTER,
  status: 'all',
  showArchived: false,
};

export const DEFAULT_ARCHITECT_VIEW_FILTERS: ArchivedViewFilter = {
  version: 1,
  showArchived: false,
};

export const DEFAULT_CHAT_VIEW_FILTERS: ArchivedViewFilter = {
  version: 1,
  showArchived: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTaskQueueStatusFilter = (value: unknown): value is TaskQueueStatusFilter =>
  typeof value === 'string' &&
  (TASK_QUEUE_STATUS_FILTERS as readonly string[]).includes(value);

export const normalizeImplementViewFilters = (value: unknown): ImplementViewFilters => {
  if (!isRecord(value) || value.version !== 1) {
    return { ...DEFAULT_IMPLEMENT_VIEW_FILTERS };
  }

  return {
    version: 1,
    projectId:
      typeof value.projectId === 'string' && value.projectId.trim().length > 0
        ? value.projectId
        : ALL_PROJECTS_FILTER,
    status: isTaskQueueStatusFilter(value.status) ? value.status : 'all',
    showArchived: typeof value.showArchived === 'boolean' ? value.showArchived : false,
  };
};

export const normalizeArchivedViewFilter = (
  value: unknown,
  fallback: ArchivedViewFilter,
): ArchivedViewFilter => {
  if (!isRecord(value) || value.version !== 1) {
    return { ...fallback };
  }
  return {
    version: 1,
    showArchived: typeof value.showArchived === 'boolean'
      ? value.showArchived
      : fallback.showArchived,
  };
};

export const resolveAvailableProjectFilter = (
  projectId: string,
  availableProjectIds: Iterable<string>,
): string => {
  if (projectId === ALL_PROJECTS_FILTER) return projectId;
  return new Set(availableProjectIds).has(projectId)
    ? projectId
    : ALL_PROJECTS_FILTER;
};
