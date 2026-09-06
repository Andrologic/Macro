import type { Project, TaskExecutionTarget } from '../types';
import type { ImplementTask } from '../stores/useTaskStore';
import { getFileChangesExecutionTargets } from './fileChangesReviewScope';
import { getProjectCapabilities } from './projectCapabilities';
import * as ipc from './tauriIpc';

export interface WorktreeDiagnosticTarget {
  target: TaskExecutionTarget;
  project: Pick<Project, 'path' | 'name' | 'gitFlowSettings'> & Partial<Pick<Project, 'pathKind'>>;
}

export function getWorktreeDiagnosticTargets(
  task: ImplementTask,
  getProject: (id: string) => Project | null | undefined,
): WorktreeDiagnosticTarget[] {
  const targets = getFileChangesExecutionTargets(task);
  return targets.filter((target) => target.executionMode !== 'direct' && target.executionKind !== 'repository_root')
    .flatMap((target) => {
      const project = getProject(target.projectId);
      const path = project?.path || target.repoPath;
      return path ? [{ target, project: { path, name: project?.name || target.projectId, gitFlowSettings: project?.gitFlowSettings, pathKind: project?.pathKind } }] : [];
    });
}

export async function inspectWorktree({ target, project }: WorktreeDiagnosticTarget) {
  if (!getProjectCapabilities(project).worktrees) throw new Error('WSL worktree diagnostics are unavailable.');
  return ipc.gitWorktreeInspect({ repoPath: project.path, taskId: target.worktreeKey, branchName: target.branchName, readOnly: true });
}

export async function repairWorktree(entry: WorktreeDiagnosticTarget) {
  if (!getProjectCapabilities(entry.project).worktrees) throw new Error('WSL worktree repair is unavailable.');
  const { target, project } = entry;
  // Reinspect immediately before the backend's protected ensure operation.
  const inspection = await inspectWorktree(entry);
  if (inspection.status === 'ready') {
    if (inspection.branchName !== target.branchName) throw new Error('The worktree uses another branch. Preserve your changes and restore the expected branch before retrying.');
    return inspection;
  }
  await ipc.gitWorktreeCreate({
    repoPath: project.path,
    taskId: target.worktreeKey,
    branchName: target.branchName,
    fromRef: target.planBranchName || target.targetBranchName || project.gitFlowSettings?.baseBranch || null,
    preferredCommitBranch: project.gitFlowSettings?.baseBranch,
    fallbackBranches: [project.gitFlowSettings?.baseBranch, project.gitFlowSettings?.mainBranch].filter((branch): branch is string => Boolean(branch)),
  });
  return inspectWorktree(entry);
}
