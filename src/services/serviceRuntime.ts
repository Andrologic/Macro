export type DataProvider = 'mock' | 'ipc';
export type ServiceTransport = 'desktop' | 'remote';
export type ServiceProviderName = DataProvider | 'remote';

export interface ServiceRuntimeWarning {
  code: 'REMOTE_PROVIDER_IGNORED' | 'IPC_FALLBACK_TO_MOCK';
  message: string;
}

export interface ResolvedServiceRuntime {
  requestedTransport: ServiceTransport;
  requestedProvider: DataProvider | null;
  effectiveTransport: ServiceTransport;
  effectiveProvider: ServiceProviderName;
  warnings: ServiceRuntimeWarning[];
}

export interface ServiceRuntimeCapabilities {
  bootstrap: boolean;
  taskCatalog: boolean;
  gitTree: boolean;
  gitHistory: boolean;
  toolPolicy: boolean;
  toolValidation: boolean;
  toolExecution: boolean;
  toolSettings: boolean;
  mcpServerSettings: boolean;
  projectMutation: boolean;
  projectGitSetupPreview: boolean;
  projectAccessPreview: boolean;
  gitWorktrees: boolean;
  gitFilePreview: boolean;
  taskMutation: boolean;
  implementExecution: boolean;
  taskProjectCommands: boolean;
}

export const REMOTE_UNSUPPORTED_IN_REMOTE_MODE = 'REMOTE_UNSUPPORTED_IN_REMOTE_MODE';
export const REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE =
  'This action is not available in remote mode yet.';

const DESKTOP_RUNTIME_CAPABILITIES: ServiceRuntimeCapabilities = {
  bootstrap: true,
  taskCatalog: true,
  gitTree: true,
  gitHistory: true,
  toolPolicy: true,
  toolValidation: true,
  toolExecution: true,
  toolSettings: true,
  mcpServerSettings: true,
  projectMutation: true,
  projectGitSetupPreview: true,
  projectAccessPreview: true,
  gitWorktrees: true,
  gitFilePreview: true,
  taskMutation: true,
  implementExecution: true,
  taskProjectCommands: true,
};

const REMOTE_MINIMAL_RUNTIME_CAPABILITIES: ServiceRuntimeCapabilities = {
  bootstrap: true,
  taskCatalog: true,
  gitTree: true,
  gitHistory: true,
  toolPolicy: true,
  toolValidation: true,
  toolExecution: true,
  toolSettings: true,
  mcpServerSettings: true,
  projectMutation: false,
  projectGitSetupPreview: false,
  projectAccessPreview: false,
  gitWorktrees: false,
  gitFilePreview: false,
  taskMutation: false,
  implementExecution: false,
  taskProjectCommands: false,
};

const detectTauriRuntime = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

const readEnv = (
  key: string,
  env?: Record<string, string | undefined>
): string | undefined => {
  const directValue = env?.[key];
  if (typeof directValue === 'string' && directValue.trim().length > 0) {
    return directValue.trim();
  }

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

const toTransport = (value?: string): ServiceTransport =>
  value === 'remote' ? 'remote' : 'desktop';

const toProvider = (value?: string): DataProvider | null => {
  if (value === 'mock' || value === 'ipc') {
    return value;
  }

  return null;
};

export const resolveServiceRuntime = (options?: {
  env?: Record<string, string | undefined>;
  tauriAvailable?: boolean;
}): ResolvedServiceRuntime => {
  const requestedTransport = toTransport(readEnv('VITE_BACKEND_TRANSPORT', options?.env));
  const requestedProvider = toProvider(readEnv('VITE_DATA_PROVIDER', options?.env));
  const tauriAvailable = options?.tauriAvailable ?? detectTauriRuntime();
  const warnings: ServiceRuntimeWarning[] = [];

  if (requestedTransport === 'remote') {
    if (requestedProvider) {
      warnings.push({
        code: 'REMOTE_PROVIDER_IGNORED',
        message:
          requestedProvider === 'mock'
            ? 'VITE_DATA_PROVIDER=mock is ignored when VITE_BACKEND_TRANSPORT=remote; using the remote provider instead.'
            : 'VITE_DATA_PROVIDER is ignored when VITE_BACKEND_TRANSPORT=remote; using the remote provider instead.',
      });
    }

    return {
      requestedTransport,
      requestedProvider,
      effectiveTransport: 'remote',
      effectiveProvider: 'remote',
      warnings,
    };
  }

  const defaultProvider: DataProvider = tauriAvailable ? 'ipc' : 'mock';
  const requestedOrDefaultProvider = requestedProvider ?? defaultProvider;
  const effectiveProvider =
    requestedOrDefaultProvider === 'ipc' && !tauriAvailable ? 'mock' : requestedOrDefaultProvider;

  if (requestedOrDefaultProvider === 'ipc' && !tauriAvailable) {
    warnings.push({
      code: 'IPC_FALLBACK_TO_MOCK',
      message: 'Tauri IPC is unavailable in this runtime; falling back to the mock provider.',
    });
  }

  return {
    requestedTransport,
    requestedProvider,
    effectiveTransport: 'desktop',
    effectiveProvider,
    warnings,
  };
};

export const getServiceRuntime = (): ResolvedServiceRuntime => resolveServiceRuntime();

export const resolveServiceRuntimeCapabilities = (
  runtime: ResolvedServiceRuntime = resolveServiceRuntime()
): ServiceRuntimeCapabilities =>
  runtime.effectiveTransport === 'remote'
    ? REMOTE_MINIMAL_RUNTIME_CAPABILITIES
    : DESKTOP_RUNTIME_CAPABILITIES;

export const getServiceRuntimeCapabilities = (): ServiceRuntimeCapabilities =>
  resolveServiceRuntimeCapabilities();

export const isRemoteServiceRuntime = (
  runtime: ResolvedServiceRuntime = resolveServiceRuntime()
): boolean => runtime.effectiveTransport === 'remote';

export const createRemoteUnsupportedInRemoteModeError = (feature: string) => ({
  code: REMOTE_UNSUPPORTED_IN_REMOTE_MODE,
  message: REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
  details: {
    feature,
  },
});
