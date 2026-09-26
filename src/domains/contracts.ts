import type { LifecycleContext } from '../types/lifecycle';
import type { AIModel, AIProvider, ChatMessage, Conversation, PlanNode, Project, ProjectGroup, Task } from '../types';

/** Public capabilities, independent from Zustand, transport DTOs and React. */
export interface ChatQueries {
  conversations(): readonly Conversation[];
  messages(conversationId: string): readonly ChatMessage[];
}
export interface ChatCommands {
  selectConversation(conversationId: string): Promise<boolean>;
  stopStreaming(): void;
}
export interface PlansQueries {
  nodes(): readonly PlanNode[];
}
export interface PlansCommands {
  activate(planId: string): Promise<boolean>;
}
export interface TasksQueries {
  find(taskId: string): Task | undefined;
}
export interface TasksCommands {
  activate(taskId: string): Promise<void>;
  startReview(taskId: string): Promise<void>;
}
export interface ProjectsCommands {
  switchContext(projectId: string | null): Promise<void>;
}
export interface ProjectsQueries {
  standalone(): readonly Project[];
  groups(): readonly ProjectGroup[];
}
export interface ToolsQueries {
  enabledChatToolIds(): readonly string[];
  enabledMCPToolIds(): readonly string[];
}
export interface ToolsCommands {
  loadSettings(context?: LifecycleContext): Promise<void>;
  callMCPTool(toolId: string, args: Record<string, unknown>): Promise<string>;
}
export interface ProvidersQueries {
  providers(): readonly AIProvider[];
  models(providerId: string): readonly AIModel[];
}
export interface ProvidersCommands {
  loadProviderConfigs(context?: LifecycleContext): Promise<void>;
  selectProvider(providerId: string): void;
  selectModel(modelId: string): void;
}
