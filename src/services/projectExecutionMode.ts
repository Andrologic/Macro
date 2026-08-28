import type { Project, TaskExecutionTarget } from '../types';

export type ProjectExecutionMode = 'git' | 'direct' | 'blocked' | 'invalid';

export type ProjectExecutionModeReason =
  | 'git_ready'
  | 'persisted_git_target'
  | 'direct_edit_enabled'
  | 'persisted_direct_target'
  | 'git_not_initialized'
  | 'initial_commit_missing'
  | 'project_read_only'
  | 'project_missing'
  | 'target_mode_missing'
  | 'git_state_missing'
  | 'target_project_mismatch'
  | 'git_target_without_repository'
  | 'direct_target_without_path'
  | 'contradictory_project_metadata';

export interface ResolvedProjectExecutionMode {
  mode: ProjectExecutionMode;
  reason: ProjectExecutionModeReason;
  source: 'observed_project' | 'persisted_target' | 'legacy_migration';
}

type ExecutionProject = Pick<
  Project,
  'id' | 'path' | 'gitSetupState' | 'directEdit' | 'userReadOnly' | 'isReadOnly'
>;

type ExecutionTarget = Pick<
  TaskExecutionTarget,
  'projectId' | 'executionMode' | 'repoPath' | 'checkpointId'
>;

export const resolveProjectExecutionMode = (params: {
  project: ExecutionProject | null | undefined;
  target?: ExecutionTarget | null;
}): ResolvedProjectExecutionMode => {
  const { project, target } = params;
  if (!project) {
    return { mode: 'invalid', reason: 'project_missing', source: 'legacy_migration' };
  }
  if (target && target.projectId !== project.id) {
    return { mode: 'invalid', reason: 'target_project_mismatch', source: 'persisted_target' };
  }

  if (target?.checkpointId && target.executionMode === 'git') {
    return {
      mode: 'invalid',
      reason: 'contradictory_project_metadata',
      source: 'persisted_target',
    };
  }

  if (target?.executionMode === 'direct' || target?.checkpointId) {
    if (!project.path?.trim() && !target.repoPath?.trim()) {
      return { mode: 'invalid', reason: 'direct_target_without_path', source: 'persisted_target' };
    }
    if (project.userReadOnly) {
      return { mode: 'blocked', reason: 'project_read_only', source: 'observed_project' };
    }
    if (project.gitSetupState === 'unborn') {
      return {
        mode: 'invalid',
        reason: 'contradictory_project_metadata',
        source: 'persisted_target',
      };
    }
    return { mode: 'direct', reason: 'persisted_direct_target', source: 'persisted_target' };
  }

  if (target?.executionMode === 'git') {
    if (!project.path?.trim() && !target.repoPath?.trim()) {
      return {
        mode: 'invalid',
        reason: 'git_target_without_repository',
        source: 'persisted_target',
      };
    }
    if (project.gitSetupState === 'not_git') {
      return {
        mode: 'invalid',
        reason: 'git_target_without_repository',
        source: 'persisted_target',
      };
    }
    if (project.gitSetupState === 'unborn') {
      return { mode: 'blocked', reason: 'initial_commit_missing', source: 'observed_project' };
    }
    if (project.gitSetupState !== 'ready') {
      return { mode: 'invalid', reason: 'git_state_missing', source: 'legacy_migration' };
    }
    if (project.userReadOnly || project.isReadOnly) {
      return { mode: 'blocked', reason: 'project_read_only', source: 'observed_project' };
    }
    if (project.directEdit) {
      return {
        mode: 'invalid',
        reason: 'contradictory_project_metadata',
        source: 'observed_project',
      };
    }
    return { mode: 'git', reason: 'persisted_git_target', source: 'persisted_target' };
  }

  if (
    target &&
    project.gitSetupState === 'ready' &&
    !project.directEdit &&
    !project.userReadOnly &&
    !project.isReadOnly &&
    (project.path?.trim() || target.repoPath?.trim())
  ) {
    return { mode: 'git', reason: 'git_ready', source: 'legacy_migration' };
  }

  if (target) {
    return { mode: 'invalid', reason: 'target_mode_missing', source: 'legacy_migration' };
  }

  if (!project.gitSetupState || project.gitSetupState === 'unknown') {
    return { mode: 'invalid', reason: 'git_state_missing', source: 'legacy_migration' };
  }
  if (project.gitSetupState === 'ready') {
    if (!project.path?.trim()) {
      return {
        mode: 'invalid',
        reason: 'git_target_without_repository',
        source: 'observed_project',
      };
    }
    if (project.directEdit) {
      return {
        mode: 'invalid',
        reason: 'contradictory_project_metadata',
        source: 'observed_project',
      };
    }
    if (project.userReadOnly || project.isReadOnly) {
      return { mode: 'blocked', reason: 'project_read_only', source: 'observed_project' };
    }
    return { mode: 'git', reason: 'git_ready', source: 'observed_project' };
  }
  if (project.gitSetupState === 'unborn') {
    return { mode: 'blocked', reason: 'initial_commit_missing', source: 'observed_project' };
  }
  if (project.gitSetupState === 'not_git' && project.directEdit) {
    if (project.userReadOnly) {
      return { mode: 'blocked', reason: 'project_read_only', source: 'observed_project' };
    }
    return { mode: 'direct', reason: 'direct_edit_enabled', source: 'observed_project' };
  }
  return { mode: 'blocked', reason: 'git_not_initialized', source: 'observed_project' };
};

export const projectExecutionUsesGit = (
  result: ResolvedProjectExecutionMode,
): boolean => result.mode === 'git';

export const projectExecutionUsesDirectEditing = (
  result: ResolvedProjectExecutionMode,
): boolean => result.mode === 'direct';
