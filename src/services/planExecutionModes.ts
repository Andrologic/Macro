import type { PlanNode, Project } from '../types';
import { resolveProjectExecutionMode, type ProjectExecutionMode } from './projectExecutionMode';

export const getPlanExecutionModesByProjectId = (
  nodes: PlanNode[] | null | undefined,
): Record<string, 'git' | 'direct'> => {
  const modes: Record<string, 'git' | 'direct'> = {};
  for (const node of nodes ?? []) {
    for (const [projectId, mode] of Object.entries(node.executionModesByProjectId ?? {})) {
      if (mode !== 'git' && mode !== 'direct') continue;
      const existing = modes[projectId];
      // A plan can span a project's transition from direct editing to Git.
      // Finalization needs Git if any surviving node for that project used it;
      // otherwise the direct-only plan remains free of Git operations.
      modes[projectId] = existing === 'git' || mode === 'git' ? 'git' : 'direct';
    }
  }
  return modes;
};

export const resolvePlanProjectExecutionMode = (params: {
  projectId: string;
  nodes: PlanNode[] | null | undefined;
  project: Project | null | undefined;
}): ProjectExecutionMode => {
  const persisted = getPlanExecutionModesByProjectId(params.nodes)[params.projectId];
  if (persisted) {
    return resolveProjectExecutionMode({
      project: params.project,
      target: {
        projectId: params.projectId,
        executionMode: persisted,
        repoPath: params.project?.path,
      },
    }).mode;
  }
  return resolveProjectExecutionMode({ project: params.project }).mode;
};
