import { isTauriAvailable } from './tauriIpc';
import type { ServiceProvider } from './contracts/serviceProvider';

export type DataProvider = 'mock' | 'ipc';
export type ServiceTransport = 'desktop' | 'remote';

type ServiceProviderModule = {
  provider: ServiceProvider;
};

const envProvider = import.meta.env.VITE_DATA_PROVIDER as DataProvider | undefined;
const providerName: DataProvider = envProvider ?? (isTauriAvailable() ? 'ipc' : 'mock');
const envTransport = import.meta.env.VITE_BACKEND_TRANSPORT as ServiceTransport | undefined;
const transport: ServiceTransport = envTransport ?? 'desktop';

let providerPromise: Promise<ServiceProvider> | null = null;

const loadServiceProviderModule = async (
  targetTransport: ServiceTransport,
  targetProvider: DataProvider
): Promise<ServiceProviderModule> => {
  if (targetTransport === 'remote') {
    if (targetProvider === 'mock') {
      return import('./providers/mock');
    }

    return import('./providers/remote');
  }

  if (targetProvider === 'mock') {
    return import('./providers/mock');
  }

  return import('./providers/ipc');
};

const getServiceProvider = async (): Promise<ServiceProvider> => {
  if (!providerPromise) {
    const resolvedProviderName =
      transport === 'desktop' && providerName === 'ipc' && !isTauriAvailable()
        ? 'mock'
        : providerName;

    providerPromise = loadServiceProviderModule(transport, resolvedProviderName).then(
      (module) => module.provider
    );
  }

  return providerPromise;
};

const callProviderMethod = async <MethodName extends keyof ServiceProvider>(
  methodName: MethodName,
  ...args: Parameters<ServiceProvider[MethodName]>
): Promise<Awaited<ReturnType<ServiceProvider[MethodName]>>> => {
  const provider = await getServiceProvider();
  const method = provider[methodName] as (...methodArgs: Parameters<ServiceProvider[MethodName]>) => ReturnType<ServiceProvider[MethodName]>;
  const result = await method(...args);
  return result as Awaited<ReturnType<ServiceProvider[MethodName]>>;
};

export const services = {
  getAppBootstrap: () => callProviderMethod('getAppBootstrap'),
  listConversations: () => callProviderMethod('listConversations'),
  listMessages: (conversationId?: string) => callProviderMethod('listMessages', conversationId),
  listTasks: () => callProviderMethod('listTasks'),
  getGitTreeForProject: (projectId: string) => callProviderMethod('getGitTreeForProject', projectId),
  gitWorktreeCreate: (
    projectId: string,
    taskId: string,
    branchName: string,
    fromRef?: string | null,
    preferredCommitBranch?: string | null
  ) =>
    callProviderMethod(
      'gitWorktreeCreate',
      projectId,
      taskId,
      branchName,
      fromRef,
      preferredCommitBranch
    ),
  gitWorktreeRemove: (projectId: string, taskId: string) =>
    callProviderMethod('gitWorktreeRemove', projectId, taskId),
  getFileContent: (path: string) => callProviderMethod('getFileContent', path),
  listCommits: (projectId?: string) => callProviderMethod('listCommits', projectId),
  listProviders: () => callProviderMethod('listProviders'),
  listModels: (providerId?: string) => callProviderMethod('listModels', providerId),
  sendChat: (request: Parameters<ServiceProvider['sendChat']>[0]) =>
    callProviderMethod('sendChat', request),
  createProject: (data: Parameters<ServiceProvider['createProject']>[0]) =>
    callProviderMethod('createProject', data),
  detectProjectGitFlow: (data: Parameters<ServiceProvider['detectProjectGitFlow']>[0]) =>
    callProviderMethod('detectProjectGitFlow', data),
  previewProjectGitSetup: (data: Parameters<ServiceProvider['previewProjectGitSetup']>[0]) =>
    callProviderMethod('previewProjectGitSetup', data),
  importGitRepo: (data: Parameters<ServiceProvider['importGitRepo']>[0]) =>
    callProviderMethod('importGitRepo', data),
  createProjectWithGitSetup: (
    data: Parameters<ServiceProvider['createProjectWithGitSetup']>[0]
  ) => callProviderMethod('createProjectWithGitSetup', data),
  renameProjectGroup: (data: Parameters<ServiceProvider['renameProjectGroup']>[0]) =>
    callProviderMethod('renameProjectGroup', data),
  renameProject: (data: Parameters<ServiceProvider['renameProject']>[0]) =>
    callProviderMethod('renameProject', data),
  updateProjectGitFlow: (data: Parameters<ServiceProvider['updateProjectGitFlow']>[0]) =>
    callProviderMethod('updateProjectGitFlow', data),
  updateProjectGitFlowWithSetup: (
    data: Parameters<ServiceProvider['updateProjectGitFlowWithSetup']>[0]
  ) => callProviderMethod('updateProjectGitFlowWithSetup', data),
  updateProjectAccess: (data: Parameters<ServiceProvider['updateProjectAccess']>[0]) =>
    callProviderMethod('updateProjectAccess', data),
  previewProjectAccessChange: (data: Parameters<ServiceProvider['previewProjectAccessChange']>[0]) =>
    callProviderMethod('previewProjectAccessChange', data),
  archiveProjectGroup: (data: Parameters<ServiceProvider['archiveProjectGroup']>[0]) =>
    callProviderMethod('archiveProjectGroup', data),
  archiveProject: (data: Parameters<ServiceProvider['archiveProject']>[0]) =>
    callProviderMethod('archiveProject', data),
  removeProjectGroup: (data: Parameters<ServiceProvider['removeProjectGroup']>[0]) =>
    callProviderMethod('removeProjectGroup', data),
  removeProject: (data: Parameters<ServiceProvider['removeProject']>[0]) =>
    callProviderMethod('removeProject', data),
  closeProject: (data: Parameters<ServiceProvider['closeProject']>[0]) =>
    callProviderMethod('closeProject', data),
  getToolSettings: () => callProviderMethod('getToolSettings'),
  updateToolSettings: (settings: Parameters<ServiceProvider['updateToolSettings']>[0]) =>
    callProviderMethod('updateToolSettings', settings),
  getMCPServerSettings: () => callProviderMethod('getMCPServerSettings'),
  updateMCPServerSettings: (settings: Parameters<ServiceProvider['updateMCPServerSettings']>[0]) =>
    callProviderMethod('updateMCPServerSettings', settings),
};

export type Services = typeof services;
