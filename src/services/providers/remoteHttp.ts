import { createRemoteUnsupportedInRemoteModeError } from '../serviceRuntime';
import { createCombinedAbortSignal } from '../../utils/abortSignals';
import { resolveRemoteConfig, type RemoteConfig } from './remoteConfig';

export { resolveRemoteConfig } from './remoteConfig';

export const notConfigured = (): never => {
  throw {
    code: 'REMOTE_NOT_CONFIGURED',
    message: 'Remote backend transport is not configured yet',
  };
};

export const ensureRemoteConfig = (): RemoteConfig => {
  const config = resolveRemoteConfig();
  if (!config) {
    return notConfigured();
  }

  return config;
};

export const getWorkspaceBasePath = (config: RemoteConfig): string => {
  if (!config.workspaceId) {
    return '/workspace';
  }

  return `/workspaces/${encodeURIComponent(config.workspaceId)}`;
};

export const toAbsoluteApiUrl = (config: RemoteConfig, path: string): string => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${config.baseUrl}${config.apiPrefix}${normalizedPath}`;
};

const extractPayload = <T>(payload: unknown, key?: string): T => {
  if (!key) {
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data;
    }

    return payload as T;
  }

  if (payload && typeof payload === 'object') {
    const direct = payload as Record<string, unknown>;
    if (key in direct) {
      return direct[key] as T;
    }

    if ('data' in direct && direct.data && typeof direct.data === 'object') {
      const nested = direct.data as Record<string, unknown>;
      if (key in nested) {
        return nested[key] as T;
      }
    }
  }

  throw {
    code: 'REMOTE_INVALID_RESPONSE',
    message: `Remote response did not include expected field: ${key}`,
    details: payload,
  };
};

interface RemoteStructuredErrorBody {
  code?: unknown;
  message?: unknown;
}

const readStructuredErrorBody = (
  body: unknown,
): { code?: string; message?: string } | null => {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const candidate = body as RemoteStructuredErrorBody;
  return {
    code:
      typeof candidate.code === 'string' && candidate.code.trim().length > 0
        ? candidate.code
        : undefined,
    message:
      typeof candidate.message === 'string' &&
      candidate.message.trim().length > 0
        ? candidate.message
        : undefined,
  };
};

export const remoteRequest = async <T>(
  path: string,
  options: RequestInit & {
    payloadKey?: string;
  } = {}
): Promise<T> => {
  const config = ensureRemoteConfig();
  const { payloadKey, ...requestOptions } = options;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
    ...(requestOptions.headers as Record<string, string> | undefined),
  };

  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  const combinedSignal = createCombinedAbortSignal([
    requestOptions.signal ?? undefined,
    controller.signal,
  ]);
  const url = toAbsoluteApiUrl(config, path);

  try {
    const response = await fetch(url, {
      ...requestOptions,
      headers,
      signal: combinedSignal.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);

    if (!response.ok) {
      const structured = readStructuredErrorBody(body);
      throw {
        code: structured?.code ?? 'REMOTE_REQUEST_FAILED',
        message: structured?.message ?? `Remote request failed (${response.status})`,
        details: {
          status: response.status,
          url,
          body,
        },
      };
    }

    return extractPayload<T>(body, payloadKey);
  } catch (error) {
    if (
      !(error instanceof Error) &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string'
    ) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      if (requestOptions.signal?.aborted) {
        throw error;
      }
      throw {
        code: 'REMOTE_TIMEOUT',
        message: `Remote request timed out after ${config.timeoutMs}ms`,
        details: { url },
      };
    }

    throw {
      code: 'REMOTE_REQUEST_ERROR',
      message: 'Remote request failed to execute',
      details: {
        url,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeoutId);
    combinedSignal.dispose();
  }
};

export const remoteUnsupported = (feature: string): never => {
  throw createRemoteUnsupportedInRemoteModeError(feature);
};
