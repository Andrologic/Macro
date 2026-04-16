import type { AppMode } from '../types';
import { isRemoteServiceRuntime } from './serviceRuntime';
import { remoteRequest, resolveRemoteConfig } from './providers/remoteHttp';

interface RemoteToolModePolicy {
  allowed_tool_ids: string[];
  enforce_macro_only_writes: boolean;
}

interface RemoteToolValidation {
  allowed: boolean;
  reason?: string | null;
  enforce_macro_only_writes: boolean;
}

const remoteKernelRequest = async <T>(path: string, options: RequestInit = {}): Promise<T> =>
  remoteRequest<T>(path, options);

export const canUseRemoteKernel = (): boolean =>
  isRemoteServiceRuntime() && resolveRemoteConfig() !== null;

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
}): Promise<string> => {
  const payload = await remoteKernelRequest<{ result: string }>('/tools/execute', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      tool_id: params.toolId,
      args: params.args,
      workspace_path: params.workspacePath ?? null,
      workspace_scope: params.workspaceScope ?? null,
    }),
  });

  return payload.result;
};
