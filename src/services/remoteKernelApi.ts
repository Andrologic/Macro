import type { AgentCodeCheckpointFileSnapshot, AppMode, ProjectMount } from '../types';
import { isRemoteServiceRuntime } from './serviceRuntime';
import { remoteRequest, resolveRemoteConfig } from './providers/remoteHttp';
import { TOOL_OUTPUT_LIMITS } from '../shared/toolOutputLimits';

interface RemoteToolModePolicy {
  allowed_tool_ids: string[];
  enforce_macro_only_writes: boolean;
  capabilities?: string[];
}

const CONTENT_REVISIONS_CAPABILITY = 'content_revisions_v1';
const BOUNDED_TOOL_OUTPUT_CAPABILITY = 'bounded_tool_output_v1';
const BOUNDED_GIT_OUTPUT_CAPABILITY = 'bounded_git_output_v1';
const STRUCTURAL_SEARCH_CAPABILITY = 'structural_search_v1';
const RECOVERABLE_CHECKPOINTS_CAPABILITY = 'recoverable_checkpoints_v1';
const INTERRUPTIBLE_REMOTE_TOOL_IDS = new Set(['list', 'read', 'glob', 'grep', 'ast_grep']);
const MUTATING_REMOTE_TOOL_IDS = new Set([
  'write',
  'edit',
  'delete',
  'apply_patch',
  'git_add',
  'git_commit',
  'git_checkout',
  'git_merge',
  'git_reset',
  'git_stash',
]);
const BOUNDED_OUTPUT_TOOL_IDS = new Set(['list', 'read', 'glob', 'grep', 'ast_grep']);
const BOUNDED_GIT_OUTPUT_TOOL_IDS = new Set([
  'git_status',
  'git_log',
  'git_branch_list',
  'git_diff',
  'git_get_tree',
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

type RemoteKernelRequestOptions = RequestInit & { timeoutMs?: number | null };

const remoteKernelRequest = async <T>(
  path: string,
  options: RemoteKernelRequestOptions = {},
): Promise<T> => remoteRequest<T>(path, options);

const remoteToolTimeoutMs = (toolId: string): number | null | undefined => {
  if (toolId === 'grep') return TOOL_OUTPUT_LIMITS.grep.timeoutMs + 1_000;
  if (toolId === 'ast_grep') return TOOL_OUTPUT_LIMITS.ast.timeoutMs + 1_000;
  if (toolId === 'read') return TOOL_OUTPUT_LIMITS.read.timeoutMs + 1_000;
  if (toolId === 'list') return TOOL_OUTPUT_LIMITS.list.timeoutMs + 1_000;
  if (toolId === 'glob') return TOOL_OUTPUT_LIMITS.glob.timeoutMs + 1_000;
  if (MUTATING_REMOTE_TOOL_IDS.has(toolId)) return null;
  return undefined;
};

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

export interface RemoteCheckpointSnapshotFile {
  path: string;
  before: AgentCodeCheckpointFileSnapshot;
  after: AgentCodeCheckpointFileSnapshot;
}

export interface RemoteWorkspaceToolExecution {
  result: string;
  checkpoint?: { files: RemoteCheckpointSnapshotFile[] } | null;
}

export const executeRemoteWorkspaceToolDetailed = async (params: {
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
  checkpointRequired?: boolean;
}): Promise<RemoteWorkspaceToolExecution> => {
  const needsContentRevisions = requiresContentRevisions(params);
  const needsBoundedOutput = BOUNDED_OUTPUT_TOOL_IDS.has(params.toolId);
  const needsBoundedGitOutput = BOUNDED_GIT_OUTPUT_TOOL_IDS.has(params.toolId);
  const needsStructuralSearch = params.toolId === 'ast_grep';
  if (
    needsContentRevisions ||
    needsBoundedOutput ||
    needsBoundedGitOutput ||
    needsStructuralSearch ||
    params.checkpointRequired
  ) {
    const policy = await getRemoteToolModePolicy(
      params.mode,
      params.projectId ?? params.focusedProjectId ?? undefined,
      params.signal,
    );
    if (needsContentRevisions && !policy.capabilities?.includes(CONTENT_REVISIONS_CAPABILITY)) {
      throw new Error(
        'The remote Macro kernel cannot enforce content revisions. Update the remote kernel before retrying this guarded mutation.',
      );
    }
    if (needsBoundedOutput && !policy.capabilities?.includes(BOUNDED_TOOL_OUTPUT_CAPABILITY)) {
      throw new Error(
        'The remote Macro kernel cannot guarantee bounded, resumable tool output. Update the remote kernel before retrying this read-only tool.',
      );
    }
    if (needsBoundedGitOutput && !policy.capabilities?.includes(BOUNDED_GIT_OUTPUT_CAPABILITY)) {
      throw new Error(
        'The remote Macro kernel cannot guarantee bounded Git tool output. Update the remote kernel before retrying this repository inspection tool.',
      );
    }
    if (needsStructuralSearch && !policy.capabilities?.includes(STRUCTURAL_SEARCH_CAPABILITY)) {
      throw new Error(
        'The remote Macro kernel does not support structural search. Update the remote kernel before retrying ast_grep.',
      );
    }
    if (
      params.checkpointRequired &&
      !policy.capabilities?.includes(RECOVERABLE_CHECKPOINTS_CAPABILITY)
    ) {
      throw new Error(
        'The remote Macro kernel cannot provide recoverable code checkpoints. Update the remote kernel before retrying this mutation.',
      );
    }
  }
  if (MUTATING_REMOTE_TOOL_IDS.has(params.toolId) && params.signal?.aborted) {
    throw params.signal.reason instanceof Error
      ? params.signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
  const executionId = createRemoteToolExecutionId();
  const signal = params.signal;
  const interruptible = INTERRUPTIBLE_REMOTE_TOOL_IDS.has(params.toolId);
  const sendCancellation = (): void => {
    void cancelRemoteWorkspaceTool(executionId).catch(() => false);
  };
  const abortListener =
    interruptible && signal && !signal.aborted
      ? (): void => {
          sendCancellation();
        }
      : undefined;
  if (interruptible && signal?.aborted) {
    sendCancellation();
  } else if (abortListener && signal) {
    signal.addEventListener('abort', abortListener, { once: true });
  }

  try {
    const payload = await remoteKernelRequest<RemoteWorkspaceToolExecution>('/tools/execute', {
      method: 'POST',
      signal: interruptible ? signal : undefined,
      timeoutMs: remoteToolTimeoutMs(params.toolId),
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
        checkpoint_required: params.checkpointRequired ?? false,
      }),
    });

    if (params.checkpointRequired) {
      const files = payload.checkpoint?.files;
      if (
        !Array.isArray(files) ||
        files.length === 0 ||
        files.some(
          (file) =>
            !file ||
            typeof file.path !== 'string' ||
            file.path.trim().length === 0 ||
            !isRemoteCheckpointSnapshot(file.before) ||
            !isRemoteCheckpointSnapshot(file.after),
        )
      ) {
        throw new Error(
          'The remote Macro kernel completed a mutation without returning valid recoverable checkpoint snapshots.',
        );
      }
    }
    return payload;
  } catch (error) {
    if (
      interruptible &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'REMOTE_TIMEOUT'
    ) {
      sendCancellation();
    }
    throw error;
  } finally {
    if (abortListener && signal) {
      signal.removeEventListener('abort', abortListener);
    }
  }
};

export const executeRemoteWorkspaceTool = async (
  params: Parameters<typeof executeRemoteWorkspaceToolDetailed>[0],
): Promise<string> => (await executeRemoteWorkspaceToolDetailed(params)).result;

const isRemoteCheckpointSnapshot = (value: unknown): value is AgentCodeCheckpointFileSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.exists !== 'boolean') return false;
  if (
    candidate.unixMode !== undefined &&
    candidate.unixMode !== null &&
    (!Number.isInteger(candidate.unixMode) ||
      Number(candidate.unixMode) < 0 ||
      Number(candidate.unixMode) > 0o7777)
  ) {
    return false;
  }
  if (!candidate.exists) {
    return (
      candidate.content === null &&
      (candidate.revision === null || candidate.revision === undefined)
    );
  }
  return (
    typeof candidate.content === 'string' &&
    typeof candidate.revision === 'string' &&
    candidate.revision.trim().length > 0 &&
    candidate.isBinary !== true
  );
};

export const readRemoteWorkspaceCheckpointSnapshot = async (params: {
  mode: AppMode;
  path: string;
  projectId?: string | null;
  workspacePath?: string | null;
  workspaceScope?: 'default' | 'metadata';
}): Promise<AgentCodeCheckpointFileSnapshot> => {
  const projectId = params.projectId?.trim();
  if (!projectId) {
    throw new Error('A project is required to read a remote checkpoint snapshot.');
  }
  const policy = await getRemoteToolModePolicy(params.mode, projectId);
  if (!policy.capabilities?.includes(RECOVERABLE_CHECKPOINTS_CAPABILITY)) {
    throw new Error(
      'The remote Macro kernel cannot provide recoverable code checkpoints. Update the remote kernel before retrying this replay.',
    );
  }
  const response = await remoteKernelRequest<{ snapshot: unknown }>('/tools/checkpoint-snapshot', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      path: params.path,
      project_id: projectId,
      workspace_path: params.workspacePath ?? null,
      workspace_scope: params.workspaceScope ?? null,
    }),
  });
  const parsed = response.snapshot;
  if (!isRemoteCheckpointSnapshot(parsed)) {
    throw new Error('The remote Macro kernel returned an incomplete checkpoint snapshot.');
  }
  return parsed;
};
