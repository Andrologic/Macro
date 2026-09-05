import type { Project } from '../types';
import { isWslProjectPath } from './wslPaths';

export interface ProjectCapabilities {
  metadata: boolean;
  worktrees: boolean;
  review: boolean;
  mergeWorkflow: boolean;
  // Basic Git merge, status, diff and synchronization have Linux implementations.
  gitOperations: boolean;
  reason: 'wsl' | null;
}

/** Mirrors the explicit WSL refusals in commands/git.rs, not overall Git support. */
export const getProjectCapabilities = (
  project: Pick<Project, 'path'> & Partial<Pick<Project, 'pathKind'>>,
): ProjectCapabilities => {
  const wsl = project.pathKind === 'wsl' || isWslProjectPath(project.path);
  return {
    metadata: !wsl,
    worktrees: !wsl,
    review: !wsl,
    mergeWorkflow: !wsl,
    gitOperations: true,
    reason: wsl ? 'wsl' : null,
  };
};
