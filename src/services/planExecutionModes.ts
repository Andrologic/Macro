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
      if (existing && existing !== mode) {
        throw new Error(`Plan project ${projectId} has conflicting execution modes.`);
      }
      modes[projectId] = mode;
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
  if (persisted) return persisted;
  return resolveProjectExecutionMode({ project: params.project }).mode;
};
