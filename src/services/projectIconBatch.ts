import type { ProjectIconDto, ProjectIconResolutionDto } from './tauriIpc';

const DEFAULT_MAX_BATCH_SIZE = 256;

type ProjectIconBatchResolver = (
  projectIds: string[],
) => Promise<ProjectIconResolutionDto[]>;

interface PendingProjectIconRequest {
  projectId: string;
  listeners: Array<{
    resolve: (icon: ProjectIconDto | null) => void;
    reject: (error: unknown) => void;
  }>;
}

export const createProjectIconBatch = (
  batchResolver: ProjectIconBatchResolver,
  maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
): ((projectId: string) => Promise<ProjectIconDto | null>) => {
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new RangeError('Project icon batch size must be a positive integer.');
  }

  const pendingRequests = new Map<string, PendingProjectIconRequest>();
  let batchScheduled = false;

  const flush = async (): Promise<void> => {
    batchScheduled = false;
    const requests = Array.from(pendingRequests.values());
    pendingRequests.clear();

    for (let offset = 0; offset < requests.length; offset += maxBatchSize) {
      const batch = requests.slice(offset, offset + maxBatchSize);
      try {
        const resolutions = await batchResolver(batch.map((request) => request.projectId));
        const iconsByProjectId = new Map(
          resolutions.map((resolution) => [resolution.projectId, resolution.icon] as const),
        );
        batch.forEach((request) => {
          const icon = iconsByProjectId.get(request.projectId) ?? null;
          request.listeners.forEach(({ resolve }) => resolve(icon));
        });
      } catch (error) {
        batch.forEach((request) => request.listeners.forEach(({ reject }) => reject(error)));
      }
    }
  };

  return (projectId) => new Promise((resolve, reject) => {
    const pending = pendingRequests.get(projectId);
    if (pending) {
      pending.listeners.push({ resolve, reject });
    } else {
      pendingRequests.set(projectId, {
        projectId,
        listeners: [{ resolve, reject }],
      });
    }
    if (!batchScheduled) {
      batchScheduled = true;
      queueMicrotask(() => void flush());
    }
  });
};
