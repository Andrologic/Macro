import type { Citation } from "../types/citation";
import type { AppMode, AgentType, ChatMessage, ContextFootprint, ContextCompactionKind, ProviderConfig, ReasoningEffort, MCPTool, MCPServer, ToolRiskLevel } from "../types";
import type { StreamMessage } from "./ai/contracts";
import type { MacroToolRegistryEntry } from "../shared/macroToolRegistry";
import type * as tauriIpc from "./tauriIpc";
import type { ContextCompactionDecision } from "./contextCompaction";
import type { InternalAgentProfile } from "./internalAgentProfile";
import type { ProjectExecutionContext } from "./projectExecutionContext";
import type { ScopedTurnConfiguration } from "./configurationClient";
import type { ChatMaxTurnsPreference } from "./chatTurnLimits";
import type { getStreamingWebSearchConfig } from "./webSearchSettings";
import type { ArchitectPlanRecord } from './architectPlanService';
export interface RepositoryInstructionDiagnosticSource {
 projectId: string; projectName: string; sourcePath: string; relativePath: string; depth: number; sizeBytes: number;
}
export interface StreamContextDiagnosticsBaseline {
  sessionId: string;
  conversationId: string;
  assistantMessageId: string;
  modeAtSend: AppMode;
  providerId: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  modelContextWindowTokens: number;
  inputLimitTokens?: number;
  outputLimitTokens?: number;
  contextLimitSource?: ContextFootprint["contextLimitSource"];
  isContextLimitAuthoritative?: boolean;
  contextLimitConfidence?: ContextFootprint["contextLimitConfidence"];
  contextLimitWarning?: string;
  allowedToolIds: string[];
  toolDefinitions: MacroToolRegistryEntry[];
  messagesForRequest: StreamMessage[];
  orderedMessages: ChatMessage[];
  citations: Citation[];
  repositoryInstructionSources: RepositoryInstructionDiagnosticSource[];
  repositoryInstructionIssues: tauriIpc.RepositoryInstructionIssueDto[];
  compactionDecision?: ContextCompactionDecision;
}

export type StreamContextDiagnosticsBaselineSeed = Omit<
  StreamContextDiagnosticsBaseline,
  "sessionId" | "assistantMessageId" | "orderedMessages"
>;

/**
 * Values captured for one assistant generation.  Tool calls must not infer
 * their target from whichever conversation, task, or project happens to be
 * selected when the provider responds.
 */
export interface FrozenToolCallContext {
  architectPlanAtSend?: { planId: string; targetBranch: string };
  conversationId: string;
  sessionId: string;
  turnId: string;
  assistantMessageId: string;
  mode: AppMode;
  agentType: AgentType | null;
  taskId: string;
  executionContext: ProjectExecutionContext;
  scopedTurnConfiguration: ScopedTurnConfiguration | null;
  allowedToolIds: readonly string[];
  mcpServers: readonly MCPServer[];
  riskLevel: ToolRiskLevel;
  signal: AbortSignal;
}

export interface AssistantStreamLaunch {
    architectPlanContext?: ArchitectPlanRecord | null;
    architectPlanAtSend?: { planId: string; targetBranch: string };
    sessionId: string;
    assistantMessage: ChatMessage;
    conversationId: string;
    replyToMessageId: string;
    userContent: string;
    modeAtSend: AppMode;
    agentTypeAtSend?: AgentType | null;
    resolvedTaskId: string;
    selectedProviderId: string;
    selectedModelId: string;
    selectedReasoningEffort?: ReasoningEffort | null;
    providerConfig: ProviderConfig;
    internalAgentProfile?: InternalAgentProfile | null;
    messagesForRequest: StreamMessage[];
    contextDiagnosticsBaselineSeed: StreamContextDiagnosticsBaselineSeed;
    executionContext: ProjectExecutionContext;
    providerSupportsNativeToolCalling?: boolean;
    fileToolContext: Array<{
      title: string;
      source: string;
      path?: string;
      snippet?: string;
      content?: string;
    }>;
    allowedToolIds: string[];
    riskLevel: ToolRiskLevel;
    scopedTurnConfiguration: ScopedTurnConfiguration | null;
    guidedToolRetry?: {
      requiredToolNames: string[];
      retrySystemPrompt: string;
      maxRetries?: number;
    };
    showToolTraces: boolean;
    enableWebSearch: boolean;
    enableWebFetch: boolean;
    webSearchOptions: ReturnType<
      typeof getStreamingWebSearchConfig
    >["webSearchOptions"];
    mcpTools: MCPTool[];
    mcpServers: MCPServer[];
    skillToolIds: string[];
    runnableSkillToolIds: string[];
    maxTurns: ChatMaxTurnsPreference;
    abortController?: AbortController;
    compactionDecision?: ContextCompactionDecision;
    overflowRecoveryAttempted?: boolean;
    replayRecovery?: {
      replayId: string;
      onProgress: () => Promise<void>;
      onFailedBeforeProgress: () => Promise<void>;
    };
}

/** Authority reused when compacting and restarting the same assistant turn. */
export type ChatTurnCapabilities = Pick<AssistantStreamLaunch,
  "allowedToolIds" | "riskLevel" | "scopedTurnConfiguration" | "mcpServers" | "mcpTools" |
  "internalAgentProfile" | "skillToolIds" | "runnableSkillToolIds" | "guidedToolRetry" |
  "showToolTraces" | "enableWebSearch" | "enableWebFetch" | "webSearchOptions" | "maxTurns" | "architectPlanContext"
>;

export interface PrepareAssistantStreamParams {
  architectPlanAtSend?: { planId: string; targetBranch: string };
    turnCapabilities?: ChatTurnCapabilities;
    conversationId: string;
    replyToMessageId: string;
    userContent: string;
    resolvedTaskId: string;
    modeAtSend: AppMode;
    agentTypeAtSend?: AgentType | null;
    providerId: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
    providerConfig: ProviderConfig;
    internalAgentProfile?: InternalAgentProfile | null;
    executionContext?: ProjectExecutionContext;
    scopedTurnConfigurationOverride?: ScopedTurnConfiguration | null;
    providerSupportsNativeToolCalling?: boolean;
    compactionMode?: ContextCompactionKind;
    forceCompaction?: boolean;
    forcePrune?: boolean;
    compactionDisplayAfterMessageId?: string | null;
}
