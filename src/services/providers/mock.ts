import {
  mockAuthPlan,
  mockProjects,
  mockConversations,
  mockChatMessages,
  mockCommits,
  getGitTree,
} from '../../mock-data/auth-scenario';
import { mockProviders, mockModels } from '../../mock-data/ai';
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
import { delay, maybeFail } from '../utils';

const DEFAULT_LATENCY_MS = 180;
const ERROR_RATE = 0;

const simulate = async <T>(value: T): Promise<T> => {
  await delay(DEFAULT_LATENCY_MS);
  maybeFail(ERROR_RATE);
  return value;
};

export const getAppBootstrap = async (): Promise<AppBootstrapDto> => {
  return simulate({ plan: mockAuthPlan, projectGroups: mockProjects });
};

export const listConversations = async (): Promise<ConversationsDto> => {
  return simulate({ conversations: mockConversations });
};

export const listMessages = async (
  conversationId?: string
): Promise<MessagesDto> => {
  const messages = conversationId
    ? mockChatMessages.filter((msg) => msg.conversation_id === conversationId)
    : mockChatMessages;
  return simulate({ messages });
};

export const listTasks = async (): Promise<TasksDto> => {
  return simulate({ tasks: mockAuthPlan.tasks });
};

export const getGitTreeForProject = async (
  projectId: string
): Promise<GitTreeDto> => {
  return simulate({ tree: getGitTree(projectId) ?? null });
};

export const listCommits = async (): Promise<CommitsDto> => {
  return simulate({ commits: mockCommits });
};

export const listProviders = async (): Promise<ProvidersDto> => {
  return simulate({ providers: mockProviders });
};

export const listModels = async (providerId?: string): Promise<ModelsDto> => {
  const models = providerId
    ? mockModels.filter((model) => model.providerId === providerId)
    : mockModels;
  return simulate({ models: models.map((model) => ({
    id: model.id,
    name: model.name,
    provider_id: model.providerId,
  })) });
};
