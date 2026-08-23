import type { AppMode, ProjectMount } from '../types';
import { isRemoteServiceRuntime } from './serviceRuntime';
import { remoteRequest, resolveRemoteConfig } from './providers/remoteHttp';

interface RemoteToolModePolicy {
  allowed_tool_ids: string[];
  enforce_macro_only_writes: boolean;
  capabilities?: string[];
}

const CONTENT_REVISIONS_CAPABILITY = 'content_revisions_v1';
const BOUNDED_TOOL_OUTPUT_CAPABILITY = 'bounded_tool_output_v1';
const BOUNDED_OUTPUT_TOOL_IDS = new Set(['list', 'read', 'glob', 'grep']);

const requiresContentRevisions = (params: {
  toolId: string;
  args: Record<string, unknown>;
}): boolean => {
  if (['write', 'edit', 'delete'].includes(params.toolId)) {
    return typeof params.args.expected_revision === 'string' && params.args.expected_revision.trim().length > 0;
  }
  if (params.toolId !== 'apply_patch') return false;
  if (
    params.args.expected_revisions &&
    typeof params.args.expected_revisions === 'object' &&
    !Array.isArray(params.args.expected_revisions) &&
    Object.keys(params.args.expected_revisions).length > 0
  ) {
    return true;
  }
  return (
    typeof params.args.patch_text === 'string' &&
    params.args.patch_text.includes('*** Add File:')
  );
};

interface RemoteToolValidation {
  allowed: boolean;
  reason?: string | null;
  enforce_macro_only_writes: boolean;
}

const remoteKernelRequest = async <T>(path: string, options: RequestInit = {}): Promise<T> =>
  remoteRequest<T>(path, options);

export const canUseRemoteKernel = (): boolean => {
  try {
    return isRemoteServiceRuntime() && resolveRemoteConfig() !== null;
  } catch {
    return false;
  }
};

export const getRemoteToolModePolicy = async (mode: AppMode): Promise<RemoteToolModePolicy> => {
  return remoteKernelRequest<RemoteToolModePolicy>(
    `/tools/mode-policy?mode=${encodeURIComponent(mode)}`,
    { method: 'GET' }
  );
};

export const validateRemoteToolExecution = async (params: {
  mode: AppMode;
  toolId: string;
  path?: string;
}): Promise<RemoteToolValidation> => {
  return remoteKernelRequest<RemoteToolValidation>('/tools/validate', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      tool_id: params.toolId,
      path: params.path,
    }),
  });
};

export const executeRemoteWorkspaceTool = async (params: {
  mode: AppMode;
  toolId: string;
  args: Record<string, unknown>;
  workspacePath?: string | null;
  workspaceScope?: 'default' | 'metadata';
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
}): Promise<string> => {
  const needsContentRevisions = requiresContentRevisions(params);
  const needsBoundedOutput = BOUNDED_OUTPUT_TOOL_IDS.has(params.toolId);
  if (needsContentRevisions || needsBoundedOutput) {
    const policy = await getRemoteToolModePolicy(params.mode);
    if (
      needsContentRevisions &&
      !policy.capabilities?.includes(CONTENT_REVISIONS_CAPABILITY)
    ) {
      throw new Error(
        'The remote Macro kernel cannot enforce content revisions. Update the remote kernel before retrying this guarded mutation.'
      );
    }
    if (
      needsBoundedOutput &&
      !policy.capabilities?.includes(BOUNDED_TOOL_OUTPUT_CAPABILITY)
    ) {
      throw new Error(
        'The remote Macro kernel cannot guarantee bounded, resumable tool output. Update the remote kernel before retrying this read-only tool.'
      );
    }
  }
  const payload = await remoteKernelRequest<{ result: string }>('/tools/execute', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      tool_id: params.toolId,
      args: params.args,
      workspace_path: params.workspacePath ?? null,
      workspace_scope: params.workspaceScope ?? null,
      project_mounts: (params.projectMounts ?? []).map((mount) => ({
        project_id: mount.projectId,
        mount_name: mount.mountName,
        workspace_path: mount.workspacePath ?? null,
        display_name: mount.displayName,
        is_read_only: Boolean(mount.isReadOnly),
      })),
      virtual_root_enabled: params.virtualRootEnabled ?? null,
      focused_project_id: params.focusedProjectId ?? null,
    }),
  });

  return payload.result;
};
