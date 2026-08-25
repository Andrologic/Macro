import type { ProjectExecutionContext } from './projectExecutionContext';
import type { WorkspaceFileReference } from '../types';
import { fsSearchFiles, type WorkspaceFileSearchRootDto } from './tauriIpc';

export interface WorkspaceFileSearchParams {
  executionContext: ProjectExecutionContext;
  query: string;
  limit?: number;
  includeHidden?: boolean;
}

const toSearchRoots = (
  executionContext: ProjectExecutionContext,
): WorkspaceFileSearchRootDto[] => {
  const roots = executionContext.projectMounts
    .filter((mount) => Boolean(mount.workspacePath))
    .map((mount) => ({
      project_id: mount.projectId,
      project_name: mount.displayName,
      workspace_path: mount.workspacePath as string,
      mount_name: mount.mountName,
      is_focused: mount.projectId === executionContext.focusedProjectId,
    }));

  if (roots.length > 0) return roots;

  if (!executionContext.workspacePath) return [];
  return [{
    project_id: executionContext.projectId,
    project_name: executionContext.projectName,
    workspace_path: executionContext.workspacePath,
    mount_name: null,
    is_focused: true,
  }];
};

export const searchWorkspaceFiles = async ({
  executionContext,
  query,
  limit = 30,
  includeHidden = false,
}: WorkspaceFileSearchParams): Promise<WorkspaceFileReference[]> => {
  const roots = toSearchRoots(executionContext);
  if (roots.length === 0 || !query.trim()) return [];

  const results = await fsSearchFiles({
    roots,
    query,
    limit,
    includeHidden,
    virtualRootEnabled: executionContext.virtualRootEnabled,
  });

  return results.map((result) => ({
    id: result.id,
    path: result.path,
    relativePath: result.relative_path,
    projectId: result.project_id ?? null,
    projectName: result.project_name ?? null,
    language: result.language ?? null,
    sizeBytes: result.size_bytes ?? null,
    modified: result.modified ?? null,
    isFocused: result.is_focused,
  }));
};
