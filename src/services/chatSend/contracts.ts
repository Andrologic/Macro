import type {
  AgentType, AppMode, ChatMessage, ProviderConfig,
  ReasoningEffort, StandaloneTaskLaunchStep,
} from '../../types';
import type { AssistantStreamLaunch, PrepareAssistantStreamParams } from '../chatStreamContracts';
import type { ChatTurnRuntime } from '../chatTurnRuntime';
import type { ChatPersistenceAdapters } from '../chatPersistenceService';
import type { ScopedModelSelection, ScopedTurnConfiguration } from '../configurationClient';
import type { ServiceError } from '../contracts/errors';
import type { InternalAgentProfile } from '../internalAgentProfile';
import type { ProjectExecutionContext } from '../projectExecutionContext';

// Structural attachment contract; the UI's existing attachment type satisfies it.
export interface SendImage {
  id: string;
  mimeType: string;
  dataUrl: string;
  width?: number;
  height?: number;
  createdAt: string;
}

export interface ChatSendInput {
  conversationId: string;
  content: string;
  taskId?: string | null;
  images?: SendImage[];
  internalAgentProfile?: InternalAgentProfile | null;
  hiddenContext?: string;
  providerInputItems?: unknown[];
  contextRefs?: ChatMessage['context_refs'];
}

export interface ArchitectPlanAtSend { planId: string; targetBranch: string }

/** Captured synchronously by the UI adapter, before invoking sendMessage. */
export interface ChatSendSnapshot {
  mode: AppMode;
  agentType: AgentType | null;
  architectPlan?: ArchitectPlanAtSend;
  conversationTaskId: string | null;
  selectedTaskId: string;
  executionContext: ProjectExecutionContext;
  composerContextRefs: ChatMessage['context_refs'];
  composerRevision: number;
  provider: {
    selectedProviderId: string | null;
    selectedModelId: string | null;
    selectedReasoningEffort: ReasoningEffort | null;
    isLoading: boolean;
    providerConfigs: ProviderConfig[];
  };
}

export type ChatSendResult = {
  status: 'sent'; conversationId: string; turnId: string;
  userMessageId: string; assistantMessageId: string | null;
} | {
  status: 'cancelled'; conversationId: string; turnId: string;
  userMessageId: null; assistantMessageId: null;
};

export interface SendLease {
  sessionId: string;
  turnId: string;
  abortController: AbortController;
}

export type ChatSendOwner = Pick<ChatTurnRuntime,
  'read' | 'set' | 'update' | 'latestSession' | 'rememberSession' | 'transfer' | 'forgetSession'>;

export interface SendTask {
  task_source?: string;
  standalone_kind?: string | null;
  draft?: boolean;
}

export interface SendModel {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
}

export type StartSendStream = PrepareAssistantStreamParams & Pick<AssistantStreamLaunch,
  'sessionId' | 'assistantMessage' | 'architectPlanAtSend' | 'abortController'>;

/** Ports expose domain operations, never a store or a generic state getter. */
export interface ChatSendPorts<Task extends SendTask, Recovery, Launch> {
  owner: ChatSendOwner;
  messages: {
    persistence: ChatPersistenceAdapters;
    ensureLoaded(conversationId: string): Promise<void>;
    list(conversationId: string): readonly ChatMessage[];
    hasInterruptedApproval(conversationId: string): boolean;
    clearApprovalRecovery(conversationId: string): Promise<void>;
  };
  preparation: {
    assertCanSend(conversationId: string): void;
    isDeleted(conversationId: string): boolean;
    createSessionId(): string;
    createTurnId(): string;
    hasPendingArchitectConversation(conversationId: string): boolean;
    materializeArchitectConversation(conversationId: string): Promise<string>;
    bindArchitectConversation(params: { architectPlan: ArchitectPlanAtSend; conversationId: string }): Promise<boolean>;
    syncArchitectMetadata(params: { branchName: string; planId: string; conversationId: string; reason: 'metadata_prefix' }): Promise<void>;
    generateMetadata(params: SendModel & { conversationId: string; firstUserContent: string; architectPlan?: ArchitectPlanAtSend }): Promise<void>;
  };
  configuration: {
    load(params: { projectIds: string[]; focusProjectId: string | null; mode: AppMode }): Promise<ScopedTurnConfiguration | null>;
    selectScoped(config: ScopedTurnConfiguration | null, snapshot: ChatSendSnapshot, profile?: InternalAgentProfile | null): ScopedModelSelection | null;
    hasAuthSession(provider: ProviderConfig): boolean;
    resolveApiKey(providerId: string): Promise<string | undefined>;
    supportsNativeToolCalling(providerId: string, modelId: string): boolean;
  };
  tasks: {
    read(taskId: string): Task | undefined;
    finalizeDraft(params: SendModel & { conversationId: string; taskId: string; userContent: string; onStep(step: StandaloneTaskLaunchStep): void }): Promise<Recovery | null>;
    assertReady(taskId: string): Promise<Task | undefined>;
    assertExecutionContextReady(task: Task | undefined): void;
    rollbackDraft(recovery: Recovery): Promise<void>;
    beginLaunch(params: { conversationId: string; taskId: string; userMessageId: string; sessionId: string }): void;
    setLaunchStep(conversationId: string, sessionId: string, step: StandaloneTaskLaunchStep): void;
    completeLaunch(conversationId: string, sessionId: string): void;
    readLaunch(conversationId: string): { sessionId: string; taskId: string } | undefined;
    failLaunch(params: { conversationId: string; sessionId: string; error: string; canRetry: boolean }): void;
  };
  projection: {
    persistSelection(mode: AppMode, conversationId: string): void;
    publishUser(message: ChatMessage, context: { images?: SendImage[]; contextRefs: ChatMessage['context_refs']; clearComposerRevision?: number }): void;
    publishAssistant(message: ChatMessage, mode: AppMode, agentType: AgentType | null): void;
    clearSecurity(conversationId: string): void;
    approvalRecoveryError(message: string): void;
    launchError(conversationId: string, sessionId: string, assistantMessageId: string | null, error: ServiceError): { applied: boolean };
    sendError(message: string): void;
    timeline(phase: string, context: Record<string, unknown>): void;
  };
  stream: {
    prepare(params: PrepareAssistantStreamParams): Promise<Launch>;
    start(params: StartSendStream, launch: Launch): void;
  };
}
