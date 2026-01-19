import type {
  AppBootstrapDto,
  ConversationsDto,
  MessagesDto,
  TasksDto,
  GitTreeDto,
  CommitsDto,
  ProvidersDto,
  ModelsDto,
} from '../contracts/dtos';

const notReady = () => {
  throw {
    code: 'IPC_NOT_READY',
    message: 'IPC provider not implemented yet',
  };
};

export const getAppBootstrap = async (): Promise<AppBootstrapDto> => notReady();

export const listConversations = async (): Promise<ConversationsDto> => notReady();

export const listMessages = async (): Promise<MessagesDto> => notReady();

export const listTasks = async (): Promise<TasksDto> => notReady();

export const getGitTreeForProject = async (): Promise<GitTreeDto> => notReady();

export const listCommits = async (): Promise<CommitsDto> => notReady();

export const listProviders = async (): Promise<ProvidersDto> => notReady();

export const listModels = async (): Promise<ModelsDto> => notReady();
