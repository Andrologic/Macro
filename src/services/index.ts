import type { ServiceProvider } from './contracts/serviceProvider';
import {
  getServiceRuntime,
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
  ServiceTransport,
} from './serviceRuntime';

type ServiceProviderModule = {
  provider: ServiceProvider;
};

let providerPromise: Promise<ServiceProvider> | null = null;

const loadServiceProviderModule = async (
  targetProvider: ServiceProviderName
): Promise<ServiceProviderModule> => {
  if (targetProvider === 'remote') {
    return import('./providers/remote');
  }

  return import('./providers/ipc');
};

const getServiceProvider = async (): Promise<ServiceProvider> => {
  if (!providerPromise) {
    const runtime = getServiceRuntime();
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
  mcpDiscoverTools: (server: Parameters<ServiceProvider['mcpDiscoverTools']>[0]) =>
    callProviderMethod('mcpDiscoverTools', server),
  mcpCallTool: (data: Parameters<ServiceProvider['mcpCallTool']>[0]) =>
    callProviderMethod('mcpCallTool', data),
  listSkills: (data?: Parameters<ServiceProvider['listSkills']>[0]) =>
    callProviderMethod('listSkills', data),
  getSkill: (data: Parameters<ServiceProvider['getSkill']>[0]) =>
    callProviderMethod('getSkill', data),
  installSkillFromLocalPath: (data: Parameters<ServiceProvider['installSkillFromLocalPath']>[0]) =>
    callProviderMethod('installSkillFromLocalPath', data),
  readSkillResource: (data: Parameters<ServiceProvider['readSkillResource']>[0]) =>
    callProviderMethod('readSkillResource', data),
  runSkillScript: (data: Parameters<ServiceProvider['runSkillScript']>[0]) =>
    callProviderMethod('runSkillScript', data),
};

export type Services = typeof services;
