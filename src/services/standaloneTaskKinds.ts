import type { ProjectGitFlowSettings, StandaloneTaskKind } from '../types';
import { isMainlineGitWorkflow } from './architectGitNaming';

export const STANDALONE_TASK_KINDS: readonly StandaloneTaskKind[] = [
  'direct',
  'feature',
  'bugfix',
  'hotfix',
];

export const getCreatableStandaloneTaskKinds = (
  settings?: Partial<ProjectGitFlowSettings> | null,
): StandaloneTaskKind[] => {
  if (!settings) {
    return [...STANDALONE_TASK_KINDS];
  }

  return isMainlineGitWorkflow(settings)
    ? ['direct', 'feature', 'hotfix']
    : [...STANDALONE_TASK_KINDS];
};

export const isStandaloneTaskKindCreatable = (
  taskKind: StandaloneTaskKind,
  settings?: Partial<ProjectGitFlowSettings> | null,
): boolean => getCreatableStandaloneTaskKinds(settings).includes(taskKind);
