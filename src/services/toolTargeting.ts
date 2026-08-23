import type { ProjectExecutionContext } from './projectExecutionContext';

export interface TerminalSessionProjectTarget {
  projectId: string | null;
  readOnlyProjectLabel: string | null;
}

export const resolveTerminalSessionProjectTarget = (
  context: ProjectExecutionContext,
  explicitProjectId: unknown
): TerminalSessionProjectTarget => {
  const normalizedExplicitProjectId =
    typeof explicitProjectId === 'string' && explicitProjectId.trim().length > 0
      ? explicitProjectId.trim()
      : null;
  const projectId =
    normalizedExplicitProjectId ||
    context.focusedProjectId ||
    context.projectId ||
    (context.actionableProjectIds.length === 1 ? context.actionableProjectIds[0] : null);

  const targetProject = projectId
    ? context.projectMounts.find((mount) => mount.projectId === projectId)
    : null;
  const readOnlyProjectLabel = targetProject?.isReadOnly
    ? targetProject.displayName || targetProject.mountName || targetProject.projectId
    : null;

  return { projectId, readOnlyProjectLabel };
};
