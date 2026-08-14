export interface PlanLocator {
  branchName: string;
  planId: string;
}

export interface TaskRuntimeIdentity extends PlanLocator {
  nodeId: string;
}

const encodePart = (value: string): string => encodeURIComponent(value.trim());

export const toPlanLocatorKey = ({ branchName, planId }: PlanLocator): string =>
  `plan:v1:${encodePart(branchName)}:${encodePart(planId)}`;

export const toTaskRuntimeId = ({ branchName, planId, nodeId }: TaskRuntimeIdentity): string =>
  `task:v1:${encodePart(branchName)}:${encodePart(planId)}:${encodePart(nodeId)}`;

export const resolveTaskReference = <T extends { id: string; node_id?: string | null }>(
  tasks: readonly T[],
  reference: string,
): T | undefined => {
  const exact = tasks.find((task) => task.id === reference);
  if (exact) return exact;

  const legacyMatches = tasks.filter((task) => task.node_id === reference);
  return legacyMatches.length === 1 ? legacyMatches[0] : undefined;
};

export const getTaskBusinessId = (task: { id: string; node_id?: string | null }): string =>
  task.node_id || task.id;

export const taskReferenceMatches = <T extends { id: string; node_id?: string | null }>(
  tasks: readonly T[], task: T, reference: string | null | undefined,
): boolean => Boolean(reference) && resolveTaskReference(tasks, reference!)?.id === task.id;
