import type { AppMode } from '../types';
import { resolveRemoteConfig } from './providers/remote';

interface RemoteToolModePolicy {
  allowed_tool_ids: string[];
  enforce_macro_only_writes: boolean;
}

interface RemoteToolValidation {
  allowed: boolean;
  reason?: string | null;
  enforce_macro_only_writes: boolean;
}

const isRemoteTransport = (): boolean =>
  (import.meta.env.VITE_BACKEND_TRANSPORT as string | undefined) === 'remote';

const remoteKernelRequest = async <T>(
  path: string,
  options: RequestInit = {}
): Promise<T> => {
  const config = resolveRemoteConfig();
  if (!config) {
    throw {
      code: 'REMOTE_NOT_CONFIGURED',
      message: 'Remote backend transport is not configured yet',
    };
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...options,
    headers,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw {
      code: 'REMOTE_REQUEST_FAILED',
      message: payload?.message || `Remote request failed (${response.status})`,
      details: payload,
    };
  }

  return payload as T;
};

export const canUseRemoteKernel = (): boolean => isRemoteTransport() && resolveRemoteConfig() !== null;

export const getRemoteToolModePolicy = async (mode: AppMode): Promise<RemoteToolModePolicy> => {
  return remoteKernelRequest<RemoteToolModePolicy>(
    `/api/v1/tools/mode-policy?mode=${encodeURIComponent(mode)}`,
    { method: 'GET' }
  );
};

export const validateRemoteToolExecution = async (params: {
  mode: AppMode;
  toolId: string;
  path?: string;
}): Promise<RemoteToolValidation> => {
  return remoteKernelRequest<RemoteToolValidation>('/api/v1/tools/validate', {
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
  const payload = await remoteKernelRequest<{ result: string }>('/api/v1/tools/execute', {
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
