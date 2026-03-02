import * as mockProvider from './providers/mock';
import * as ipcProvider from './providers/ipc';
import * as remoteProvider from './providers/remote';
import { isTauriAvailable } from './tauriIpc';
import type { ServiceProvider } from './contracts/serviceProvider';

export type DataProvider = 'mock' | 'ipc';
export type ServiceTransport = 'desktop' | 'remote';

const envProvider = import.meta.env.VITE_DATA_PROVIDER as DataProvider | undefined;
const providerName: DataProvider = envProvider ?? (isTauriAvailable() ? 'ipc' : 'mock');
const envTransport = import.meta.env.VITE_BACKEND_TRANSPORT as ServiceTransport | undefined;
const transport: ServiceTransport = envTransport ?? 'desktop';

const providerByTransport: Record<ServiceTransport, Record<DataProvider, ServiceProvider>> = {
  desktop: {
    mock: mockProvider.provider,
    ipc: ipcProvider.provider,
  },
  remote: {
    mock: mockProvider.provider,
    ipc: remoteProvider.provider,
  },
};

const provider: ServiceProvider =
  transport === 'desktop' && providerName === 'ipc' && !isTauriAvailable()
    ? providerByTransport.desktop.mock
    : providerByTransport[transport][providerName];

export const services = {
  getAppBootstrap: provider.getAppBootstrap,
  listConversations: provider.listConversations,
  listMessages: provider.listMessages,
  listTasks: provider.listTasks,
  getGitTreeForProject: provider.getGitTreeForProject,
  gitWorktreeCreate: provider.gitWorktreeCreate,
  gitWorktreeRemove: provider.gitWorktreeRemove,
  getFileContent: provider.getFileContent,
  listCommits: provider.listCommits,
  listProviders: provider.listProviders,
  listModels: provider.listModels,
  sendChat: provider.sendChat,
  createProject: provider.createProject,
  importGitRepo: provider.importGitRepo,
  renameProjectGroup: provider.renameProjectGroup,
  renameProject: provider.renameProject,
  archiveProjectGroup: provider.archiveProjectGroup,
  archiveProject: provider.archiveProject,
  closeProject: provider.closeProject,
  getToolSettings: provider.getToolSettings,
  updateToolSettings: provider.updateToolSettings,
  getMCPServerSettings: provider.getMCPServerSettings,
  updateMCPServerSettings: provider.updateMCPServerSettings,
};

export type Services = typeof services;
