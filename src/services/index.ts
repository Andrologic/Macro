import * as mockProvider from './providers/mock';
import * as ipcProvider from './providers/ipc';
import { isTauriAvailable } from './tauriIpc';

export type DataProvider = 'mock' | 'ipc';

const envProvider = import.meta.env.VITE_DATA_PROVIDER as DataProvider | undefined;
const providerName: DataProvider = envProvider ?? (isTauriAvailable() ? 'ipc' : 'mock');

const provider =
  providerName === 'ipc' && isTauriAvailable()
    ? ipcProvider
    : mockProvider;

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
