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
const BOUNDED_GIT_OUTPUT_CAPABILITY = 'bounded_git_output_v1';
const STRUCTURAL_SEARCH_CAPABILITY = 'structural_search_v1';
const BOUNDED_OUTPUT_TOOL_IDS = new Set(['list', 'read', 'glob', 'grep', 'ast_grep']);
const BOUNDED_GIT_OUTPUT_TOOL_IDS = new Set([
  'git_status',
  'git_log',
  'git_diff',
]);

const requiresContentRevisions = (params: {
  toolId: string;
  args: Record<string, unknown>;
}): boolean => {
  return ['write', 'edit', 'delete', 'apply_patch'].includes(params.toolId);
};

interface RemoteToolValidation {
  allowed: boolean;
  reason?: string | null;
  enforce_macro_only_writes: boolean;
}

const remoteKernelRequest = async <T>(path: string, options: RequestInit = {}): Promise<T> =>
  remoteRequest<T>(path, options);

let remoteToolExecutionCounter = 0;

const createRemoteToolExecutionId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  remoteToolExecutionCounter += 1;
  return `remote-tool-${Date.now()}-${remoteToolExecutionCounter}`;
};

export const cancelRemoteWorkspaceTool = async (executionId: string): Promise<boolean> => {
  const result = await remoteKernelRequest<{ cancelled?: boolean }>('/tools/cancel', {
    method: 'POST',
    body: JSON.stringify({ execution_id: executionId }),
  });
  return Boolean(result?.cancelled);
};

export const canUseRemoteKernel = (): boolean => {
  try {
    return isRemoteServiceRuntime() && resolveRemoteConfig() !== null;
  } catch {
    return false;
  }
};

export const getRemoteToolModePolicy = async (
  mode: AppMode,
  projectId?: string,
  signal?: AbortSignal,
): Promise<RemoteToolModePolicy> => {
  const query = [
    `mode=${encodeURIComponent(mode)}`,
    ...(projectId ? [`projectId=${encodeURIComponent(projectId)}`] : []),
  ].join('&');
  return remoteKernelRequest<RemoteToolModePolicy>(`/tools/mode-policy?${query}`, {
    method: 'GET',
    signal,
  });
};

export const validateRemoteToolExecution = async (params: {
  mode: AppMode;
  toolId: string;
  path?: string;
  projectId: string;
}): Promise<RemoteToolValidation> => {
  return remoteKernelRequest<RemoteToolValidation>('/tools/validate', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      tool_id: params.toolId,
      path: params.path,
      projectId: params.projectId,
    }),
  });
};

export const executeRemoteWorkspaceTool = async (params: {
  mode: AppMode;
  toolId: string;
  args: Record<string, unknown>;
  projectId?: string | null;
  workspacePath?: string | null;
  workspaceScope?: 'default' | 'metadata';
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  signal?: AbortSignal;
}): Promise<string> => {
  const needsContentRevisions = requiresContentRevisions(params);
  const needsBoundedOutput = BOUNDED_OUTPUT_TOOL_IDS.has(params.toolId);
  const needsBoundedGitOutput = BOUNDED_GIT_OUTPUT_TOOL_IDS.has(params.toolId);
  const needsStructuralSearch = params.toolId === 'ast_grep';
  if (needsContentRevisions || needsBoundedOutput || needsBoundedGitOutput || needsStructuralSearch) {
    const policy = await getRemoteToolModePolicy(
      params.mode,
      params.projectId ?? undefined,
      params.signal,
    );
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
    if (
      needsBoundedGitOutput &&
      !policy.capabilities?.includes(BOUNDED_GIT_OUTPUT_CAPABILITY)
    ) {
      throw new Error(
        'The remote Macro kernel cannot guarantee bounded Git tool output. Update the remote kernel before retrying this repository inspection tool.'
      );
    }
    if (
      needsStructuralSearch &&
      !policy.capabilities?.includes(STRUCTURAL_SEARCH_CAPABILITY)
    ) {
      throw new Error(
        'The remote Macro kernel does not support structural search. Update the remote kernel before retrying ast_grep.'
      );
    }
  }
  const executionId = createRemoteToolExecutionId();
  const signal = params.signal;
  const sendCancellation = (): void => {
    void cancelRemoteWorkspaceTool(executionId).catch(() => false);
  };
  const abortListener =
    signal && !signal.aborted
      ? (): void => {
          sendCancellation();
        }
      : undefined;
  if (signal?.aborted) {
    sendCancellation();
  } else if (abortListener && signal) {
    signal.addEventListener('abort', abortListener, { once: true });
  }

  try {
    const payload = await remoteKernelRequest<{ result: string }>('/tools/execute', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        mode: params.mode,
        tool_id: params.toolId,
        execution_id: executionId,
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
  } finally {
    if (abortListener && signal) {
      signal.removeEventListener('abort', abortListener);
    }
  }
};
