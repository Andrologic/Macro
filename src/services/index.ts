import type { ServiceProvider } from './contracts/serviceProvider';
import {
  getServiceRuntime,
  type ResolvedServiceRuntime,
  type ServiceProviderName,
} from './serviceRuntime';

export {
  createRemoteUnsupportedInRemoteModeError,
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE,
  REMOTE_UNSUPPORTED_IN_REMOTE_MODE_MESSAGE,
  getServiceRuntime,
  getServiceRuntimeCapabilities,
  isRemoteServiceRuntime,
  resolveServiceRuntime,
  resolveServiceRuntimeCapabilities,
} from './serviceRuntime';
export type {
  DataProvider,
  ResolvedServiceRuntime,
  ServiceProviderName,
  ServiceRuntimeCapabilities,
  ServiceRuntimeWarning,
  ServiceTransport,
} from './serviceRuntime';

type ServiceProviderModule = {
  provider: ServiceProvider;
};

let providerPromise: Promise<ServiceProvider> | null = null;
let runtimeWarningsLogged = false;

const loadServiceProviderModule = async (
  targetProvider: ServiceProviderName
): Promise<ServiceProviderModule> => {
  if (targetProvider === 'remote') {
    return import('./providers/remote');
  }

  if (targetProvider === 'mock') {
    return import('./providers/mock');
  }

  return import('./providers/ipc');
};

const logRuntimeWarnings = (runtime: ResolvedServiceRuntime): void => {
  if (!import.meta.env.DEV || runtimeWarningsLogged || runtime.warnings.length === 0) {
    return;
  }

  runtimeWarningsLogged = true;
  runtime.warnings.forEach((warning) => {
    console.warn(`[services] ${warning.message}`);
  });
};

const getServiceProvider = async (): Promise<ServiceProvider> => {
  if (!providerPromise) {
    const runtime = getServiceRuntime();
    logRuntimeWarnings(runtime);
    providerPromise = loadServiceProviderModule(runtime.effectiveProvider).then(
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
  const method = provider[methodName] as (
    ...methodArgs: Parameters<ServiceProvider[MethodName]>
  ) => ReturnType<ServiceProvider[MethodName]>;
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
    preferredCommitBranch?: string | null,
    fallbackBranches?: string[] | null
  ) =>
    callProviderMethod(
      'gitWorktreeCreate',
      projectId,
      taskId,
      branchName,
      fromRef,
      preferredCommitBranch,
      fallbackBranches
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
  previewProjectAccessChange: (
    data: Parameters<ServiceProvider['previewProjectAccessChange']>[0]
  ) => callProviderMethod('previewProjectAccessChange', data),
  archiveProjectGroup: (data: Parameters<ServiceProvider['archiveProjectGroup']>[0]) =>
    callProviderMethod('archiveProjectGroup', data),
  archiveProject: (data: Parameters<ServiceProvider['archiveProject']>[0]) =>
    callProviderMethod('archiveProject', data),
  removeProjectGroup: (data: Parameters<ServiceProvider['removeProjectGroup']>[0]) =>
    callProviderMethod('removeProjectGroup', data),
  removeProject: (data: Parameters<ServiceProvider['removeProject']>[0]) =>
    callProviderMethod('removeProject', data),
  debugResetProject: (data: Parameters<ServiceProvider['debugResetProject']>[0]) =>
    callProviderMethod('debugResetProject', data),
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
