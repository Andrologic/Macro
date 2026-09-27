/** workspaceTools IPC wrappers and frontend adapters. */

import type {
  AppMode,
  ProjectMount,
} from "../../types";
import { invoke } from "../tauriRuntimeBridge";
import type {
  ToolModePolicyDto,
  ToolValidationResultDto,
  WorkspaceScope,
} from "./workspaceTools.types";

export async function validateToolExecution(params: {
  mode: AppMode;
  toolId: string;
  path?: string;
}): Promise<ToolValidationResultDto> {
  return invoke<ToolValidationResultDto>("tool_validate_execution", {
    mode: params.mode,
    toolId: params.toolId,
    path: params.path,
  });
}

export async function getToolModePolicy(
  mode: AppMode,
): Promise<ToolModePolicyDto> {
  return invoke<ToolModePolicyDto>("tool_get_mode_policy", { mode });
}

export async function executeWorkspaceTool(params: {
  mode: AppMode;
  toolId: string;
  args: Record<string, unknown>;
  workspacePath?: string | null;
  workspaceScope?: WorkspaceScope;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  executionId?: string | null;
}): Promise<string> {
  return invoke<string>("tool_execute_workspace", {
    mode: params.mode,
    toolId: params.toolId,
    args: params.args,
    workspacePath: params.workspacePath ?? null,
    workspaceScope: params.workspaceScope ?? null,
    projectMounts: (params.projectMounts ?? []).map((mount) => ({
      project_id: mount.projectId,
      mount_name: mount.mountName,
      workspace_path: mount.workspacePath ?? null,
      display_name: mount.displayName,
      is_read_only: Boolean(mount.isReadOnly),
    })),
    virtualRootEnabled: params.virtualRootEnabled ?? null,
    focusedProjectId: params.focusedProjectId ?? null,
    executionId: params.executionId ?? null,
  });
}

export async function cancelWorkspaceTool(executionId: string): Promise<boolean> {
  return invoke<boolean>("tool_cancel_workspace", { executionId });
}
