export interface RemoteConfig {
  baseUrl: string;
  apiPrefix: string;
  workspaceId?: string;
  authToken?: string;
  timeoutMs: number;
}

const DEFAULT_API_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT_MS = 15000;

const readEnv = (key: string): string | undefined => {
  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const viteValue = viteEnv?.[key];
  if (typeof viteValue === 'string' && viteValue.trim().length > 0) {
    return viteValue.trim();
  }

  if (typeof process !== 'undefined' && process.env) {
    const processValue = process.env[key];
    if (typeof processValue === 'string' && processValue.trim().length > 0) {
      return processValue.trim();
    }
  }

  return undefined;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');

export const resolveRemoteConfig = (): RemoteConfig | null => {
  const baseUrl = readEnv('VITE_REMOTE_API_BASE_URL') ?? readEnv('VITE_REMOTE_BACKEND_URL');
  if (!baseUrl) {
    return null;
  }

  const apiPrefix = readEnv('VITE_REMOTE_API_PREFIX') ?? DEFAULT_API_PREFIX;
  const timeoutRaw = readEnv('VITE_REMOTE_TIMEOUT_MS');
  const timeoutNumber = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  const timeoutMs =
    Number.isFinite(timeoutNumber) && timeoutNumber > 0 ? timeoutNumber : DEFAULT_TIMEOUT_MS;

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiPrefix: apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`,
    workspaceId: readEnv('VITE_REMOTE_WORKSPACE_ID'),
    authToken: readEnv('VITE_REMOTE_AUTH_TOKEN'),
    timeoutMs,
  };
};
