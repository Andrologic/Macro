export type DataProvider = 'ipc';
export type ServiceTransport = 'desktop' | 'remote';
export type ServiceProviderName = DataProvider | 'remote';

export interface ResolvedServiceRuntime {
  requestedTransport: ServiceTransport;
  effectiveTransport: ServiceTransport;
  effectiveProvider: ServiceProviderName;
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
  skills: boolean;
}

export const REMOTE_UNSUPPORTED_IN_REMOTE_MODE = 'REMOTE_UNSUPPORTED_IN_REMOTE_MODE';
export const REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE =
  'This action is not available in remote mode yet.';
export const DESKTOP_IPC_UNAVAILABLE_MESSAGE =
  'Desktop transport requires Tauri IPC; use VITE_BACKEND_TRANSPORT=remote for web/mobile runtimes.';

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
  skills: true,
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
  skills: true,
};

const hasTauriIpcInvoke = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const tauriWindow = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: unknown;
    } | null;
  };

  return typeof tauriWindow.__TAURI_INTERNALS__?.invoke === 'function';
};

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

export const resolveServiceRuntime = (options?: {
  env?: Record<string, string | undefined>;
  tauriAvailable?: boolean;
}): ResolvedServiceRuntime => {
  const requestedTransport = toTransport(readEnv('VITE_BACKEND_TRANSPORT', options?.env));
  const tauriAvailable = options?.tauriAvailable ?? hasTauriIpcInvoke();

  if (requestedTransport === 'remote') {
    return {
      requestedTransport,
      effectiveTransport: 'remote',
      effectiveProvider: 'remote',
    };
  }

  if (!tauriAvailable) {
    throw new Error(DESKTOP_IPC_UNAVAILABLE_MESSAGE);
  }

  return {
    requestedTransport,
    effectiveTransport: 'desktop',
    effectiveProvider: 'ipc',
  };
};

export const getServiceRuntime = (): ResolvedServiceRuntime => resolveServiceRuntime();

export const resolveServiceRuntimeCapabilities = (
  runtime?: ResolvedServiceRuntime
): ServiceRuntimeCapabilities => {
  const resolvedRuntime = runtime ?? resolveServiceRuntime();
  return resolvedRuntime.effectiveTransport === 'remote'
    ? REMOTE_MINIMAL_RUNTIME_CAPABILITIES
    : DESKTOP_RUNTIME_CAPABILITIES;
};

export const getServiceRuntimeCapabilities = (): ServiceRuntimeCapabilities => {
  try {
    return resolveServiceRuntimeCapabilities();
  } catch (error) {
    if (error instanceof Error && error.message === DESKTOP_IPC_UNAVAILABLE_MESSAGE) {
      return REMOTE_MINIMAL_RUNTIME_CAPABILITIES;
    }
    throw error;
  }
};

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
