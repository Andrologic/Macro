import type { ChatCommands, ChatQueries, PlansCommands, PlansQueries, TasksQueries, TasksCommands, ProjectsQueries, ProjectsCommands, ToolsCommands, ToolsQueries, ProvidersCommands, ProvidersQueries } from '../domains/contracts';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useTaskStore } from '../stores/useTaskStore';
import { useToolsStore } from '../stores/useToolsStore';
import { useProviderStore } from '../stores/useProviderStore';

/** Explicit adapters over the current owners. No snapshots or global lookup API. */
export const chat: ChatQueries & ChatCommands = {
  conversations: () => useChatStore.getState().conversations,
  messages: (id) => useChatStore.getState().messagesByConversationId[id] ?? [],
  selectConversation: (id) => useChatStore.getState().selectConversation(id),
  stopStreaming: () => useChatStore.getState().stopStreaming(),
};
export const plans: PlansQueries & PlansCommands = {
  nodes: () => useAppStore.getState().planNodes,
  activate: (id) => useAppStore.getState().activateArchitectPlan(id),
};
export const tasks: TasksQueries & TasksCommands = {
  activate: (id) => useTaskStore.getState().activateTask(id),
  startReview: (id) => useTaskStore.getState().startReview(id),
  find: (id) => useTaskStore.getState().getTaskById(id),
};
export const projects: ProjectsQueries & ProjectsCommands = {
  switchContext: (id) => useAppStore.getState().switchProjectContext(id),
  standalone: () => useAppStore.getState().standaloneProjects,
  groups: () => useAppStore.getState().projectGroups,
};
export const tools: ToolsQueries & ToolsCommands = {
  enabledChatToolIds: () => useToolsStore.getState().getEnabledChatToolIds(),
  enabledMCPToolIds: () => useToolsStore.getState().getEnabledMCPToolIds(),
  loadSettings: (context) => useToolsStore.getState().loadSettings(context),
  callMCPTool: (id, args) => useToolsStore.getState().callMCPTool(id, args),
};
export const providers: ProvidersQueries & ProvidersCommands = {
  providers: () => useProviderStore.getState().providers,
  models: (id) => useProviderStore.getState().modelsByProvider[id] ?? [],
  loadProviderConfigs: (context) => useProviderStore.getState().loadProviderConfigs({ lifecycle: context }),
  selectProvider: (id) => useProviderStore.getState().selectProvider(id),
  selectModel: (id) => useProviderStore.getState().selectModel(id),
};
