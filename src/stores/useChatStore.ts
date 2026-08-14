import { create } from "zustand";
import {
  AppMode,
  AgentType,
  AgentCodeCheckpoint,
  AgentCodeCheckpointFile,
  AgentCodeReplayPreview,
  ChatMessage,
  ConversationApprovalGrant,
  ConversationQuestionnaireDraft,
  ConversationQuestionnaireState,
  ConversationRuntimeState,
  ContextCompactionKind,
  ContextFootprint,
  ContextFootprintReason,
  ContextRefKind,
  ContextReference,
  Conversation,
  ConversationCompactionState,
  CompactionPass,
  CompactionSummarySource,
  MCPTool,
  PendingToolApproval,
  PersistedContextReference,
  PlanNode,
  PredictedBranch,
  ProviderTurnState,
  Project,
  ProjectGroup,
  ReasoningEffort,
  SkillManifest,
  SkillPermissionSnapshot,
  SkillTurnFeedback,
  SkillTurnFeedbackItem,
  StandaloneTaskKind,
  ToolRiskLevel,
  ToolTrace,
  WorkspaceFileReference,
} from "../types";
import { toServiceError } from "../services/contracts/errors";
import {
  extractContextLimitTokensFromErrorLike,
  isContextOverflowErrorLike,
} from "../services/contextOverflow";
import { providerHasCredentials, useProviderStore } from "./useProviderStore";
import { useCitationsStore } from "./useCitationsStore";
import type { Citation, SourcePassageKind } from "./useCitationsStore";
import {
  cancelStream,
  sendChatNonStreaming,
  estimateCopilotSerializedPayloadTokens,
  estimateChatCompletionSerializedPayloadTokens,
  type LiveStreamContextSnapshot,
  type StreamCompletionResult,
  type StreamMessage,
  type StreamTimelinePhase,
  type ToolCallResolution,
} from "../services/streamingChat";
import {
  buildExplicitSkillsInstruction,
  buildSkillCatalogInstruction,
  buildSkillReferenceLines,
  filterSkillToolsForAvailability,
  getSkillToolIdsForRequest,
  handleSkillToolCall,
} from "../services/skills/chatIntegration";
import {
  runAssistantStream,
  type ChatStreamTokenControls,
} from "../services/chatStreamOrchestrator";
import { createChatStreamLifecycleRuntime } from "../services/chatStreamLifecycleRuntime";
import { getStreamingWebSearchConfig } from "../services/webSearchSettings";
import {
  fetchWebPage,
  formatSearchResultsAsContext,
  webSearch,
} from "../services/webSearch";
import { useToolsStore } from "./useToolsStore";
import { useSkillsStore, type SkillTurnPreparation } from "./useSkillsStore";
import { useAppStore } from "./useAppStore";
import { useTaskStore, type ImplementTask } from "./useTaskStore";
import {
  getImplementAgentToolPolicy,
  getToolModePolicy as getLocalToolModePolicy,
  isToolAllowedForImplementAgent,
} from "../services/toolModePolicy";
import {
  executeWorkspaceTool,
  resolveExplicitMutatingToolProjectTargets,
} from "../services/workspaceToolExecutor";
import {
  MODE_PROMPT_KEYS_BY_MODE,
  loadPreference,
  PREF_KEYS,
  savePreference,
} from "../services/preferences";
import { loadMetadataModelConfig } from "../services/metadataModelPreference";
import {
  type ChatMaxTurnsPreference,
  normalizeChatMaxTurns,
} from "../services/chatTurnLimits";
import { useTerminalStore } from "./useTerminalStore";
import { devLogger } from "../utils/devLogger";
import {
  canUseRemoteKernel,
  getRemoteToolModePolicy,
} from "../services/remoteKernelApi";
import * as tauriIpc from "../services/tauriIpc";
import {
  type ArchitectPlanActivationPayload,
  type ArchitectPlanRecord,
  bindArchitectPlanConversation,
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanActivationPayload,
  getArchitectPlanChatTranscript,
  getArchitectPlanTargetDisplay,
  getGitFlowBaseBranch,
  getArchitectPlanVisibleProjectIds,
  hasPersistedArchitectStrategy,
  isArchitectPlanReplicaDivergenceError,
  isArchitectPlanStrategyMutationLocked,
  isArchitectPlanSlugAvailable,
  isArchitectPlanSlugMutable,
  listArchitectPlans,
  resolvePlanProjectContextId,
  resolveTargetBranch,
  syncArchitectPlanChatFromConversation,
  updateArchitectPlan,
} from "../services/architectPlanService";
import {
  getArchitectPlanLifecyclePhase,
  getArchitectPlanConversationTitle,
  isDefaultNewPlanFamilyLabel,
  isCanonicalArchitectPlan,
} from "../services/architectPlanPresentation";
import { buildArchitectPlanToolFollowUpInstruction } from "../services/architectChat";
import { normalizeArchitectToolId } from "../services/architectToolNames";
import { selectInjectableMCPToolIds } from "../services/mcp";
import { isMCPToolId } from "../services/mcpToolNames";
import {
  getArchitectProfileAdjustedToolIds,
} from "../services/architectToolSurface";
import { handleArchitectToolCall } from "../services/architectToolRuntime";
import {
  canPlanFinalizationTaskReceiveMessages,
  isPlanFinalizationTaskSource,
} from "../services/planFinalization";
import {
  resolvePlanNodeTodoPresentation,
} from "../services/planNodeTodos";
import {
  applyTaskTodoOperations,
  formatTaskTodoResult,
  resolveTaskTodoTarget,
} from "../services/taskTodoToolService";
import {
  buildTaskArtifactContextBlock,
  formatTaskArtifactGetResult,
  formatTaskArtifactListResult,
  formatTaskArtifactPutResult,
  putTaskArtifact,
  resolveTaskArtifactTarget,
} from "../services/architectPlanArtifactService";
import {
  buildToolRiskLevelSystemInstruction,
  DEFAULT_TOOL_RISK_LEVEL,
  evaluateToolSecurity,
  filterDeniedToolIdsForRiskLevel,
} from "../services/toolSecurityPolicy";
import {
  createAssistantPlaceholderMessage,
  createUserMessage,
  deleteConversation as deletePersistedConversation,
  deleteConversations as deletePersistedConversations,
  deleteMessagesAfter as deletePersistedMessagesAfter,
  loadChatBootstrapSnapshot,
  loadConversationMessages,
  persistAssistantCompletionResult,
  persistAssistantPartialResult,
  renameConversation as renamePersistedConversation,
  updateEditedUserMessage,
  updateProviderInputItemsForMessage,
  type ChatPersistenceAdapters,
} from "../services/chatPersistenceService";
import {
  renderStandaloneTaskBranchName,
} from "../services/architectGitNaming";
import { retargetTaskForProjectSelection } from "../services/projectIdentityReconciliation";
import { provisionPlanBranches } from "../services/architectGitFlowService";
import {
  applyStrategyMutationPreview,
  prepareStrategyMutationPreview,
} from "../services/architectStrategyMutationGuard";
import {
  getLocalProjectContextState,
  type LocalProjectContextState,
} from "../services/localProjectContext";
import {
  getFocusedProjectForGroup,
  getGlobalProjectById,
  getProjectGroupByProjectId,
  getScopedActionableProjectIds,
  getScopedProjectIds,
} from "../services/globalProjects";
import { taskMatchesProjectId } from "../services/implementTaskCatalog";
import { resolveTaskReference, taskReferenceMatches } from "../services/durableIdentity";
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from "../services/projectWorkspaceState";
import { syncMacroMetadataAfterStream as syncMacroMetadataAfterStreamService } from "../services/macroSyncService";
import {
  resolveProjectExecutionContext,
  type ProjectExecutionContext,
} from "../services/projectExecutionContext";
import {
  buildQuestionnaireResponseArtifacts,
  buildQuestionnaireResponseProviderInputItems,
  buildQuestionnaireHiddenContextBlock,
  DEFAULT_QUESTIONNAIRE_INTRO,
  findFirstUnansweredQuestionStepIndex,
  resolveActiveConversationQuestionnaire,
  validateQuestionToolArgs,
} from "../services/chatQuestionnaires";
import {
  buildContextTooLargeErrorMessage,
  buildManualCompactionRequiredErrorMessage,
  buildCompactedMessagesForRequest,
  COMPACTED_CONVERSATION_STATE_MARKER,
  estimateConversationFootprint,
  isContextFootprintOverUsableBudget,
  type ContextBudgetPolicy,
  type ContextCompactionDecision,
  type ManualCompactionSkipReason,
  type MaybeCompactConversationResult,
  type SummaryGenerationInput,
} from "../services/contextCompaction";
import {
  buildCompactionDecisionAuditMetadata,
  consolidateCompletedAssistantTurnCompaction,
  getCompactionBoundaryForMode,
  isSyntheticCompactionBoundaryState,
  runContextCompactionOrchestration,
  type PendingToolBoundaryCompaction,
} from "../services/contextCompactionOrchestrator";
import {
  getCompactionEventTrigger,
  isTransientCompactionStatus,
  resolveCompactionStatusFromState,
  type ConversationCompactionStatus,
  type SessionCompactionEvent,
} from "../services/contextCompactionSession";
import { createChatCompactionRuntime } from "../services/chatCompactionRuntime";
import {
  buildConversationReplayPlan,
  type ConversationReplayPlan,
} from "../services/conversationReplayService";
import {
  contextLimitsToFootprintFields,
  resolveModelContextLimits,
  type ContextLimitFootprintFields,
} from "../services/modelContextLimits";
import {
  appendAgentCodeCheckpoint,
  buildAgentCodeReplayPreview,
  clearAgentCodeCheckpoints,
  createAgentCodeCheckpoint,
  hydrateAgentCodeReplayPreviewCurrentState,
  loadAgentCodeCheckpoints,
  pruneAgentCodeCheckpointsToMessageIds,
  restoreAgentCodeReplayPreview,
  saveAgentCodeCheckpoints,
} from "../services/agentCodeCheckpoints";
import {
  LinkedConversationDeletionSagaCorruptionError,
  loadLinkedConversationDeletionSagas,
  removeLinkedConversationDeletionSaga,
  upsertLinkedConversationDeletionSaga,
} from "../services/linkedTaskDeletionSaga";
import { applyEditingStrategyToToolIds } from "../services/aiEditingStrategy";
import {
  filterToolIdsForInternalAgentProfile,
  getInternalAgentProfilePromptPreferenceKey,
  resolveInternalAgentProfile,
  type InternalAgentProfile,
} from "../services/internalAgentProfile";
import {
  filterCopilotSupportedToolIds,
  MACRO_TOOL_REGISTRY,
  type MacroToolRegistryEntry,
} from "../shared/macroToolRegistry";
import {
  EMPTY_CONTEXT_DIAGNOSTICS_COUNTS,
  buildContextDiagnosticsFromFootprint,
  type ConversationContextDiagnostics,
  type ConversationContextDiagnosticsProviderContext,
  type ConversationContextDiagnosticsRefreshMode,
  type ManualCompactionCompletedResult,
  type ManualCompactionResult,
  type ManualCompactionSkippedResult,
} from "./chat/chatContextDiagnostics";
import {
  assistantTurnRequiresUserReply,
  buildAssistantMessagePresentation,
  buildUserMessagePresentation,
  mapDbConversationToConversation,
  mapDbMessageToChatMessage,
} from "./chat/chatDbMappers";
import {
  EMPTY_AI_CONTEXT_SELECTIONS,
  buildAISelectionRestorePlan,
  cloneAIContextSelections,
  normalizeAIContextSelections,
  pruneAIContextSelections,
  removeConversationSelectionData as removeConversationSelectionDataFromState,
  upsertSelectionForContext,
  type PersistedAIContextSelections,
  type PersistedAISelection,
} from "./chat/chatAISelectionState";
import {
  buildMessageState,
  findChatMessageInState,
  getConversationMessagesFromState,
  indexMessagesByConversation,
  sortMessagesChronologically,
} from "./chat/chatMessageState";
import {
  EMPTY_MESSAGE_IMAGES,
  clearQuestionnaireDraftsForConversations,
  loadMessageImagesFromStorage,
  loadQuestionnaireDraftsFromStorage,
  saveMessageImagesToStorage,
  saveQuestionnaireDraftsToStorage,
  setActiveQuestionnaireDraftStep,
  setQuestionnaireDraftForConversation,
  type MessageImageAttachment,
} from "./chat/chatLocalSessionState";
import {
  buildConversationRuntimePatch,
  buildLegacyStreamingFlags,
  createConversationSessionId,
  createConversationTurnId,
  getConversationRuntimeSnapshot,
  getMessageTurnId,
  isConversationRuntimeActive,
  type ChatSendState,
} from "./chat/chatRuntimeState";
import { buildReplayTrimStatePatch } from "./chat/chatReplayTrimState";

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

export type {
  ConversationContextDiagnostics,
  ConversationContextDiagnosticsBreakdownItem,
  ConversationContextDiagnosticsProviderContext,
  ConversationContextDiagnosticsRefreshMode,
  ConversationContextDiagnosticsSource,
  ConversationContextDiagnosticsStatus,
  ManualCompactionCompletedResult,
  ManualCompactionResult,
  ManualCompactionSkippedResult,
  ManualCompactionSkipReason,
} from "./chat/chatContextDiagnostics";
export type { MessageImageAttachment } from "./chat/chatLocalSessionState";

const METADATA_MAX_TITLE_LENGTH = 72;
const METADATA_MAX_DESCRIPTION_LENGTH = 180;
const MANUAL_FEATURE_MAX_SLUG_LENGTH = 64;
const MANUAL_FEATURE_METADATA_ATTEMPT_LIMIT = 4;
const ARCHITECT_PLAN_METADATA_ATTEMPT_LIMIT = 3;
const COPILOT_COMPACTION_SUMMARY_TIMEOUT_MS = 60_000;
const metadataGenerationInFlight = new Set<string>();
const conversationCompactionStateCache = new Map<
  string,
  ConversationCompactionState | null
>();
const conversationCompactionInProgress = new Set<string>();
const gitStageCommitChallengesByAssistantTurn = new Set<string>();
const LOCKED_AGENT_TOOL_IDS = [
  "skill_activate",
  "skill_read_resource",
  "skill_run_script",
] as const;
const ARCHITECT_STRATEGY_MUTATION_TOOL_IDS = new Set([
  "strategy_generate",
  "strategy_update",
  "strategy_delete",
]);
const assistantTurnContextByMessageId = new Map<
  string,
  { conversationId: string; mode: AppMode; agentType: AgentType | null }
>();

const shouldCountProviderInputItemsForContext = (
  providerType?: string | null,
): boolean => providerType !== "copilot";

const normalizeMessagesForProviderContext = (
  providerType: string | null | undefined,
  messages: StreamMessage[],
): StreamMessage[] => {
  if (providerType !== "copilot") {
    return messages;
  }

  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  }));
};

const estimateSerializedPayloadTokensForProvider = (params: {
  messages: StreamMessage[];
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
  modelId: string;
}): number => {
  if (params.providerType === "copilot") {
    return estimateCopilotSerializedPayloadTokens({
      messages: normalizeMessagesForProviderContext("copilot", params.messages),
    });
  }

  return estimateChatCompletionSerializedPayloadTokens({
    messages: params.messages,
    providerType: params.providerType ?? undefined,
    providerId: params.providerId ?? undefined,
    baseUrl: params.baseUrl ?? undefined,
    modelId: params.modelId,
  });
};
const agentCodeCheckpointLoadPromisesByConversationId = new Map<
  string,
  Promise<AgentCodeCheckpoint[]>
>();
const chatPersistenceAdapters: ChatPersistenceAdapters = {
  isTauriAvailable: () => tauriIpc.isTauriAvailable(),
  ipc: tauriIpc,
  now: () => new Date(),
  randomIdSuffix: () => Math.random().toString(36).slice(2, 8),
};
const LIVE_CONTEXT_DIAGNOSTICS_THROTTLE_MS = 1000;
const GIT_STAGE_COMMIT_CHALLENGE_TOOL_IDS = new Set(["git_add", "git_commit"]);
const GIT_STAGE_COMMIT_CHALLENGE_MESSAGE =
  "Do not stage or commit unless the user explicitly asked for it in this task. Re-read the latest user instruction. If the user did explicitly ask to stage/commit, call this tool again; otherwise stop and ask for confirmation.";
const TOOL_EXECUTION_ABORTED_RESULT = "Tool execution aborted";
const IMPLEMENT_PLAN_TOOL_DENIAL_MESSAGE =
  "Plan mode is read-only. This assistant turn cannot edit files, update todos, run terminal commands, stage, commit, checkout, merge, reset, or stash. Inspect the repo and produce a concrete implementation plan instead.";
const IMPLEMENT_PLAN_SYSTEM_INSTRUCTION =
  "Plan mode is read-only. Do not edit files, update todos, run mutating terminal commands, stage, commit, checkout, merge, reset, stash, or claim changes were made. Use tools to inspect the repo, ask blocking questions when needed, then end with a concrete implementation plan. If the user asks you to implement while still in Plan, produce an implementation plan instead of applying it.";
const IMPLEMENT_BUILD_AFTER_PLAN_SYSTEM_INSTRUCTION =
  "The previous assistant turn used Plan mode. Execute the latest plan unless the user changed direction.";
const STANDALONE_IMPLEMENT_SYSTEM_INSTRUCTION =
  "This is a standalone implementation task, not an Architect plan task. Do not call task_todo_* or task_artifact_* tools; they are unavailable for standalone tasks. Work directly from the conversation, task title, and execution context. In Build mode, use workspace, git, and terminal tools against the selected task repository/worktree. In Plan mode, inspect only and return a concrete plan.";
const ARCHITECT_TASK_ONLY_TOOL_IDS = new Set([
  "task_todo_get",
  "task_todo_update",
  "task_artifact_list",
  "task_artifact_get",
  "task_artifact_put",
]);
const COMPACTION_SUMMARY_SYSTEM_PROMPT =
  "Compact older conversation history for a programming agent into schema v3. Return ONLY valid JSON with keys " +
  '"currentObjective", "userInstructions", "decisions", "discoveries", "openQuestions", "activeFiles", "toolFacts", "knownErrors", "remainingWork", "summary". ' +
  'Use short factual strings. "userInstructions", "decisions", "discoveries", "openQuestions", "activeFiles", "toolFacts", "knownErrors", and "remainingWork" must be arrays of strings. ' +
  "Preserve acceptance criteria, user preferences, exact file paths, commands run, errors, decisions, and remaining work. Do not invent facts.";

interface CompactionSummaryAttemptOptions {
  compactableMessageLimit: number;
  compactableCharsPerMessage: number;
  retainedMessageLimit: number;
  sourceLimit: number;
  toolDigestLimit: number;
}

const getCompactionSummaryAttemptPlan = (
  compactableMessageCount: number,
): CompactionSummaryAttemptOptions[] => [
  {
    compactableMessageLimit: compactableMessageCount,
    compactableCharsPerMessage: 2400,
    retainedMessageLimit: 6,
    sourceLimit: 12,
    toolDigestLimit: 18,
  },
  {
    compactableMessageLimit: Math.min(compactableMessageCount, 24),
    compactableCharsPerMessage: 1200,
    retainedMessageLimit: 5,
    sourceLimit: 8,
    toolDigestLimit: 12,
  },
  {
    compactableMessageLimit: Math.min(compactableMessageCount, 12),
    compactableCharsPerMessage: 600,
    retainedMessageLimit: 4,
    sourceLimit: 4,
    toolDigestLimit: 8,
  },
];

const clearGitStageCommitChallengesForConversations = (
  conversationIds: string[],
) => {
  if (conversationIds.length === 0) {
    return;
  }
  const prefixes = conversationIds.map((conversationId) => `${conversationId}::`);
  Array.from(gitStageCommitChallengesByAssistantTurn).forEach((key) => {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      gitStageCommitChallengesByAssistantTurn.delete(key);
    }
  });
};

const clearAssistantTurnContextsForConversations = (
  conversationIds: string[],
) => {
  if (conversationIds.length === 0) {
    return;
  }
  const removedConversationIds = new Set(conversationIds);
  Array.from(assistantTurnContextByMessageId.entries()).forEach(
    ([messageId, context]) => {
      if (removedConversationIds.has(context.conversationId)) {
        assistantTurnContextByMessageId.delete(messageId);
      }
    },
  );
};

interface LiveContextDiagnosticsRefreshState {
  timeoutId: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  pending: boolean;
  lastStartedAt: number;
}

interface StreamContextDiagnosticsBaseline {
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
  compactionDecision?: ContextCompactionDecision;
}

type StreamContextDiagnosticsBaselineSeed = Omit<
  StreamContextDiagnosticsBaseline,
  "sessionId" | "assistantMessageId" | "orderedMessages"
>;

interface LiveStreamDiagnosticsPayload {
  systemMessage: string;
  preparedMessages: StreamMessage[];
  orderedMessages: ChatMessage[];
  citations: Citation[];
  baseline: StreamContextDiagnosticsBaseline;
}

const isProviderContextOverflowError = (error: unknown): boolean => {
  return isContextOverflowErrorLike(error);
};

const OVERFLOW_RECOVERY_FAILURE_MESSAGE =
  "The selected model still rejected this conversation after an aggressive compaction pass. Macro kept your message; continue with a larger-context model or compact manually before retrying.";

const streamContentToPlainText = (content: StreamMessage["content"]): string => {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "image_url"
          ? "[image attachment]"
          : "",
    )
    .filter(Boolean)
    .join("\n");
};

const splitSystemAndPreparedStreamMessages = (
  messages: StreamMessage[],
): { systemMessage: string; preparedMessages: StreamMessage[] } => {
  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    return {
      systemMessage: first.content,
      preparedMessages: messages.slice(1),
    };
  }
  return {
    systemMessage: "",
    preparedMessages: messages,
  };
};

const buildSyntheticOrderedMessagesForStreamRequest = (params: {
  conversationId: string;
  taskId: string;
  messages: StreamMessage[];
}): ChatMessage[] => {
  const timestampBase = Date.now();
  return params.messages.map((message, index) => {
    const role: ChatMessage["role"] =
      message.role === "assistant" || message.role === "tool" || message.role === "system"
        ? "assistant"
        : "user";
    const label =
      message.role === "tool"
        ? "Tool result"
        : message.role === "system"
          ? "System instruction"
          : "";
    const content = streamContentToPlainText(message.content);
    return {
      id: `stream-boundary-${index}`,
      task_id: params.taskId,
      conversation_id: params.conversationId,
      role,
      content: label ? `[${label}]\n${content}` : content,
      timestamp: new Date(timestampBase + index).toISOString(),
      provider_input_items: message.provider_input_items,
      provider_turn_state: message.provider_turn_state,
    };
  });
};

const getConversationFallbackTitle = (content: string): string => {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New Conversation";
  const words = cleaned.split(" ").slice(0, 6).join(" ");
  return words.slice(0, METADATA_MAX_TITLE_LENGTH);
};

const getConversationFallbackDescription = (content: string): string => {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (!cleaned) return "General discussion.";
  return cleaned.slice(0, METADATA_MAX_DESCRIPTION_LENGTH);
};

const extractJsonObjectFromModelOutput = (
  raw: string,
): Record<string, unknown> => {
  const noThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const firstBrace = noThinking.indexOf("{");
  const lastBrace = noThinking.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found");
  }

  return JSON.parse(noThinking.slice(firstBrace, lastBrace + 1)) as Record<
    string,
    unknown
  >;
};

const extractMetadataFromModelOutput = (
  raw: string,
): { title: string; description: string } => {
  const parsed = extractJsonObjectFromModelOutput(raw) as {
    title?: unknown;
    description?: unknown;
  };

  if (
    typeof parsed.title !== "string" ||
    typeof parsed.description !== "string"
  ) {
    throw new Error("Invalid metadata shape");
  }

  const title = parsed.title
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, METADATA_MAX_TITLE_LENGTH);
  const description = parsed.description
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, METADATA_MAX_DESCRIPTION_LENGTH);

  if (!title || !description) {
    throw new Error("Empty metadata values");
  }

  return { title, description };
};

const normalizeManualFeatureSlugInput = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const leaf = normalized.split("/").filter(Boolean).pop() || normalized;
  return (
    leaf
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, MANUAL_FEATURE_MAX_SLUG_LENGTH) || "work"
  );
};

const extractManualFeatureMetadataFromModelOutput = (
  raw: string,
): {
  title: string;
  description: string;
  featureSlug: string;
  taskKind: StandaloneTaskKind;
} => {
  const parsed = extractJsonObjectFromModelOutput(raw) as {
    title?: unknown;
    description?: unknown;
    featureSlug?: unknown;
    taskKind?: unknown;
  };

  if (
    typeof parsed.title !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.featureSlug !== "string" ||
    (parsed.taskKind !== "feature" &&
      parsed.taskKind !== "bugfix" &&
      parsed.taskKind !== "hotfix")
  ) {
    throw new Error("Invalid manual feature metadata shape");
  }

  const title = parsed.title
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, METADATA_MAX_TITLE_LENGTH);
  const description = parsed.description
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, METADATA_MAX_DESCRIPTION_LENGTH);
  const featureSlug = normalizeManualFeatureSlugInput(parsed.featureSlug);
  const taskKind = parsed.taskKind;

  if (!title || !description || !featureSlug) {
    throw new Error("Empty manual feature metadata values");
  }

  return { title, description, featureSlug, taskKind };
};

const buildManualFeatureFallbackMetadata = (content: string, taskTitle = '') => {
  const title = getConversationFallbackTitle(content);
  const description = getConversationFallbackDescription(content);
  const featureSlug = normalizeManualFeatureSlugInput(title || content);
  const normalizedContent = `${taskTitle} ${content}`.toLocaleLowerCase();
  const taskKind: StandaloneTaskKind =
    /\b(hotfix|production incident|incident de production|correctif urgent|urgence production)\b/.test(normalizedContent)
      ? "hotfix"
      : /\b(bug|bugfix|fix|réparer|corriger|correctif|erreur|régression|regression)\b/.test(normalizedContent)
        ? "bugfix"
        : "feature";
  return { title, description, featureSlug, taskKind };
};

const normalizeComparableBranchName = (value: string): string =>
  value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");

const branchNameMatchesCandidate = (
  existingBranchName: string,
  candidateBranchName: string,
): boolean => {
  const normalizedExisting = normalizeComparableBranchName(existingBranchName);
  return (
    normalizedExisting === candidateBranchName ||
    normalizedExisting.endsWith(`/${candidateBranchName}`)
  );
};

type ChatHydrationStatus = "idle" | "hydrating" | "ready" | "error";
type ChatRestoreStatus = "idle" | "resolving" | "ready" | "error";
type ChatContextKey = string;

interface ChatSendResult {
  status: "sent";
  conversationId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string | null;
}

interface ChatSendCancelledResult {
  status: "cancelled";
  conversationId: string;
  turnId: string;
  userMessageId: null;
  assistantMessageId: null;
}

/**
 * Values captured for one assistant generation.  Tool calls must not infer
 * their target from whichever conversation, task, or project happens to be
 * selected when the provider responds.
 */
interface FrozenToolCallContext {
  conversationId: string;
  sessionId: string;
  turnId: string;
  assistantMessageId: string;
  mode: AppMode;
  agentType: AgentType | null;
  taskId: string;
  executionContext: ProjectExecutionContext;
  signal: AbortSignal;
}

interface ArchitectTranscriptState {
  dbCount: number;
  metadataCount: number;
  relation: "equal" | "db_prefix" | "metadata_prefix" | "diverged";
}

type ArchitectPlanNamingRecoveryStage = "choice" | "manual";

interface ArchitectPlanNamingRecoveryState {
  conversationId: string;
  planId: string;
  targetBranch: string;
  firstUserContent: string;
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  stage: ArchitectPlanNamingRecoveryStage;
  isSubmitting: boolean;
  error: string | null;
}

type PendingToolApprovalResolution =
  | { kind: "allow_once" }
  | { kind: "allow_conversation" }
  | { kind: "deny"; reason?: string };

type ConversationMessageLoadStatus = "idle" | "loading" | "ready" | "error";

export type {
  ConversationCompactionPhase,
  ConversationCompactionStatus,
  SessionCompactionEvent,
  SessionCompactionEventStatus,
} from "../services/contextCompactionSession";

export interface LiveStreamContextEstimate {
  sessionId: string;
  assistantMessageId: string;
  version: number;
  baseline?: StreamContextDiagnosticsBaseline;
  visibleContent: string;
  visibleContentLength: number;
  hiddenContext?: string;
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
  toolTraces: ToolTrace[];
  updatedAt: string;
}

interface ChatStore {
  messages: ChatMessage[];
  messagesByConversationId: Record<string, ChatMessage[]>;
  messageIndexById: Record<string, number>;
  messageLoadStatusByConversationId: Record<
    string,
    ConversationMessageLoadStatus | undefined
  >;
  conversations: Conversation[];
  selectedConversationId: string | null;
  selectedConversationIdsByMode: Partial<Record<AppMode, string | null>>;
  hydrationStatus: ChatHydrationStatus;
  restoreStatus: ChatRestoreStatus;
  activeContextKey: ChatContextKey | null;
  selectionRequestId: number;
  pendingArchitectPlanSwitchRequestId: number | null;
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>;
  conversationCompactionStatusById: Record<
    string,
    ConversationCompactionStatus | undefined
  >;
  sessionCompactionEventsByConversationId: Record<
    string,
    SessionCompactionEvent[] | undefined
  >;
  agentCodeCheckpointsByConversationId: Record<
    string,
    AgentCodeCheckpoint[] | undefined
  >;
  contextDiagnosticsByConversationId: Record<
    string,
    ConversationContextDiagnostics | undefined
  >;
  liveStreamContextEstimatesByConversationId: Record<
    string,
    LiveStreamContextEstimate | undefined
  >;
  isLoading: boolean;
  isStreaming: boolean;
  sendState: ChatSendState;
  lastError: string | null;
  abortController: AbortController | null;
  messageImagesByMessageId: Record<string, MessageImageAttachment[]>;
  questionnaireDraftsByConversationId: Record<
    string,
    ConversationQuestionnaireDraft
  >;
  pendingToolApprovalByConversationId: Record<string, PendingToolApproval | undefined>;
  conversationApprovalGrantsByConversationId: Record<
    string,
    ConversationApprovalGrant[]
  >;
  skillTurnFeedbackByMessageId: Record<string, SkillTurnFeedback | undefined>;
  architectPlanNamingRecovery: ArchitectPlanNamingRecoveryState | null;
  pendingComposerDraftByConversationId: Record<string, string>;
  composerDraftsByContextKey: Record<string, ComposerDraft>;
  addMessage: (message: ChatMessage) => void;
  clearLastError: () => void;
  updateMessageContent: (messageId: string, content: string) => void;
  updateMessageFields: (
    messageId: string,
    patch: Partial<
      Pick<
        ChatMessage,
        | "tool_traces"
        | "turn_id"
        | "hidden_context"
        | "provider_input_items"
        | "provider_turn_state"
        | "context_refs"
        | "completion_reason"
      >
    >,
  ) => void;
  updateLastMessage: (content: string) => void;
  appendToLastMessage: (token: string) => void;
  appendToMessage: (messageId: string, tokenChunk: string) => void;
  clearMessages: () => void;
  selectConversation: (conversationId: string) => Promise<boolean>;
  clearSelectedConversation: () => void;
  createConversation: (
    title: string,
    taskId: string | null,
    projectId: string | null,
    groupId?: string | null,
  ) => Promise<Conversation>;
  beginArchitectPlanSwitch: (params?: { requestId?: number }) => void;
  ensureArchitectConversationForPlan: (params: {
    plan: ArchitectPlanRecord;
    targetBranch: string;
    fallbackProjectId?: string;
    fallbackGroupId?: string;
    sharedConversation?: boolean;
  }) => Promise<{
    conversationId: string | null;
    restoredTranscript: boolean;
    createdConversation: boolean;
  }>;
  ensureConversationForCurrentMode: () => Promise<string | null>;
  reapplySelectionForCurrentContext: () => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  togglePinConversation: (conversationId: string) => Promise<boolean>;
  deleteConversation: (
    conversationId: string,
    confirmation?: {
      mode: "chat" | "implement" | "architect";
      typedProjectName?: string;
    },
  ) => Promise<void>;
  deleteChatConversations: (conversationIds: string[]) => Promise<void>;
  completeLinkedTaskConversationDeletion: (conversationId: string) => Promise<boolean>;
  markAsRead: (conversationId: string) => void;
  getConversationByTask: (taskId: string) => Conversation | undefined;
  getConversationMessages: (conversationId: string) => ChatMessage[];
  ensureMessagesLoaded: (conversationId: string) => Promise<void>;
  getConversationRuntime: (conversationId: string) => ConversationRuntimeState;
  compactConversationNow: (conversationId: string) => Promise<ManualCompactionResult>;
  refreshConversationContextDiagnostics: (
    conversationId: string,
    options?: {
      mode?: ConversationContextDiagnosticsRefreshMode;
      providerContext?: ConversationContextDiagnosticsProviderContext;
    },
  ) => Promise<void>;
  setComposerDraft: (conversationId: string, text: string) => void;
  peekComposerDraft: (conversationId: string) => string | null;
  consumeComposerDraft: (conversationId: string) => string | null;
  acknowledgeComposerDraft: (conversationId: string) => void;
  saveComposerDraftForContext: (contextKey: string, draft: ComposerDraft) => void;
  getComposerDraftForContext: (contextKey: string) => ComposerDraft | null;
  clearComposerDraftForContext: (contextKey: string) => void;
  migrateComposerDraftContext: (fromContextKey: string, toContextKey: string) => void;
  getPendingToolApproval: (conversationId: string) => PendingToolApproval | null;
  approvePendingToolApprovalOnce: (conversationId: string) => void;
  approvePendingToolApprovalForConversation: (conversationId: string) => void;
  denyPendingToolApproval: (conversationId: string, reason?: string) => void;
  getActiveQuestionnaire: (
    conversationId: string,
  ) => ConversationQuestionnaireState | null;
  startQuestionnaireResponseEdit: (messageId: string) => boolean;
  cancelQuestionnaireSession: (conversationId: string) => void;
  setActiveQuestionnaireStep: (
    conversationId: string,
    stepIndex: number,
  ) => void;
  setActiveQuestionnaireDraftText: (
    conversationId: string,
    value: string,
  ) => void;
  recordActiveQuestionnaireAnswer: (
    conversationId: string,
    answer: string,
  ) => { completed: boolean; state: ConversationQuestionnaireState | null } | null;
  submitActiveQuestionnaire: (
    conversationId: string,
  ) => Promise<ChatSendResult | ChatSendCancelledResult | null>;
  sendMessage: (payload: {
    conversationId: string;
    content: string;
    taskId?: string | null;
    images?: MessageImageAttachment[];
    internalAgentProfile?: InternalAgentProfile | null;
    hiddenContext?: string;
    providerInputItems?: unknown[];
  }) => Promise<ChatSendResult | ChatSendCancelledResult>;
  stopConversationStream: (conversationId: string) => void;
  clearConversationRuntimeError: (conversationId: string) => void;
  stopStreaming: () => void;
  getAgentCodeReplayPreview: (
    messageId: string,
  ) => Promise<AgentCodeReplayPreview | null>;
  restoreAgentCodeForReplay: (
    preview: AgentCodeReplayPreview,
  ) => Promise<void>;
  editMessage: (
    messageId: string,
    newContent: string,
    options?: {
      hiddenContext?: string;
      providerInputItems?: unknown[];
      replaceStructuredFields?: boolean;
      clearQuestionnaireSession?: boolean;
      skipAgentCodeReplayCheck?: boolean;
    },
  ) => Promise<void>;
  setMessageImages: (
    messageId: string,
    images: MessageImageAttachment[],
  ) => void;
  getMessageImages: (messageId: string) => MessageImageAttachment[];
  dismissArchitectPlanNamingRecovery: () => void;
  setArchitectPlanNamingRecoveryStage: (
    stage: ArchitectPlanNamingRecoveryStage,
  ) => void;
  retryArchitectPlanNamingRecovery: () => Promise<boolean>;
  submitArchitectPlanManualName: (value: string) => Promise<boolean>;
  syncArchitectPlanConversationMetadata: (
    conversationId: string,
    plan: ArchitectPlanRecord,
    descriptionOverride?: string,
  ) => Promise<void>;
  composerContextRefs: ContextReference[];
  replaceComposerContextRefs: (
    refs: ContextReference[],
    conversationId?: string | null,
  ) => void;
  addComposerContextRef: (ref: ContextReference) => void;
  removeComposerContextRef: (id: string, kind: ContextRefKind) => void;
  clearComposerContextRefs: () => void;
  reconcileProjectRegistry: (
    validGroupIds: string[],
    validProjectIds: string[],
  ) => void;
  initialize: () => Promise<void>;
  initializeCritical: () => Promise<void>;
  resumeAfterInitialize: () => Promise<void>;
}

interface TranscriptComparableMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface ResolvedConversationForContext {
  conversationId: string | null;
  source: "active_plan" | "mode_fallback";
  planId?: string;
  targetBranch?: string;
  fallbackProjectId?: string | null;
  fallbackGroupId?: string | null;
}

export interface ComposerDraft {
  text: string;
  images: MessageImageAttachment[];
  contextRefs: ContextReference[];
}

const buildChatContextKey = (
  appState: Pick<
    ReturnType<typeof useAppStore.getState>,
    | "mode"
    | "selectedGroupId"
    | "selectedProjectId"
    | "selectedTaskId"
    | "activeArchitectPlanId"
    | "activePlanContext"
  >,
): ChatContextKey => {
  if (appState.mode === "Architect") {
    if (appState.activeArchitectPlanId) {
      return [
        "Architect",
        "plan",
        appState.activeArchitectPlanId,
        appState.activePlanContext?.targetBranch || "none",
        appState.selectedGroupId || "none",
        appState.selectedProjectId || "none",
      ].join("::");
    }

    return [
      "Architect",
      "scope",
      appState.selectedGroupId || "none",
      appState.selectedProjectId || "none",
      appState.activePlanContext?.targetBranch || "none",
    ].join("::");
  }

  return [
    appState.mode,
    appState.selectedGroupId || "none",
    appState.selectedProjectId || "none",
    appState.selectedTaskId || "none",
  ].join("::");
};

const isChatContextKeyCurrent = (contextKey: ChatContextKey): boolean =>
  buildChatContextKey(useAppStore.getState()) === contextKey;

interface ResolveImplementTaskForContextInput {
  selectedTaskId?: string | null;
  tasks: ImplementTask[];
  standaloneProjects?: Project[];
  projectGroups: ProjectGroup[];
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  localContext?: LocalProjectContextState | null;
}

const IMPLEMENT_CONTEXT_TASK_STATUS_ORDER: Record<string, number> = {
  InProgress: 0,
  AwaitingResponse: 1,
  Pending: 2,
};

const taskMatchesScopedProjectIds = (
  task: Pick<ImplementTask, "project_id" | "project_ids" | "execution_targets">,
  scopedProjectIds: string[],
): boolean =>
  scopedProjectIds.length === 0 ||
  scopedProjectIds.some((projectId) => taskMatchesProjectId(task, projectId));

const retargetImplementTaskForSelection = (
  task: ImplementTask,
  params: {
    standaloneProjects?: Project[];
    projectGroups: ProjectGroup[];
    selectedGroupId?: string | null;
    selectedProjectId?: string | null;
  },
): ImplementTask => {
  const knownProjectIds = new Set([
    ...(params.standaloneProjects ?? []).map((project) => project.id),
    ...params.projectGroups.flatMap((group) => group.projects.map((project) => project.id)),
  ]);
  const taskProjectIds = [...(task.project_ids ?? []), task.project_id].filter(Boolean);
  if (taskProjectIds.some((projectId) => knownProjectIds.has(projectId))) {
    return task;
  }
  return retargetTaskForProjectSelection(task, {
    standaloneProjects: params.standaloneProjects ?? [],
    projectGroups: params.projectGroups,
    selectedGroupId: params.selectedGroupId,
    selectedProjectId: params.selectedProjectId,
  });
};

export const resolveImplementTaskForContext = ({
  selectedTaskId,
  tasks,
  standaloneProjects,
  projectGroups,
  selectedGroupId,
  selectedProjectId,
  localContext,
}: ResolveImplementTaskForContextInput): ImplementTask | null => {
  const selectedTask = selectedTaskId
    ? tasks.find((task) => task.id === selectedTaskId) ?? null
    : null;
  if (selectedTask) return selectedTask;
  const scopedProjectIds = getScopedProjectIds(
    {
      standaloneProjects: standaloneProjects ?? [],
      projectGroups,
    },
    selectedGroupId,
    selectedProjectId,
  );
  const eligibleTasks = tasks.filter((task) => {
    if (task.archived_at) return task.id === selectedTaskId;
    if (task.id === selectedTaskId) return true;
    if (taskMatchesScopedProjectIds(task, scopedProjectIds)) {
      return true;
    }
    if (task.task_source !== "standalone" && !taskReferenceMatches(tasks, task, selectedTaskId)) {
      return false;
    }
    const executionTask = retargetImplementTaskForSelection(task, {
      standaloneProjects,
      projectGroups,
      selectedGroupId,
      selectedProjectId,
    });
    return taskMatchesScopedProjectIds(executionTask, scopedProjectIds);
  });
  const findEligibleTask = (taskId?: string | null): ImplementTask | null =>
    taskId
      ? resolveTaskReference(eligibleTasks, taskId) ?? null
      : null;

  return (
    findEligibleTask(selectedTaskId) ||
    findEligibleTask(localContext?.lastTaskId) ||
    [...eligibleTasks].sort((left, right) => {
      const leftOrder =
        IMPLEMENT_CONTEXT_TASK_STATUS_ORDER[left.status] ??
        Number.MAX_SAFE_INTEGER;
      const rightOrder =
        IMPLEMENT_CONTEXT_TASK_STATUS_ORDER[right.status] ??
        Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return (left.sequence_index ?? 0) - (right.sequence_index ?? 0);
    })[0] ||
    null
  );
};

const toComparableChatMessage = (
  message: ChatMessage,
): TranscriptComparableMessage => ({
  id: message.id,
  role: message.role,
  content: message.content,
  createdAt: message.timestamp,
});

const resolveConversationQuestionnaireFromState = (
  state: Pick<
    ChatStore,
    | "messages"
    | "messagesByConversationId"
    | "questionnaireDraftsByConversationId"
  >,
  conversationId: string,
): ConversationQuestionnaireState | null =>
  resolveActiveConversationQuestionnaire(
    conversationId,
    getConversationMessagesFromState(state, conversationId),
    state.questionnaireDraftsByConversationId[conversationId],
  );

const getStrictTranscriptFingerprint = (
  message: TranscriptComparableMessage,
): string => {
  const trimmedId = message.id.trim();
  if (trimmedId.length > 0) {
    return `id:${trimmedId}`;
  }
  return `f:${message.role}:${message.content}:${message.createdAt}`;
};

const getSemanticTranscriptFingerprint = (
  message: TranscriptComparableMessage,
): string => `s:${message.role}:${message.content}`;

const normalizeGuidedToolRequestText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const userExplicitlyRequestsQuestionTool = (value: string): boolean => {
  const normalized = normalizeGuidedToolRequestText(value);
  if (!normalized) return false;

  const explicitPhrases = [
    "outil question",
    "question tool",
    "tool question",
    "use the question tool",
    "use question tool",
    "utilise l outil question",
    "utiliser l outil question",
    "utilise outil question",
    "utiliser outil question",
  ];

  return explicitPhrases.some((phrase) => normalized.includes(phrase));
};

const compareTranscriptSequence = (
  dbMessages: TranscriptComparableMessage[],
  metadataMessages: TranscriptComparableMessage[],
  fingerprintFor: (message: TranscriptComparableMessage) => string,
): ArchitectTranscriptState => {
  const sharedLength = Math.min(dbMessages.length, metadataMessages.length);

  for (let index = 0; index < sharedLength; index += 1) {
    if (
      fingerprintFor(dbMessages[index]!) !==
      fingerprintFor(metadataMessages[index]!)
    ) {
      return {
        dbCount: dbMessages.length,
        metadataCount: metadataMessages.length,
        relation: "diverged",
      };
    }
  }

  if (dbMessages.length === metadataMessages.length) {
    return {
      dbCount: dbMessages.length,
      metadataCount: metadataMessages.length,
      relation: "equal",
    };
  }

  return {
    dbCount: dbMessages.length,
    metadataCount: metadataMessages.length,
    relation:
      dbMessages.length < metadataMessages.length
        ? "db_prefix"
        : "metadata_prefix",
  };
};

const compareArchitectTranscriptState = (
  dbMessages: TranscriptComparableMessage[],
  metadataMessages: TranscriptComparableMessage[],
): ArchitectTranscriptState => {
  const strictState = compareTranscriptSequence(
    dbMessages,
    metadataMessages,
    getStrictTranscriptFingerprint,
  );
  if (strictState.relation !== "diverged") {
    return strictState;
  }

  return compareTranscriptSequence(
    dbMessages,
    metadataMessages,
    getSemanticTranscriptFingerprint,
  );
};

export const useChatStore = create<ChatStore>((set, get) => {
  let aiSelections = { ...EMPTY_AI_CONTEXT_SELECTIONS };
  let aiSelectionsLoaded = false;
  let composerContextRefsRevision = 0;
  let providerSelectionUnsubscribe: (() => void) | null = null;
  let contextSelectionUnsubscribe: (() => void) | null = null;
  let taskAwaitingResponseSyncUnsubscribe: (() => void) | null = null;
  let hydrationPromise: Promise<void> | null = null;
  const messageLoadPromisesByConversationId = new Map<string, Promise<void>>();
  const checkpointMutationQueuesByConversationId = new Map<string, Promise<void>>();
  const deletedConversationIds = new Set<string>();
  const replayRecoveryBlockedConversationIds = new Set<string>();
  const pendingConversationDeletionIds = new Set<string>();
  const latestConversationSessionIdByConversationId = new Map<string, string>();
  const completionPersistenceOwnersByConversationId = new Map<
    string,
    { sessionId: string; turnId: string | null; assistantMessageId: string }
  >();
  const contextDiagnosticsRequestIds = new Map<string, number>();
  const liveContextDiagnosticsRefreshByConversationId = new Map<
    string,
    LiveContextDiagnosticsRefreshState
  >();
  let awaitingResponseReconciliationScheduled = false;
  const awaitingResponseReconciliationTaskIds = new Set<string>();
  let suppressedSelectionPersistenceCount = 0;
  const pendingArchitectConversationIdsByPlanKey = new Map<string, string>();
  const pendingArchitectConversationDetailsById = new Map<
    string,
    {
      targetBranch: string;
      planId: string;
      title: string;
      fallbackProjectId: string | null;
      fallbackGroupId: string | null;
    }
  >();
  const pendingToolApprovalResolvers = new Map<
    string,
    (resolution: PendingToolApprovalResolution) => void
  >();
  const pendingToolApprovalQueues = new Map<string, Promise<void>>();
  const pendingAgentCodeReplayRollbacksByConversationId = new Map<
    string,
    () => Promise<void>
  >();

  const serializeToolApproval = async <T>(
    conversationId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const previous = pendingToolApprovalQueues.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => slot);
    pendingToolApprovalQueues.set(conversationId, queued);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (pendingToolApprovalQueues.get(conversationId) === queued) {
        pendingToolApprovalQueues.delete(conversationId);
      }
    }
  };

  const getPendingToolApprovalResolverKey = (
    conversationId: string,
    toolCallId: string,
  ): string => `${conversationId}::${toolCallId}`;

  const getArchitectPlanConversationCacheKey = (
    targetBranch: string,
    planId: string,
  ): string => `${targetBranch}::${planId}`;

  const removePendingArchitectConversationFromState = (conversationId: string) => {
    messageLoadPromisesByConversationId.delete(conversationId);
    set((state) => {
      const nextMessages = state.messages.filter(
        (message) => message.conversation_id !== conversationId,
      );
      const nextSelectedConversationId =
        state.selectedConversationId === conversationId
          ? null
          : state.selectedConversationId;
      const nextByMode = { ...state.selectedConversationIdsByMode };
      if (nextByMode.Architect === conversationId) {
        nextByMode.Architect = null;
      }
      const nextConversationRuntimeById = Object.fromEntries(
        Object.entries(state.conversationRuntimeById).filter(
          ([candidateId]) => candidateId !== conversationId,
        ),
      );

      return {
        conversations: state.conversations.filter(
          (conversation) => conversation.id !== conversationId,
        ),
        ...buildMessageState(nextMessages),
        messageLoadStatusByConversationId: Object.fromEntries(
          Object.entries(state.messageLoadStatusByConversationId).filter(
            ([candidateId]) => candidateId !== conversationId,
          ),
        ),
        selectedConversationId: nextSelectedConversationId,
        selectedConversationIdsByMode: nextByMode,
        conversationRuntimeById: nextConversationRuntimeById,
        ...buildLegacyStreamingFlags({
          conversationRuntimeById: nextConversationRuntimeById,
          selectedConversationId: nextSelectedConversationId,
        }),
      };
    });
  };

  const clearPendingArchitectConversationForPlan = (params: {
    targetBranch: string;
    planId: string;
  }) => {
    const cacheKey = getArchitectPlanConversationCacheKey(
      params.targetBranch,
      params.planId,
    );
    const conversationId = pendingArchitectConversationIdsByPlanKey.get(cacheKey);
    pendingArchitectConversationIdsByPlanKey.delete(cacheKey);
    if (
      conversationId &&
      pendingArchitectConversationDetailsById.delete(conversationId)
    ) {
      removePendingArchitectConversationFromState(conversationId);
    }
  };

  const clearPendingArchitectConversationsExcept = (params?: {
    targetBranch: string;
    planId: string;
  }) => {
    const keepKey = params
      ? getArchitectPlanConversationCacheKey(params.targetBranch, params.planId)
      : null;
    const removedConversationIds: string[] = [];
    for (const [planKey, conversationId] of Array.from(
      pendingArchitectConversationIdsByPlanKey.entries(),
    )) {
      if (planKey === keepKey) {
        continue;
      }
      pendingArchitectConversationIdsByPlanKey.delete(planKey);
      if (pendingArchitectConversationDetailsById.delete(conversationId)) {
        removedConversationIds.push(conversationId);
      }
    }
    removedConversationIds.forEach(removePendingArchitectConversationFromState);
  };

  const clearPendingArchitectConversationsForConversationIds = (
    conversationIds: string[],
  ) => {
    if (conversationIds.length === 0) {
      return;
    }

    const removedConversationIds = new Set(conversationIds);
    for (const [planKey, conversationId] of pendingArchitectConversationIdsByPlanKey) {
      if (removedConversationIds.has(conversationId)) {
        pendingArchitectConversationIdsByPlanKey.delete(planKey);
        pendingArchitectConversationDetailsById.delete(conversationId);
      }
    }
  };

  const getPendingArchitectConversationId = (params: {
    targetBranch: string;
    planId: string;
  }): string | null => {
    const conversationId =
      pendingArchitectConversationIdsByPlanKey.get(
        getArchitectPlanConversationCacheKey(params.targetBranch, params.planId),
      ) ?? null;
    if (!conversationId) {
      return null;
    }

    const conversationStillExists = get().conversations.some(
      (conversation) => conversation.id === conversationId,
    );
    if (conversationStillExists) {
      return conversationId;
    }

    clearPendingArchitectConversationForPlan(params);
    return null;
  };

  const loadToolRiskLevelPreference = async (): Promise<ToolRiskLevel> => {
    const value = await loadPreference<ToolRiskLevel>(PREF_KEYS.TOOL_RISK_LEVEL);
    return value || DEFAULT_TOOL_RISK_LEVEL;
  };

  const resolveConversationExecutionContext = (conversationId: string) => {
    const appState = useAppStore.getState();
    const taskState = useTaskStore.getState();
    return resolveProjectExecutionContext({
      mode: appState.mode,
      projects: [
        ...(appState.standaloneProjects ?? []),
        ...appState.projectGroups.flatMap((group) => group.projects),
      ],
      projectGroups: appState.projectGroups,
      tasks: taskState.tasks,
      conversations: get().conversations,
      conversationId,
      selectedGroupId: appState.selectedGroupId,
      selectedProjectId: appState.selectedProjectId,
      selectedTaskId: appState.selectedTaskId,
      activeRepositoryPath: taskState.activeRepositoryPath,
      workspacePathOverridesByProjectId: taskState.activeWorkspacePathOverridesByProjectId,
      branchWorktrees: taskState.branchWorktrees,
    });
  };

  const resolveConversationImplementTask = (
    conversationId: string,
    executionContext: ProjectExecutionContext,
    selectedTaskId?: string | null,
  ): ImplementTask | undefined => {
    const taskState = useTaskStore.getState();
    const conversationTaskId =
      get().conversations.find((conversation) => conversation.id === conversationId)
        ?.task_id ?? null;
    const taskId =
      conversationTaskId ||
      executionContext.taskId ||
      selectedTaskId ||
      null;
    return taskId ? taskState.getTaskById(taskId) : undefined;
  };

  const isStandaloneImplementTask = (
    task: Pick<ImplementTask, "task_source"> | undefined | null,
  ): task is ImplementTask => task?.task_source === "standalone";

  const filterToolIdsForImplementTask = (
    toolIds: string[],
    task: ImplementTask | undefined,
  ): string[] => {
    if (!isStandaloneImplementTask(task)) {
      return toolIds;
    }
    return toolIds.filter((toolId) => !ARCHITECT_TASK_ONLY_TOOL_IDS.has(toolId));
  };

  const formatStandaloneArchitectToolUnavailable = (toolName: string): string =>
    `${toolName} is unavailable for standalone tasks. Use the conversation, workspace tools, git, and terminal tools for this independent task instead.`;

  const assertStandaloneTaskExecutionContextReady = (
    task: ImplementTask | undefined,
  ): void => {
    if (!isStandaloneImplementTask(task)) {
      return;
    }
    const appState = useAppStore.getState();
    const executionTask = retargetImplementTaskForSelection(task, {
      standaloneProjects: appState.standaloneProjects,
      projectGroups: appState.projectGroups,
      selectedGroupId: appState.selectedGroupId,
      selectedProjectId: appState.selectedProjectId,
    });
    if (executionTask.draft) {
      throw buildSendError(
        "This standalone task is still a draft. Send a first description so Macro can initialize its repository and branch before starting the agent.",
      );
    }

    const projectIds = new Set(
      [
        ...(Array.isArray(executionTask.project_ids) ? executionTask.project_ids : []),
        executionTask.project_id ?? null,
        ...(Array.isArray(executionTask.execution_targets)
          ? executionTask.execution_targets
              .map((target) => target.projectId)
              .filter((projectId): projectId is string => Boolean(projectId))
          : []),
      ].filter((projectId): projectId is string => Boolean(projectId)),
    );
    const hasExecutionTargets =
      Array.isArray(executionTask.execution_targets) && executionTask.execution_targets.length > 0;
    const hasBranch = Boolean(executionTask.branch_name?.trim());

    if (projectIds.size === 0 || !hasBranch) {
      throw buildSendError(
        "This standalone task is missing its execution target, repository, or branch. Reopen the task or recreate it so Macro can initialize the worktree before contacting the agent.",
      );
    }
    if (!hasExecutionTargets) {
      devLogger.warn(
        "Standalone task has no execution_targets; falling back to project/branch routing.",
        {
          taskId: executionTask.id,
          projectIds: Array.from(projectIds),
          branchName: executionTask.branch_name,
        },
      );
    }
  };

  const canPromoteContextProjectsForTask = (
    task: ImplementTask | undefined,
  ): task is ImplementTask =>
    Boolean(
      task &&
        task.task_source === "architect" &&
        task.plan_id &&
        (task.plan_storage_branch || task.plan_target_branch),
    );

  const formatContextPromotionUnavailableToolResult = (
    toolName: string,
    projectIds: string[],
  ): string => {
    const appState = useAppStore.getState();
    const labels = projectIds
      .map((projectId) => {
        const project = appState.getProjectById(projectId);
        return project?.name || projectId;
      })
      .join(", ");
    return (
      `Cannot execute ${toolName} on context-only ` +
      `project${projectIds.length === 1 ? "" : "s"} ${labels}: ` +
      "context promotion is only available for Architect tasks."
    );
  };

  const resolveContextPromotionRequest = (params: {
    conversationId: string;
    executionContext: ProjectExecutionContext;
    selectedTaskId?: string | null;
    toolName: string;
    args: Record<string, unknown>;
  }): {
    task: ImplementTask | undefined;
    projectIds: string[];
    unavailableResult: string | null;
  } => {
    const task = resolveConversationImplementTask(
      params.conversationId,
      params.executionContext,
      params.selectedTaskId,
    );
    const explicitProjectTargets = resolveExplicitMutatingToolProjectTargets(
      params.toolName,
      params.args,
      {
        workspacePath: params.executionContext.workspacePath,
        defaultWorkspacePath: params.executionContext.defaultWorkspacePath,
        projectId: params.executionContext.projectId,
        focusedProjectId: params.executionContext.focusedProjectId,
        groupId: params.executionContext.groupId,
        projectMounts: params.executionContext.projectMounts,
        virtualRootEnabled: params.executionContext.virtualRootEnabled,
        workspacePathsByProjectId: params.executionContext.workspacePathsByProjectId,
      },
    );
    const contextProjectIdSet = new Set(
      task?.context_project_ids?.length
        ? task.context_project_ids
        : params.executionContext.contextProjectIds,
    );
    const actionableProjectIdSet = new Set(params.executionContext.actionableProjectIds);
    const projectIds = explicitProjectTargets.filter(
      (projectId) =>
        contextProjectIdSet.has(projectId) &&
        !actionableProjectIdSet.has(projectId),
    );

    if (projectIds.length === 0) {
      return { task, projectIds, unavailableResult: null };
    }

    if (!canPromoteContextProjectsForTask(task)) {
      return {
        task,
        projectIds,
        unavailableResult: formatContextPromotionUnavailableToolResult(
          params.toolName,
          projectIds,
        ),
      };
    }

    return { task, projectIds, unavailableResult: null };
  };

  const updateAssistantToolTraceStatus = (
    assistantMessageId: string,
    toolCallId: string,
    status: ToolTrace["status"],
  ) => {
    set((state) => {
      const targetIndex = state.messageIndexById[assistantMessageId];
      const currentMessage =
        typeof targetIndex === "number" ? state.messages[targetIndex] : undefined;
      if (!currentMessage) {
        return state;
      }

      const currentTraces = currentMessage.tool_traces ?? [];
      if (currentTraces.length === 0) {
        return state;
      }

      let didChange = false;
      const nextToolTraces = currentTraces.map((trace) => {
        if (trace.tool_call_id !== toolCallId || trace.status === status) {
          return trace;
        }
        didChange = true;
        return { ...trace, status };
      });

      if (!didChange) {
        return state;
      }

      const nextMessage = {
        ...currentMessage,
        tool_traces: nextToolTraces,
      };
      const nextMessages = [...state.messages];
      nextMessages[targetIndex] = nextMessage;
      const nextMessagesByConversationId = {
        ...state.messagesByConversationId,
        [currentMessage.conversation_id]: sortMessagesChronologically(
          getConversationMessagesFromState(state, currentMessage.conversation_id).map(
            (message) => (message.id === assistantMessageId ? nextMessage : message),
          ),
        ),
      };

      return {
        messages: nextMessages,
        messagesByConversationId: nextMessagesByConversationId,
      };
    });
  };

  const clearConversationSecurityState = (conversationId: string) => {
    const pendingApproval = get().pendingToolApprovalByConversationId[conversationId];
    if (pendingApproval) {
      const resolverKey = getPendingToolApprovalResolverKey(
        conversationId,
        pendingApproval.toolCallId,
      );
      pendingToolApprovalResolvers.get(resolverKey)?.({ kind: "deny" });
      pendingToolApprovalResolvers.delete(resolverKey);
    }

    set((state) => {
      if (
        !state.pendingToolApprovalByConversationId[conversationId] &&
        !state.conversationApprovalGrantsByConversationId[conversationId]
      ) {
        return state;
      }

      const nextPendingApprovals = { ...state.pendingToolApprovalByConversationId };
      const nextGrants = { ...state.conversationApprovalGrantsByConversationId };
      delete nextPendingApprovals[conversationId];
      delete nextGrants[conversationId];

      return {
        pendingToolApprovalByConversationId: nextPendingApprovals,
        conversationApprovalGrantsByConversationId: nextGrants,
      };
    });
  };

  const persistAiSelections = () => {
    if (!aiSelectionsLoaded) return;
    void savePreference(PREF_KEYS.AI_CONTEXT_SELECTIONS, aiSelections);
  };

  const withSuppressedSelectionPersistence = async <T>(
    run: () => Promise<T> | T,
  ): Promise<T> => {
    suppressedSelectionPersistenceCount += 1;
    try {
      return await run();
    } finally {
      suppressedSelectionPersistenceCount = Math.max(
        0,
        suppressedSelectionPersistenceCount - 1,
      );
    }
  };

  const getCurrentSelection = (): PersistedAISelection | null => {
    const providerState = useProviderStore.getState();
    if (!providerState.selectedProviderId || !providerState.selectedModelId) {
      return null;
    }

    return {
      providerId: providerState.selectedProviderId,
      modelId: providerState.selectedModelId,
      reasoningEffort: providerState.selectedReasoningEffort,
      updatedAt: new Date().toISOString(),
    };
  };

  const getConversationPersistedSelection = (
    conversationId: string | null,
  ): PersistedAISelection | null => {
    if (!conversationId) {
      return null;
    }

    const conversation = get().conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    if (!conversation?.provider_id || !conversation.model_id) {
      return null;
    }

    return {
      providerId: conversation.provider_id,
      modelId: conversation.model_id,
      reasoningEffort: conversation.reasoning_effort ?? null,
      updatedAt: conversation.updated_at || new Date().toISOString(),
    };
  };

  const persistConversationAISelection = (
    conversationId: string | null,
    selection: PersistedAISelection | null,
  ) => {
    if (!conversationId || !selection?.providerId || !selection.modelId) {
      return;
    }

    const currentConversation = get().conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (!currentConversation) {
      return;
    }

    const nextReasoningEffort = selection.reasoningEffort ?? null;
    if (
      currentConversation.provider_id === selection.providerId &&
      currentConversation.model_id === selection.modelId &&
      currentConversation.reasoning_effort === nextReasoningEffort
    ) {
      return;
    }

    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              provider_id: selection.providerId,
              model_id: selection.modelId,
              reasoning_effort: nextReasoningEffort,
            }
          : conversation,
      ),
    }));

    if (!tauriIpc.isTauriAvailable()) {
      return;
    }

    void tauriIpc.updateConversationAISelection({
      id: conversationId,
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoningEffort: nextReasoningEffort,
    }).catch((error) => {
      console.warn(
        "Failed to persist conversation AI choice:",
        toServiceError(error).message,
      );
    });
  };

  const providerHasAuthSession = (provider: {
    providerType: string;
    authStatus?: string;
  }): boolean => {
    if (provider.providerType === "chatgpt") {
      return ["authenticated", "refreshing", "expired"].includes(
        provider.authStatus ?? "",
      );
    }

    if (provider.providerType === "copilot") {
      return provider.authStatus === "connected";
    }

    return false;
  };

  const resolveConversationMetadataProviderContext = async (params: {
    providerId: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
  }) => {
    const providerState = useProviderStore.getState();
    const providerConfig = providerState.providerConfigs.find(
      (candidate) => candidate.id === params.providerId,
    );
    if (!providerConfig || !providerConfig.isEnabled) {
      throw new Error("The selected provider is no longer available.");
    }

    const apiKey =
      providerConfig.isLocal || providerHasAuthSession(providerConfig)
        ? providerConfig.apiKey
        : await providerState.resolveProviderApiKey(params.providerId);

    return {
      providerId: params.providerId,
      providerType: providerConfig.providerType,
      baseUrl: providerConfig.baseUrl,
      apiKey,
      modelId: params.modelId,
      reasoningEffort: params.reasoningEffort,
    };
  };

  const resolveMetadataGenerationProviderContext = async (fallback: {
    providerId: string;
    providerType?: string;
    baseUrl?: string;
    apiKey?: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
  }) => {
    const providerState = useProviderStore.getState();
    const metadataModelConfig = await loadMetadataModelConfig({
      providerConfigs: providerState.providerConfigs,
      modelsByProvider: providerState.modelsByProvider,
      getAvailableReasoningEfforts: providerState.getAvailableReasoningEfforts,
    });

    if (metadataModelConfig?.mode === "dedicated") {
      return await resolveConversationMetadataProviderContext({
        providerId: metadataModelConfig.providerId,
        modelId: metadataModelConfig.modelId,
        reasoningEffort: metadataModelConfig.reasoningEffort,
      });
    }

    if (fallback.providerType && fallback.baseUrl !== undefined) {
      return {
        providerId: fallback.providerId,
        providerType: fallback.providerType,
        baseUrl: fallback.baseUrl,
        apiKey: fallback.apiKey,
        modelId: fallback.modelId,
        reasoningEffort: fallback.reasoningEffort,
      };
    }

    return await resolveConversationMetadataProviderContext({
      providerId: fallback.providerId,
      modelId: fallback.modelId,
      reasoningEffort: fallback.reasoningEffort,
    });
  };

  const commitAiSelections = (nextSelections: PersistedAIContextSelections) => {
    aiSelections = nextSelections;
    persistAiSelections();
  };

  const persistSelectionForContext = (
    mode: AppMode,
    conversationId: string | null,
  ) => {
    const selection = getCurrentSelection();
    if (!selection) return;

    const nextSelections = cloneAIContextSelections(aiSelections);
    if (!upsertSelectionForContext(nextSelections, mode, conversationId, selection)) {
      return;
    }

    commitAiSelections(nextSelections);
    persistConversationAISelection(conversationId, selection);
  };

  const persistSelectionForConversationSwitch = (
    mode: AppMode,
    previousConversationId: string | null,
    nextConversationId: string | null,
  ) => {
    if (!previousConversationId || previousConversationId === nextConversationId) {
      return;
    }
    persistSelectionForContext(mode, previousConversationId);
  };

  const removeConversationSelectionData = (conversationId: string) => {
    const nextSelections = cloneAIContextSelections(aiSelections);
    if (
      !removeConversationSelectionDataFromState(nextSelections, conversationId)
    ) {
      return;
    }

    commitAiSelections(nextSelections);
  };

  const runAiSelectionRestore = async (params: {
    mode: AppMode;
    conversationId: string | null;
    preferredProviderId?: string | null;
    requestId?: number;
    activeContextKey?: ChatContextKey | null;
    shouldShowResolving?: boolean;
    clearPendingArchitectPlanSwitchRequestId?: boolean;
  }): Promise<boolean> => {
    const stateAtStart = get();
    const requestId = params.requestId ?? stateAtStart.selectionRequestId + 1;

    set({
      selectionRequestId: requestId,
      ...(params.activeContextKey !== undefined
        ? { activeContextKey: params.activeContextKey }
        : {}),
      ...(params.clearPendingArchitectPlanSwitchRequestId
        ? { pendingArchitectPlanSwitchRequestId: null }
        : {}),
      ...(params.shouldShowResolving ?? true
        ? { restoreStatus: "resolving" as const }
        : {}),
      lastError: null,
    });

    const isCurrentRequest = () => {
      const state = get();
      if (state.selectionRequestId !== requestId) {
        return false;
      }
      if (
        params.activeContextKey !== undefined &&
        state.activeContextKey !== params.activeContextKey
      ) {
        return false;
      }
      if (
        typeof params.activeContextKey === "string" &&
        !isChatContextKeyCurrent(params.activeContextKey)
      ) {
        return false;
      }
      return true;
    };

    try {
      const nextSelections = cloneAIContextSelections(aiSelections);
      let selectionsChanged = false;
      let appliedSelection: PersistedAISelection | null = null;
      let restoreMessage: string | null = null;
      const currentSelection = getCurrentSelection();
      const resolutionPlan = buildAISelectionRestorePlan({
        selections: aiSelections,
        mode: params.mode,
        conversationId: params.conversationId,
        preferredProviderId: params.preferredProviderId ?? null,
        currentSelection,
        persistedConversationSelection: getConversationPersistedSelection(
          params.conversationId,
        ),
      });

      await withSuppressedSelectionPersistence(async () => {
        for (const step of resolutionPlan) {
          if (!isCurrentRequest()) {
            return;
          }

          if (step.kind === "candidate") {
            const committed = await useProviderStore
              .getState()
              .commitRestoredSelection(
                {
                  providerId: step.selection.providerId!,
                  modelId: step.selection.modelId!,
                  reasoningEffort: step.selection.reasoningEffort ?? null,
                },
                { isActive: isCurrentRequest },
              );

            if (!isCurrentRequest()) {
              return;
            }

            if (committed) {
              appliedSelection = {
                providerId: committed.providerId,
                modelId: committed.modelId,
                reasoningEffort: committed.reasoningEffort,
                updatedAt: new Date().toISOString(),
              };
              selectionsChanged =
                upsertSelectionForContext(
                  nextSelections,
                  params.mode,
                  params.conversationId,
                  appliedSelection,
                ) || selectionsChanged;
              return;
            }

            selectionsChanged =
              step.invalidate(nextSelections) || selectionsChanged;
            continue;
          }

          if (step.kind === "provider_fallback") {
            const committed = await useProviderStore
              .getState()
              .commitRestoredSelection(
                {
                  providerId: step.providerId,
                  modelId: null,
                  reasoningEffort: null,
                },
                { isActive: isCurrentRequest },
              );

            if (!isCurrentRequest()) {
              return;
            }

            if (committed) {
              appliedSelection = {
                providerId: committed.providerId,
                modelId: committed.modelId,
                reasoningEffort: committed.reasoningEffort,
                updatedAt: new Date().toISOString(),
              };
              selectionsChanged =
                upsertSelectionForContext(
                  nextSelections,
                  params.mode,
                  params.conversationId,
                  appliedSelection,
                ) || selectionsChanged;
              return;
            }

            continue;
          }

          const providerConfigs = useProviderStore
            .getState()
            .providerConfigs.filter((provider) => providerHasCredentials(provider))
            .sort((left, right) => {
              const leftExcluded = step.excludedProviderIds.includes(left.id);
              const rightExcluded = step.excludedProviderIds.includes(right.id);
              if (leftExcluded === rightExcluded) return 0;
              return leftExcluded ? 1 : -1;
            });

          for (const provider of providerConfigs) {
            if (!isCurrentRequest()) {
              return;
            }

            const committed = await useProviderStore
              .getState()
              .commitRestoredSelection(
                {
                  providerId: provider.id,
                  modelId: null,
                  reasoningEffort: null,
                },
                { isActive: isCurrentRequest },
              );

            if (!isCurrentRequest()) {
              return;
            }

            if (!committed) {
              continue;
            }

            appliedSelection = {
              providerId: committed.providerId,
              modelId: committed.modelId,
              reasoningEffort: committed.reasoningEffort,
              updatedAt: new Date().toISOString(),
            };
            selectionsChanged =
              upsertSelectionForContext(
                nextSelections,
                params.mode,
                params.conversationId,
                appliedSelection,
              ) || selectionsChanged;
            return;
          }
        }

        if (!isCurrentRequest()) {
          return;
        }

        useProviderStore.setState({
          selectedProviderId: null,
          selectedModelId: null,
          selectedReasoningEffort: null,
        });
        restoreMessage =
          "No available provider or model could be restored for this conversation.";
      });

      if (!isCurrentRequest()) {
        return false;
      }

      if (selectionsChanged) {
        commitAiSelections(nextSelections);
      }
      persistConversationAISelection(params.conversationId, appliedSelection);

      set((current) => ({
        restoreStatus: "ready",
        lastError: restoreMessage,
        ...(params.clearPendingArchitectPlanSwitchRequestId
          ? { pendingArchitectPlanSwitchRequestId: null }
          : {}),
        selectionRequestId: current.selectionRequestId,
      }));

      return appliedSelection !== null;
    } catch (error) {
      const normalized = toServiceError(error);
      if (isCurrentRequest()) {
        set({
          restoreStatus: "error",
          ...(params.clearPendingArchitectPlanSwitchRequestId
            ? { pendingArchitectPlanSwitchRequestId: null }
            : {}),
          lastError: normalized.message,
        });
      }
      return false;
    }
  };

  const pruneConversationSelections = (conversations: Conversation[]) => {
    const nextSelections = pruneAIContextSelections(
      aiSelections,
      conversations.map((conversation) => conversation.id),
    );
    if (nextSelections !== aiSelections) {
      aiSelections = nextSelections;
      persistAiSelections();
    }
  };

  const waitForHydration = async (): Promise<void> => {
    if (get().hydrationStatus !== "hydrating" || !hydrationPromise) {
      return;
    }

    try {
      await hydrationPromise;
    } catch {
      // A failed hydration already updates store state.
    }
  };

  const markConversationMessagesReady = (conversationId: string) => {
    set((state) => ({
      messageLoadStatusByConversationId: {
        ...state.messageLoadStatusByConversationId,
        [conversationId]: "ready",
      },
    }));
  };

  const replaceLoadedConversationMessages = (
    conversationId: string,
    messages: ChatMessage[],
  ) => {
    set((state) => {
      const nextMessages = [
        ...state.messages.filter(
          (message) => message.conversation_id !== conversationId,
        ),
        ...messages,
      ];
      return {
        ...buildMessageState(nextMessages),
        messageLoadStatusByConversationId: {
          ...state.messageLoadStatusByConversationId,
          [conversationId]: "ready" as const,
        },
      };
    });
  };

  const ensureMessagesLoadedForConversation = async (
    conversationId: string,
  ): Promise<void> => {
    if (!conversationId || deletedConversationIds.has(conversationId)) {
      return;
    }
    if (get().hydrationStatus === "hydrating") {
      await waitForHydration();
    }
    const currentStatus =
      get().messageLoadStatusByConversationId[conversationId] ?? "idle";
    if (currentStatus === "ready") {
      return;
    }
    const existingPromise =
      messageLoadPromisesByConversationId.get(conversationId);
    if (existingPromise) {
      await existingPromise;
      return;
    }
    const stateBeforeLoad = get();
    const existingMessages =
      stateBeforeLoad.messagesByConversationId[conversationId] ??
      stateBeforeLoad.messages.filter(
        (message) => message.conversation_id === conversationId,
      );
    const knownMessageCount =
      stateBeforeLoad.conversations.find(
        (conversation) => conversation.id === conversationId,
      )?.message_count ?? existingMessages.length;
    if (knownMessageCount === 0) {
      markConversationMessagesReady(conversationId);
      return;
    }
    if (existingMessages.length > 0 && existingMessages.length >= knownMessageCount) {
      markConversationMessagesReady(conversationId);
      return;
    }

    const loadPromise = (async () => {
      set((state) => ({
        messageLoadStatusByConversationId: {
          ...state.messageLoadStatusByConversationId,
          [conversationId]: "loading" as const,
        },
      }));

      if (!chatPersistenceAdapters.isTauriAvailable()) {
        markConversationMessagesReady(conversationId);
        return;
      }

      try {
        const loadedMessages = await loadConversationMessages(
          chatPersistenceAdapters,
          {
            conversationId,
            conversations: get().conversations,
          },
        );
        if (deletedConversationIds.has(conversationId)) {
          return;
        }
        replaceLoadedConversationMessages(
          conversationId,
          loadedMessages,
        );
      } catch (error) {
        set((state) => ({
          messageLoadStatusByConversationId: {
            ...state.messageLoadStatusByConversationId,
            [conversationId]: "error" as const,
          },
          lastError: toServiceError(error).message,
        }));
        throw error;
      }
    })();

    messageLoadPromisesByConversationId.set(conversationId, loadPromise);
    try {
      await loadPromise;
    } finally {
      messageLoadPromisesByConversationId.delete(conversationId);
    }
  };

  const hydrateConversationCitationsIfAvailable = async (
    conversationId: string,
  ): Promise<void> => {
    const hydrate =
      useCitationsStore.getState().hydrateConversationCitations;
    if (typeof hydrate === "function") {
      await hydrate(conversationId);
    }
  };

  const clearConversationCitationsIfAvailable = (
    conversationId: string,
  ): void => {
    const clear =
      useCitationsStore.getState().clearConversationCitations;
    if (typeof clear === "function") {
      clear(conversationId);
    }
  };

  const clearConversationCitationsBulkIfAvailable = (
    conversationIds: string[],
  ): void => {
    const clearBulk =
      useCitationsStore.getState().clearConversationCitationsBulk;
    if (typeof clearBulk === "function") {
      clearBulk(conversationIds);
    }
  };

  const buildSendError = (message: string): Error => new Error(message);

  const assertConversationRuntimeAvailableForSend = (conversationId: string) => {
    if (
      deletedConversationIds.has(conversationId) ||
      !get().conversations.some((conversation) => conversation.id === conversationId)
    ) {
      throw buildSendError("This conversation is no longer available.");
    }
    const runtime = getConversationRuntimeSnapshot(
      get().conversationRuntimeById,
      conversationId,
    );
    if (isConversationRuntimeActive(runtime)) {
      throw buildSendError(
        "This conversation is already running. Wait for it to finish before sending again.",
      );
    }
  };

  const transferConversationSessionOwnership = (
    previousConversationId: string,
    materializedConversationId: string,
    sessionId: string,
  ): boolean => {
    if (deletedConversationIds.has(materializedConversationId)) {
      return false;
    }
    if (
      latestConversationSessionIdByConversationId.get(previousConversationId) !==
      sessionId
    ) {
      return false;
    }
    const materializedOwner = latestConversationSessionIdByConversationId.get(
      materializedConversationId,
    );
    if (materializedOwner && materializedOwner !== sessionId) {
      return false;
    }
    latestConversationSessionIdByConversationId.set(
      materializedConversationId,
      sessionId,
    );
    latestConversationSessionIdByConversationId.delete(previousConversationId);
    return true;
  };

  const setConversationRuntime = (
    conversationId: string,
    runtime: ConversationRuntimeState | null,
    options?: {
      globalLastError?: string | null;
    },
  ) => {
    set((state) => ({
      ...buildConversationRuntimePatch(state, conversationId, runtime),
      ...(options && "globalLastError" in options
        ? { lastError: options.globalLastError ?? null }
        : {}),
    }));
  };

  const updateConversationRuntimeIfSessionMatches = (
    conversationId: string,
    sessionId: string,
    updater: (
      currentRuntime: ConversationRuntimeState,
    ) => ConversationRuntimeState | null,
  ): boolean => {
    let didMatch = false;
    set((state) => {
      const currentRuntime = state.conversationRuntimeById[conversationId];
      if (!currentRuntime || currentRuntime.sessionId !== sessionId) {
        return state;
      }
      didMatch = true;
      return buildConversationRuntimePatch(
        state,
        conversationId,
        updater(currentRuntime),
      );
    });
    return didMatch;
  };

  const abortAndClearPreparingRuntimeIfSessionMatches = (
    conversationId: string,
    sessionId: string,
    turnId: string,
    abortController: AbortController,
  ): void => {
    const runtime = getConversationRuntimeSnapshot(
      get().conversationRuntimeById,
      conversationId,
    );
    if (
      runtime.phase !== "preparing" ||
      runtime.sessionId !== sessionId ||
      runtime.turnId !== turnId ||
      runtime.abortController !== abortController
    ) {
      return;
    }
    abortController.abort();
    if (latestConversationSessionIdByConversationId.get(conversationId) === sessionId) {
      latestConversationSessionIdByConversationId.delete(conversationId);
    }
    updateConversationRuntimeIfSessionMatches(
      conversationId,
      sessionId,
      () => null,
    );
  };

  const getLiveContextDiagnosticsRefreshState = (
    conversationId: string,
  ): LiveContextDiagnosticsRefreshState => {
    const existing = liveContextDiagnosticsRefreshByConversationId.get(conversationId);
    if (existing) {
      return existing;
    }
    const created: LiveContextDiagnosticsRefreshState = {
      timeoutId: null,
      inFlight: false,
      pending: false,
      lastStartedAt: 0,
    };
    liveContextDiagnosticsRefreshByConversationId.set(conversationId, created);
    return created;
  };

  const cancelLiveContextDiagnosticsRefreshSchedule = (conversationId: string) => {
    const refreshState = liveContextDiagnosticsRefreshByConversationId.get(conversationId);
    if (!refreshState) {
      return;
    }
    if (refreshState.timeoutId !== null) {
      clearTimeout(refreshState.timeoutId);
      refreshState.timeoutId = null;
    }
    refreshState.pending = false;
    liveContextDiagnosticsRefreshByConversationId.delete(conversationId);
  };

  const cancelAllLiveContextDiagnosticsRefreshSchedules = () => {
    for (const refreshState of liveContextDiagnosticsRefreshByConversationId.values()) {
      if (refreshState.timeoutId !== null) {
        clearTimeout(refreshState.timeoutId);
      }
    }
    liveContextDiagnosticsRefreshByConversationId.clear();
  };

  const clearLiveStreamContextEstimate = (conversationId: string) => {
    cancelLiveContextDiagnosticsRefreshSchedule(conversationId);
    set((state) => {
      if (!state.liveStreamContextEstimatesByConversationId[conversationId]) {
        return state;
      }
      const next = { ...state.liveStreamContextEstimatesByConversationId };
      delete next[conversationId];
      return {
        liveStreamContextEstimatesByConversationId: next,
      };
    });
  };

  const stopConversationRuntimeLocally = (conversationId: string) => {
    const runtime = getConversationRuntimeSnapshot(
      get().conversationRuntimeById,
      conversationId,
    );
    clearConversationSecurityState(conversationId);
    clearLiveStreamContextEstimate(conversationId);
    if (!isConversationRuntimeActive(runtime)) {
      return;
    }

    if (runtime.abortController) {
      runtime.abortController.abort();
    }
    if (runtime.sessionId) {
      cancelStream(runtime.sessionId);
    }

    setConversationRuntime(
      conversationId,
      {
        ...runtime,
        phase: "idle",
        abortController: null,
        lastError: null,
      },
      { globalLastError: null },
    );
  };

  const stopActiveStreamsForCompletedTasks = (
    previousTasks: Pick<ImplementTask, "id" | "status">[],
    nextTasks: Pick<ImplementTask, "id" | "status">[],
  ) => {
    const previousStatusByTaskId = new Map(
      previousTasks.map((task) => [task.id, task.status]),
    );
    const completedTaskIds = new Set(
      nextTasks
        .filter(
          (task) =>
            task.status === "Completed" &&
            previousStatusByTaskId.get(task.id) !== "Completed",
        )
        .map((task) => task.id),
    );

    if (completedTaskIds.size === 0) {
      return;
    }

    get().conversations.forEach((conversation) => {
      if (
        conversation.scope_mode === "Implement" &&
        conversation.task_id &&
        completedTaskIds.has(conversation.task_id)
      ) {
        stopConversationRuntimeLocally(conversation.id);
      }
    });
  };

  const reconcileImplementAwaitingResponseTasks = async () => {
    const state = get();
    const taskStore = useTaskStore.getState();
    const taskIdsToMark = new Set<string>();

    state.conversations.forEach((conversation) => {
      if (conversation.scope_mode !== "Implement" || !conversation.task_id) {
        return;
      }

      const runtime = getConversationRuntimeSnapshot(
        state.conversationRuntimeById,
        conversation.id,
      );
      if (isConversationRuntimeActive(runtime)) {
        return;
      }

      const activeQuestionnaire = resolveConversationQuestionnaireFromState(
        state,
        conversation.id,
      );
      if (!activeQuestionnaire || activeQuestionnaire.mode !== "pending_reply") {
        return;
      }

      const task = taskStore.getTaskById(conversation.task_id);
      if (!task) {
        return;
      }

      if (
        task.status === "AwaitingResponse" ||
        task.status === "Completed" ||
        task.status === "Failed" ||
        task.status === "InReview"
      ) {
        return;
      }

      taskIdsToMark.add(conversation.task_id);
    });

    for (const taskId of taskIdsToMark) {
      if (awaitingResponseReconciliationTaskIds.has(taskId)) {
        continue;
      }
      awaitingResponseReconciliationTaskIds.add(taskId);
      try {
        const currentTask = taskStore.getTaskById(taskId);
        if (!currentTask) {
          continue;
        }

        if (currentTask.status === "Pending") {
          await taskStore.startTask(taskId);
        }

        const refreshedTask = taskStore.getTaskById(taskId);
        if (!refreshedTask || refreshedTask.status !== "InProgress") {
          continue;
        }

        await taskStore.markTaskAwaitingResponse(taskId);
      } finally {
        awaitingResponseReconciliationTaskIds.delete(taskId);
      }
    }
  };

  const scheduleImplementAwaitingResponseReconciliation = () => {
    if (awaitingResponseReconciliationScheduled) {
      return;
    }

    awaitingResponseReconciliationScheduled = true;
    queueMicrotask(() => {
      awaitingResponseReconciliationScheduled = false;
      void reconcileImplementAwaitingResponseTasks();
    });
  };

  const ensureTaskAwaitingResponseSync = () => {
    if (taskAwaitingResponseSyncUnsubscribe) {
      return;
    }

    taskAwaitingResponseSyncUnsubscribe = useTaskStore.subscribe(
      (nextState, previousState) => {
        if (nextState.tasks === previousState.tasks) {
          return;
        }

        stopActiveStreamsForCompletedTasks(
          previousState.tasks as Pick<ImplementTask, "id" | "status">[],
          nextState.tasks as Pick<ImplementTask, "id" | "status">[],
        );
        scheduleImplementAwaitingResponseReconciliation();
      },
    );
  };

  const assertImplementTaskReadyForSend = async (
    taskId: string,
  ): Promise<ImplementTask> => {
    const taskStore = useTaskStore.getState();
    const task = taskStore.getTaskById(taskId);
    const isPlanFinalizationTask = isPlanFinalizationTaskSource(task?.task_source);
    const activeMergeWorkflow =
      typeof taskStore.getMergeWorkflowRuntime === "function"
        ? taskStore.getMergeWorkflowRuntime(taskId)
        : null;

    if (!task) {
      throw buildSendError(`Unknown task: ${taskId}`);
    }

    if (task.draft) {
      return task;
    }

    if (task.status === "Pending" && !activeMergeWorkflow) {
      await taskStore.startTask(taskId);
    } else if (
      (task.status === "AwaitingResponse" || task.status === "Failed") &&
      !activeMergeWorkflow
    ) {
      await taskStore.retryTask(taskId);
    }

    const refreshedTask = useTaskStore.getState().getTaskById(taskId);
    if (!refreshedTask) {
      throw buildSendError(`Unknown task: ${taskId}`);
    }

    if (refreshedTask.draft) {
      throw buildSendError(
        useTaskStore.getState().lastError ||
          "Task is still in draft mode and cannot receive messages yet.",
      );
    }

    if (activeMergeWorkflow) {
      if (refreshedTask.status === "Completed") {
        throw buildSendError(
          useTaskStore.getState().lastError ||
            `Task ${taskId} is already completed.`,
        );
      }
      return refreshedTask;
    }

    if (
      !isPlanFinalizationTask &&
      refreshedTask.status !== "InProgress" &&
      refreshedTask.status !== "InReview"
    ) {
      throw buildSendError(
        useTaskStore.getState().lastError ||
          `Task ${taskId} is not ready to receive a message (current status: ${refreshedTask.status}).`,
      );
    }

    if (
      isPlanFinalizationTask &&
      !canPlanFinalizationTaskReceiveMessages(refreshedTask.status)
    ) {
      throw buildSendError(
        useTaskStore.getState().lastError ||
        `Task ${taskId} is already completed.`,
      );
    }

    return refreshedTask;
  };

  const ensureProviderSelectionSync = () => {
    if (providerSelectionUnsubscribe) return;

    providerSelectionUnsubscribe = useProviderStore.subscribe(
      (nextState, previousState) => {
        if (!aiSelectionsLoaded) return;

        const providerChanged =
          nextState.selectedProviderId !== previousState.selectedProviderId;
        const modelChanged =
          nextState.selectedModelId !== previousState.selectedModelId;
        const reasoningChanged =
          nextState.selectedReasoningEffort !==
          previousState.selectedReasoningEffort;
        if (!providerChanged && !modelChanged && !reasoningChanged) {
          return;
        }

        const appState = useAppStore.getState();
        const selectedConversationId = get().selectedConversationId;

        if (
          providerChanged &&
          nextState.selectedProviderId &&
          !nextState.selectedModelId
        ) {
          void runAiSelectionRestore({
            mode: appState.mode,
            conversationId: selectedConversationId,
            preferredProviderId: nextState.selectedProviderId,
            activeContextKey: get().activeContextKey,
            shouldShowResolving: true,
          });
          return;
        }

        if (suppressedSelectionPersistenceCount > 0) {
          return;
        }

        if (!nextState.selectedProviderId || !nextState.selectedModelId) {
          return;
        }

        persistSelectionForContext(appState.mode, selectedConversationId);
        if ((providerChanged || modelChanged) && selectedConversationId) {
          void maybeCompactConversationAfterModelSwitch({
            conversationId: selectedConversationId,
            previousProviderId: previousState.selectedProviderId,
            previousModelId: previousState.selectedModelId,
            nextProviderId: nextState.selectedProviderId,
            nextModelId: nextState.selectedModelId,
          });
        }
      },
    );
  };

  const ensureContextSelectionSync = () => {
    if (contextSelectionUnsubscribe) return;

    contextSelectionUnsubscribe = useAppStore.subscribe(
      (nextState, previousState) => {
        const nextContextKey = buildChatContextKey(nextState);
        const previousContextKey = buildChatContextKey(previousState);
        if (nextContextKey === previousContextKey) {
          return;
        }

        const nextArchitectBranch =
          nextState.mode === "Architect"
            ? resolveTargetBranch(nextState.activePlanContext?.targetBranch)
            : null;
        const previousArchitectBranch =
          previousState.mode === "Architect"
            ? resolveTargetBranch(previousState.activePlanContext?.targetBranch)
            : null;
        const shouldBeginArchitectPlanSwitch =
          nextState.mode === "Architect" &&
          (previousState.mode !== "Architect" ||
            nextState.activeArchitectPlanId !==
              previousState.activeArchitectPlanId ||
            nextArchitectBranch !== previousArchitectBranch);

        if (aiSelectionsLoaded) {
          const previousConversationId =
            get().selectedConversationIdsByMode[previousState.mode] ??
            get().selectedConversationId;
          if (previousConversationId) {
            persistSelectionForContext(
              previousState.mode,
              previousConversationId,
            );
          }
        }

        if (shouldBeginArchitectPlanSwitch) {
          beginArchitectPlanSwitchSelection({
            requestId: nextState.architectPlanSwitch.requestId,
          });
        }

        void get().ensureConversationForCurrentMode();
      },
    );
  };

  queueMicrotask(() => {
    ensureTaskAwaitingResponseSync();
  });

  const sanitizeAssistantContentForModel = (content: string): string => {
    return content
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<think>[\s\S]*$/gi, "")
      .replace(/<\/think>/gi, "")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (/^\[\s*TOOL\s*\]/i.test(trimmed)) return false;
        if (/^\[\s*TOOL_DONE\s*\]/i.test(trimmed)) return false;
        if (/^🔍\s*\*\*(Recherche web|Web search):\*\*/i.test(trimmed))
          return false;
        return true;
      })
      .join("\n")
      .trim();
  };

  const truncateContextText = (value: string, maxChars: number): string => {
    if (value.length <= maxChars) return value;
    const marker = "\n\n[... compacted for summary budget ...]\n\n";
    const tailChars = Math.min(600, Math.max(120, Math.floor(maxChars * 0.25)));
    const headChars = Math.max(0, maxChars - marker.length - tailChars);
    return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
  };

  const getToolDefinitionsForIds = (toolIds: string[]) => {
    const allowedIdSet = new Set(toolIds);
    const macroDefinitions = MACRO_TOOL_REGISTRY.filter((entry) => allowedIdSet.has(entry.id));
    const mcpDefinitions: MacroToolRegistryEntry[] = useToolsStore
      .getState()
      .getEnabledMCPTools()
      .filter((tool) => allowedIdSet.has(tool.id))
      .map((tool) => ({
        id: tool.id,
        description: tool.description || `MCP tool ${tool.name} from ${tool.serverId}`,
        parameters: (tool.inputSchema as MacroToolRegistryEntry["parameters"]) ?? {
          type: "object",
          properties: {},
        },
      }));
    return [...macroDefinitions, ...mcpDefinitions];
  };

  const getSelectedModelContext = (
    providerId: string,
    modelId: string,
    providerType: string,
  ): {
    limits: ReturnType<typeof resolveModelContextLimits>;
    footprintFields: ContextLimitFootprintFields;
  } => {
    const providerState = useProviderStore.getState();
    const selectedModel = (
      providerState.modelsByProvider[providerId] || []
    ).find((model) => model.id === modelId);
    const limits = resolveModelContextLimits({
      providerType,
      providerId,
      baseUrl: providerState.providerConfigs.find(
        (provider) => provider.id === providerId,
      )?.baseUrl,
      modelId,
      modelContextWindowTokens: selectedModel?.contextWindowTokens,
      inputLimitTokens: selectedModel?.inputLimitTokens,
      outputLimitTokens: selectedModel?.outputLimitTokens,
      contextWindowSource: selectedModel?.contextWindowSource,
      contextLimitsUpdatedAt: selectedModel?.contextLimitsUpdatedAt,
    });
    return {
      limits,
      footprintFields: contextLimitsToFootprintFields(limits),
    };
  };

  const getSelectedModelContextWindowTokens = (
    providerId: string,
    modelId: string,
    providerType: string,
  ): number =>
    getSelectedModelContext(providerId, modelId, providerType)
      .footprintFields.modelContextWindowTokens;

  const parseCompactionJson = <T,>(
    value: string | null | undefined,
    fallback: T,
  ): T => {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  };

  const normalizeContextFootprintReason = (
    value: string | null | undefined,
  ): ContextFootprintReason | null => {
    switch (value) {
      case "below_threshold":
      case "total_context_ratio":
      case "hidden_context_ratio":
      case "tool_turn_count":
      case "post_compaction_overflow":
      case "hard_stop_ratio":
      case "model_window_shrank":
      case "manual_compaction_required":
        return value;
      default:
        return null;
    }
  };

  const normalizeContextCompactionKind = (
    value: string | null | undefined,
  ): ContextCompactionKind | undefined => {
    switch (value) {
      case "background":
      case "blocking":
      case "model_switch":
      case "overflow_recovery":
      case "safety_prestream":
      case "stream_overflow":
      case "manual":
        return value;
      default:
        return undefined;
    }
  };

  const normalizeCompactionPass = (
    value: string | null | undefined,
  ): CompactionPass => {
    switch (value) {
      case "forced":
      case "ultra":
        return value;
      default:
        return "normal";
    }
  };

  const normalizeCompactionSummarySource = (
    value: string | null | undefined,
  ): CompactionSummarySource | undefined => {
    switch (value) {
      case "model":
      case "fallback":
        return value;
      default:
        return undefined;
    }
  };

  const normalizeCheckpointHealth = (
    value: string | null | undefined,
  ): ConversationCompactionState["checkpointHealth"] | undefined => {
    switch (value) {
      case "ok":
      case "degraded":
      case "fallback":
        return value;
      default:
        return undefined;
    }
  };

  const normalizeCompactionTrigger = (
    value: string | null | undefined,
  ): ConversationCompactionState["lastTrigger"] | undefined => {
    switch (value) {
      case "manual":
      case "model_switch":
      case "safety_prestream":
      case "stream_overflow":
        return value;
      default:
        return undefined;
    }
  };

  const normalizeSummaryFormatVersion = (
    value: number | null | undefined,
  ): number => (
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : 1
  );

  const getLastConversationMessageId = (conversationId: string): string | null =>
    getOrderedConversationMessages(conversationId).at(-1)?.id ?? null;

  const compactionRuntime = createChatCompactionRuntime({
    getState: get,
    setState: (updater) => {
      set((state) => updater(state));
    },
    getLastConversationMessageId,
  });
  const {
    setConversationCompactionStatus,
    publishPersistedCompactionStatusIfIdle,
    completeLatestSessionCompactionEvent,
    clearLatestRunningSessionCompactionEvent,
    markConversationCompactionStarted,
  } = compactionRuntime;

  const mapDbCompactionStateToState = (
    record: tauriIpc.DbConversationCompactionState,
  ): ConversationCompactionState => ({
    conversationId: record.conversation_id,
    upToMessageId: record.up_to_message_id,
    summaryText: record.summary_text,
    toolDigest: parseCompactionJson(record.tool_digest_json, []),
    usedSourcePassageIds: parseCompactionJson(
      record.used_source_passage_ids_json,
      [],
    ),
    interestingSourcePassageIds: parseCompactionJson(
      record.interesting_source_passage_ids_json,
      [],
    ),
    estimatedTokensBefore: record.estimated_tokens_before,
    estimatedTokensAfter: record.estimated_tokens_after,
    fingerprint: record.fingerprint,
    version: record.version,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    prunedToolContextMessageIds: parseCompactionJson(
      record.pruned_tool_context_message_ids_json,
      [],
    ),
    reservedTokens: record.reserved_tokens ?? 0,
    footprintBefore: parseCompactionJson(
      record.footprint_before_json,
      undefined as ContextFootprint | undefined,
    ),
    footprintAfter: parseCompactionJson(
      record.footprint_after_json,
      undefined as ContextFootprint | undefined,
    ),
    degradedReason: normalizeContextFootprintReason(record.degraded_reason),
    compactionKind: normalizeContextCompactionKind(record.compaction_kind),
    compactionPass: normalizeCompactionPass(record.compaction_pass),
    summaryFormatVersion: normalizeSummaryFormatVersion(
      record.summary_format_version,
    ),
    summarySource: normalizeCompactionSummarySource(record.summary_source),
    policyVersion:
      typeof record.policy_version === "number" ? record.policy_version : undefined,
    fingerprintInputsJson: record.fingerprint_inputs_json ?? undefined,
    sourceHashesJson: record.source_hashes_json ?? undefined,
    modelContextWindowTokens:
      typeof record.model_context_window_tokens === "number"
        ? record.model_context_window_tokens
        : undefined,
    providerId: record.provider_id ?? undefined,
    modelId: record.model_id ?? undefined,
    checkpointHealth: normalizeCheckpointHealth(record.checkpoint_health),
    lastTrigger: normalizeCompactionTrigger(record.last_trigger),
  });

  const getConversationCompactionState = async (
    conversationId: string,
  ): Promise<ConversationCompactionState | null> => {
    if (conversationCompactionStateCache.has(conversationId)) {
      const cachedState =
        conversationCompactionStateCache.get(conversationId) ?? null;
      publishPersistedCompactionStatusIfIdle(conversationId, cachedState);
      return cachedState;
    }

    if (!tauriIpc.isTauriAvailable()) {
      conversationCompactionStateCache.set(conversationId, null);
      return null;
    }
    if (typeof tauriIpc.dbGetConversationCompactionState !== "function") {
      conversationCompactionStateCache.set(conversationId, null);
      return null;
    }

    try {
      const record =
        await tauriIpc.dbGetConversationCompactionState(conversationId);
      const state = record ? mapDbCompactionStateToState(record) : null;
      conversationCompactionStateCache.set(conversationId, state);
      publishPersistedCompactionStatusIfIdle(conversationId, state);
      return state;
    } catch (error) {
      console.error("Failed to load conversation compaction state:", error);
      conversationCompactionStateCache.set(conversationId, null);
      return null;
    }
  };

  const persistConversationCompactionState = async (
    state: ConversationCompactionState | null,
  ): Promise<void> => {
    if (!state?.conversationId) {
      return;
    }

    conversationCompactionStateCache.set(state.conversationId, state);
    setConversationCompactionStatus(
      state.conversationId,
      resolveCompactionStatusFromState(state),
    );
    if (!tauriIpc.isTauriAvailable()) {
      return;
    }
    if (typeof tauriIpc.dbUpsertConversationCompactionState !== "function") {
      return;
    }

    try {
      await tauriIpc.dbUpsertConversationCompactionState({
        conversation_id: state.conversationId,
        up_to_message_id: state.upToMessageId,
        summary_text: state.summaryText,
        tool_digest_json: JSON.stringify(state.toolDigest),
        used_source_passage_ids_json: JSON.stringify(
          state.usedSourcePassageIds,
        ),
        interesting_source_passage_ids_json: JSON.stringify(
          state.interestingSourcePassageIds,
        ),
        estimated_tokens_before: state.estimatedTokensBefore,
        estimated_tokens_after: state.estimatedTokensAfter,
        fingerprint: state.fingerprint,
        version: state.version,
        pruned_tool_context_message_ids_json: JSON.stringify(
          state.prunedToolContextMessageIds ?? [],
        ),
        reserved_tokens: state.reservedTokens ?? null,
        footprint_before_json: state.footprintBefore
          ? JSON.stringify(state.footprintBefore)
          : null,
        footprint_after_json: state.footprintAfter
          ? JSON.stringify(state.footprintAfter)
          : null,
        degraded_reason: state.degradedReason ?? null,
        compaction_kind: state.compactionKind ?? null,
        compaction_pass: state.compactionPass ?? 'normal',
        summary_format_version: state.summaryFormatVersion ?? 1,
        summary_source: state.summarySource ?? null,
        policy_version: state.policyVersion ?? null,
        fingerprint_inputs_json: state.fingerprintInputsJson ?? null,
        source_hashes_json: state.sourceHashesJson ?? null,
        model_context_window_tokens: state.modelContextWindowTokens ?? null,
        provider_id: state.providerId ?? null,
        model_id: state.modelId ?? null,
        checkpoint_health: state.checkpointHealth ?? null,
        last_trigger: state.lastTrigger ?? null,
      });
    } catch (error) {
      console.error("Failed to persist conversation compaction state:", error);
    }
  };

  const deleteConversationCompactionState = async (
    conversationId: string,
  ): Promise<void> => {
    conversationCompactionStateCache.delete(conversationId);
    setConversationCompactionStatus(conversationId, null);
    if (!tauriIpc.isTauriAvailable()) {
      return;
    }
    if (typeof tauriIpc.dbDeleteConversationCompactionState !== "function") {
      return;
    }

    try {
      await tauriIpc.dbDeleteConversationCompactionState(conversationId);
    } catch (error) {
      console.error("Failed to delete conversation compaction state:", error);
    }
  };

  const recordConversationCompactionEvent = async (params: {
    conversationId: string;
    trigger: ConversationCompactionState["lastTrigger"] | ContextCompactionKind;
    providerId?: string | null;
    modelId?: string | null;
    modelContextWindowTokens?: number | null;
    tokensBefore?: number | null;
    tokensAfter?: number | null;
    status: "success" | "failed" | "blocked" | "degraded" | "skipped";
    errorCode?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    if (!tauriIpc.isTauriAvailable()) return;
    if (typeof tauriIpc.dbInsertConversationCompactionEvent !== "function") return;

    try {
      await tauriIpc.dbInsertConversationCompactionEvent({
        conversation_id: params.conversationId,
        trigger: params.trigger ?? "unknown",
        provider_id: params.providerId ?? null,
        model_id: params.modelId ?? null,
        model_context_window_tokens: params.modelContextWindowTokens ?? null,
        tokens_before: params.tokensBefore ?? null,
        tokens_after: params.tokensAfter ?? null,
        status: params.status,
        error_code: params.errorCode ?? null,
        reason: params.reason ?? null,
        metadata_json: params.metadata ? JSON.stringify(params.metadata) : null,
      });
    } catch (error) {
      devLogger.info(
        `Failed to record compaction event for conversation=${params.conversationId}: ${toServiceError(error).message}`,
      );
    }
  };

  const prepareCompactionSummaryMessages = (
    input: SummaryGenerationInput,
    options: Partial<CompactionSummaryAttemptOptions> = {},
  ): StreamMessage[] => {
    const compactedTranscript = input.compactableMessages
      .slice(-(options.compactableMessageLimit ?? input.compactableMessages.length))
      .map((message) => {
        const content =
          message.role === "assistant"
            ? sanitizeAssistantContentForModel(message.content)
            : message.content;
        return `${message.role.toUpperCase()} [${message.id}]\n${
          truncateContextText(
            content.trim() || "[empty]",
            options.compactableCharsPerMessage ?? 2400,
          )
        }`;
      })
      .join("\n\n---\n\n");

    const retainedContext = input.retainedMessages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-(options.retainedMessageLimit ?? 6))
      .map((message) => {
        const content =
          message.role === "assistant"
            ? sanitizeAssistantContentForModel(message.content)
            : message.content;
        return `${message.role.toUpperCase()} [${message.id}]\n${
          truncateContextText(content.trim() || "[empty]", 3200)
        }`;
      })
      .join("\n\n---\n\n");

    const toolDigest = input.toolDigest
      .slice(0, options.toolDigestLimit ?? input.toolDigest.length)
      .map(
        (entry) =>
          `- kind=${entry.kind}; tool=${entry.tool_name}; target=${entry.target}; evidence=${entry.evidence_excerpt}`,
      )
      .join("\n");

    const usedPassages = input.usedSourcePassages
      .slice(0, options.sourceLimit ?? input.usedSourcePassages.length)
      .map(
        (citation) =>
          `- ${citation.title}${citation.source ? ` (${citation.source})` : ""}: ${citation.snippet || ""}`,
      )
      .join("\n");

    const interestingPassages = input.interestingSourcePassages
      .slice(0, options.sourceLimit ?? input.interestingSourcePassages.length)
      .map(
        (citation) =>
          `- ${citation.title}${citation.source ? ` (${citation.source})` : ""}: ${citation.snippet || ""}`,
      )
      .join("\n");

    return [
      {
        role: "system",
        content: COMPACTION_SUMMARY_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: [
          "Older transcript to compact:",
          compactedTranscript || "[none]",
          retainedContext ? `Recent retained context:\n${retainedContext}` : "",
          toolDigest ? `Deterministic tool facts:\n${toolDigest}` : "",
          usedPassages ? `Used source passages:\n${usedPassages}` : "",
          interestingPassages
            ? `Interesting source passages:\n${interestingPassages}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];
  };

  const asNonEmptyStringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter((item) => item.length > 0)
      : [];

  const formatSummaryListSection = (
    title: string,
    items: string[],
  ): string => (items.length > 0
    ? `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`
    : "");

  const formatCompactionSummaryFromModelOutput = (raw: string): string => {
    const parsed = extractJsonObjectFromModelOutput(raw) as {
      currentObjective?: unknown;
      userInstructions?: unknown;
      decisions?: unknown;
      discoveries?: unknown;
      openQuestions?: unknown;
      activeFiles?: unknown;
      toolFacts?: unknown;
      knownErrors?: unknown;
      remainingWork?: unknown;
      summary?: unknown;
    };

    const currentObjective =
      typeof parsed.currentObjective === "string"
        ? parsed.currentObjective.trim()
        : "";
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const userInstructions = asNonEmptyStringArray(parsed.userInstructions);
    const decisions = asNonEmptyStringArray(parsed.decisions);
    const discoveries = asNonEmptyStringArray(parsed.discoveries);
    const openQuestions = asNonEmptyStringArray(parsed.openQuestions);
    const activeFiles = asNonEmptyStringArray(parsed.activeFiles);
    const toolFacts = asNonEmptyStringArray(parsed.toolFacts);
    const knownErrors = asNonEmptyStringArray(parsed.knownErrors);
    const remainingWork = asNonEmptyStringArray(parsed.remainingWork);

    return [
      currentObjective ? `Current objective: ${currentObjective}` : "",
      formatSummaryListSection("User instructions", userInstructions),
      formatSummaryListSection("Decisions made", decisions),
      formatSummaryListSection("Discoveries", discoveries),
      formatSummaryListSection("Open questions", openQuestions),
      formatSummaryListSection("Active files/projects", activeFiles),
      formatSummaryListSection("Tool facts", toolFacts),
      formatSummaryListSection("Known errors / constraints", knownErrors),
      formatSummaryListSection("Remaining work", remainingWork),
      summary ? `Summary:\n${summary}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
  };

  const generateCompactionSummary = async (
    providerConfig: NonNullable<
      ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
    >,
    providerId: string,
    modelId: string,
    reasoningEffort: ReasoningEffort | null | undefined,
    input: SummaryGenerationInput,
  ): Promise<string | null> => {
    const modelContextWindowTokens = getSelectedModelContextWindowTokens(
      providerId,
      modelId,
      providerConfig.providerType,
    );
    const usableSummaryBudget = Math.max(
      512,
      Math.floor(modelContextWindowTokens * 0.7),
    );
    const attempts = getCompactionSummaryAttemptPlan(
      input.compactableMessages.length,
    );

    let lastError: unknown = null;
    const lastAttempt = attempts[attempts.length - 1];
    for (const attempt of attempts) {
      const messages = prepareCompactionSummaryMessages(input, attempt);
      const estimatedTokens = estimateSerializedPayloadTokensForProvider({
        messages,
        providerType: providerConfig.providerType,
        providerId,
        baseUrl: providerConfig.baseUrl,
        modelId,
      });
      if (estimatedTokens > usableSummaryBudget && attempt !== lastAttempt) {
        continue;
      }

      try {
        const output = await sendChatNonStreaming({
          providerId,
          providerType: providerConfig.providerType,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          modelId,
          reasoningEffort,
          messages,
          copilotSendTimeoutMs:
            providerConfig.providerType === "copilot"
              ? COPILOT_COMPACTION_SUMMARY_TIMEOUT_MS
              : null,
          onComplete: () => {},
          onError: () => {},
        });
        const summary = formatCompactionSummaryFromModelOutput(output);
        return summary || null;
      } catch (error) {
        lastError = error;
        if (!isProviderContextOverflowError(error)) {
          break;
        }
      }
    }

    devLogger.info(
      `Compaction summary generation failed for provider=${providerConfig.providerType}: ${toServiceError(lastError).message}`,
    );
    return null;
  };

  const loadContextBudgetPolicy = async (): Promise<ContextBudgetPolicy> => {
    return {
      auto: true,
      prune: true,
      reservedTokens: null,
    };
  };

  const compactConversationMessages = async (params: {
    conversationId: string;
    providerId: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
    providerConfig: NonNullable<
      ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
    >;
    allowedToolIds: string[];
    systemMessage: string;
    preparedMessages: StreamMessage[];
    orderedMessages: ChatMessage[];
    citations: Citation[];
    mode: ContextCompactionKind;
    forceCompaction?: boolean;
    forcePrune?: boolean;
    displayAfterMessageId?: string | null;
  }) => {
    const toolDefinitions = getToolDefinitionsForIds(params.allowedToolIds);
    const previousCompactionStatus =
      get().conversationCompactionStatusById[params.conversationId] ?? null;
    const currentCompactionState = await getConversationCompactionState(
      params.conversationId,
    );
    if (isTransientCompactionStatus(previousCompactionStatus)) {
      const persistedStatus = currentCompactionState
        ? resolveCompactionStatusFromState(currentCompactionState)
        : null;
      const restoredStatus: ConversationCompactionStatus = {
        ...persistedStatus,
        ...previousCompactionStatus,
        phase: previousCompactionStatus.phase,
      };
      setConversationCompactionStatus(
        params.conversationId,
        restoredStatus,
      );
    }
    const statusBeforeNewCompaction =
      get().conversationCompactionStatusById[params.conversationId] ??
      previousCompactionStatus;
    const { footprintFields } = getSelectedModelContext(
      params.providerId,
      params.modelId,
      params.providerConfig.providerType,
    );
    const budgetPolicy = await loadContextBudgetPolicy();
    const preparedMessagesForContext = normalizeMessagesForProviderContext(
      params.providerConfig.providerType,
      params.preparedMessages,
    );
    const countProviderInputItems = shouldCountProviderInputItemsForContext(
      params.providerConfig.providerType,
    );
    const estimateSerializedPayloadTokens = (messages: StreamMessage[]) =>
      estimateSerializedPayloadTokensForProvider({
        messages,
        providerType: params.providerConfig.providerType,
        providerId: params.providerId,
        baseUrl: params.providerConfig.baseUrl,
        modelId: params.modelId,
      });
    let orchestration: Awaited<
      ReturnType<typeof runContextCompactionOrchestration>
    >;
    try {
      orchestration = await runContextCompactionOrchestration({
        boundary: getCompactionBoundaryForMode(params.mode),
        mode: params.mode,
        systemMessage: params.systemMessage,
        preparedMessages: preparedMessagesForContext,
        orderedMessages: params.orderedMessages,
        citations: params.citations,
        toolDefinitions,
        footprintFields,
        previousModelContextWindowTokens:
          currentCompactionState?.modelContextWindowTokens,
        providerId: params.providerId,
        providerType: params.providerConfig.providerType,
        modelId: params.modelId,
        currentCompactionState,
        budgetPolicy,
        forceCompaction: params.forceCompaction,
        forcePrune: params.forcePrune,
        estimateSerializedPayloadTokens,
        countProviderInputItems,
        onCompactionStarted: () => {
          markConversationCompactionStarted(
            params.conversationId,
            params.mode,
            statusBeforeNewCompaction,
            params.displayAfterMessageId,
          );
        },
        generateSummary: (input) =>
          generateCompactionSummary(
            params.providerConfig,
            params.providerId,
            params.modelId,
            params.reasoningEffort,
            input,
          ),
      });
    } catch (error) {
      clearLatestRunningSessionCompactionEvent(params.conversationId, params.mode);
      setConversationCompactionStatus(params.conversationId, statusBeforeNewCompaction);
      await recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: getCompactionEventTrigger(params.mode),
        providerId: params.providerId,
        modelId: params.modelId,
        modelContextWindowTokens: footprintFields.modelContextWindowTokens,
        status: "failed",
        errorCode: isProviderContextOverflowError(error)
          ? "context_overflow"
          : "compaction_error",
        reason: toServiceError(error).message,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.providerId,
          providerType: params.providerConfig.providerType,
          modelId: params.modelId,
          trigger: getCompactionEventTrigger(params.mode),
          status: "failed",
          footprintFields,
          budgetPolicy,
          reason: toServiceError(error).message,
          result: "compaction_error",
        }),
      });
      throw error;
    }

    if (orchestration.outcome === "blocked") {
      clearLatestRunningSessionCompactionEvent(params.conversationId, params.mode);
      setConversationCompactionStatus(params.conversationId, {
        phase: "too_large",
        updatedAt: new Date().toISOString(),
        reason: orchestration.preflightFootprint.reason,
        kind: params.mode,
        footprintAfter: orchestration.preflightFootprint,
      });
      await recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: getCompactionEventTrigger(params.mode),
        providerId: params.providerId,
        modelId: params.modelId,
        modelContextWindowTokens:
          orchestration.preflightFootprint.modelContextWindowTokens,
        tokensBefore: orchestration.preflightFootprint.totalEstimatedTokens,
        tokensAfter: orchestration.preflightFootprint.totalEstimatedTokens,
        status: "blocked",
        reason: orchestration.evaluation.reason,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.providerId,
          providerType: params.providerConfig.providerType,
          modelId: params.modelId,
          trigger: getCompactionEventTrigger(params.mode),
          status: "blocked",
          footprint: orchestration.preflightFootprint,
          footprintFields,
          budgetPolicy,
          reason: orchestration.evaluation.reason,
          result: "latest_boundary_payload_too_large",
        }),
      });
      throw buildSendError(orchestration.errorMessage);
    }
    if (orchestration.outcome === "manual_required") {
      clearLatestRunningSessionCompactionEvent(params.conversationId, params.mode);
      setConversationCompactionStatus(params.conversationId, {
        ...statusBeforeNewCompaction,
        phase: "needs_manual_compaction",
        updatedAt: new Date().toISOString(),
        reason: "manual_compaction_required",
        kind: params.mode,
        footprintAfter: {
          ...orchestration.preflightFootprint,
          reason: "manual_compaction_required",
        },
      });
      await recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: getCompactionEventTrigger(params.mode),
        providerId: params.providerId,
        modelId: params.modelId,
        modelContextWindowTokens:
          orchestration.preflightFootprint.modelContextWindowTokens,
        tokensBefore: orchestration.preflightFootprint.totalEstimatedTokens,
        tokensAfter: orchestration.preflightFootprint.totalEstimatedTokens,
        status: "skipped",
        reason: "manual_compaction_required",
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.providerId,
          providerType: params.providerConfig.providerType,
          modelId: params.modelId,
          trigger: getCompactionEventTrigger(params.mode),
          status: "skipped",
          footprint: {
            ...orchestration.preflightFootprint,
            reason: "manual_compaction_required",
          },
          footprintFields,
          budgetPolicy,
          reason: "manual_compaction_required",
          result: "auto_compaction_disabled",
        }),
      });
      throw buildSendError(orchestration.errorMessage);
    }

    const { result } = orchestration;
    if (result.manualSkip) {
      clearLatestRunningSessionCompactionEvent(params.conversationId, params.mode);
      setConversationCompactionStatus(params.conversationId, statusBeforeNewCompaction);
      await recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: getCompactionEventTrigger(params.mode),
        providerId: params.providerId,
        modelId: params.modelId,
        modelContextWindowTokens: result.footprintBefore.modelContextWindowTokens,
        tokensBefore: result.footprintBefore.totalEstimatedTokens,
        tokensAfter: result.footprintAfter.totalEstimatedTokens,
        status: "skipped",
        reason: result.manualSkip.reason,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.providerId,
          providerType: params.providerConfig.providerType,
          modelId: params.modelId,
          trigger: getCompactionEventTrigger(params.mode),
          status: "skipped",
          footprintBefore: result.footprintBefore,
          footprintAfter: result.footprintAfter,
          footprintFields,
          budgetPolicy,
          reason: result.manualSkip.reason,
          result: "manual_compaction_skipped",
        }),
      });
      return result;
    }
    if (orchestration.shouldPersistCompaction) {
      if (result.compactionState) {
        completeLatestSessionCompactionEvent(
          params.conversationId,
          result.compactionState,
          params.mode,
        );
      }
      await persistConversationCompactionState(result.compactionState);
      await recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger:
          result.compactionState?.lastTrigger ??
          getCompactionEventTrigger(params.mode),
        providerId: params.providerId,
        modelId: params.modelId,
        modelContextWindowTokens: footprintFields.modelContextWindowTokens,
        tokensBefore: result.footprintBefore.totalEstimatedTokens,
        tokensAfter: result.footprintAfter.totalEstimatedTokens,
        status: result.degraded ? "degraded" : "success",
        reason: result.footprintAfter.reason,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.providerId,
          providerType: params.providerConfig.providerType,
          modelId: params.modelId,
          trigger:
            result.compactionState?.lastTrigger ??
            getCompactionEventTrigger(params.mode),
          status: result.degraded ? "degraded" : "success",
          footprintBefore: result.footprintBefore,
          footprintAfter: result.footprintAfter,
          footprintFields,
          budgetPolicy,
          reason: result.footprintAfter.reason,
          result: result.usedExistingCompaction
            ? "used_existing_compaction"
            : "created_or_refreshed_compaction",
        }),
      });
    } else if (orchestration.hasCompaction) {
      completeLatestSessionCompactionEvent(
        params.conversationId,
        result.compactionState!,
        params.mode,
      );
      setConversationCompactionStatus(
        params.conversationId,
        resolveCompactionStatusFromState(result.compactionState!),
      );
    } else if (orchestration.hadCompaction && params.mode !== "blocking") {
      clearLatestRunningSessionCompactionEvent(params.conversationId, params.mode);
      await deleteConversationCompactionState(params.conversationId);
    } else {
      clearLatestRunningSessionCompactionEvent(params.conversationId, params.mode);
      setConversationCompactionStatus(params.conversationId, statusBeforeNewCompaction);
    }

    if (result.degraded) {
      devLogger.info(
        `Context compaction degraded conversation=${params.conversationId} ratio=${result.footprintAfter.totalContextRatio.toFixed(3)} reason=${result.footprintAfter.reason}`,
      );
    }

    return result;
  };

  const maybeCompactConversationAfterModelSwitch = async (params: {
    conversationId: string;
    previousProviderId: string | null;
    previousModelId: string | null;
    nextProviderId: string | null;
    nextModelId: string | null;
  }): Promise<void> => {
    if (
      !params.conversationId ||
      !params.previousProviderId ||
      !params.previousModelId ||
      !params.nextProviderId ||
      !params.nextModelId
    ) {
      return;
    }
    const runtime = getConversationRuntimeSnapshot(
      get().conversationRuntimeById,
      params.conversationId,
    );
    if (isConversationRuntimeActive(runtime)) {
      return;
    }

    const providerState = useProviderStore.getState();
    const previousProvider = providerState.providerConfigs.find(
      (provider) => provider.id === params.previousProviderId,
    );
    const nextProvider = providerState.providerConfigs.find(
      (provider) => provider.id === params.nextProviderId,
    );
    if (!previousProvider || !nextProvider) {
      return;
    }

    const previousWindow = getSelectedModelContextWindowTokens(
      params.previousProviderId,
      params.previousModelId,
      previousProvider.providerType,
    );
    const nextWindow = getSelectedModelContextWindowTokens(
      params.nextProviderId,
      params.nextModelId,
      nextProvider.providerType,
    );
    if (nextWindow >= previousWindow) {
      return;
    }

    const previousStatus =
      get().conversationCompactionStatusById[params.conversationId] ?? null;
    try {
      await ensureMessagesLoadedForConversation(params.conversationId);
      await ensureToolsLoaded();
      const orderedMessages = getOrderedConversationMessages(params.conversationId);
      if (orderedMessages.length < 3) {
        return;
      }

      const taskStatus = orderedMessages
        .map((message) => message.task_id)
        .find(Boolean)
        ? useTaskStore
            .getState()
            .getTaskById(orderedMessages.find((message) => message.task_id)?.task_id ?? "")
            ?.status ?? null
        : null;
      const internalAgentProfile = resolveInternalAgentProfile({
        mode: useAppStore.getState().mode,
        taskStatus,
      });
      const allowedToolIds = await getAllowedToolIdsForCurrentMode(
        internalAgentProfile,
      );
      const preparedRequest = await prepareMessagesForRequest(
        params.conversationId,
        allowedToolIds,
        internalAgentProfile,
      );
      const { footprintFields } = getSelectedModelContext(
        params.nextProviderId,
        params.nextModelId,
        nextProvider.providerType,
      );
      const toolDefinitions = getToolDefinitionsForIds(allowedToolIds);
      const budgetPolicy = await loadContextBudgetPolicy();
      const preparedMessagesForContext = normalizeMessagesForProviderContext(
        nextProvider.providerType,
        preparedRequest.preparedMessages,
      );
      const footprint = estimateConversationFootprint({
        systemMessage: preparedRequest.systemMessage,
        preparedMessages: preparedMessagesForContext,
        orderedMessages: preparedRequest.orderedMessages,
        citations: preparedRequest.citations,
        toolDefinitions,
        ...footprintFields,
        estimateSerializedPayloadTokens: (messages) =>
          estimateSerializedPayloadTokensForProvider({
            messages,
            providerType: nextProvider.providerType,
            providerId: params.nextProviderId!,
            baseUrl: nextProvider.baseUrl,
            modelId: params.nextModelId!,
          }),
        countProviderInputItems: shouldCountProviderInputItemsForContext(
          nextProvider.providerType,
        ),
        mode: "model_switch",
        budgetPolicy,
      });
      if (!isContextFootprintOverUsableBudget(footprint)) {
        return;
      }

      if (budgetPolicy.auto === false) {
        setConversationCompactionStatus(params.conversationId, {
          ...previousStatus,
          phase: "needs_manual_compaction",
          updatedAt: new Date().toISOString(),
          reason: "manual_compaction_required",
          kind: "model_switch",
          footprintAfter: {
            ...footprint,
            reason: "manual_compaction_required",
          },
        });
        await recordConversationCompactionEvent({
          conversationId: params.conversationId,
          trigger: "model_switch",
          providerId: params.nextProviderId,
          modelId: params.nextModelId,
          modelContextWindowTokens: footprint.modelContextWindowTokens,
          tokensBefore: footprint.totalEstimatedTokens,
          tokensAfter: footprint.totalEstimatedTokens,
          status: "skipped",
          reason: "manual_compaction_required",
          metadata: buildCompactionDecisionAuditMetadata({
            providerId: params.nextProviderId,
            providerType: nextProvider.providerType,
            modelId: params.nextModelId,
            trigger: "model_switch",
            status: "skipped",
            footprintAfter: {
              ...footprint,
              reason: "manual_compaction_required",
            },
            footprintFields,
            budgetPolicy,
            reason: "manual_compaction_required",
            result: "auto_compaction_disabled",
          }),
        });
        void refreshConversationContextDiagnostics(params.conversationId, {
          mode: "full",
          providerContext: {
            providerId: params.nextProviderId,
            providerType: nextProvider.providerType,
            baseUrl: nextProvider.baseUrl ?? "",
            modelId: params.nextModelId,
          },
        });
        return;
      }

      const resolvedApiKey =
        nextProvider.isLocal || providerHasAuthSession(nextProvider)
          ? nextProvider.apiKey
          : await providerState.resolveProviderApiKey(params.nextProviderId);
      const providerConfigForUse = {
        ...nextProvider,
        apiKey: resolvedApiKey,
        apiKeyLoaded: nextProvider.apiKeyLoaded || resolvedApiKey !== undefined,
      };

      setConversationCompactionStatus(params.conversationId, {
        ...previousStatus,
        phase: "model_switch_compacting",
        updatedAt: new Date().toISOString(),
        reason: "model_window_shrank",
        kind: "model_switch",
        footprintAfter: footprint,
      });
      await compactConversationMessages({
        conversationId: params.conversationId,
        providerId: params.nextProviderId,
        modelId: params.nextModelId,
        reasoningEffort: providerState.selectedReasoningEffort,
        providerConfig: providerConfigForUse,
        allowedToolIds,
        systemMessage: preparedRequest.systemMessage,
        preparedMessages: preparedRequest.preparedMessages,
        orderedMessages: preparedRequest.orderedMessages,
        citations: preparedRequest.citations,
        mode: "model_switch",
        forceCompaction: true,
        forcePrune: true,
        displayAfterMessageId:
          preparedRequest.orderedMessages.at(-1)?.id ?? null,
      });
      void refreshConversationContextDiagnostics(params.conversationId, {
        mode: "full",
        providerContext: {
          providerId: params.nextProviderId,
          providerType: nextProvider.providerType,
          baseUrl: nextProvider.baseUrl ?? "",
          modelId: params.nextModelId,
        },
      });
    } catch (error) {
      const normalized = toServiceError(error);
      setConversationCompactionStatus(params.conversationId, previousStatus);
      set({ lastError: normalized.message });
    }
  };

  const ensureToolsLoaded = async (): Promise<void> => {
    const toolsState = useToolsStore.getState();
    if (Object.keys(toolsState.internalTools).length > 0) return;
    await toolsState.loadSettings();
  };

  const getModePolicyForCurrentMode = async (
    modeOverride?: AppMode,
  ): Promise<{
    allowedToolIds: string[];
    enforceMacroOnlyWrites: boolean;
  }> => {
    const mode = modeOverride ?? useAppStore.getState().mode;
    const adjustAllowedToolIds = (allowedToolIds: string[]): string[] =>
      mode === "Architect"
        ? getArchitectProfileAdjustedToolIds(allowedToolIds)
        : allowedToolIds;

    if (tauriIpc.isTauriAvailable()) {
      try {
        const backendPolicy = await tauriIpc.getToolModePolicy(mode);
        return {
          allowedToolIds: adjustAllowedToolIds(backendPolicy.allowed_tool_ids),
          enforceMacroOnlyWrites: backendPolicy.enforce_macro_only_writes,
        };
      } catch (error) {
        console.warn(
          "Failed to load backend tool policy, using local fallback:",
          error,
        );
      }
    }

    if (canUseRemoteKernel()) {
      try {
        const backendPolicy = await getRemoteToolModePolicy(mode);
        return {
          allowedToolIds: adjustAllowedToolIds(backendPolicy.allowed_tool_ids),
          enforceMacroOnlyWrites: backendPolicy.enforce_macro_only_writes,
        };
      } catch (error) {
        console.warn(
          "Failed to load remote backend tool policy, using local fallback:",
          error,
        );
      }
    }

    const fallback = getLocalToolModePolicy(mode);
    return {
      allowedToolIds: adjustAllowedToolIds(fallback.allowedToolIds),
      enforceMacroOnlyWrites: fallback.enforceMacroOnlyWrites,
    };
  };

  const isSourceToolEnabled = async (
    toolId: string,
    modeOverride?: AppMode,
    agentTypeOverride?: AgentType | null,
  ): Promise<boolean> => {
    const mode = modeOverride ?? useAppStore.getState().mode;
    const toolsState = useToolsStore.getState();
    if (isMCPToolId(toolId)) {
      if (
        mode === "Implement" &&
        agentTypeOverride === "plan" &&
        !isToolAllowedForImplementAgent("plan", toolId)
      ) {
        return false;
      }
      return toolsState.getEnabledMCPToolIds().includes(toolId);
    }

    const modePolicy = await getModePolicyForCurrentMode(mode);
    if (!modePolicy.allowedToolIds.includes(toolId)) {
      return false;
    }
    if (
      mode === "Implement" &&
      agentTypeOverride === "plan" &&
      !isToolAllowedForImplementAgent("plan", toolId)
    ) {
      return false;
    }

    if (mode === "Chat") {
      return toolsState.isChatToolEnabled(toolId);
    }

    return toolsState.isToolEnabled(toolId);
  };

  const normalizeContextLookup = (value?: string): string =>
    (value || "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

  const getCitationBody = (citation: Citation): string =>
    (citation.content || citation.snippet || "").trim();

  const normalizeSourcePassageText = (value: string): string =>
    value.replace(/\s+/g, " ").trim();

  const citationContainsSourcePassage = (
    citation: Citation,
    normalizedPassage: string,
  ): boolean =>
    [citation.content, citation.snippet]
      .filter((value): value is string => typeof value === "string")
      .some((value) =>
        normalizeSourcePassageText(value).includes(normalizedPassage),
      );

  const isSourcePassagePresentInConversationContext = async (
    conversationId: string,
    passage: string,
  ): Promise<boolean> => {
    const normalizedPassage = normalizeSourcePassageText(passage);
    if (!normalizedPassage) return false;
    const citationsState = useCitationsStore.getState();
    const contextCitations =
      citationsState.getConversationContextCitations(conversationId);
    if (
      contextCitations.some((citation) =>
        citationContainsSourcePassage(citation, normalizedPassage),
      )
    ) {
      return true;
    }

    for (const citation of contextCitations) {
      if (typeof citation.content === "string") continue;
      const loadedCitation =
        await useCitationsStore.getState().ensureCitationContentLoaded(citation.id);
      if (
        loadedCitation &&
        citationContainsSourcePassage(loadedCitation, normalizedPassage)
      ) {
        return true;
      }
    }

    return false;
  };

  const truncateInjectedContextSnippet = (value: string): string => {
    const limit = 4000;
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  };

  const isFileContextRef = (
    ref: ContextReference | PersistedContextReference,
  ): ref is (ContextReference | PersistedContextReference) & { kind: "file" } =>
    ref.kind === "file";

  const getFileRefPath = (
    ref: (ContextReference | PersistedContextReference) & { kind: "file" },
  ): string => {
    if ("path" in ref && ref.path) return ref.path;
    if ("data" in ref && "path" in ref.data && ref.data.path) return ref.data.path;
    return ref.title;
  };

  const getFileRefRelativePath = (
    ref: (ContextReference | PersistedContextReference) & { kind: "file" },
  ): string => {
    if ("relativePath" in ref && ref.relativePath) return ref.relativePath;
    if ("data" in ref && "relativePath" in ref.data && ref.data.relativePath) {
      return ref.data.relativePath;
    }
    return getFileRefPath(ref);
  };

  const getFileRefProjectId = (
    ref: (ContextReference | PersistedContextReference) & { kind: "file" },
  ): string | null => {
    if ("projectId" in ref && ref.projectId) return ref.projectId;
    if ("data" in ref && "projectId" in ref.data && ref.data.projectId) {
      return ref.data.projectId;
    }
    return null;
  };

  const getConversationFileRefs = (
    conversationId: string,
  ): Array<(ContextReference | PersistedContextReference) & { kind: "file" }> => {
    const messageRefs = getOrderedConversationMessages(conversationId)
      .flatMap((message) => message.context_refs ?? [])
      .filter(isFileContextRef);
    const composerRefs = get().composerContextRefs.filter(
      (ref): ref is ContextReference & { kind: "file" } => ref.kind === "file",
    );
    const seen = new Set<string>();
    return [...messageRefs, ...composerRefs].filter((ref) => {
      const key = `${ref.id}:${getFileRefPath(ref)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const findFileRefForRequest = (
    refs: Array<(ContextReference | PersistedContextReference) & { kind: "file" }>,
    requested: string,
  ) =>
    refs.find((ref) => {
      const title = normalizeContextLookup(ref.title);
      const path = normalizeContextLookup(getFileRefPath(ref));
      const relativePath = normalizeContextLookup(getFileRefRelativePath(ref));
      return (
        requested === title ||
        requested === path ||
        requested === relativePath ||
        title.includes(requested) ||
        path.includes(requested) ||
        relativePath.includes(requested)
      );
    }) ?? null;

  const readWorkspaceFileRef = async (
    conversationId: string,
    ref: (ContextReference | PersistedContextReference) & { kind: "file" },
  ): Promise<string> => {
    const executionContext = resolveConversationExecutionContext(conversationId);
    const projectId = getFileRefProjectId(ref);
    const workspacePath =
      (projectId ? executionContext.workspacePathsByProjectId[projectId] : null) ||
      executionContext.workspacePath;
    if (!workspacePath) {
      return `File not available: Macro has no workspace path for "${getFileRefPath(ref)}".`;
    }

    const readPath = getFileRefRelativePath(ref);
    try {
      const result = await tauriIpc.fsReadFileWithOptions({
        path: readPath,
        workspacePath,
        allowOutsideWorkspace: false,
      });
      if (result.is_binary) {
        return `FILE: ${getFileRefPath(ref)}\nSOURCE: WORKSPACE\n\nBinary file (${result.size} bytes, encoding=${result.encoding}).`;
      }
      // Record the read content on the conversation's context citation so
      // mark_source_passage provenance validation can match passages from
      // workspace files (addCitation dedupes file citations by path).
      useCitationsStore.getState().addCitation({
        type: "file",
        scope: "context",
        source: getFileRefPath(ref),
        title: ref.title || getFileRefPath(ref),
        path: getFileRefPath(ref),
        content: result.content,
        messageId: `workspace-read-${Date.now()}`,
        conversationId,
      });
      return `FILE: ${getFileRefPath(ref)}\nSOURCE: WORKSPACE\nLANGUAGE: ${result.language}\n\n${result.content}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `File not available: failed to read "${getFileRefPath(ref)}" from workspace. ${message}`;
    }
  };

  const readConversationFileContext = async (
    conversationId: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const requestedRaw = typeof args.file === "string" ? args.file.trim() : "";
    const requested = normalizeContextLookup(requestedRaw);
    const extractText = args.extract_text === true;
    const fileCitations = useCitationsStore
      .getState()
      .getConversationContextCitations(conversationId)
      .filter((citation) => citation.type === "file" || citation.type === "document");
    const fileRefs = getConversationFileRefs(conversationId);
    const available = [
      ...fileCitations
      .map((citation) => citation.path || citation.title || citation.source)
        .filter(Boolean),
      ...fileRefs.map(getFileRefPath),
    ];

    if (!requested) {
      return `No file provided. Available files: ${available.join(", ") || "none"}`;
    }

    const match = fileCitations.find((citation) => {
      const title = normalizeContextLookup(citation.title);
      const source = normalizeContextLookup(citation.source);
      const path = normalizeContextLookup(citation.path);
      return (
        requested === title ||
        requested === source ||
        requested === path ||
        title.includes(requested) ||
        source.includes(requested) ||
        path.includes(requested)
      );
    });

    const matchedFileRef = findFileRefForRequest(fileRefs, requested);

    if (!match && !matchedFileRef) {
      return `File not found in context: "${requestedRaw}". Available files: ${
        available.join(", ") || "none"
      }`;
    }

    const hydratedMatch = match
      ? await useCitationsStore.getState().ensureCitationContentLoaded(match.id)
      : null;
    const matchForRead = hydratedMatch ?? match;
    const matchedCitationHasContent = Boolean(matchForRead?.content?.trim());
    if (matchedFileRef && !matchedCitationHasContent) {
      return readWorkspaceFileRef(conversationId, matchedFileRef);
    }

    if (!matchForRead) {
      return `File not found in context: "${requestedRaw}". Available files: ${
        available.join(", ") || "none"
      }`;
    }

    const label = matchForRead.path || matchForRead.title || matchForRead.source;
    const content = getCitationBody(matchForRead);
    const base = content
      ? `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\n${content}`
      : `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\nNo textual content available for this file in context.`;
    const extractNotice =
      extractText && /\.docx$/i.test(label || "")
        ? "\n\nNote: extract_text=true requested. Rich DOCX extraction is not available in this build; using available context text."
        : "";

    return `${base}${extractNotice}`;
  };

  const normalizeSourcePassageKind = (value: unknown): SourcePassageKind | undefined =>
    value === "interesting" || value === "used" ? value : undefined;

  const readConversationSources = async (
    conversationId: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const rawKind = typeof args.kind === "string" ? args.kind : "all";
    const kind = rawKind === "interesting" || rawKind === "used" ? rawKind : "all";
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(50, Math.max(1, Math.floor(args.limit)))
        : 50;
    const includeSnippet = args.include_snippet !== false;
    let citations = useCitationsStore
      .getState()
      .getConversationSourceCitations(conversationId)
      .filter((citation) => {
        const citationKind = citation.kind || "used";
        if (kind !== "all" && citationKind !== kind) return false;
        if (!query) return true;
        return [
          citation.id,
          citation.title,
          citation.source,
          citation.url,
          citation.reason,
          citation.snippet,
          citation.content,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      })
      .slice(0, limit);

    if (includeSnippet) {
      citations = (
        await Promise.all(
          citations.map((citation) =>
            useCitationsStore
              .getState()
              .ensureCitationContentLoaded(citation.id),
          ),
        )
      ).filter((citation): citation is Citation => Boolean(citation));
    }

    if (citations.length === 0) {
      return "No source passages available.";
    }

    return [
      "Saved source passages:",
      ...citations.map((citation, index) => {
        const lines = [
          `[${index + 1}] citation_id=${citation.id}`,
          `Title: ${citation.title}`,
          `Kind: ${citation.kind || "used"}`,
          `Source: ${citation.source}`,
        ];
        if (citation.url) lines.push(`URL: ${citation.url}`);
        if (citation.reason) lines.push(`Reason: ${citation.reason}`);
        if (includeSnippet) lines.push(`Passage: ${getCitationBody(citation)}`);
        return lines.join("\n");
      }),
    ].join("\n\n");
  };

  const editConversationSource = (
    conversationId: string,
    args: Record<string, unknown>,
  ): string => {
    const citationId = typeof args.citation_id === "string" ? args.citation_id.trim() : "";
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (!citationId) return "Missing citation_id for edit_source_passage.";
    if (!["update", "reclassify", "delete"].includes(action)) {
      return 'Missing or invalid action for edit_source_passage. Use "update", "reclassify", or "delete".';
    }

    const citationsState = useCitationsStore.getState();
    const existing = citationsState
      .getConversationSourceCitations(conversationId)
      .find((citation) => citation.id === citationId);
    if (!existing) {
      return `Source passage not found: ${citationId}`;
    }

    if (action === "delete") {
      citationsState.removeCitation(citationId);
      return `Source passage deleted (citation_id=${citationId}).`;
    }

    const kind = normalizeSourcePassageKind(args.kind);
    if (action === "reclassify" && !kind) {
      return 'Missing kind for action="reclassify". Use "interesting" or "used".';
    }

    const updated = citationsState.updateSourcePassage({
      conversationId,
      citationId,
      title: typeof args.title === "string" ? args.title : undefined,
      passage: typeof args.passage === "string" ? args.passage : undefined,
      source: typeof args.source === "string" ? args.source : undefined,
      url: typeof args.url === "string" ? args.url : undefined,
      kind,
      reason:
        "reason" in args
          ? typeof args.reason === "string"
            ? args.reason
            : null
          : undefined,
    });

    return updated
      ? `Source passage updated (citation_id=${citationId}).`
      : `Source passage update failed (citation_id=${citationId}).`;
  };

  const handleTaskTodoToolCall = async (
    conversationId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string | undefined> => {
    if (toolName !== "task_todo_get" && toolName !== "task_todo_update") {
      return undefined;
    }

    const taskState = useTaskStore.getState();
    const executionContext = resolveConversationExecutionContext(conversationId);
    const selectedTaskId = useAppStore.getState().selectedTaskId;
    const currentTask = resolveConversationImplementTask(
      conversationId,
      executionContext,
      selectedTaskId,
    );
    if (isStandaloneImplementTask(currentTask)) {
      return formatStandaloneArchitectToolUnavailable(toolName);
    }

    const target = await resolveTaskTodoTarget({
      args,
      executionContext,
      selectedTaskId,
      tasks: taskState.tasks,
      getArchitectPlan,
      mutating: toolName === "task_todo_update",
    });
    if (toolName === "task_todo_get") {
      return formatTaskTodoResult("task_todo_get", target);
    }

    const nextTodos = applyTaskTodoOperations(target.node.todos, args.operations);
    const nextNodes = (target.plan.nodes || []).map((node) =>
      node.id === target.node.id ? { ...node, todos: nextTodos } : node,
    );
    await updateArchitectPlan({
      branchName: target.branchName,
      planId: target.plan.id,
      nodes: nextNodes,
      setActive: false,
    });

    const appState = useAppStore.getState();
    if (appState.activeArchitectPlanId === target.plan.id) {
      appState.setPlanNodes(nextNodes);
    }
    await useTaskStore.getState().refreshFromPlan();

    const updatedTarget = await resolveTaskTodoTarget({
      args: { task_id: target.task.id },
      executionContext: resolveConversationExecutionContext(conversationId),
      selectedTaskId: useAppStore.getState().selectedTaskId,
      tasks: useTaskStore.getState().tasks,
      getArchitectPlan,
    });
    return formatTaskTodoResult("task_todo_update", updatedTarget);
  };

  const handleTaskArtifactToolCall = async (
    conversationId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string | undefined> => {
    if (
      toolName !== "task_artifact_list" &&
      toolName !== "task_artifact_get" &&
      toolName !== "task_artifact_put"
    ) {
      return undefined;
    }

    const taskState = useTaskStore.getState();
    const executionContext = resolveConversationExecutionContext(conversationId);
    const selectedTaskId = useAppStore.getState().selectedTaskId;
    const currentTask = resolveConversationImplementTask(
      conversationId,
      executionContext,
      selectedTaskId,
    );
    if (isStandaloneImplementTask(currentTask)) {
      return formatStandaloneArchitectToolUnavailable(toolName);
    }

    const target = await resolveTaskArtifactTarget({
      args,
      executionContext,
      selectedTaskId,
      tasks: taskState.tasks,
      getArchitectPlan,
      mutating: toolName === "task_artifact_put",
    });

    if (toolName === "task_artifact_list") {
      return formatTaskArtifactListResult(target, args);
    }
    if (toolName === "task_artifact_get") {
      return formatTaskArtifactGetResult(target, args);
    }

    const artifact = await putTaskArtifact({ target, args });
    return formatTaskArtifactPutResult(artifact);
  };

  const getLoadedAgentCodeCheckpoints = async (
    conversationId: string,
  ): Promise<AgentCodeCheckpoint[]> => {
    const cached = get().agentCodeCheckpointsByConversationId[conversationId];
    if (deletedConversationIds.has(conversationId)) {
      return [];
    }
    if (cached) {
      return cached;
    }

    const existingPromise =
      agentCodeCheckpointLoadPromisesByConversationId.get(conversationId);
    if (existingPromise) {
      return existingPromise;
    }

    const loadPromise = loadAgentCodeCheckpoints(conversationId);
    agentCodeCheckpointLoadPromisesByConversationId.set(
      conversationId,
      loadPromise,
    );
    try {
      const checkpoints = await loadPromise;
      if (deletedConversationIds.has(conversationId)) {
        return [];
      }
      set((state) => ({
        agentCodeCheckpointsByConversationId: {
          ...state.agentCodeCheckpointsByConversationId,
          [conversationId]: checkpoints,
        },
      }));
      return checkpoints;
    } finally {
      agentCodeCheckpointLoadPromisesByConversationId.delete(conversationId);
    }
  };

  const serializeAgentCodeCheckpointMutation = async <T>(
    conversationId: string,
    mutate: () => Promise<T>,
  ): Promise<T> => {
    const previous =
      checkpointMutationQueuesByConversationId.get(conversationId) ??
      Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => slot);
    checkpointMutationQueuesByConversationId.set(conversationId, queued);
    await previous.catch(() => undefined);
    try {
      return await mutate();
    } finally {
      release();
      if (checkpointMutationQueuesByConversationId.get(conversationId) === queued) {
        checkpointMutationQueuesByConversationId.delete(conversationId);
      }
    }
  };

  const persistAgentCodeCheckpointsForConversation = async (
    conversationId: string,
    checkpoints: AgentCodeCheckpoint[],
  ): Promise<void> => {
    if (deletedConversationIds.has(conversationId)) {
      return;
    }
    set((state) => ({
      agentCodeCheckpointsByConversationId: {
        ...state.agentCodeCheckpointsByConversationId,
        [conversationId]: checkpoints,
      },
    }));
    if (deletedConversationIds.has(conversationId)) {
      set((state) => {
        const next = { ...state.agentCodeCheckpointsByConversationId };
        delete next[conversationId];
        return { agentCodeCheckpointsByConversationId: next };
      });
      return;
    }
    await saveAgentCodeCheckpoints(conversationId, checkpoints);
    if (deletedConversationIds.has(conversationId)) {
      set((state) => {
        const next = { ...state.agentCodeCheckpointsByConversationId };
        delete next[conversationId];
        return { agentCodeCheckpointsByConversationId: next };
      });
    }
  };

  const recordAgentCodeCheckpoint = async (params: {
    conversationId: string;
    turnId?: string | null;
    assistantMessageId: string;
    toolCallId?: string;
    toolName: string;
    files: AgentCodeCheckpointFile[];
  }): Promise<void> => {
    if (params.files.length === 0) {
      return;
    }

    if (deletedConversationIds.has(params.conversationId)) {
      return;
    }

    await serializeAgentCodeCheckpointMutation(params.conversationId, async () => {
      const existing = await getLoadedAgentCodeCheckpoints(params.conversationId);
      if (deletedConversationIds.has(params.conversationId)) {
        return;
      }
      const checkpoint = createAgentCodeCheckpoint(existing, params);
      await persistAgentCodeCheckpointsForConversation(
        params.conversationId,
        appendAgentCodeCheckpoint(existing, checkpoint),
      );
    });
  };

  const shouldChallengeGitStageCommitToolCall = (
    conversationId: string,
    assistantTurnId: string | null,
    assistantMessageId: string,
    toolName: string,
  ): boolean => {
    if (!GIT_STAGE_COMMIT_CHALLENGE_TOOL_IDS.has(toolName)) {
      return false;
    }

    const turnKey = assistantTurnId || assistantMessageId;
    const challengeKey = `${conversationId}::${turnKey}::${toolName}`;
    if (gitStageCommitChallengesByAssistantTurn.has(challengeKey)) {
      return false;
    }

    gitStageCommitChallengesByAssistantTurn.add(challengeKey);
    return true;
  };

  const rememberAssistantTurnContext = (
    assistantMessageId: string,
    conversationId: string,
    mode: AppMode,
    agentType: AgentType | null,
  ) => {
    assistantTurnContextByMessageId.set(assistantMessageId, {
      conversationId,
      mode,
      agentType,
    });
  };

  const handleToolCall = async (
    operation: FrozenToolCallContext,
    toolName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<ToolCallResolution | string | void> => {
    const {
      conversationId,
      assistantMessageId,
      mode: modeAtSend,
      agentType: agentTypeAtSend,
      taskId: taskIdAtSend,
      signal,
    } = operation;
    const isCurrentOperation = () => {
      const runtime = getConversationRuntimeSnapshot(
        get().conversationRuntimeById,
        conversationId,
      );
      return !signal.aborted &&
        runtime.sessionId === operation.sessionId &&
        runtime.turnId === operation.turnId &&
        runtime.assistantMessageId === assistantMessageId &&
        runtime.phase === "streaming";
    };
    if (!isCurrentOperation()) {
      return TOOL_EXECUTION_ABORTED_RESULT;
    }
    const normalizedToolName = normalizeArchitectToolId(toolName);
    const assistantTurnId = operation.turnId;

    if (
      modeAtSend === "Implement" &&
      agentTypeAtSend === "plan" &&
      !isToolAllowedForImplementAgent("plan", normalizedToolName)
    ) {
      if (toolCallId) {
        updateAssistantToolTraceStatus(
          assistantMessageId,
          toolCallId,
          "denied",
        );
      }
      return IMPLEMENT_PLAN_TOOL_DENIAL_MESSAGE;
    }

    if (
      !(await isSourceToolEnabled(
        normalizedToolName,
        modeAtSend,
        agentTypeAtSend,
      ))
    ) {
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      return `Tool ${normalizedToolName} is disabled for the current mode.`;
    }

    let executionContext = operation.executionContext;
    const riskLevel = await loadToolRiskLevelPreference();
    if (!isCurrentOperation()) {
      return TOOL_EXECUTION_ABORTED_RESULT;
    }
    const securityEvaluation = evaluateToolSecurity(normalizedToolName, args, {
      mode: modeAtSend,
      riskLevel,
      workspacePath: executionContext.workspacePath,
      defaultWorkspacePath: executionContext.defaultWorkspacePath,
      projectMounts: executionContext.projectMounts,
      grants:
        get().conversationApprovalGrantsByConversationId[conversationId] ?? [],
    });

    if (securityEvaluation.decision === "deny") {
      if (toolCallId) {
        updateAssistantToolTraceStatus(
          assistantMessageId,
          toolCallId,
          "denied",
        );
      }
      return securityEvaluation.denialReason;
    }

    if (
      shouldChallengeGitStageCommitToolCall(
        conversationId,
        assistantTurnId,
        assistantMessageId,
        normalizedToolName,
      )
    ) {
      if (toolCallId) {
        updateAssistantToolTraceStatus(
          assistantMessageId,
          toolCallId,
          "denied",
        );
      }
      return GIT_STAGE_COMMIT_CHALLENGE_MESSAGE;
    }

    if (securityEvaluation.decision === "ask") {
      const resolvedToolCallId =
        toolCallId ??
        `${normalizedToolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pendingApproval: PendingToolApproval = {
        conversationId,
        assistantMessageId,
        toolCallId: resolvedToolCallId,
        toolId: normalizedToolName,
        actionGroup: securityEvaluation.normalizedCall.actionGroup,
        riskLevel,
        isDestructive: securityEvaluation.normalizedCall.isDestructive,
        summary: securityEvaluation.normalizedCall.summary,
        detail: securityEvaluation.normalizedCall.detail,
        args,
        rememberKey: securityEvaluation.normalizedCall.rememberKey,
      };

      const resolution = await serializeToolApproval(
        conversationId,
        () => {
          if (!isCurrentOperation()) {
            return Promise.resolve<PendingToolApprovalResolution>({ kind: "deny" });
          }
          return new Promise<PendingToolApprovalResolution>((resolve) => {
          pendingToolApprovalResolvers.set(
            getPendingToolApprovalResolverKey(conversationId, resolvedToolCallId),
            resolve,
          );
          set((state) => ({
            pendingToolApprovalByConversationId: {
              ...state.pendingToolApprovalByConversationId,
              [conversationId]: pendingApproval,
            },
          }));
          if (toolCallId) {
            updateAssistantToolTraceStatus(
              assistantMessageId,
              resolvedToolCallId,
              "pending_approval",
            );
          }
          });
        },
      );

      pendingToolApprovalResolvers.delete(
        getPendingToolApprovalResolverKey(conversationId, resolvedToolCallId),
      );
      set((state) => {
        if (!state.pendingToolApprovalByConversationId[conversationId]) {
          return state;
        }
        const nextPendingApprovals = {
          ...state.pendingToolApprovalByConversationId,
        };
        delete nextPendingApprovals[conversationId];
        return {
          pendingToolApprovalByConversationId: nextPendingApprovals,
        };
      });

      if (resolution.kind === "deny") {
        if (toolCallId) {
          updateAssistantToolTraceStatus(
            assistantMessageId,
            resolvedToolCallId,
            "denied",
          );
        }
        const denialPrefix = `Tool ${normalizedToolName} was denied by the user.`;
        return resolution.reason?.trim()
          ? `${denialPrefix} User reason: ${resolution.reason.trim()}`
          : denialPrefix;
      }

      if (!isCurrentOperation()) {
        if (toolCallId) {
          updateAssistantToolTraceStatus(
            assistantMessageId,
            resolvedToolCallId,
            "denied",
          );
        }
        return TOOL_EXECUTION_ABORTED_RESULT;
      }

      if (resolution.kind === "allow_conversation") {
        set((state) => {
          const currentGrants =
            state.conversationApprovalGrantsByConversationId[conversationId] ??
            [];
          if (
            currentGrants.some(
              (grant) =>
                grant.toolId === pendingApproval.toolId &&
                grant.rememberKey === pendingApproval.rememberKey,
            )
          ) {
            return state;
          }
          return {
            conversationApprovalGrantsByConversationId: {
              ...state.conversationApprovalGrantsByConversationId,
              [conversationId]: [
                ...currentGrants,
                {
                  toolId: pendingApproval.toolId,
                  rememberKey: pendingApproval.rememberKey,
                  createdAt: new Date().toISOString(),
                },
              ],
            },
          };
        });
      }

      if (toolCallId) {
        updateAssistantToolTraceStatus(
          assistantMessageId,
          resolvedToolCallId,
          "running",
        );
      }
    }

    if (normalizedToolName === "question") {
      const questionnaire = validateQuestionToolArgs(args);
      return {
        kind: "interrupt",
        result: `Questionnaire queued for the user with ${questionnaire.questions.length} question(s).`,
        visibleContent: questionnaire.intro || DEFAULT_QUESTIONNAIRE_INTRO,
        hiddenContext: buildQuestionnaireHiddenContextBlock(questionnaire),
      };
    }

    if (normalizedToolName === "web_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return "Missing query for web_search.";
      const { enableWebSearch, webSearchOptions } = getStreamingWebSearchConfig();
      if (
        !enableWebSearch ||
        (!webSearchOptions?.tavilyApiKey && !webSearchOptions?.braveApiKey)
      ) {
        return "Web search is not configured for this provider.";
      }
      const results = await webSearch(query, webSearchOptions);
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      if (results.length > 0) {
        useCitationsStore
          .getState()
          .addWebCitations(results, assistantMessageId, conversationId);
      }
      return formatSearchResultsAsContext(results);
    }

    if (normalizedToolName === "web_fetch") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return "Missing URL for web_fetch.";
      const { enableWebFetch } = getStreamingWebSearchConfig();
      if (!enableWebFetch) {
        return "Web fetch is disabled for this provider.";
      }
      const fetched = await fetchWebPage(url);
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      useCitationsStore.getState().addCitation({
        type: "web",
        scope: "context",
        source: fetched.url,
        title: fetched.title,
        snippet: fetched.snippet,
        content: fetched.content,
        url: fetched.url,
        favicon: fetched.favicon,
        messageId: assistantMessageId,
        conversationId,
      });
      return `TITLE: ${fetched.title}\nURL: ${fetched.url}\n\n${fetched.content}`;
    }

    if (normalizedToolName === "read_file") {
      return readConversationFileContext(conversationId, args);
    }

    const skillToolResult = await handleSkillToolCall(
      normalizedToolName,
      args,
      conversationId,
    );
    if (!isCurrentOperation()) {
      return TOOL_EXECUTION_ABORTED_RESULT;
    }
    if (skillToolResult !== undefined) {
      return skillToolResult;
    }

    if (isMCPToolId(normalizedToolName)) {
      const result = await useToolsStore.getState().callMCPTool(normalizedToolName, args);
      return isCurrentOperation() ? result : TOOL_EXECUTION_ABORTED_RESULT;
    }

    if (normalizedToolName === "mark_source_passage") {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const passage = typeof args.passage === "string" ? args.passage.trim() : "";
      if (!title || !passage) {
        return "Missing title or passage for mark_source_passage.";
      }
      if (!(await isSourcePassagePresentInConversationContext(conversationId, passage))) {
        return "Error executing tool mark_source_passage: passage is not present in any read source content.";
      }
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      const kind = normalizeSourcePassageKind(args.kind) || "used";
      const citationId = useCitationsStore.getState().addSourcePassage({
        conversationId,
        messageId: assistantMessageId,
        title,
        passage,
        source: typeof args.source === "string" ? args.source : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
        kind,
        reason: typeof args.reason === "string" ? args.reason : undefined,
      });
      return `Source passage marked successfully (citation_id=${citationId}, kind=${kind}).`;
    }

    if (normalizedToolName === "read_sources") {
      return await readConversationSources(conversationId, args);
    }

    if (normalizedToolName === "edit_source_passage") {
      return editConversationSource(conversationId, args);
    }

    const taskTodoToolResult = await handleTaskTodoToolCall(
      conversationId,
      normalizedToolName,
      args,
    );
    if (taskTodoToolResult !== undefined) {
      return taskTodoToolResult;
    }

    const taskArtifactToolResult = await handleTaskArtifactToolCall(
      conversationId,
      normalizedToolName,
      args,
    );
    if (taskArtifactToolResult !== undefined) {
      return taskArtifactToolResult;
    }

    const architectToolResult = await handleArchitectToolCall({
      assistantMessageId,
      toolName: normalizedToolName,
      args,
      planService: {
        createArchitectPlan,
        getArchitectPlan,
        getGitFlowBaseBranch,
        isArchitectPlanSlugAvailable,
        isArchitectPlanSlugMutable,
        listArchitectPlans,
        resolvePlanProjectContextId,
        resolveTargetBranch,
        updateArchitectPlan,
      },
      strategyService: {
        prepareStrategyMutationPreview,
        applyStrategyMutationPreview,
        guardDeps: {
          getArchitectPlan,
          updateArchitectPlan,
          provisionPlanBranches,
        },
      },
      getAppState: () => useAppStore.getState(),
      getTaskState: () => useTaskStore.getState(),
      ensureArchitectConversationForPlan: get().ensureArchitectConversationForPlan,
    }).catch((error) => {
      if (!isArchitectPlanReplicaDivergenceError(error)) {
        throw error;
      }

      return [
        `Plan metadata replica issue for plan ${error.divergence.planId}: ${error.message}`,
        '',
        'Structured context:',
        JSON.stringify(
          {
            error: 'architect_plan_replica_divergence',
            plan_id: error.divergence.planId,
            branch_name: error.divergence.branchName,
            reason: error.divergence.reason,
            repair_action: 'repair_metadata',
            replicas: error.divergence.replicas,
          },
          null,
          2
        ),
      ].join('\n');
    });

    if (architectToolResult !== undefined) {
      return architectToolResult;
    }

    if (
      normalizedToolName === "list" ||
      normalizedToolName === "read" ||
      normalizedToolName === "write" ||
      normalizedToolName === "edit" ||
      normalizedToolName === "delete" ||
      normalizedToolName === "glob" ||
      normalizedToolName === "grep" ||
      normalizedToolName === "terminal_create_session" ||
      normalizedToolName === "terminal_run" ||
      normalizedToolName === "terminal_read" ||
      normalizedToolName === "terminal_kill" ||
      normalizedToolName.startsWith("git_")
    ) {
      const mode = modeAtSend;
      let promotedProjectIdsForTool: string[] = [];

      if (mode === "Implement") {
        const promotionRequest = resolveContextPromotionRequest({
          conversationId,
          executionContext,
          selectedTaskId: taskIdAtSend,
          toolName: normalizedToolName,
          args,
        });

        if (promotionRequest.unavailableResult) {
          return promotionRequest.unavailableResult;
        }

        if (promotionRequest.task && promotionRequest.projectIds.length > 0) {
          const promotion = await useTaskStore
            .getState()
            .promoteTaskContextProjects(promotionRequest.task.id, promotionRequest.projectIds, {
              triggerTool: normalizedToolName,
            });
          promotedProjectIdsForTool = promotion?.promotedProjectIds || [];
          // The promotion result is the only permitted scope change during an
          // operation. Derive it from the frozen snapshot, never from the
          // current project selection.
          executionContext = {
            ...operation.executionContext,
            actionableProjectIds: Array.from(
              new Set([
                ...operation.executionContext.actionableProjectIds,
                ...promotedProjectIdsForTool,
              ]),
            ),
            contextProjectIds: operation.executionContext.contextProjectIds.filter(
              (projectId) => !promotedProjectIdsForTool.includes(projectId),
            ),
            projectMounts: operation.executionContext.projectMounts.map(
              (mount) =>
                promotedProjectIdsForTool.includes(mount.projectId)
                  ? { ...mount, isReadOnly: false }
                  : mount,
            ),
          };
          if (!isCurrentOperation()) {
            return TOOL_EXECUTION_ABORTED_RESULT;
          }
        }
      }

      const withPromotionNotice = (result: string): string => {
        if (promotedProjectIdsForTool.length === 0) {
          return result;
        }
        return `[macro_scope_promotion] ${JSON.stringify({
          promoted_project_ids: promotedProjectIdsForTool,
          retried_tool: normalizedToolName,
        })}\n${result}`;
      };

      if (normalizedToolName === "terminal_create_session") {
        const explicitProjectId =
          typeof args.project_id === "string" &&
          args.project_id.trim().length > 0
            ? args.project_id.trim()
            : null;
        const projectId =
          explicitProjectId ||
          executionContext.actionableProjectIds[0] ||
          executionContext.focusedProjectId ||
          executionContext.projectId;

        if (!projectId) {
          return "Missing project_id argument for terminal_create_session.";
        }

        if (explicitProjectId) {
          const explicitProject = executionContext.projectMounts.find(
            (mount) => mount.projectId === explicitProjectId,
          );
          if (explicitProject?.isReadOnly) {
            return `Error executing terminal_create_session: project "${explicitProject.displayName}" is read-only.`;
          }
        }

        const session = await useTerminalStore.getState().createSession({
          projectId,
          cwd: typeof args.cwd === "string" ? args.cwd : null,
        });
        return withPromotionNotice(JSON.stringify(session, null, 2));
      }

      if (normalizedToolName === "terminal_run") {
        const sessionId =
          typeof args.session_id === "string" ? args.session_id.trim() : "";
        const command = typeof args.command === "string" ? args.command : "";
        if (!sessionId) return "Missing session_id argument for terminal_run.";
        if (!command.trim())
          return "Missing command argument for terminal_run.";

        const session = await useTerminalStore.getState().runCommand({
          sessionId,
          command,
          timeoutMs:
            typeof args.timeout_ms === "number"
              ? Math.min(1_800_000, Math.max(1, Math.floor(args.timeout_ms)))
              : null,
        });
        return JSON.stringify(session, null, 2);
      }

      if (normalizedToolName === "terminal_read") {
        const sessionId =
          typeof args.session_id === "string" ? args.session_id.trim() : "";
        if (!sessionId) return "Missing session_id argument for terminal_read.";

        const session = await useTerminalStore
          .getState()
          .readSession(sessionId);
        return JSON.stringify(session, null, 2);
      }

      if (normalizedToolName === "terminal_kill") {
        const sessionId =
          typeof args.session_id === "string" ? args.session_id.trim() : "";
        if (!sessionId) return "Missing session_id argument for terminal_kill.";

        const session = await useTerminalStore
          .getState()
          .killSession(sessionId);
        return JSON.stringify(session, null, 2);
      }

      const result = await executeWorkspaceTool(normalizedToolName, args, mode, {
        signal,
        workspacePath: executionContext.workspacePath,
        defaultWorkspacePath: executionContext.defaultWorkspacePath,
        projectId: executionContext.projectId,
        focusedProjectId: executionContext.focusedProjectId,
        groupId: executionContext.groupId,
        projectMounts: executionContext.projectMounts,
        virtualRootEnabled: executionContext.virtualRootEnabled,
        workspacePathsByProjectId: executionContext.workspacePathsByProjectId,
        onCodeCheckpoint: async (checkpoint) => {
          await recordAgentCodeCheckpoint({
            conversationId,
            turnId: assistantTurnId,
            assistantMessageId,
            toolCallId,
            toolName: checkpoint.toolName,
            files: checkpoint.files,
          });
        },
      });
      if (!isCurrentOperation()) {
        return TOOL_EXECUTION_ABORTED_RESULT;
      }
      return result === undefined ? result : withPromotionNotice(result);
    }
  };

  const getOrderedConversationMessages = (conversationId: string) => {
    const state = get();
    return getConversationMessagesFromState(state, conversationId);
  };

  const cloneProviderInputItems = (
    items?: unknown[] | null,
  ): unknown[] | undefined => {
    if (!Array.isArray(items) || items.length === 0) {
      return undefined;
    }

    return items.map((item) =>
      item && typeof item === "object"
        ? JSON.parse(JSON.stringify(item))
        : item,
    );
  };

  const cloneStreamMessage = (message: StreamMessage): StreamMessage => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) =>
          part.type === "image_url"
            ? {
                type: "image_url" as const,
                image_url: { ...part.image_url },
              }
            : { ...part },
        )
      : message.content,
    provider_input_items: cloneProviderInputItems(message.provider_input_items),
  });

  const cloneChatMessageForDiagnostics = (message: ChatMessage): ChatMessage => ({
    ...message,
    tool_traces: message.tool_traces
      ? message.tool_traces.map((trace) => ({ ...trace }))
      : message.tool_traces,
    provider_input_items: cloneProviderInputItems(message.provider_input_items),
  });

  const cloneCitationForDiagnostics = (citation: Citation): Citation => ({
    ...citation,
  });

  const persistableContextRefs = (
    refs: ContextReference[],
  ): PersistedContextReference[] | undefined => {
    const persisted = refs.map((ref) => {
      const skill =
        ref.kind === "skill" &&
        ref.data &&
        typeof ref.data === "object"
          ? (ref.data as SkillManifest)
          : null;
      const file =
        ref.kind === "file" &&
        ref.data &&
        typeof ref.data === "object" &&
        "path" in ref.data
          ? (ref.data as WorkspaceFileReference)
          : null;
      const source =
        ref.kind === "source" &&
        ref.data &&
        typeof ref.data === "object"
          ? (ref.data as Citation)
          : null;
      return {
        id: ref.id,
        kind: ref.kind,
        title: ref.title,
        subtitle: ref.subtitle,
        ...(skill
          ? {
              skillFilePath: skill.skillFilePath,
              contentHash: skill.contentHash,
              location: skill.location,
              source: skill.source,
            }
          : {}),
        ...(file
          ? {
              path: file.path,
              relativePath: file.relativePath,
              projectId: file.projectId ?? null,
              projectName: file.projectName ?? null,
            }
          : {}),
        ...(source
          ? {
              snippet: source.content || source.snippet,
              sourceLabel: source.source,
              url: source.url,
            }
          : {}),
      } satisfies PersistedContextReference;
    });
    return persisted.length > 0 ? persisted : undefined;
  };

  const isPersistedContextRefKind = (value: string): value is ContextRefKind =>
    value === "plan-node" ||
    value === "predicted-branch" ||
    value === "skill" ||
    value === "file" ||
    value === "source";

  const parsePersistedContextRefsJson = (
    raw: string | null | undefined,
  ): PersistedContextReference[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is PersistedContextReference => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<PersistedContextReference>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.kind === "string" &&
          isPersistedContextRefKind(candidate.kind) &&
          typeof candidate.title === "string"
        );
      });
    } catch {
      return [];
    }
  };

  const createFallbackSkillManifest = (
    ref: PersistedContextReference,
  ): SkillManifest => {
    const rootPath =
      ref.source?.rootPath ||
      ref.location?.uri ||
      ref.skillFilePath ||
      ref.id;
    return {
      id: ref.id,
      name: ref.title,
      description: ref.subtitle ?? "",
      rootPath,
      skillFilePath: ref.skillFilePath ?? null,
      location: ref.location ?? { kind: "local", uri: rootPath },
      source: ref.source ?? { kind: "global", rootPath },
      resources: [],
      scripts: [],
      contentHash: ref.contentHash,
      validationErrors: [],
      isValid: true,
    };
  };

  const rebuildComposerContextRef = (
    conversationId: string,
    ref: PersistedContextReference,
  ): ContextReference | null => {
    const appState = useAppStore.getState();
    if (ref.kind === "source") {
      const citation = useCitationsStore
        .getState()
        .citations.find(
          (candidate) =>
            candidate.id === ref.id &&
            candidate.conversationId === conversationId,
        );
      if (!citation) return null;
      return {
        id: citation.id,
        kind: "source",
        title: citation.title,
        subtitle: citation.source,
        data: citation,
      };
    }

    if (ref.kind === "file") {
      const path = ref.path || ref.relativePath || ref.title;
      const file: WorkspaceFileReference = {
        id: ref.id,
        path,
        relativePath: ref.relativePath || path,
        projectId: ref.projectId ?? null,
        projectName: ref.projectName ?? null,
      };
      return {
        id: ref.id,
        kind: "file",
        title: ref.title,
        subtitle: ref.subtitle,
        data: file,
      };
    }

    if (ref.kind === "skill") {
      const skill =
        useSkillsStore.getState().skills.find((candidate) => candidate.id === ref.id) ??
        createFallbackSkillManifest(ref);
      return {
        id: ref.id,
        kind: "skill",
        title: ref.title || skill.name,
        subtitle: ref.subtitle,
        data: skill,
      };
    }

    if (ref.kind === "plan-node") {
      const planNode =
        appState.planNodes.find((candidate) => candidate.id === ref.id) ??
        ({
          id: ref.id,
          title: ref.title,
          description: ref.subtitle,
          type: "task",
          status: "pending",
          dependencies: [],
        } satisfies PlanNode);
      return {
        id: ref.id,
        kind: "plan-node",
        title: ref.title || planNode.title,
        subtitle: ref.subtitle,
        data: planNode,
      };
    }

    const branch =
      appState.predictedBranches.find((candidate) => candidate.id === ref.id) ??
      ({
        id: ref.id,
        name: ref.title,
        color: "#64748b",
        parentBranch: null,
        projectId: ref.projectId ?? "",
        taskIds: [],
        status: "pending",
      } satisfies PredictedBranch);
    return {
      id: ref.id,
      kind: "predicted-branch",
      title: ref.title || branch.name,
      subtitle: ref.subtitle,
      data: branch,
    };
  };

  const restoreComposerContextRefsFromPersisted = (
    conversationId: string,
    persistedRefs: PersistedContextReference[],
  ): ContextReference[] => {
    const seen = new Set<string>();
    return persistedRefs
      .map((ref) => rebuildComposerContextRef(conversationId, ref))
      .filter((ref): ref is ContextReference => {
        if (!ref) return false;
        const key = `${ref.kind}:${ref.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  const persistComposerContextRefsForConversation = (
    conversationId: string | null | undefined,
    refs: ContextReference[],
  ): void => {
    if (!conversationId || !tauriIpc.isTauriAvailable()) return;

    const persistedRefs = persistableContextRefs(refs) ?? [];
    const persist = async () => {
      if (persistedRefs.length === 0) {
        if (typeof tauriIpc.deleteConversationToolboxState === "function") {
          await tauriIpc.deleteConversationToolboxState(conversationId);
        }
        return;
      }
      if (typeof tauriIpc.upsertConversationToolboxState === "function") {
        await tauriIpc.upsertConversationToolboxState({
          conversation_id: conversationId,
          composer_context_refs_json: JSON.stringify(persistedRefs),
          timestamp: new Date().toISOString(),
        });
      }
    };

    void persist().catch((error) => {
      console.warn("[chat] Failed to persist toolbox state:", error);
    });
  };

  const clearComposerContextRefsIfRevisionMatches = (
    conversationId: string,
    expectedRevision: number,
  ): void => {
    if (composerContextRefsRevision !== expectedRevision) {
      return;
    }
    composerContextRefsRevision += 1;
    if (get().selectedConversationId === conversationId) {
      set({ composerContextRefs: [] });
    }
    persistComposerContextRefsForConversation(
      conversationId,
      [],
    );
  };

  const deleteConversationToolboxStateIfAvailable = async (
    conversationId: string,
  ): Promise<void> => {
    if (!tauriIpc.isTauriAvailable()) return;
    if (typeof tauriIpc.deleteConversationToolboxState !== "function") return;
    await tauriIpc.deleteConversationToolboxState(conversationId);
  };

  const beginStandaloneConversationDeletionSaga = async (
    conversationId: string,
  ): Promise<void> => {
    await upsertLinkedConversationDeletionSaga({
      ownerType: "conversation",
      ownerId: conversationId,
      conversationId,
      phase: "task_deleted",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  const completeStandaloneConversationDeletionSaga = async (
    conversationId: string,
  ): Promise<void> => {
    await removeLinkedConversationDeletionSaga("conversation", conversationId);
  };

  const hydrateConversationToolboxStateIfAvailable = async (
    conversationId: string,
  ): Promise<void> => {
    if (!tauriIpc.isTauriAvailable()) {
      return;
    }
    if (typeof tauriIpc.getConversationToolboxState !== "function") {
      return;
    }
    try {
      const record = await tauriIpc.getConversationToolboxState(conversationId);
      if (get().selectedConversationId !== conversationId) {
        return;
      }
      const persistedRefs = parsePersistedContextRefsJson(
        record?.composer_context_refs_json,
      );
      const composerContextRefs = restoreComposerContextRefsFromPersisted(
        conversationId,
        persistedRefs,
      );
      composerContextRefsRevision += 1;
      set({ composerContextRefs });
    } catch (error) {
      console.warn("[chat] Failed to hydrate toolbox state:", error);
    }
  };

  const getSkillFeedbackAction = (warning: string): SkillTurnFeedbackItem["action"] | undefined => {
    const normalized = warning.toLocaleLowerCase();
    if (normalized.includes("settings")) return "open_settings";
    if (normalized.includes("refresh")) return "refresh";
    return undefined;
  };

  const buildSkillTurnFeedback = (
    messageId: string | null | undefined,
    preparation: Pick<SkillTurnPreparation, "activatedSkills" | "warnings">,
  ): SkillTurnFeedback | null => {
    if (!messageId) return null;
    const skillsState = useSkillsStore.getState();
    const loaded = preparation.activatedSkills.map<SkillTurnFeedbackItem>((activation) => {
      const skill = skillsState.getSkillById(activation.skillId);
      return {
        skillId: activation.skillId,
        title: skill?.name ?? activation.skillId,
        status: "loaded",
      };
    });
    const warnings = preparation.warnings.map<SkillTurnFeedbackItem>((warning) => ({
      title: "Skill context",
      status: warning.toLocaleLowerCase().includes("no longer available") ? "ignored" : "blocked",
      reason: warning,
      action: getSkillFeedbackAction(warning),
    }));
    if (loaded.length === 0 && warnings.length === 0) return null;
    return { messageId, loaded, warnings };
  };

  const cloneStreamContextDiagnosticsBaseline = (
    baseline: StreamContextDiagnosticsBaseline,
  ): StreamContextDiagnosticsBaseline => ({
    ...baseline,
    allowedToolIds: [...baseline.allowedToolIds],
    toolDefinitions: baseline.toolDefinitions.map((tool) => ({ ...tool })),
    messagesForRequest: baseline.messagesForRequest.map(cloneStreamMessage),
    orderedMessages: baseline.orderedMessages.map(cloneChatMessageForDiagnostics),
    citations: baseline.citations.map(cloneCitationForDiagnostics),
  });

  const buildProviderInputItemsFromContent = (
    role: "user" | "assistant",
    content: StreamMessage["content"],
  ): unknown[] => {
    const parts =
      typeof content === "string"
        ? [
            {
              type: role === "user" ? "input_text" : "output_text",
              text: content,
            },
          ]
        : content.map((part) => {
            if (part.type === "image_url") {
              return {
                type: "input_image",
                image_url: part.image_url.url,
              };
            }

            return {
              type: role === "user" ? "input_text" : "output_text",
              text: part.text || "",
            };
          });

    return [
      {
        type: "message",
        role,
        content: parts,
      },
    ];
  };

  const prepareMessagesForRequest = async (
    conversationId: string,
    allowedToolIds: string[],
    internalAgentProfile?: InternalAgentProfile | null,
    modeAtSend?: AppMode,
    agentTypeAtSend?: AgentType | null,
    messageWithImagesId?: string,
    skillPermissionSnapshot?: SkillPermissionSnapshot | null,
    executionContextOverride?: ProjectExecutionContext,
  ) => {
    const appState = useAppStore.getState();
    const executionContext =
      executionContextOverride ?? resolveConversationExecutionContext(conversationId);
    const riskLevel = await loadToolRiskLevelPreference();
    const contextCitations = useCitationsStore
      .getState()
      .getConversationContextCitations(conversationId);
    const sourceCitations = useCitationsStore
      .getState()
      .getConversationSourceCitations(conversationId);
    const citations = allowedToolIds.includes("mark_source_passage")
      ? [...contextCitations, ...sourceCitations]
      : contextCitations;
    const fileCitations = contextCitations.filter(
      (c) => c.type === "file" || c.type === "document",
    );
    const orderedMessages = getOrderedConversationMessages(conversationId);
    const lastUserIndex = orderedMessages
      .map((m) => m.role)
      .lastIndexOf("user");
    const lastUserMessage = lastUserIndex >= 0 ? orderedMessages[lastUserIndex] : null;
    const fileRefsForTurn = (lastUserMessage?.context_refs ?? get().composerContextRefs)
      .filter(isFileContextRef);
    const availableFiles = [
      ...fileCitations
        .map((c) => c.path || c.title || c.source)
        .filter(Boolean),
      ...fileRefsForTurn.map(getFileRefPath),
    ].join(", ");
    const skillPreparation =
      lastUserMessage?.role === "user"
        ? await useSkillsStore.getState().prepareSkillsForTurn({
            conversationId,
            content: lastUserMessage.content,
            contextRefs: lastUserMessage.context_refs ?? get().composerContextRefs,
            toolsAvailable: allowedToolIds.includes("skill_activate"),
            permissionSnapshot: skillPermissionSnapshot ?? null,
          })
        : {
            activatedSkills: [],
            systemInstructionBlocks: [],
            explicitSkillIds: [],
            warnings: [],
            toolsAvailable: allowedToolIds.includes("skill_activate"),
            permissionSnapshot: skillPermissionSnapshot ?? null,
          };
    const skillTurnFeedback = buildSkillTurnFeedback(
      lastUserMessage?.id,
      skillPreparation,
    );
    const explicitSkillIdSet = new Set(skillPreparation.explicitSkillIds);
    const messageImagesByMessageId = get().messageImagesByMessageId;

    const providerInputItemsByMessageId: Record<string, unknown[] | undefined> =
      {};

    const preparedMessages = orderedMessages.map((message, index) => {
      let messageContent = message.content;
      if (message.role === "assistant") {
        messageContent = sanitizeAssistantContentForModel(messageContent);
      }

      // Inject context into the last user message
      if (index === lastUserIndex) {
        const blocks: string[] = [];

        if (citations.length > 0) {
          let contextIndex = 0;
          let sourceIndex = 0;
          const contextBlock = citations
            .map((c) => {
              if (c.scope === "source") {
                sourceIndex += 1;
                return `[Important Source ${sourceIndex}: ${c.title}] (citation_id=${c.id}, kind=${c.kind || "used"}, source=${c.source})`;
              }
              contextIndex += 1;
              return `[Context ${contextIndex}: ${c.title}]\n${truncateInjectedContextSnippet(c.snippet || c.source || "")}`;
            })
            .join("\n\n---\n\n");
          const readSourcesHint =
            sourceIndex > 0
              ? "\n\nUse read_sources to review the full text of saved Important Source passages."
              : "";
          blocks.push(`CONTEXT INFORMATION:\n\n${contextBlock}${readSourcesHint}`);
        }

        const skillActivationAvailable = allowedToolIds.includes("skill_activate");
        const contextRefs = (message.context_refs ?? get().composerContextRefs).filter(
          (ref) => ref.kind !== "skill" || explicitSkillIdSet.has(ref.id) || skillActivationAvailable,
        );
        if (contextRefs.length > 0) {
          const refsBlock = contextRefs
            .map((ref) => {
              const lines: string[] = [`[${ref.kind}: ${ref.title}]`];
              if (ref.subtitle) lines.push(`Category: ${ref.subtitle}`);
              if (ref.kind === "skill") {
                return (buildSkillReferenceLines(ref, explicitSkillIdSet) ?? lines).join("\n");
              }
              if (ref.kind === "file") {
                const path =
                  ("path" in ref && ref.path) ||
                  ("data" in ref && "path" in ref.data ? ref.data.path : ref.title);
                lines.push(`File path: ${path}`);
                lines.push("Content: not preloaded. Use read_file with this exact path before analyzing file contents.");
                if ("projectName" in ref && ref.projectName) {
                  lines.push(`Project: ${ref.projectName}`);
                } else if ("data" in ref && "projectName" in ref.data && ref.data.projectName) {
                  lines.push(`Project: ${ref.data.projectName}`);
                }
              }
              if (ref.kind === "source") {
                const snippet =
                  ("snippet" in ref && ref.snippet) ||
                  ("data" in ref && "content" in ref.data && ref.data.content) ||
                  ("data" in ref && "snippet" in ref.data && ref.data.snippet) ||
                  "";
                const sourceLabel =
                  ("sourceLabel" in ref && ref.sourceLabel) ||
                  ("data" in ref && "source" in ref.data && ref.data.source) ||
                  ref.subtitle;
                const url =
                  ("url" in ref && ref.url) ||
                  ("data" in ref && "url" in ref.data && ref.data.url);
                lines.push(`Passage: ${snippet}`);
                if (sourceLabel) lines.push(`Source: ${sourceLabel}`);
                if (url) lines.push(`URL: ${url}`);
                return lines.join("\n");
              }
              if ("data" in ref && "description" in ref.data && ref.data.description) {
                lines.push(`Description: ${ref.data.description}`);
              }
              if ("data" in ref && "status" in ref.data && ref.data.status) {
                lines.push(`Status: ${ref.data.status}`);
              }
              if ("data" in ref && "priority" in ref.data && ref.data.priority) {
                lines.push(`Priority: ${ref.data.priority}`);
              }
              if (
                "data" in ref &&
                "tags" in ref.data &&
                Array.isArray(ref.data.tags) &&
                ref.data.tags.length > 0
              ) {
                lines.push(`Tags: ${ref.data.tags.join(", ")}`);
              }
              if ("data" in ref && "type" in ref.data && ref.data.type) {
                lines.push(`Type: ${ref.data.type}`);
              }
              if (
                "data" in ref &&
                "dependencies" in ref.data &&
                Array.isArray(ref.data.dependencies) &&
                ref.data.dependencies.length > 0
              ) {
                lines.push(`Dependencies: ${ref.data.dependencies.join(", ")}`);
              }
              return lines.join("\n");
            })
            .join("\n\n---\n\n");
          blocks.push(`REFERENCED ITEMS:\n\n${refsBlock}`);
        }

        if (blocks.length > 0) {
          messageContent = `${blocks.join("\n\n")}\n\nUSER REQUEST: ${message.content}`;
        }
      }

      if (
        message.role === "user" &&
        messageWithImagesId &&
        message.id === messageWithImagesId
      ) {
        const images = messageImagesByMessageId[message.id] || [];
        if (images.length > 0) {
          const content = [
            { type: "text" as const, text: messageContent },
            ...images.map((image) => ({
              type: "image_url" as const,
              image_url: { url: image.dataUrl },
            })),
          ];
          providerInputItemsByMessageId[message.id] =
            cloneProviderInputItems(message.provider_input_items) ??
            buildProviderInputItemsFromContent("user", content);
          return {
            role: "user" as const,
            content,
            ...(providerInputItemsByMessageId[message.id]
              ? {
                  provider_input_items:
                    providerInputItemsByMessageId[message.id],
                }
              : {}),
          };
        }
      }

      providerInputItemsByMessageId[message.id] =
        cloneProviderInputItems(message.provider_input_items) ??
        (message.role === "user" || message.role === "assistant"
          ? buildProviderInputItemsFromContent(message.role, messageContent)
          : undefined);

      return {
        role: message.role as "user" | "assistant",
        content: messageContent,
        ...(providerInputItemsByMessageId[message.id]
          ? { provider_input_items: providerInputItemsByMessageId[message.id] }
          : {}),
        ...(message.provider_turn_state
          ? { provider_turn_state: message.provider_turn_state }
          : {}),
      };
    });

    const systemInstructions: string[] = [];
    if (skillPreparation.systemInstructionBlocks.length > 0) {
      systemInstructions.push(
        [
          "Explicit Macro skills selected for this turn have already been loaded below. Follow these skill instructions for this turn; do not call skill_activate again for these ids unless you need to refresh after an error.",
          ...skillPreparation.systemInstructionBlocks,
        ].join("\n\n"),
      );
    }
    if (skillPreparation.warnings.length > 0) {
      systemInstructions.push(
        `Macro skill warnings for this turn:\n${skillPreparation.warnings.map((warning) => `- ${warning}`).join("\n")}`,
      );
    }
    if (allowedToolIds.includes("read_file")) {
      systemInstructions.push(
        `When the user asks to inspect or analyze an attached file, call read_file first using the file name/path. Available files: ${availableFiles || "none"}.`,
      );
    }
    if (allowedToolIds.includes("mark_source_passage")) {
      systemInstructions.push(
        'Use mark_source_passage for source tracking. Use kind="interesting" for key excerpts worth keeping while analyzing sources. Use kind="used" only for excerpts you actually used in your final answer. Always include concise title and exact passage. Add source or url when available, and reason when helpful. Only mark genuinely important passages.',
      );
    }
    if (allowedToolIds.includes("read_sources")) {
      systemInstructions.push(
        "Use read_sources when you need to review previously saved source passages before answering or editing citations.",
      );
    }
    if (allowedToolIds.includes("edit_source_passage")) {
      systemInstructions.push(
        'Use edit_source_passage to reclassify saved source passages from kind="interesting" to kind="used" at the end of your answer when you actually used them. Use action="update" or action="delete" only when the user explicitly asks to update or delete saved source passages.',
      );
    }
    if (allowedToolIds.includes("question")) {
      systemInstructions.push(
        'Use the question tool only for blocking structured clarifications. If the user explicitly asks you to use the question tool, you must call it instead of asking in plain text. Do not use it for open brainstorming. Make at most one question tool call per assistant turn, with 1 to 5 sequential questions total, and exactly 3 suggested choices per question. If you use it, stop after the tool call and wait for the user questionnaire response.',
      );
    }
    if (
      allowedToolIds.includes("git_add") ||
      allowedToolIds.includes("git_commit")
    ) {
      systemInstructions.push(
        "Never stage or commit on your own initiative. Use git_add or git_commit only after an explicit user request.",
      );
    }
    if (allowedToolIds.includes("apply_patch")) {
      systemInstructions.push(
        "For coordinated file edits, use apply_patch instead of write/edit. Macro patch format is: *** Begin Patch, then one or more sections using *** Add File:, *** Update File:, or *** Delete File:, and finally *** End Patch. In update hunks, prefix context lines with a space, removals with -, additions with +, and separate hunks with @@ when needed. Use delete for a direct single-file removal when that is simpler than crafting a patch.",
      );
    } else if (
      allowedToolIds.includes("write") ||
      allowedToolIds.includes("edit") ||
      allowedToolIds.includes("delete")
    ) {
      systemInstructions.push(
        "For file edits in this session, use write/edit/delete tools and do not emit apply_patch. The delete tool only supports files, not directories.",
      );
    }
    if (allowedToolIds.includes("skill_activate")) {
      const skillsState = useSkillsStore.getState();
      const catalogInstruction = buildSkillCatalogInstruction(
        skillsState.getEnabledLoadableSkills({ permissionSnapshot: skillPermissionSnapshot ?? null }),
      );
      if (catalogInstruction) {
        systemInstructions.push(catalogInstruction);
        const explicitInstruction = buildExplicitSkillsInstruction(
          skillPreparation.explicitSkillIds
            .map((skillId) => skillsState.getSkillById(skillId))
            .filter((skill): skill is SkillManifest => Boolean(skill)),
        );
        if (explicitInstruction) {
          systemInstructions.push(explicitInstruction);
        }
      }
    }
    const appMode = modeAtSend ?? appState.mode;
    const agentType =
      appMode === "Implement"
        ? (agentTypeAtSend ?? appState.agentType)
        : null;
    const modePrompt = await loadPreference<string>(
      MODE_PROMPT_KEYS_BY_MODE[appMode]
    );

    if (modePrompt) {
      systemInstructions.unshift(modePrompt);
    }

    systemInstructions.push(buildToolRiskLevelSystemInstruction(riskLevel));

    const internalAgentProfilePromptKey =
      getInternalAgentProfilePromptPreferenceKey(internalAgentProfile);
    const internalAgentProfilePrompt = internalAgentProfilePromptKey
      ? await loadPreference<string>(internalAgentProfilePromptKey)
      : null;
    if (internalAgentProfilePrompt) {
      systemInstructions.push(internalAgentProfilePrompt);
    }

    const implementContextTaskId =
      executionContext.taskId ||
      get().conversations.find((conversation) => conversation.id === conversationId)?.task_id ||
      appState.selectedTaskId ||
      null;
    const implementContextTask =
      appMode === "Implement" && implementContextTaskId
        ? useTaskStore.getState().getTaskById(implementContextTaskId)
        : undefined;

    if (
      appMode === "Implement" &&
      agentType === "plan"
    ) {
      systemInstructions.push(IMPLEMENT_PLAN_SYSTEM_INSTRUCTION);
    }

    let previousAssistantMessage: ChatMessage | null = null;
    for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
      const candidate = orderedMessages[index];
      if (candidate?.role === "assistant") {
        previousAssistantMessage = candidate;
        break;
      }
    }
    const previousAssistantContext = previousAssistantMessage
      ? assistantTurnContextByMessageId.get(previousAssistantMessage.id)
      : null;
    if (
      appMode === "Implement" &&
      agentType === "build" &&
      previousAssistantContext?.agentType === "plan"
    ) {
      systemInstructions.push(IMPLEMENT_BUILD_AFTER_PLAN_SYSTEM_INSTRUCTION);
    }

    if (appMode === "Implement" && isStandaloneImplementTask(implementContextTask)) {
      systemInstructions.push(STANDALONE_IMPLEMENT_SYSTEM_INSTRUCTION);
    }

    if (
      executionContext.groupName ||
      executionContext.projectName ||
      executionContext.workspacePath ||
      executionContext.taskId ||
      executionContext.branchName
    ) {
      const scopedProjects =
        executionContext.projectIds
          .map(
            (projectId) =>
              appState.getProjectById(projectId)?.name || projectId,
          )
          .join(", ") || "none";
      const mountSummary =
        executionContext.projectMounts
          .map((mount) => `${mount.mountName}=>${mount.displayName}`)
          .join(", ") || "none";
      systemInstructions.push(
        `[Execution Context] group="${executionContext.groupName || executionContext.groupId || "none"}", default_project="${executionContext.projectName || executionContext.projectId || "none"}", focused_project="${executionContext.focusedProjectId || "none"}", scoped_projects="${scopedProjects}", task="${executionContext.taskId || "none"}", branch="${executionContext.branchName || "none"}", virtual_root="${executionContext.virtualRootEnabled ? "enabled" : "disabled"}", project_mounts="${mountSummary}". When virtual_root is enabled, the visible workspace root is virtual and its first level contains only project mounts such as \`api/\` or \`web/\`. Use virtual paths like \`api/src/server.ts\` for filesystem tools, or pass \`project_id\` to target one project explicitly. Git and terminal operations must target exactly one project; there is no git or terminal at the virtual root.`,
      );
    }

    if (appMode === "Implement" && implementContextTaskId) {
      const task = implementContextTask;
      if (task && task.task_source === "architect") {
        const taskTodoPresentation = resolvePlanNodeTodoPresentation(task);
        const taskTodos = taskTodoPresentation.todos;
        if (taskTodos.length > 0) {
          const { progress } = taskTodoPresentation;
          systemInstructions.push(
            `[Task Todos] task_id="${task.id}", progress="${progress.done}/${progress.total}". Use task_todo_get to refresh this checklist and task_todo_update to mark progress. Open todos block task completion. todos=${JSON.stringify(taskTodos)}.`,
          );
        } else {
          systemInstructions.push(
            `[Task Todos] task_id="${task.id}". This Architect task has no generated task checklist available. Do not invent implicit todos; use task_todo_get if you need to confirm whether the plan predates task checklists, and task_todo_update add only when a real checklist item should be created.`,
          );
        }
      }
      if (task && (task.task_source === "architect" || isPlanFinalizationTaskSource(task.task_source))) {
        const artifactContextBlock = await buildTaskArtifactContextBlock({
          task,
          getPlan: getArchitectPlan,
          allowWrites: allowedToolIds.includes("task_artifact_put"),
        });
        if (artifactContextBlock) {
          systemInstructions.push(artifactContextBlock);
        }
      }
    }

    if (appMode === "Architect") {
      systemInstructions.push(buildArchitectPlanToolFollowUpInstruction());
      systemInstructions.push(
        "In Architect mode, discuss the plan directly with the user. Inspect the selected project code when it provides useful context, and use the `question` tool for focused clarifications when important information is missing. Generate or regenerate strategy only after an explicit user request, using the plan conversation, expressed intent, plan scope, selected projects, inspected code context, and clarification answers.",
      );
      systemInstructions.push(
        "In Architect mode, do not call `strategy_generate` automatically. Only call it after an explicit user request to generate/regenerate strategy (for example via the Generate Strategy button or a direct instruction in chat).",
      );
      systemInstructions.push(
        "In Architect mode, the plan lifecycle remains UI-only for this iteration. Never call `plan_create`, `plan_delete`, `plan_restore`, or `plan_set_active`; ask the user to use the plan selector instead.",
      );
      systemInstructions.push(
        "In Architect mode, `plan_update` may change the optional label/title alias, description, mutable draft slug, and draft-only scope metadata. Never use it to change plan status or activate a plan.",
      );
      systemInstructions.push(
        "In Architect mode, if a strategy tool reports frozen-node conflicts and explicitly requests a repair retry, immediately call the same strategy tool one more time with a corrected full strategy that preserves all frozen nodes verbatim. If the tool stages a preview or blocks the mutation, stop retrying and explain that the user must review the preview.",
      );
      systemInstructions.push(
        "Git workflow for plans is strict: each plan has an immutable technical id plus a logical `slug` once it is locked. In mainline mode, where the development target and main branch are the same, create feature work only and do not propose release, hotfix, or bugfix branches. Feature plans integrate on rendered `plan/*` branches. The Architect AI should propose `plan_slug` and unique per-node `featureSlug` values, not raw git branch names. Task work branches are rendered later from each project's Git workflow profile and merge into the plan integration branch.",
      );
      systemInstructions.push(
        "Each executable plan node owns its own work branch. Express sequential work with `dependencies`, never by reusing a `featureSlug`; duplicate pending slugs are normalized into unique task slugs. Include concrete per-node `todos` for the Implement checklist; each todo should be task-local and use `pending`, `in-progress`, or `done`. Do not create a `Finalize plan` node yourself: Macro adds a synthetic finalization task after the terminal strategy nodes and handles the final merge.",
      );
      const activePlanContext = useAppStore.getState().activePlanContext;
      if (activePlanContext) {
        const appState = useAppStore.getState();
        const planKind = activePlanContext.planKind || "feature";
        const targetDisplay = getArchitectPlanTargetDisplay(activePlanContext, null, {
          getProjectGitFlowSettings: (projectId) =>
            appState.getProjectById(projectId)?.gitFlowSettings ?? null,
        });
        const typedPlanInstruction =
          planKind === "release"
            ? "This is a Release plan. First inspect likely version files and relevant repositories. If important version or repository scope information remains missing, use the question tool for focused clarification; do not force confirmation when the conversation and inspected code already establish it. Do not create tags or GitHub releases."
            : planKind === "hotfix"
              ? "This is a Hotfix plan. Ask the user to describe the production bug if they have not already done so. Then inspect from the main-branch mindset, infer affected repositories, and propose a concise hotfix slug and patch versions per repository. Use the question tool only when important scope, version, or slug information remains missing; do not impose a confirmation step before strategy generation."
              : planKind === "bugfix"
                ? "This is a Bugfix plan. Ask the user to describe the bug if they have not already done so. Then inspect from the development-branch mindset, infer affected repositories, and propose a concise bugfix slug. Use the question tool only when important scope or slug information remains missing; do not impose a confirmation step before strategy generation."
                : "This is a Feature plan. Keep the existing lightweight planning flow; do not force an initial questionnaire unless a clarification is blocking.";
        systemInstructions.push(
          `[Active Plan] id="${activePlanContext.id}", kind="${planKind}", slug="${activePlanContext.slug || activePlanContext.id}", title="${activePlanContext.title}", label="${activePlanContext.label || "none"}", description="${activePlanContext.description || "none"}", status="${activePlanContext.status}", storageTargetBranch="${activePlanContext.targetBranch}", effectiveTargetBranch="${targetDisplay.effectiveTargetBranch || targetDisplay.targetBranch}", targetBranchesByProjectId=${JSON.stringify(targetDisplay.targetBranchesByProjectId)}. ${typedPlanInstruction} Use plan_update.label (or title as legacy alias) for the optional display label. For Release/Hotfix/Bugfix, plan_update may also update project_ids, context_project_ids, and git_flow metadata while the plan is still a draft. Only update plan slug through \`plan_update.slug\` or \`strategy_generate.plan_slug\` while the plan is still a mutable draft.`,
        );
      }
    }

    const systemMessage =
      systemInstructions.join(" ") ||
      "Use context information when it is provided.";

    return {
      systemMessage,
      messages: [
        {
          role: "system" as const,
          content: systemMessage,
        },
        ...preparedMessages,
      ],
      preparedMessages,
      orderedMessages,
      providerInputItemsByMessageId,
      citations,
      executionContext,
      skillPermissionSnapshot: skillPreparation.permissionSnapshot,
      skillTurnFeedback,
    };
  };

  const buildLiveStreamDiagnosticsPayload = (
    liveEstimate: LiveStreamContextEstimate,
  ): LiveStreamDiagnosticsPayload | null => {
    const baseline = liveEstimate.baseline;
    if (!baseline) {
      return null;
    }

    const [systemMessageCandidate, ...payloadMessages] =
      baseline.messagesForRequest.map(cloneStreamMessage);
    const systemMessage =
      typeof systemMessageCandidate?.content === "string"
        ? systemMessageCandidate.content
        : "";
    const liveContent = liveEstimate.visibleContent;
    const modelContent = sanitizeAssistantContentForModel(liveContent);
    const providerInputItems =
      cloneProviderInputItems(liveEstimate.providerInputItems) ??
      buildProviderInputItemsFromContent("assistant", modelContent);
    const livePreparedMessage: StreamMessage = {
      role: "assistant",
      content: modelContent,
      ...(providerInputItems ? { provider_input_items: providerInputItems } : {}),
      ...(liveEstimate.providerTurnState
        ? { provider_turn_state: liveEstimate.providerTurnState }
        : {}),
    };
    const preparedMessages = [...payloadMessages, livePreparedMessage];

    let didUpdateAssistantMessage = false;
    const orderedMessages = baseline.orderedMessages.map((message) => {
      if (message.id !== liveEstimate.assistantMessageId) {
        return cloneChatMessageForDiagnostics(message);
      }
      didUpdateAssistantMessage = true;
      return {
        ...cloneChatMessageForDiagnostics(message),
        content: liveContent,
        tool_traces: liveEstimate.toolTraces.map((trace) => ({ ...trace })),
        hidden_context: liveEstimate.hiddenContext,
        provider_input_items: providerInputItems,
        provider_turn_state:
          liveEstimate.providerTurnState ?? message.provider_turn_state,
      };
    });

    if (!didUpdateAssistantMessage) {
      orderedMessages.push({
        id: liveEstimate.assistantMessageId,
        task_id: "",
        conversation_id: baseline.conversationId,
        role: "assistant",
        content: liveContent,
        timestamp: liveEstimate.updatedAt,
        tool_traces: liveEstimate.toolTraces.map((trace) => ({ ...trace })),
        hidden_context: liveEstimate.hiddenContext,
        provider_input_items: providerInputItems,
        provider_turn_state: liveEstimate.providerTurnState,
      });
    }

    return {
      systemMessage,
      preparedMessages,
      orderedMessages,
      citations: baseline.citations.map(cloneCitationForDiagnostics),
      baseline,
    };
  };

  const liveStreamBaselineHasCompaction = (
    baseline: StreamContextDiagnosticsBaseline,
  ): boolean =>
    baseline.messagesForRequest.some(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes(COMPACTED_CONVERSATION_STATE_MARKER),
    );

  const isProviderRuntimeError = (runtime: ConversationRuntimeState): boolean =>
    runtime.lastErrorOrigin === "provider" ||
    runtime.lastErrorDisplayTarget === "transcript";

  const publishConversationContextDiagnostics = (
    conversationId: string,
    diagnostics: ConversationContextDiagnostics,
  ) => {
    set((state) => ({
      contextDiagnosticsByConversationId: {
        ...state.contextDiagnosticsByConversationId,
        [conversationId]: diagnostics,
      },
    }));
  };

  const markConversationContextDiagnosticsEstimating = (
    conversationId: string,
  ) => {
    set((state) => {
      const previous = state.contextDiagnosticsByConversationId[conversationId];
      return {
        contextDiagnosticsByConversationId: {
          ...state.contextDiagnosticsByConversationId,
          [conversationId]: {
            status: "estimating",
            source: "full",
            conversationId,
            updatedAt: new Date().toISOString(),
            providerId: previous?.providerId,
            providerType: previous?.providerType,
            modelId: previous?.modelId,
            modelContextWindowTokens: previous?.modelContextWindowTokens,
            previousModelContextWindowTokens:
              previous?.previousModelContextWindowTokens,
            modelContextWindowShrank: previous?.modelContextWindowShrank,
            marginTokens: previous?.marginTokens,
            phase: previous?.phase,
            decision: previous?.decision,
            compactionPass: previous?.compactionPass,
            summaryFormatVersion: previous?.summaryFormatVersion,
            summarySource: previous?.summarySource,
            footprintBefore: previous?.footprintBefore,
            footprintAfter: previous?.footprintAfter,
            ratio: previous?.ratio ?? 0,
            usableRatio: previous?.usableRatio ?? 0,
            isHardStop: previous?.isHardStop ?? false,
            counts: previous?.counts ?? EMPTY_CONTEXT_DIAGNOSTICS_COUNTS,
            breakdown: previous?.breakdown ?? [],
            topContributors: previous?.topContributors ?? [],
          },
        },
      };
    });
  };

  const resolveContextDiagnosticsProviderContext = (
    providerContext?: ConversationContextDiagnosticsProviderContext,
  ): ConversationContextDiagnosticsProviderContext => {
    const providerState = useProviderStore.getState();
    const providerId =
      providerContext?.providerId ?? providerState.selectedProviderId;
    const modelId = providerContext?.modelId ?? providerState.selectedModelId;
    if (!providerId || !modelId) {
      throw buildSendError("Select a provider and model to inspect context.");
    }

    const configuredProvider = providerState.providerConfigs.find(
      (provider) => provider.id === providerId,
    );
    const providerType =
      providerContext?.providerType ?? configuredProvider?.providerType;
    if (!providerType) {
      throw buildSendError("Provider configuration not found.");
    }

    return {
      providerId,
      providerType,
      baseUrl: providerContext?.baseUrl ?? configuredProvider?.baseUrl ?? "",
      modelId,
    };
  };

  const isLiveStreamEstimateCurrent = (
    conversationId: string,
    liveEstimate: LiveStreamContextEstimate,
  ): boolean => {
    const runtime = getConversationRuntimeSnapshot(
      get().conversationRuntimeById,
      conversationId,
    );
    const current =
      get().liveStreamContextEstimatesByConversationId[conversationId];
    return (
      runtime.phase === "streaming" &&
      runtime.sessionId === liveEstimate.sessionId &&
      runtime.assistantMessageId === liveEstimate.assistantMessageId &&
      current?.sessionId === liveEstimate.sessionId &&
      current.assistantMessageId === liveEstimate.assistantMessageId &&
      current.version === liveEstimate.version
    );
  };

  const resolveActiveLiveStreamDiagnosticsPayload = (
    conversationId: string,
  ): {
    runtime: ConversationRuntimeState;
    liveEstimate: LiveStreamContextEstimate;
    payload: LiveStreamDiagnosticsPayload;
  } | null => {
    const runtime = getConversationRuntimeSnapshot(
      get().conversationRuntimeById,
      conversationId,
    );
    const liveEstimate =
      get().liveStreamContextEstimatesByConversationId[conversationId];
    if (
      !liveEstimate ||
      !liveEstimate.baseline ||
      runtime.phase !== "streaming" ||
      runtime.sessionId !== liveEstimate.sessionId ||
      runtime.assistantMessageId !== liveEstimate.assistantMessageId ||
      liveEstimate.baseline.sessionId !== liveEstimate.sessionId ||
      liveEstimate.baseline.assistantMessageId !==
        liveEstimate.assistantMessageId
    ) {
      return null;
    }

    const payload = buildLiveStreamDiagnosticsPayload(liveEstimate);
    if (!payload) {
      return null;
    }

    return { runtime, liveEstimate, payload };
  };

  const buildLiveStreamContextDiagnostics = async (
    conversationId: string,
  ): Promise<{
    liveEstimate: LiveStreamContextEstimate;
    diagnostics: ConversationContextDiagnostics;
  } | null> => {
    const liveContext = resolveActiveLiveStreamDiagnosticsPayload(conversationId);
    if (!liveContext) {
      return null;
    }
    const { liveEstimate, payload, runtime } = liveContext;

    const budgetPolicy = await loadContextBudgetPolicy();
    if (!isLiveStreamEstimateCurrent(conversationId, liveEstimate)) {
      return null;
    }

    const estimateSerializedPayloadTokens = (messages: StreamMessage[]) =>
      estimateSerializedPayloadTokensForProvider({
        messages,
        providerType: payload.baseline.providerType,
        providerId: payload.baseline.providerId,
        baseUrl: payload.baseline.baseUrl,
        modelId: payload.baseline.modelId,
      });
    const preparedMessagesForContext = normalizeMessagesForProviderContext(
      payload.baseline.providerType,
      payload.preparedMessages,
    );
    const footprint = estimateConversationFootprint({
      systemMessage: payload.systemMessage,
      preparedMessages: preparedMessagesForContext,
      orderedMessages: payload.orderedMessages,
      citations: payload.citations,
      toolDefinitions: payload.baseline.toolDefinitions,
      modelContextWindowTokens: payload.baseline.modelContextWindowTokens,
      inputLimitTokens: payload.baseline.inputLimitTokens,
      outputLimitTokens: payload.baseline.outputLimitTokens,
      contextLimitSource: payload.baseline.contextLimitSource,
      isContextLimitAuthoritative: payload.baseline.isContextLimitAuthoritative,
      contextLimitConfidence: payload.baseline.contextLimitConfidence,
      contextLimitWarning: payload.baseline.contextLimitWarning,
      estimateSerializedPayloadTokens,
      countProviderInputItems: shouldCountProviderInputItemsForContext(
        payload.baseline.providerType,
      ),
      mode: "blocking",
      budgetPolicy,
    });
    const hasCompactedPayload = liveStreamBaselineHasCompaction(payload.baseline);
    const phase: ConversationContextDiagnostics["phase"] =
      isProviderRuntimeError(runtime)
        ? "provider_error"
        : footprint.isHardStop
          ? "too_large"
          : isContextFootprintOverUsableBudget(footprint)
            ? "needs_manual_compaction"
          : hasCompactedPayload
            ? "compacted"
            : "idle";

    return {
      liveEstimate,
      diagnostics: buildContextDiagnosticsFromFootprint({
        conversationId,
        providerId: payload.baseline.providerId,
        providerType: payload.baseline.providerType,
        modelId: payload.baseline.modelId,
        status: "ready",
        source: "live_stream",
        phase,
        decision: footprint.isHardStop
          ? "hard_stop"
          : payload.baseline.compactionDecision ?? "send",
        footprintAfter: footprint,
        orderedMessages: payload.orderedMessages,
        preparedMessages: preparedMessagesForContext,
        citations: payload.citations,
      }),
    };
  };

  const recalcConversation = (
    conversationId: string,
    messages: ChatMessage[],
    updatedAt?: string,
  ) => {
    const conversationMessages =
      indexMessagesByConversation(messages)[conversationId] ?? [];
    const lastMessage = conversationMessages[conversationMessages.length - 1];
    return {
      message_count: conversationMessages.length,
      last_message: lastMessage?.content ?? "",
      updated_at: updatedAt ?? new Date().toISOString(),
    };
  };

  const getConversationGroupId = (
    conversation: Conversation,
  ): string | null => {
    if (conversation.group_id) {
      return conversation.group_id;
    }

    return (
      getProjectGroupByProjectId(
        useAppStore.getState().projectGroups,
        conversation.project_id,
      )?.id ?? null
    );
  };

  const getConversationScopeMode = (conversation: Conversation): AppMode => {
    if (
      conversation.scope_mode === "Architect" ||
      conversation.scope_mode === "Implement" ||
      conversation.scope_mode === "Chat"
    ) {
      return conversation.scope_mode;
    }

    if (conversation.task_id) {
      return "Implement";
    }

    if (conversation.group_id || conversation.project_id) {
      return "Architect";
    }

    return "Chat";
  };

  const isConversationAllowedForMode = (
    conversation: Conversation,
    mode: AppMode,
    selectedGroupId: string | null,
    selectedProjectId: string | null,
    selectedTaskId: string | null,
  ): boolean => {
    if (getConversationScopeMode(conversation) !== mode) {
      return false;
    }

    if (mode === "Chat") {
      return true;
    }

    if (mode === "Architect") {
      if (!selectedGroupId && !selectedProjectId) {
        return false;
      }

      if (selectedGroupId) {
        return (
          getConversationGroupId(conversation) === selectedGroupId &&
          !conversation.task_id
        );
      }
      if (selectedProjectId) {
        return (
          conversation.project_id === selectedProjectId && !conversation.task_id
        );
      }
      return !conversation.task_id;
    }

    if (mode === "Implement") {
      if (!selectedTaskId) {
        return !conversation.task_id;
      }
      const tasks = useTaskStore.getState().tasks;
      const selectedTask = resolveTaskReference(tasks, selectedTaskId);
      return Boolean(selectedTask && taskReferenceMatches(tasks, selectedTask, conversation.task_id));
    }

    return false;
  };

  const getFallbackConversationIdForMode = (
    conversations: Conversation[],
    mode: AppMode,
    selectedGroupId: string | null,
    selectedProjectId: string | null,
    selectedTaskId: string | null,
    excludedConversationIds: ReadonlySet<string> = EMPTY_STRING_SET,
  ): string | null => {
    const scoped = conversations
      .filter((conversation) =>
        !excludedConversationIds.has(conversation.id) &&
        isConversationAllowedForMode(
          conversation,
          mode,
          selectedGroupId,
          selectedProjectId,
          selectedTaskId,
        ),
      )
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );

    return scoped[0]?.id ?? null;
  };

  const getLatestConversationForTask = (
    taskId: string,
    conversations: Conversation[] = get().conversations,
  ): Conversation | null => {
    const tasks = useTaskStore.getState().tasks;
    const task = resolveTaskReference(tasks, taskId);
    if (!task) return null;
    return conversations
      .filter(
        (conversation) =>
          getConversationScopeMode(conversation) === "Implement" &&
          taskReferenceMatches(tasks, task, conversation.task_id),
      )
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0] ?? null;
  };

  type ConversationRemovalSnapshot = Pick<
    ChatStore,
    | "conversations"
    | "messages"
    | "messagesByConversationId"
    | "messageIndexById"
    | "messageLoadStatusByConversationId"
    | "contextDiagnosticsByConversationId"
    | "liveStreamContextEstimatesByConversationId"
    | "messageImagesByMessageId"
    | "questionnaireDraftsByConversationId"
    | "pendingToolApprovalByConversationId"
    | "conversationApprovalGrantsByConversationId"
    | "skillTurnFeedbackByMessageId"
    | "conversationRuntimeById"
    | "selectedConversationId"
    | "selectedConversationIdsByMode"
  >;

  const buildConversationRemovalState = (
    state: ConversationRemovalSnapshot,
    conversationIds: string[],
  ): ConversationRemovalSnapshot => {
    const idsToRemove = new Set(conversationIds);
    const appState = useAppStore.getState();
    const nextConversations = state.conversations.filter(
      (conversation) => !idsToRemove.has(conversation.id),
    );
    const nextMessages = state.messages.filter(
      (message) => !idsToRemove.has(message.conversation_id),
    );
    const remainingMessageIds = new Set(
      nextMessages.map((message) => message.id),
    );
    const nextImages = Object.fromEntries(
      Object.entries(state.messageImagesByMessageId).filter(([messageId]) =>
        remainingMessageIds.has(messageId),
      ),
    );
    saveMessageImagesToStorage(nextImages);
    const nextQuestionnaireDrafts = clearQuestionnaireDraftsForConversations(
      state.questionnaireDraftsByConversationId,
      conversationIds,
    );
    saveQuestionnaireDraftsToStorage(nextQuestionnaireDrafts);
    const nextPendingToolApprovals = Object.fromEntries(
      Object.entries(state.pendingToolApprovalByConversationId).filter(
        ([conversationId]) => !idsToRemove.has(conversationId),
      ),
    );
    const nextConversationApprovalGrants = Object.fromEntries(
      Object.entries(state.conversationApprovalGrantsByConversationId).filter(
        ([conversationId]) => !idsToRemove.has(conversationId),
      ),
    );
    const nextSkillTurnFeedback = Object.fromEntries(
      Object.entries(state.skillTurnFeedbackByMessageId).filter(([messageId]) =>
        remainingMessageIds.has(messageId),
      ),
    );
    const nextMessageLoadStatusByConversationId = Object.fromEntries(
      Object.entries(state.messageLoadStatusByConversationId).filter(
        ([conversationId]) => !idsToRemove.has(conversationId),
      ),
    );
    const nextContextDiagnosticsByConversationId = Object.fromEntries(
      Object.entries(state.contextDiagnosticsByConversationId).filter(
        ([conversationId]) => !idsToRemove.has(conversationId),
      ),
    );
    const nextLiveStreamContextEstimatesByConversationId = Object.fromEntries(
      Object.entries(state.liveStreamContextEstimatesByConversationId).filter(
        ([conversationId]) => !idsToRemove.has(conversationId),
      ),
    );

    const nextByMode = { ...state.selectedConversationIdsByMode };
    (Object.keys(nextByMode) as AppMode[]).forEach((modeKey) => {
      if (nextByMode[modeKey] && idsToRemove.has(nextByMode[modeKey]!)) {
        nextByMode[modeKey] = null;
      }
    });

    const fallbackForCurrentMode = getFallbackConversationIdForMode(
      nextConversations,
      appState.mode,
      appState.selectedGroupId,
      appState.selectedProjectId,
      appState.selectedTaskId,
    );

    const nextSelectedConversationId =
      state.selectedConversationId &&
      idsToRemove.has(state.selectedConversationId)
        ? fallbackForCurrentMode
        : state.selectedConversationId;

    nextByMode[appState.mode] =
      nextSelectedConversationId &&
      nextConversations.some(
        (conversation) => conversation.id === nextSelectedConversationId,
      )
        ? nextSelectedConversationId
        : fallbackForCurrentMode;

    const nextConversationRuntimeById = Object.fromEntries(
      Object.entries(state.conversationRuntimeById).filter(
        ([conversationId]) => !idsToRemove.has(conversationId),
      ),
    );

    return {
      conversations: nextConversations,
      ...buildMessageState(nextMessages),
      messageLoadStatusByConversationId: nextMessageLoadStatusByConversationId,
      contextDiagnosticsByConversationId: nextContextDiagnosticsByConversationId,
      liveStreamContextEstimatesByConversationId:
        nextLiveStreamContextEstimatesByConversationId,
      messageImagesByMessageId: nextImages,
      questionnaireDraftsByConversationId: nextQuestionnaireDrafts,
      pendingToolApprovalByConversationId: nextPendingToolApprovals,
      conversationApprovalGrantsByConversationId:
        nextConversationApprovalGrants,
      skillTurnFeedbackByMessageId: nextSkillTurnFeedback,
      conversationRuntimeById: nextConversationRuntimeById,
      ...buildLegacyStreamingFlags({
        conversationRuntimeById: nextConversationRuntimeById,
        selectedConversationId: nextSelectedConversationId,
      }),
      selectedConversationId: nextSelectedConversationId,
      selectedConversationIdsByMode: nextByMode,
    };
  };

  const applyLocalConversationRemoval = (conversationIds: string[]) => {
    if (conversationIds.length === 0) {
      return;
    }
    clearPendingArchitectConversationsForConversationIds(conversationIds);
    clearGitStageCommitChallengesForConversations(conversationIds);
    clearAssistantTurnContextsForConversations(conversationIds);
    conversationIds.forEach((conversationId) => {
      clearConversationSecurityState(conversationId);
      cancelLiveContextDiagnosticsRefreshSchedule(conversationId);
      pendingAgentCodeReplayRollbacksByConversationId.delete(conversationId);
    });
    set((state) => buildConversationRemovalState(state, conversationIds));
  };

  const hydrateSelectedConversationAfterRemoval = async (
    removedConversationIds: string[],
  ): Promise<void> => {
    const conversationId = get().selectedConversationId;
    if (!conversationId || removedConversationIds.includes(conversationId)) {
      return;
    }
    const mode = useAppStore.getState().mode;
    await ensureMessagesLoadedForConversation(conversationId);
    await hydrateConversationCitationsIfAvailable(conversationId);
    await hydrateConversationToolboxStateIfAvailable(conversationId);
    await getConversationCompactionState(conversationId);
    await runAiSelectionRestore({
      mode,
      conversationId,
      activeContextKey: get().activeContextKey,
      shouldShowResolving: true,
    });
  };

  const getAllowedToolIdsForCurrentMode = async (
    internalAgentProfile?: InternalAgentProfile | null,
    modeOverride?: AppMode,
    agentTypeOverride?: AgentType | null,
    providerSnapshot?: {
      supportsNativeToolCalling: boolean;
      providerConfig: NonNullable<
        ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
      >;
      modelId: string;
    },
  ): Promise<string[]> => {
    if (
      providerSnapshot
        ? !providerSnapshot.supportsNativeToolCalling
        : !useProviderStore.getState().selectedSupportsNativeToolCalling()
    ) {
      return [];
    }

    const riskLevel = await loadToolRiskLevelPreference();
    const providerState = useProviderStore.getState();
    const selectedProvider =
      providerSnapshot?.providerConfig ??
      providerState.providerConfigs.find(
        (provider) => provider.id === providerState.selectedProviderId,
      );
    const selectedModelId =
      providerSnapshot?.modelId ?? providerState.selectedModelId;
    const strategyFilterForSelectedProvider = (toolIds: string[]): string[] =>
      applyEditingStrategyToToolIds(
        toolIds,
        selectedProvider?.providerType,
        selectedModelId,
      );
    const filterForSelectedProvider = (toolIds: string[]): string[] =>
      selectedProvider?.providerType === "copilot"
        ? filterCopilotSupportedToolIds(
            strategyFilterForSelectedProvider(toolIds),
          )
        : strategyFilterForSelectedProvider(toolIds);
    const appState = useAppStore.getState();
    const mode = modeOverride ?? appState.mode;
    const activePlanContext = appState.activePlanContext;
    const filterStrategyMutationToolsForActivePlan = (toolIds: string[]): string[] => {
      if (
        mode !== "Architect" ||
        !isArchitectPlanStrategyMutationLocked(activePlanContext?.status)
      ) {
        return toolIds;
      }
      return toolIds.filter((toolId) => !ARCHITECT_STRATEGY_MUTATION_TOOL_IDS.has(toolId));
    };
    const finalizeAllowedToolIds = (toolIds: string[]): string[] => {
      const uniqueToolIds = filterStrategyMutationToolsForActivePlan(
        Array.from(new Set(toolIds)),
      );
      const filteredToolIds = filterToolIdsForInternalAgentProfile(
        filterForSelectedProvider(uniqueToolIds),
        internalAgentProfile,
      );
      const riskFilteredToolIds = filterDeniedToolIdsForRiskLevel(
        filteredToolIds,
        riskLevel,
      );
      const availableToolIds = filterSkillToolsForAvailability(riskFilteredToolIds, {
        tauriAvailable: chatPersistenceAdapters.isTauriAvailable(),
      });

      if (
        internalAgentProfile === "task_reviewer" &&
        uniqueToolIds.includes("apply_patch") &&
        !availableToolIds.includes("apply_patch")
      ) {
        return Array.from(new Set([...availableToolIds, "apply_patch"]));
      }

      return availableToolIds;
    };

    const agentType =
      mode === "Implement"
        ? (agentTypeOverride ?? appState.agentType)
        : null;
    const modePolicy = await getModePolicyForCurrentMode(mode);
    const lockedAgentToolIds = LOCKED_AGENT_TOOL_IDS.filter((toolId) =>
      modePolicy.allowedToolIds.includes(toolId),
    );
    const toolsState = useToolsStore.getState();
    const enabledMCPToolIds = selectInjectableMCPToolIds({
      enabledToolIds: toolsState.getEnabledMCPToolIds(),
      supportsNativeToolCalling: true,
      providerType: selectedProvider?.providerType,
      mode,
      agentType,
    });

    if (mode === "Chat") {
      const enabledChatTools = toolsState.getEnabledChatToolIds();
      return finalizeAllowedToolIds(
        [
          ...enabledChatTools.filter((toolId) =>
            modePolicy.allowedToolIds.includes(toolId),
          ),
          ...lockedAgentToolIds,
          ...enabledMCPToolIds,
        ],
      );
    }

    const enabledTools = Object.values(toolsState.internalTools)
      .filter((tool) => toolsState.isToolEnabled(tool.id))
      .map((tool) => tool.id);

    const modeAllowedToolIds =
      mode === "Implement" && agentType
        ? getImplementAgentToolPolicy(agentType).allowedToolIds.filter(
            (toolId) => modePolicy.allowedToolIds.includes(toolId),
          )
        : modePolicy.allowedToolIds;

    return finalizeAllowedToolIds(
      [
        ...enabledTools.filter((toolId) => modeAllowedToolIds.includes(toolId)),
        ...lockedAgentToolIds.filter((toolId) =>
          modeAllowedToolIds.includes(toolId),
        ),
        ...enabledMCPToolIds,
      ],
    );
  };

  const buildGuidedToolRetryPolicy = (params: {
    userContent: string;
    allowedToolIds: string[];
    supportsNativeToolCalling?: boolean;
    fileToolContext: Array<{
      title: string;
      source: string;
      path?: string;
      snippet?: string;
      content?: string;
    }>;
  }) => {
    if (
      !(
        params.supportsNativeToolCalling ??
        useProviderStore.getState().selectedSupportsNativeToolCalling()
      )
    ) {
      return undefined;
    }

    if (
      params.allowedToolIds.includes("question") &&
      userExplicitlyRequestsQuestionTool(params.userContent)
    ) {
      return {
        requiredToolNames: ["question"],
        retrySystemPrompt:
          "The user explicitly asked you to use the question tool. " +
          "If you need clarification, call question instead of asking in plain text. " +
          "Emit exactly one question tool call, then stop and wait for the user questionnaire response.",
        maxRetries: 1,
      };
    }

    if (
      params.fileToolContext.length > 0 &&
      params.allowedToolIds.includes("read_file")
    ) {
      return {
        requiredToolNames: ["read_file"],
        retrySystemPrompt:
          "You must call read_file before answering about attached files or document context. " +
          "Do not summarize, infer, or quote file contents until read_file has been used with the exact file name or path. " +
          "If the filename is ambiguous, say so only after attempting the appropriate tool call.",
        maxRetries: 1,
      };
    }

    return undefined;
  };

  const prepareMetadataMessages = (firstUserContent: string) => [
    {
      role: "system" as const,
      content:
        "Generate concise metadata for this conversation. Return ONLY valid JSON with keys: title, description. " +
        "title: 3-7 words, specific and action-oriented. description: one clear sentence under 180 characters.",
    },
    {
      role: "user" as const,
      content: firstUserContent,
    },
  ];

  const prepareManualFeatureMetadataMessages = (
    taskTitle: string,
    firstUserContent: string,
    unavailableBranchNames: string[] = [],
    selectedTaskKind?: StandaloneTaskKind | null,
  ) => {
    const unavailableBranchSummary =
      unavailableBranchNames.length > 0
        ? ` These branch names are already taken and must not be reused: ${unavailableBranchNames.join(", ")}. Return a different featureSlug.`
        : "";

    return [
      {
        role: "system" as const,
        content:
          "Generate concise metadata for a standalone implementation task. Return ONLY valid JSON with keys: title, description, featureSlug, taskKind. " +
          "title: 3-7 words, specific and action-oriented. description: one clear sentence under 180 characters. " +
          "featureSlug: lowercase kebab-case branch slug without any branch prefix. " +
          (selectedTaskKind
            ? `taskKind must be exactly ${selectedTaskKind}, as selected by the user. Do not change it. `
            : "taskKind must be exactly feature, bugfix, or hotfix. ") +
          "The concrete branch name is rendered later from the selected project's Git Flow template." +
          unavailableBranchSummary,
      },
      {
        role: "user" as const,
        content: `Task title: ${taskTitle}\nImplementation request: ${firstUserContent}`,
      },
    ];
  };

  const updateConversationMetadataLocally = (
    conversationId: string,
    metadata: { title: string; description: string },
  ) => {
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title: metadata.title,
              description: metadata.description,
              updated_at: new Date().toISOString(),
            }
          : conversation,
      ),
    }));
  };

  const persistConversationMetadata = async (
    conversationId: string,
    metadata: { title: string; description: string },
  ) => {
    updateConversationMetadataLocally(conversationId, metadata);

    if (!tauriIpc.isTauriAvailable()) {
      return;
    }

    await tauriIpc.updateConversationDetails({
      id: conversationId,
      title: metadata.title,
      description: metadata.description,
    });
  };

  type ManualFeatureDraftRecovery = {
    taskId: string;
    conversationId: string;
    metadata: {
      title: string;
      description: string;
    };
  };

  const getManualFeatureDraftRecoveryMetadata = (
    conversationId: string,
  ): ManualFeatureDraftRecovery["metadata"] => {
    const conversation = get().conversations.find(
      (candidate) => candidate.id === conversationId,
    );

    return {
      title: conversation?.title?.trim() || "New feature",
      description: conversation?.description ?? "",
    };
  };

  const rollbackManualFeatureDraftAfterFailedLaunch = async (
    recovery: ManualFeatureDraftRecovery,
  ) => {
    try {
      await useTaskStore.getState().revertManualFeatureToDraft({
        taskId: recovery.taskId,
        conversationId: recovery.conversationId,
        title: recovery.metadata.title,
        description: recovery.metadata.description,
      });
      await persistConversationMetadata(
        recovery.conversationId,
        recovery.metadata,
      );
    } catch (error) {
      console.warn(
        "Failed to revert manual feature draft after assistant launch failure:",
        error,
      );
    }
  };

  const maybeFinalizeManualFeatureDraftForAssistantRequest = async (params: {
    conversationId: string;
    taskId: string;
    userContent: string;
    providerId: string;
    providerType: string;
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
  }): Promise<ManualFeatureDraftRecovery | null> => {
    const task = useTaskStore.getState().getTaskById(params.taskId);
    if (
      !task ||
      task.task_source !== "standalone" ||
      task.standalone_kind !== "manual_feature" ||
      task.draft !== true
    ) {
      return null;
    }

    const recovery: ManualFeatureDraftRecovery = {
      taskId: params.taskId,
      conversationId: params.conversationId,
      metadata: getManualFeatureDraftRecoveryMetadata(params.conversationId),
    };

    try {
      await finalizeManualFeatureDraftIfNeeded({
        conversationId: params.conversationId,
        taskId: params.taskId,
        firstUserContent: params.userContent,
        providerId: params.providerId,
        providerType: params.providerType,
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        modelId: params.modelId,
        reasoningEffort: params.reasoningEffort,
      });
    } catch (error) {
      await rollbackManualFeatureDraftAfterFailedLaunch(recovery);
      throw error;
    }

    return recovery;
  };

  const shouldGenerateArchitectPlanTitleFromFirstMessage = (
    plan: ArchitectPlanRecord,
    conversationId: string,
  ): boolean =>
    plan.status !== "deleted" &&
    plan.conversationId === conversationId &&
    isCanonicalArchitectPlan(plan) &&
    isDefaultNewPlanFamilyLabel(plan.label) &&
    !hasPersistedArchitectStrategy(plan);

  const requestConversationMetadata = async (params: {
    firstUserContent: string;
    providerId: string;
    providerType: string;
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
  }): Promise<{ title: string; description: string }> => {
    const output = await sendChatNonStreaming({
      providerId: params.providerId,
      providerType: params.providerType,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      modelId: params.modelId,
      reasoningEffort: params.reasoningEffort,
      messages: prepareMetadataMessages(params.firstUserContent),
      onComplete: () => {},
      onError: () => {},
    });

    return extractMetadataFromModelOutput(output);
  };

  const requestConversationMetadataWithRetries = async (
    params: Parameters<typeof requestConversationMetadata>[0],
    attemptLimit: number,
  ): Promise<{ title: string; description: string }> => {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      try {
        return await requestConversationMetadata(params);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("Failed to generate conversation metadata.");
  };

  const hydrateActiveArchitectPlanIfNeeded = async (params: {
    updatedPlan: ArchitectPlanRecord;
    targetBranch: string;
  }) => {
    const appState = useAppStore.getState();
    if (
      appState.activeArchitectPlanId !== params.updatedPlan.id ||
      resolveTargetBranch(appState.activePlanContext?.targetBranch) !==
        params.targetBranch
    ) {
      return;
    }

    appState.setPlanNodes(params.updatedPlan.nodes || []);
    appState.setPredictedBranches(params.updatedPlan.predictedBranches || []);
    appState.setActivePlanContext({
      id: params.updatedPlan.id,
      slug: params.updatedPlan.slug,
      title: params.updatedPlan.title,
      label: params.updatedPlan.label,
      description: params.updatedPlan.description,
      status: params.updatedPlan.status,
      targetBranch: params.updatedPlan.targetBranch,
      targetBranchesByProjectId: params.updatedPlan.targetBranchesByProjectId,
      hasMixedTargetBranches:
        Boolean(params.updatedPlan.targetBranchesByProjectId) &&
        new Set(
          Object.values(params.updatedPlan.targetBranchesByProjectId || {}),
        ).size > 1,
    });

  };

  const syncConversationMetadataFromArchitectPlan = async (
    conversationId: string,
    plan: ArchitectPlanRecord,
    descriptionOverride?: string,
  ) => {
    await persistConversationMetadata(conversationId, {
      title: getArchitectPlanConversationTitle(plan),
      description: descriptionOverride ?? plan.description ?? "",
    });
  };

  const finalizeManualFeatureDraftIfNeeded = async (params: {
    conversationId: string;
    taskId: string;
    firstUserContent: string;
    providerId: string;
    providerType: string;
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
  }) => {
    const taskStore = useTaskStore.getState();
    const task = taskStore.getTaskById(params.taskId);
    if (
      !task ||
      task.task_source !== "standalone" ||
      task.standalone_kind !== "manual_feature" ||
      task.draft !== true
    ) {
      return;
    }

    const metadataProviderContext =
      await resolveMetadataGenerationProviderContext({
        providerId: params.providerId,
        providerType: params.providerType,
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        modelId: params.modelId,
        reasoningEffort: params.reasoningEffort,
      });
    const selectedTaskKind = task.task_kind ?? null;
    const keepSelectedTaskKind = (
      metadata: ReturnType<typeof buildManualFeatureFallbackMetadata>,
    ): ReturnType<typeof buildManualFeatureFallbackMetadata> =>
      selectedTaskKind ? { ...metadata, taskKind: selectedTaskKind } : metadata;

    const appState = useAppStore.getState();
    const executionTask = retargetImplementTaskForSelection(task, {
      standaloneProjects: appState.standaloneProjects,
      projectGroups: appState.projectGroups,
      selectedGroupId: appState.selectedGroupId,
      selectedProjectId: appState.selectedProjectId,
    });
    const projectIds = Array.from(
      new Set(
        [...(executionTask.project_ids || []), executionTask.project_id].filter(
          (projectId): projectId is string =>
            typeof projectId === "string" && projectId.trim().length > 0,
        ),
      ),
    );

    const renderManualFeatureBranchCandidates = (
      featureSlug: string,
      taskKind: StandaloneTaskKind,
    ): Array<{ projectId: string; branchName: string }> => {
      const projectIdsToCheck =
        projectIds.length > 0
          ? projectIds
          : appState.selectedGroupId
            ? getScopedActionableProjectIds(
                {
                  standaloneProjects: appState.standaloneProjects,
                  projectGroups: appState.projectGroups,
                },
                appState.selectedGroupId,
                null,
              )
            : appState.selectedProjectId
              ? getScopedActionableProjectIds(
                  {
                    standaloneProjects: appState.standaloneProjects,
                    projectGroups: appState.projectGroups,
                  },
                  null,
                  appState.selectedProjectId,
                )
            : [];

      return projectIdsToCheck.map((projectId) => ({
        projectId,
        branchName: renderStandaloneTaskBranchName({
          taskKind,
          taskSlug: featureSlug,
          settings: appState.getProjectById(projectId)?.gitFlowSettings,
        }),
      }));
    };

    const findConflictingBranchCandidates = async (
      featureSlug: string,
      taskKind: StandaloneTaskKind,
    ): Promise<Array<{ projectId: string; branchName: string }>> => {
      if (!tauriIpc.isTauriAvailable()) {
        return [];
      }

      const branchCandidates = renderManualFeatureBranchCandidates(featureSlug, taskKind);

      const conflictResults = await Promise.all(
        branchCandidates.map(async (candidate) => {
          const repoPath = appState
            .getProjectById(candidate.projectId)
            ?.path?.trim();
          if (!repoPath) {
            return null;
          }

          const branches = await tauriIpc.gitBranchList(repoPath);
          const branchTaken = [...branches.local, ...branches.remote].some(
            (branch) =>
              branchNameMatchesCandidate(branch.name, candidate.branchName),
          );

          return branchTaken ? candidate : null;
        }),
      );

      return conflictResults.filter(
        (candidate): candidate is { projectId: string; branchName: string } =>
          Boolean(candidate),
      );
    };

    const requestManualFeatureMetadata = async (
      unavailableBranchNames: string[],
    ) => {
      const output = await sendChatNonStreaming({
        providerId: metadataProviderContext.providerId,
        providerType: metadataProviderContext.providerType,
        baseUrl: metadataProviderContext.baseUrl,
        apiKey: metadataProviderContext.apiKey,
        modelId: metadataProviderContext.modelId,
        reasoningEffort: metadataProviderContext.reasoningEffort,
        messages: prepareManualFeatureMetadataMessages(
          task.title,
          params.firstUserContent,
          unavailableBranchNames,
          selectedTaskKind,
        ),
        onComplete: () => {},
        onError: () => {},
      });
      return keepSelectedTaskKind(extractManualFeatureMetadataFromModelOutput(output));
    };

    const resolveAvailableFallbackSlug = async (
      baseSlug: string,
    ): Promise<string> => {
      const normalizedBaseSlug = normalizeManualFeatureSlugInput(baseSlug);

      for (let suffix = 0; suffix < 50; suffix += 1) {
        const candidateSlug =
          suffix === 0
            ? normalizedBaseSlug
            : normalizeManualFeatureSlugInput(
                `${normalizedBaseSlug}-${suffix + 1}`,
              );
        const conflictingCandidates =
          await findConflictingBranchCandidates(candidateSlug, metadata.taskKind);
        if (conflictingCandidates.length === 0) {
          return candidateSlug;
        }
      }

      return `work-${Date.now().toString(36)}`;
    };

    let metadata = keepSelectedTaskKind(
      buildManualFeatureFallbackMetadata(params.firstUserContent, task.title),
    );
    let unavailableBranchNames: string[] = [];

    for (
      let attempt = 0;
      attempt < MANUAL_FEATURE_METADATA_ATTEMPT_LIMIT;
      attempt += 1
    ) {
      if (attempt === 0) {
        try {
          metadata = await requestManualFeatureMetadata(unavailableBranchNames);
        } catch {
          metadata = keepSelectedTaskKind(
            buildManualFeatureFallbackMetadata(params.firstUserContent, task.title),
          );
        }
      } else {
        try {
          metadata = await requestManualFeatureMetadata(unavailableBranchNames);
        } catch {
          metadata = {
            ...metadata,
            featureSlug: await resolveAvailableFallbackSlug(
              metadata.featureSlug,
            ),
          };
        }
      }

      const conflictingCandidates = await findConflictingBranchCandidates(
        metadata.featureSlug,
        metadata.taskKind,
      );
      if (conflictingCandidates.length === 0) {
        break;
      }

      unavailableBranchNames = Array.from(
        new Set([
          ...unavailableBranchNames,
          ...conflictingCandidates.map((candidate) => candidate.branchName),
        ]),
      );
      if (attempt === MANUAL_FEATURE_METADATA_ATTEMPT_LIMIT - 1) {
        metadata = {
          ...metadata,
          featureSlug: await resolveAvailableFallbackSlug(metadata.featureSlug),
        };
        break;
      }
    }

    updateConversationMetadataLocally(params.conversationId, metadata);

    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.updateConversationDetails({
        id: params.conversationId,
        title: metadata.title,
        description: metadata.description,
      });
    }

    await taskStore.finalizeManualFeatureDraft({
      taskId: params.taskId,
      conversationId: params.conversationId,
      title: metadata.title,
      description: metadata.description,
      featureSlug: metadata.featureSlug,
      taskKind: metadata.taskKind,
    });
    await taskStore.startTask(params.taskId);

    const refreshedTask = useTaskStore.getState().getTaskById(params.taskId);
    if (
      !refreshedTask ||
      refreshedTask.draft ||
      refreshedTask.status !== "InProgress"
    ) {
      const failureMessage =
        useTaskStore.getState().lastError ||
        "Failed to initialize the manual feature execution context.";
      throw new Error(failureMessage);
    }
  };

  const loadRecoverableArchitectPlan = async (params: {
    architectPlan: {
      planId: string;
      targetBranch: string;
    };
    conversationId: string;
  }): Promise<ArchitectPlanRecord | null> => {
    try {
      const plan = await getArchitectPlan(
        params.architectPlan.targetBranch,
        params.architectPlan.planId,
      );
      if (
        !plan ||
        !shouldGenerateArchitectPlanTitleFromFirstMessage(
          plan,
          params.conversationId,
        )
      ) {
        return null;
      }

      return plan;
    } catch (error) {
      console.warn(
        "Failed to load architect plan metadata from first message:",
        error,
      );
      return null;
    }
  };

  const bindPendingArchitectConversationIfNeeded = async (params: {
    architectPlan: {
      planId: string;
      targetBranch: string;
    };
    conversationId: string;
  }): Promise<boolean> => {
    const pendingConversationId = getPendingArchitectConversationId({
      targetBranch: params.architectPlan.targetBranch,
      planId: params.architectPlan.planId,
    });
    if (!pendingConversationId) {
      return true;
    }
    if (pendingConversationId !== params.conversationId) {
      return false;
    }

    try {
      await bindArchitectPlanConversation({
        branchName: params.architectPlan.targetBranch,
        planId: params.architectPlan.planId,
        conversationId: params.conversationId,
      });
      clearPendingArchitectConversationForPlan({
        targetBranch: params.architectPlan.targetBranch,
        planId: params.architectPlan.planId,
      });
      return true;
    } catch (error) {
      logArchitectTranscriptEvent(
        "warn",
        "architect_conversation_binding_failed",
        {
          planId: params.architectPlan.planId,
          conversationId: params.conversationId,
          error: toServiceError(error).message,
        },
      );
      return false;
    }
  };

  const applyArchitectPlanInitialMetadata = async (params: {
    architectPlan: {
      planId: string;
      targetBranch: string;
    };
    conversationId: string;
    metadata: {
      title: string;
      description: string;
    };
  }): Promise<boolean> => {
    const recoverablePlan = await loadRecoverableArchitectPlan({
      architectPlan: params.architectPlan,
      conversationId: params.conversationId,
    });
    if (!recoverablePlan) {
      return false;
    }

    const nextDescription =
      recoverablePlan.description.trim() || params.metadata.description;
    const updatedPlan = await updateArchitectPlan({
      branchName: params.architectPlan.targetBranch,
      planId: recoverablePlan.id,
      label: params.metadata.title,
      description: nextDescription,
    });

    await syncConversationMetadataFromArchitectPlan(
      params.conversationId,
      updatedPlan,
      nextDescription,
    );
    await hydrateActiveArchitectPlanIfNeeded({
      updatedPlan,
      targetBranch: params.architectPlan.targetBranch,
    });

    set((state) => ({
      architectPlanNamingRecovery:
        state.architectPlanNamingRecovery?.planId === updatedPlan.id &&
        state.architectPlanNamingRecovery?.conversationId ===
          params.conversationId
          ? null
          : state.architectPlanNamingRecovery,
    }));

    return true;
  };

  const maybeGenerateConversationMetadata = async (params: {
    conversationId: string;
    firstUserContent: string;
    providerId: string;
    providerType: string;
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
    architectPlan?: {
      planId: string;
      targetBranch: string;
    };
  }) => {
    const {
      conversationId,
      firstUserContent,
      providerId,
      providerType,
      baseUrl,
      apiKey,
      modelId,
      reasoningEffort,
      architectPlan,
    } = params;

    if (metadataGenerationInFlight.has(conversationId)) return;
    metadataGenerationInFlight.add(conversationId);

    try {
      const metadataProviderContext =
        await resolveMetadataGenerationProviderContext({
          providerId,
          providerType,
          baseUrl,
          apiKey,
          modelId,
          reasoningEffort,
        });

      if (architectPlan) {
        const recoverablePlan = await loadRecoverableArchitectPlan({
          architectPlan,
          conversationId,
        });
        if (recoverablePlan) {
          try {
            const metadata = await requestConversationMetadataWithRetries(
              {
                firstUserContent,
                ...metadataProviderContext,
              },
              ARCHITECT_PLAN_METADATA_ATTEMPT_LIMIT,
            );
            await applyArchitectPlanInitialMetadata({
              architectPlan,
              conversationId,
              metadata,
            });
          } catch (error) {
            console.warn(
              "Failed to generate architect plan metadata from first message:",
              error,
            );
            set({
              architectPlanNamingRecovery: {
                conversationId,
                planId: architectPlan.planId,
                targetBranch: architectPlan.targetBranch,
                firstUserContent,
                providerId,
                modelId,
                reasoningEffort,
                stage: "choice",
                isSubmitting: false,
                error: null,
              },
            });
          }
          return;
        }

        return;
      }

      const metadata = await requestConversationMetadata({
        firstUserContent,
        ...metadataProviderContext,
      }).catch(() => ({
        title: getConversationFallbackTitle(firstUserContent),
        description: getConversationFallbackDescription(firstUserContent),
      }));

      await persistConversationMetadata(conversationId, metadata);
    } catch (error) {
      console.warn("Failed to update conversation metadata:", error);
    } finally {
      metadataGenerationInFlight.delete(conversationId);
    }
  };

  const persistProviderInputItemsForMessage = async (
    messageId: string,
    providerInputItems: unknown[] | undefined,
  ) => {
    if (!Array.isArray(providerInputItems) || providerInputItems.length === 0) {
      return;
    }

    const message = get().messages.find(
      (candidate) => candidate.id === messageId,
    );
    if (!message) {
      return;
    }

    try {
      await updateProviderInputItemsForMessage(chatPersistenceAdapters, {
        message,
        providerInputItems,
      });
      get().updateMessageFields(messageId, {
        provider_input_items: providerInputItems,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      throw buildSendError(
        `Failed to persist provider metadata for this message: ${normalized.message}`,
      );
    }
  };

  const buildUserMessageForSend = async (params: {
    conversationId: string;
    turnId: string;
    taskId: string;
    content: string;
    hiddenContext?: string;
    providerInputItems?: unknown[];
    contextRefs?: ChatMessage["context_refs"];
  }): Promise<ChatMessage> => {
    try {
      return await createUserMessage(chatPersistenceAdapters, params);
    } catch (error) {
      const normalized = toServiceError(error);
      throw buildSendError(
        `Failed to save the message before sending: ${normalized.message}`,
      );
    }
  };

  const buildAssistantMessageForSend = async (params: {
    conversationId: string;
    turnId: string;
    taskId: string;
  }): Promise<ChatMessage> => {
    try {
      return await createAssistantPlaceholderMessage(
        chatPersistenceAdapters,
        params,
      );
    } catch (error) {
      const normalized = toServiceError(error);
      throw buildSendError(
        `Failed to create the assistant message before streaming: ${normalized.message}`,
      );
    }
  };

  const prepareAssistantStreamLaunch = async (params: {
    conversationId: string;
    replyToMessageId: string;
    userContent: string;
    resolvedTaskId: string;
    modeAtSend: AppMode;
    agentTypeAtSend?: AgentType | null;
    providerId: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
    providerConfig: NonNullable<
      ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
    >;
    internalAgentProfile?: InternalAgentProfile | null;
    executionContext?: ProjectExecutionContext;
    providerSupportsNativeToolCalling?: boolean;
    compactionMode?: ContextCompactionKind;
    forceCompaction?: boolean;
    forcePrune?: boolean;
    compactionDisplayAfterMessageId?: string | null;
  }) => {
    try {
      await ensureToolsLoaded();
      const toolsState = useToolsStore.getState();
      const toolLoadError =
        typeof toolsState.lastError === "string" ? toolsState.lastError : null;
      if (
        toolLoadError &&
        Object.keys(toolsState.internalTools).length === 0
      ) {
        throw buildSendError(`Failed to load tool settings: ${toolLoadError}`);
      }
    } catch (error) {
      const normalized = toServiceError(error);
      throw buildSendError(normalized.message);
    }

    const taskStatus = params.resolvedTaskId
      ? useTaskStore.getState().getTaskById(params.resolvedTaskId)?.status ??
        null
      : null;
    const internalAgentProfile = resolveInternalAgentProfile({
      mode: params.modeAtSend,
      taskStatus,
      overrideProfile: params.internalAgentProfile,
    });
    const taskForToolScope = params.resolvedTaskId
      ? useTaskStore.getState().getTaskById(params.resolvedTaskId)
      : undefined;
    const baseAllowedToolIds = await getAllowedToolIdsForCurrentMode(
      internalAgentProfile,
      params.modeAtSend,
      params.agentTypeAtSend,
      {
        supportsNativeToolCalling:
          params.providerSupportsNativeToolCalling ??
          useProviderStore.getState().selectedSupportsNativeToolCalling(),
        providerConfig: params.providerConfig,
        modelId: params.modelId,
      },
    );
    const allowedToolIds =
      params.modeAtSend === "Implement"
        ? filterToolIdsForImplementTask(baseAllowedToolIds, taskForToolScope)
        : baseAllowedToolIds;
    const showToolTraces = false;
    const skillPermissionSnapshot = useSkillsStore
      .getState()
      .createSkillPermissionSnapshot(params.conversationId, params.replyToMessageId);
    const preparedRequest = await prepareMessagesForRequest(
      params.conversationId,
      allowedToolIds,
      internalAgentProfile,
      params.modeAtSend,
      params.agentTypeAtSend,
      params.replyToMessageId,
      skillPermissionSnapshot,
      params.executionContext,
    );
    set((state) => {
      const nextFeedback = { ...state.skillTurnFeedbackByMessageId };
      if (preparedRequest.skillTurnFeedback) {
        nextFeedback[preparedRequest.skillTurnFeedback.messageId] =
          preparedRequest.skillTurnFeedback;
      } else {
        delete nextFeedback[params.replyToMessageId];
      }
      return { skillTurnFeedbackByMessageId: nextFeedback };
    });
    const toolDefinitions = getToolDefinitionsForIds(allowedToolIds);
    await useProviderStore
      .getState()
      .ensureSelectedModelContextMetadata(
        params.providerId,
        params.modelId,
        "pre_send",
      );
    const { footprintFields } = getSelectedModelContext(
      params.providerId,
      params.modelId,
      params.providerConfig.providerType,
    );
    const budgetPolicy = await loadContextBudgetPolicy();
    const preparedMessagesForContext = normalizeMessagesForProviderContext(
      params.providerConfig.providerType,
      preparedRequest.preparedMessages,
    );
    const countProviderInputItems = shouldCountProviderInputItemsForContext(
      params.providerConfig.providerType,
    );
    const estimateSerializedPayloadTokens = (messages: StreamMessage[]) =>
      estimateSerializedPayloadTokensForProvider({
        messages,
        providerType: params.providerConfig.providerType,
        providerId: params.providerId,
        baseUrl: params.providerConfig.baseUrl,
        modelId: params.modelId,
      });
    const initialFootprint = estimateConversationFootprint({
      systemMessage: preparedRequest.systemMessage,
      preparedMessages: preparedMessagesForContext,
      orderedMessages: preparedRequest.orderedMessages,
      citations: preparedRequest.citations,
      toolDefinitions,
      ...footprintFields,
      estimateSerializedPayloadTokens,
      countProviderInputItems,
      mode: params.compactionMode ?? "blocking",
      budgetPolicy,
    });
    const markSafetyPrestreamCompacting = (footprintAfter: ContextFootprint) => {
      const previousStatus =
        get().conversationCompactionStatusById[params.conversationId] ?? null;
      setConversationCompactionStatus(params.conversationId, {
        ...previousStatus,
        phase: "safety_compacting",
        updatedAt: new Date().toISOString(),
        kind: "safety_prestream",
        footprintAfter,
      });
    };
    const compactPreparedRequest = (
      overrides: Partial<{
        mode: ContextCompactionKind;
        forceCompaction: boolean;
        forcePrune: boolean;
      }> = {},
    ) =>
      compactConversationMessages({
        conversationId: params.conversationId,
        providerId: params.providerId,
        modelId: params.modelId,
        reasoningEffort: params.reasoningEffort,
        providerConfig: params.providerConfig,
        allowedToolIds,
        systemMessage: preparedRequest.systemMessage,
        preparedMessages: preparedRequest.preparedMessages,
        orderedMessages: preparedRequest.orderedMessages,
        citations: preparedRequest.citations,
        mode: overrides.mode ?? params.compactionMode ?? "blocking",
        forceCompaction: overrides.forceCompaction ?? params.forceCompaction,
        forcePrune: overrides.forcePrune ?? params.forcePrune,
        displayAfterMessageId:
          params.compactionDisplayAfterMessageId ?? params.replyToMessageId,
      });
    const autoCompactionEnabled = budgetPolicy.auto !== false;
    let needsSafetyPrestream =
      autoCompactionEnabled &&
      !params.compactionMode &&
      isContextFootprintOverUsableBudget(initialFootprint);
    let compactedRequest: MaybeCompactConversationResult;
    if (needsSafetyPrestream) {
      markSafetyPrestreamCompacting(initialFootprint);
      compactedRequest = await compactPreparedRequest({
        mode: "safety_prestream",
        forceCompaction: true,
        forcePrune: true,
      });
    } else {
      compactedRequest = await compactPreparedRequest();
      needsSafetyPrestream =
        autoCompactionEnabled &&
        !params.compactionMode &&
        isContextFootprintOverUsableBudget(compactedRequest.footprintAfter);
      if (needsSafetyPrestream) {
        markSafetyPrestreamCompacting(compactedRequest.footprintAfter);
        compactedRequest = await compactPreparedRequest({
          mode: "safety_prestream",
          forceCompaction: true,
          forcePrune: true,
        });
      }
    }
    if (
      compactedRequest.decision === "hard_stop" ||
      isContextFootprintOverUsableBudget(compactedRequest.footprintAfter)
    ) {
      const latestUserContextTokens =
        compactedRequest.footprintAfter.latestUserContextTokens ?? 0;
      const latestRequestTooLarge =
        latestUserContextTokens > 0 &&
        latestUserContextTokens >= compactedRequest.footprintAfter.usableContextTokens;
      const autoCompactionBlocked =
        !autoCompactionEnabled &&
        !params.compactionMode &&
        isContextFootprintOverUsableBudget(compactedRequest.footprintAfter) &&
        !latestRequestTooLarge;
      const blockedFootprint: ContextFootprint = autoCompactionBlocked
        ? {
            ...compactedRequest.footprintAfter,
            reason: "manual_compaction_required",
          }
        : compactedRequest.footprintAfter;
      setConversationCompactionStatus(params.conversationId, {
        phase:
          (needsSafetyPrestream || autoCompactionBlocked) && !latestRequestTooLarge
            ? "needs_manual_compaction"
            : "too_large",
        updatedAt: new Date().toISOString(),
        reason: blockedFootprint.reason,
        kind: needsSafetyPrestream || autoCompactionBlocked
          ? "safety_prestream"
          : params.compactionMode ?? "blocking",
        footprintAfter: blockedFootprint,
      });
      await recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: needsSafetyPrestream || autoCompactionBlocked
          ? "safety_prestream"
          : getCompactionEventTrigger(params.compactionMode ?? "blocking"),
        providerId: params.providerId,
        modelId: params.modelId,
        modelContextWindowTokens: blockedFootprint.modelContextWindowTokens,
        tokensBefore: compactedRequest.footprintBefore.totalEstimatedTokens,
        tokensAfter: blockedFootprint.totalEstimatedTokens,
        status: autoCompactionBlocked ? "skipped" : "blocked",
        reason: blockedFootprint.reason,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.providerId,
          providerType: params.providerConfig.providerType,
          modelId: params.modelId,
          trigger: needsSafetyPrestream || autoCompactionBlocked
            ? "safety_prestream"
            : getCompactionEventTrigger(params.compactionMode ?? "blocking"),
          status: autoCompactionBlocked ? "skipped" : "blocked",
          footprintBefore: compactedRequest.footprintBefore,
          footprintAfter: blockedFootprint,
          footprintFields,
          budgetPolicy,
          reason: blockedFootprint.reason,
          result: autoCompactionBlocked
            ? "auto_compaction_disabled"
            : "context_too_large",
        }),
      });
      throw buildSendError(
        autoCompactionBlocked
          ? buildManualCompactionRequiredErrorMessage(blockedFootprint)
          : buildContextTooLargeErrorMessage(blockedFootprint),
      );
    }
    const fileRefToolContext = preparedRequest.orderedMessages
      .flatMap((message) => message.context_refs ?? [])
      .filter(isFileContextRef)
      .map((ref) => {
        const path = getFileRefPath(ref);
        return {
          title: ref.title,
          source: path,
          path,
          snippet: undefined,
          content: undefined,
        };
      });
    const fileToolContextByPath = new Map<string, {
      title: string;
      source: string;
      path?: string;
      snippet?: string;
      content?: string;
    }>();
    useCitationsStore
      .getState()
      .getConversationContextCitations(params.conversationId)
      .filter((c) => c.type === "file" || c.type === "document")
      .forEach((c) => {
        const item = {
        title: c.title,
        source: c.source,
        path: c.path,
        snippet: c.snippet,
        content: c.content,
        };
        fileToolContextByPath.set(c.path || c.source || c.title, item);
      });
    fileRefToolContext.forEach((item) => {
      if (!fileToolContextByPath.has(item.path)) {
        fileToolContextByPath.set(item.path, item);
      }
    });
    const fileToolContext = Array.from(fileToolContextByPath.values());
    const { enableWebSearch, enableWebFetch, webSearchOptions } =
      getStreamingWebSearchConfig();
    const guidedToolRetry = buildGuidedToolRetryPolicy({
      userContent: params.userContent,
      allowedToolIds,
      supportsNativeToolCalling: params.providerSupportsNativeToolCalling,
      fileToolContext,
    });
    const maxTurns = normalizeChatMaxTurns(
      await loadPreference<ChatMaxTurnsPreference>(PREF_KEYS.CHAT_MAX_TURNS),
    );
    const mcpTools: MCPTool[] = useToolsStore
      .getState()
      .getEnabledMCPTools()
      .filter((tool) => allowedToolIds.includes(tool.id));
    const { skillToolIds, runnableSkillToolIds } =
      getSkillToolIdsForRequest(
        allowedToolIds,
        preparedRequest.skillPermissionSnapshot,
      );

    await persistProviderInputItemsForMessage(
      params.replyToMessageId,
      preparedRequest.providerInputItemsByMessageId[params.replyToMessageId],
    );

    return {
      allowedToolIds,
      showToolTraces,
      messagesForRequest: compactedRequest.messages,
      contextDiagnosticsBaselineSeed: {
        conversationId: params.conversationId,
        modeAtSend: params.modeAtSend,
        providerId: params.providerId,
        providerType: params.providerConfig.providerType,
        baseUrl: params.providerConfig.baseUrl ?? "",
        modelId: params.modelId,
        ...footprintFields,
        allowedToolIds,
        toolDefinitions: getToolDefinitionsForIds(allowedToolIds),
        messagesForRequest: compactedRequest.messages.map(cloneStreamMessage),
        citations: preparedRequest.citations.map(cloneCitationForDiagnostics),
        compactionDecision: compactedRequest.decision,
      } satisfies StreamContextDiagnosticsBaselineSeed,
      executionContext: preparedRequest.executionContext,
      fileToolContext,
      internalAgentProfile,
      enableWebSearch,
      enableWebFetch,
      webSearchOptions,
      mcpTools,
      skillToolIds,
      runnableSkillToolIds,
      guidedToolRetry,
      maxTurns,
      compactionDecision: compactedRequest.decision,
    };
  };

  const removeEmptyAssistantPlaceholderFromState = (
    state: ChatStore,
    messageId: string,
  ): Partial<ChatStore> => {
    const targetMessage =
      state.messages[state.messageIndexById[messageId] ?? -1] ??
      state.messages.find((message) => message.id === messageId);
    if (
      !targetMessage ||
      targetMessage.role !== "assistant" ||
      targetMessage.content.trim().length > 0 ||
      (targetMessage.tool_traces?.length ?? 0) > 0
    ) {
      return {};
    }

    const nextMessages = state.messages.filter(
      (message) => message.id !== messageId,
    );
    const messageIndexById = Object.fromEntries(
      nextMessages.map((message, index) => [message.id, index]),
    );
    const existingConversationMessages = getConversationMessagesFromState(
      state,
      targetMessage.conversation_id,
    );
    const conversationMessages = existingConversationMessages.filter(
      (message) => message.id !== messageId,
    );
    return {
      messages: nextMessages,
      messagesByConversationId: {
        ...state.messagesByConversationId,
        [targetMessage.conversation_id]: conversationMessages,
      },
      messageIndexById,
      conversations: state.conversations.map((conversation) =>
        conversation.id === targetMessage.conversation_id
          ? {
              ...conversation,
              message_count: conversationMessages.length,
              last_message:
                conversationMessages[conversationMessages.length - 1]
                  ?.content ?? "",
              updated_at: new Date().toISOString(),
            }
          : conversation,
      ),
    };
  };

  const applyAssistantLaunchError = (
    conversationId: string,
    sessionId: string,
    assistantMessageId: string | null,
    error: unknown,
    options?: { setSendState?: boolean },
  ) => {
    const normalized = toServiceError(error);
    let applied = false;
    set((state) => {
      const currentRuntime = state.conversationRuntimeById[conversationId];
      if (
        !currentRuntime ||
        currentRuntime.sessionId !== sessionId ||
        !isConversationRuntimeActive(currentRuntime)
      ) {
        return state;
      }
      applied = true;
      return {
        ...(assistantMessageId
          ? removeEmptyAssistantPlaceholderFromState(state, assistantMessageId)
          : {}),
        ...buildConversationRuntimePatch(state, conversationId, {
          phase: "error",
          sessionId,
          turnId: currentRuntime.turnId ?? null,
          assistantMessageId: null,
          abortController: null,
          lastError: normalized.message,
          lastErrorOrigin: "macro",
          lastErrorDisplayTarget: "composer",
        }),
        lastError: normalized.message,
        ...(options?.setSendState ? { sendState: "error" as const } : {}),
      };
    });
    return { error: normalized, applied };
  };

  const replaceUserMessagePresentationLocally = (params: {
    messageId: string;
    turnId?: string | null;
    content: string;
    hiddenContext?: string;
    providerInputItems?: unknown[];
  }) => {
    const presentation = buildUserMessagePresentation(
      params.content,
      params.hiddenContext,
    );

    set((state) => {
      const targetIndex =
        typeof state.messageIndexById[params.messageId] === "number"
          ? state.messageIndexById[params.messageId]
          : state.messages.findIndex((message) => message.id === params.messageId);
      if (typeof targetIndex !== "number") {
        return state;
      }

      const currentMessage = state.messages[targetIndex];
      if (!currentMessage || currentMessage.role !== "user") {
        return state;
      }

      const updatedMessage: ChatMessage = {
        ...currentMessage,
        turn_id: params.turnId ?? currentMessage.turn_id ?? null,
        content: presentation.content,
        hidden_context: params.hiddenContext,
        provider_input_items: cloneProviderInputItems(
          params.providerInputItems,
        ),
        questionnaire_response_summary:
          presentation.questionnaire_response_summary,
      };
      const updatedMessages = [...state.messages];
      updatedMessages[targetIndex] = updatedMessage;
      const { messagesByConversationId, messageIndexById } =
        buildMessageState(updatedMessages);
      const updatedConversationMessages =
        messagesByConversationId[updatedMessage.conversation_id] ?? [];
      const conversationMeta = {
        message_count: updatedConversationMessages.length,
        last_message:
          updatedConversationMessages[updatedConversationMessages.length - 1]
            ?.content ?? "",
        updated_at: new Date().toISOString(),
      };

      return {
        messages: updatedMessages,
        messagesByConversationId,
        messageIndexById,
        conversations: state.conversations.map((conv) =>
          conv.id === updatedMessage.conversation_id
            ? { ...conv, ...conversationMeta }
            : conv,
        ),
      };
    });
  };

  const persistEditedUserMessage = async (params: {
    messageId: string;
    turnId?: string | null;
    content: string;
    hiddenContext?: string;
    providerInputItems?: unknown[];
    replaceStructuredFields?: boolean;
  }) => {
    const currentMessage = get().messages.find(
      (message) => message.id === params.messageId,
    );
    if (!currentMessage) {
      return;
    }

    const nextHiddenContext = params.replaceStructuredFields
      ? params.hiddenContext
      : currentMessage.hidden_context;
    const nextProviderInputItems = params.replaceStructuredFields
      ? cloneProviderInputItems(params.providerInputItems)
      : currentMessage.provider_input_items;

    try {
      await updateEditedUserMessage(chatPersistenceAdapters, {
        message: currentMessage,
        content: params.content,
        turnId: params.turnId,
        hiddenContext: nextHiddenContext,
        providerInputItems: nextProviderInputItems,
      });
      if (params.replaceStructuredFields) {
        replaceUserMessagePresentationLocally({
          messageId: params.messageId,
          turnId: params.turnId,
          content: params.content,
          hiddenContext: nextHiddenContext,
          providerInputItems: nextProviderInputItems,
        });
      } else {
        get().updateMessageContent(params.messageId, params.content);
        if (params.turnId) {
          get().updateMessageFields(params.messageId, {
            turn_id: params.turnId,
          });
        }
      }
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message, sendState: "error" });
      throw buildSendError(
        `Failed to save the edited message: ${normalized.message}`,
      );
    }
  };

  const trimConversationAfterMessage = async (params: {
    conversationId: string;
    messageId: string;
    clearQuestionnaireSession?: boolean;
    updatedMessage?: ChatMessage;
    replayRecovery?: {
      sessionId: string;
      turnId: string;
      replayId: string;
      content: string;
      hiddenContext?: string;
      providerInputItems?: unknown[];
    };
  }) => {
    const existingCompactionState = await getConversationCompactionState(
      params.conversationId,
    );
    const stateBeforeReplay = get();
    const replayMessages = params.updatedMessage
      ? stateBeforeReplay.messages.map((message) =>
          message.id === params.updatedMessage!.id
            ? params.updatedMessage!
            : message,
        )
      : stateBeforeReplay.messages;

    const applyReplayTrimToState = (
      plan: ConversationReplayPlan<SessionCompactionEvent>,
    ) => {
      let persistedMessageImages: Record<string, MessageImageAttachment[]> | null = null;
      let persistedQuestionnaireDrafts: Record<
        string,
        ConversationQuestionnaireDraft
      > | null = null;
      set((current) => {
        const result = buildReplayTrimStatePatch({
          state: current,
          conversationId: params.conversationId,
          plan,
          updatedMessage: params.updatedMessage,
          clearQuestionnaireSession: params.clearQuestionnaireSession,
        });
        if (result.shouldPersistMessageImages) {
          persistedMessageImages = result.patch.messageImagesByMessageId;
        }
        if (result.shouldPersistQuestionnaireDrafts) {
          persistedQuestionnaireDrafts =
            result.patch.questionnaireDraftsByConversationId;
        }
        return result.patch;
      });
      if (persistedMessageImages) {
        saveMessageImagesToStorage(persistedMessageImages);
      }
      if (persistedQuestionnaireDrafts) {
        saveQuestionnaireDraftsToStorage(persistedQuestionnaireDrafts);
      }
    };

    const plan = buildConversationReplayPlan({
      conversationId: params.conversationId,
      replayMessageId: params.messageId,
      conversationMessages: replayMessages,
      contextCompactionState: existingCompactionState,
      sessionCompactionEvents:
        stateBeforeReplay.sessionCompactionEventsByConversationId[
          params.conversationId
        ],
    });

    try {
      await serializeAgentCodeCheckpointMutation(params.conversationId, async () => {
        const existing = await getLoadedAgentCodeCheckpoints(params.conversationId);
        const pruned = pruneAgentCodeCheckpointsToMessageIds(
          existing,
          params.conversationId,
          plan.keptMessageIds,
        );
        const checkpointsChanged = pruned.length !== existing.length;

        if (tauriIpc.isTauriAvailable()) {
          if (params.replayRecovery) {
            await tauriIpc.dbPrepareConversationReplay({
              conversationId: params.conversationId,
              messageId: params.messageId,
              sessionId: params.replayRecovery.sessionId,
              turnId: params.replayRecovery.turnId,
              replayId: params.replayRecovery.replayId,
              content: params.replayRecovery.content,
              hiddenContext: params.replayRecovery.hiddenContext ?? null,
              providerInputItemsJson: params.replayRecovery.providerInputItems
                ? JSON.stringify(params.replayRecovery.providerInputItems)
                : null,
              codeCheckpointsJson: checkpointsChanged ? JSON.stringify(pruned) : null,
              deleteContextCompactionState: plan.shouldDeleteContextCompactionState,
            });
          } else {
            await tauriIpc.dbTrimConversationReplay({
              conversationId: params.conversationId,
              afterMessageId: params.messageId,
              codeCheckpointsJson: checkpointsChanged ? JSON.stringify(pruned) : null,
              deleteContextCompactionState: plan.shouldDeleteContextCompactionState,
            });
          }
        } else {
          await deletePersistedMessagesAfter(
            chatPersistenceAdapters,
            params.conversationId,
            params.messageId,
          );
          if (checkpointsChanged) {
            await saveAgentCodeCheckpoints(params.conversationId, pruned);
          }
        }

        if (checkpointsChanged) {
          set((state) => ({
            agentCodeCheckpointsByConversationId: {
              ...state.agentCodeCheckpointsByConversationId,
              [params.conversationId]: pruned,
            },
          }));
        }
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ lastError: normalized.message, sendState: "error" });
      throw buildSendError(
        `Failed to trim the conversation before retrying: ${normalized.message}`,
      );
    }

    applyReplayTrimToState(plan);
    useCitationsStore.getState().pruneConversationCitations(
      params.conversationId,
      Array.from(plan.keptMessageIds),
    );
    if (plan.shouldDeleteContextCompactionState) {
      conversationCompactionStateCache.delete(params.conversationId);
      setConversationCompactionStatus(params.conversationId, null);
    }
  };

  const restartAssistantFromEditedMessage = async (params: {
    sessionId: string;
    turnId: string;
    messageId: string;
    conversationId: string;
    taskId: string;
    userContent: string;
    modeAtSend: AppMode;
    providerId: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
    providerConfig: NonNullable<
      ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
    >;
    executionContext: ProjectExecutionContext;
    providerSupportsNativeToolCalling: boolean;
    abortController: AbortController;
    manualFeatureDraftRecovery?: ManualFeatureDraftRecovery | null;
    agentTypeAtSend: AgentType | null;
    replayRecovery?: {
      replayId: string;
      onLaunched: () => void;
      onProgress: () => void;
      onFailedBeforeProgress: () => Promise<void>;
    };
  }) => {
    let assistantMessageId: string | null = null;
    const agentTypeAtSend = params.agentTypeAtSend;
    const cleanupCancelledAssistantPlaceholder = async (
      placeholderMessageId: string,
    ): Promise<void> => {
      set((state) =>
        removeEmptyAssistantPlaceholderFromState(state, placeholderMessageId),
      );
      if (
        latestConversationSessionIdByConversationId.get(
          params.conversationId,
        ) !== params.sessionId
      ) {
        return;
      }
      try {
        await deletePersistedMessagesAfter(
          chatPersistenceAdapters,
          params.conversationId,
          params.messageId,
        );
      } catch (error) {
        console.warn(
          "Failed to delete cancelled assistant placeholder after edit:",
          error,
        );
      }
    };
    const isCurrentPreparation = () => {
      const runtime = getConversationRuntimeSnapshot(
        get().conversationRuntimeById,
        params.conversationId,
      );
      return (
        !params.abortController.signal.aborted &&
        runtime.phase === "preparing" &&
        runtime.sessionId === params.sessionId &&
        runtime.turnId === params.turnId &&
        runtime.abortController === params.abortController
      );
    };

    try {
      const streamLaunch = await prepareAssistantStreamLaunch({
        conversationId: params.conversationId,
        replyToMessageId: params.messageId,
        userContent: params.userContent,
        resolvedTaskId: params.taskId ?? "",
        modeAtSend: params.modeAtSend,
        agentTypeAtSend,
        providerId: params.providerId,
        modelId: params.modelId,
        reasoningEffort: params.reasoningEffort,
        providerConfig: params.providerConfig,
        executionContext: params.executionContext,
        providerSupportsNativeToolCalling:
          params.providerSupportsNativeToolCalling,
      });
      if (!isCurrentPreparation()) {
        return;
      }

      const assistantMessage = await buildAssistantMessageForSend({
        conversationId: params.conversationId,
        turnId: params.turnId,
        taskId: params.taskId,
      });
      if (!isCurrentPreparation()) {
        await cleanupCancelledAssistantPlaceholder(assistantMessage.id);
        return;
      }
      rememberAssistantTurnContext(
        assistantMessage.id,
        params.conversationId,
        params.modeAtSend,
        agentTypeAtSend,
      );
      assistantMessageId = assistantMessage.id;
      get().addMessage(assistantMessage);
      updateConversationRuntimeIfSessionMatches(
        params.conversationId,
        params.sessionId,
        (runtime) =>
          runtime.phase === "preparing" &&
          runtime.turnId === params.turnId &&
          runtime.abortController === params.abortController
            ? {
                ...runtime,
                assistantMessageId: assistantMessage.id,
              }
            : runtime,
      );
      if (!isCurrentPreparation()) {
        return;
      }

      if (params.replayRecovery) {
        await tauriIpc.dbMarkConversationReplayLaunched({
          conversationId: params.conversationId,
          replayId: params.replayRecovery.replayId,
        });
        params.replayRecovery.onLaunched();
      }

      startAssistantStream({
        sessionId: params.sessionId,
        assistantMessage,
        conversationId: params.conversationId,
        replyToMessageId: params.messageId,
        userContent: params.userContent,
        modeAtSend: params.modeAtSend,
        agentTypeAtSend,
        resolvedTaskId: params.taskId ?? "",
        selectedProviderId: params.providerId,
        selectedModelId: params.modelId,
        selectedReasoningEffort: params.reasoningEffort,
        providerConfig: params.providerConfig,
        internalAgentProfile: streamLaunch.internalAgentProfile,
        messagesForRequest: streamLaunch.messagesForRequest,
        contextDiagnosticsBaselineSeed:
          streamLaunch.contextDiagnosticsBaselineSeed,
        executionContext: streamLaunch.executionContext,
        providerSupportsNativeToolCalling:
          params.providerSupportsNativeToolCalling,
        fileToolContext: streamLaunch.fileToolContext,
        allowedToolIds: streamLaunch.allowedToolIds,
        skillToolIds: streamLaunch.skillToolIds,
        runnableSkillToolIds: streamLaunch.runnableSkillToolIds,
        guidedToolRetry: streamLaunch.guidedToolRetry,
        showToolTraces: streamLaunch.showToolTraces,
        enableWebSearch: streamLaunch.enableWebSearch,
        enableWebFetch: streamLaunch.enableWebFetch,
        webSearchOptions: streamLaunch.webSearchOptions,
        mcpTools: streamLaunch.mcpTools,
        maxTurns: streamLaunch.maxTurns,
        compactionDecision: streamLaunch.compactionDecision,
        abortController: params.abortController,
        replayRecovery: params.replayRecovery
          ? {
              replayId: params.replayRecovery.replayId,
              onProgress: params.replayRecovery.onProgress,
              onFailedBeforeProgress: params.replayRecovery.onFailedBeforeProgress,
            }
          : undefined,
      });
    } catch (error) {
      if (params.manualFeatureDraftRecovery) {
        await rollbackManualFeatureDraftAfterFailedLaunch(
          params.manualFeatureDraftRecovery,
        );
      }
      applyAssistantLaunchError(
        params.conversationId,
        params.sessionId,
        assistantMessageId,
        error,
      );
      throw error;
    }
  };

  const buildSkippedManualCompactionResult = (
    result: MaybeCompactConversationResult,
    reason: ManualCompactionSkipReason,
  ): ManualCompactionSkippedResult => ({
    outcome: "skipped",
    updatedAt: new Date().toISOString(),
    reason,
    footprintBefore: result.footprintBefore,
    userTurnCount: result.manualSkip?.userTurnCount ?? 0,
    retainedTurnCount: result.manualSkip?.retainedTurnCount ?? 2,
  });

  const buildCompletedManualCompactionResult = (
    result: MaybeCompactConversationResult,
  ): ManualCompactionCompletedResult => {
    const compactionState = result.compactionState;
    if (!compactionState) {
      return {
        outcome: "compacted",
        updatedAt: new Date().toISOString(),
        footprintBefore: result.footprintBefore,
        footprintAfter: result.footprintAfter,
        tokensSaved: Math.max(
          0,
          result.footprintBefore.totalEstimatedTokens -
            result.footprintAfter.totalEstimatedTokens,
        ),
        upToMessageId: "",
        summarySource: undefined,
      };
    }
    return {
      outcome: "compacted",
      updatedAt: compactionState.updatedAt,
      footprintBefore: result.footprintBefore,
      footprintAfter: result.footprintAfter,
      tokensSaved: Math.max(
        0,
        result.footprintBefore.totalEstimatedTokens -
          result.footprintAfter.totalEstimatedTokens,
      ),
      upToMessageId: compactionState.upToMessageId,
      summarySource: compactionState.summarySource,
    };
  };

  const compactConversationNow = async (
    conversationId: string,
  ): Promise<ManualCompactionResult> => {
    if (!conversationId) {
      throw buildSendError("Select a conversation before compacting.");
    }
    if (conversationCompactionInProgress.has(conversationId)) {
      throw buildSendError(
        "Compaction is already in progress for this conversation.",
      );
    }
    conversationCompactionInProgress.add(conversationId);
    const previousCompactionStatus =
      get().conversationCompactionStatusById[conversationId] ?? null;

    try {
      await ensureMessagesLoadedForConversation(conversationId);
      await ensureToolsLoaded();

      const providerState = useProviderStore.getState();
      const {
        selectedProviderId,
        selectedModelId,
        selectedReasoningEffort,
        providerConfigs,
      } = providerState;
      if (!selectedProviderId || !selectedModelId) {
        throw buildSendError("Select a provider and model before compacting.");
      }

      const providerConfig = providerConfigs.find(
        (provider) => provider.id === selectedProviderId,
      );
      if (!providerConfig) {
        throw buildSendError("Provider configuration not found.");
      }

      const resolvedApiKey =
        providerConfig.isLocal || providerHasAuthSession(providerConfig)
          ? providerConfig.apiKey
          : await providerState.resolveProviderApiKey(selectedProviderId);
      const providerConfigForUse = {
        ...providerConfig,
        apiKey: resolvedApiKey,
        apiKeyLoaded:
          providerConfig.apiKeyLoaded || resolvedApiKey !== undefined,
      };

      const conversation = get().conversations.find(
        (candidate) => candidate.id === conversationId,
      );
      const taskStatus = conversation?.task_id
        ? useTaskStore.getState().getTaskById(conversation.task_id)?.status ??
          null
        : null;
      const internalAgentProfile = resolveInternalAgentProfile({
        mode: useAppStore.getState().mode,
        taskStatus,
      });
      const allowedToolIds = await getAllowedToolIdsForCurrentMode(
        internalAgentProfile,
      );
      const preparedRequest = await prepareMessagesForRequest(
        conversationId,
        allowedToolIds,
        internalAgentProfile,
      );
      const result = await compactConversationMessages({
        conversationId,
        providerId: selectedProviderId,
        modelId: selectedModelId,
        reasoningEffort: selectedReasoningEffort,
        providerConfig: providerConfigForUse,
        allowedToolIds,
        systemMessage: preparedRequest.systemMessage,
        preparedMessages: preparedRequest.preparedMessages,
        orderedMessages: preparedRequest.orderedMessages,
        citations: preparedRequest.citations,
        mode: "manual",
        forceCompaction: true,
        forcePrune: true,
        displayAfterMessageId:
          preparedRequest.orderedMessages.at(-1)?.id ?? null,
      });

      if (result.manualSkip) {
        return buildSkippedManualCompactionResult(
          result,
          result.manualSkip.reason,
        );
      }

      if (!result.compactionState) {
        return buildSkippedManualCompactionResult(result, "not_enough_history");
      }

      return buildCompletedManualCompactionResult(result);
    } catch (error) {
      const normalized = toServiceError(error);
      if (isProviderContextOverflowError(error)) {
        setConversationCompactionStatus(conversationId, {
          ...previousCompactionStatus,
          phase: "too_large",
          updatedAt: new Date().toISOString(),
          reason: "hard_stop_ratio",
          kind: "manual",
        });
      } else {
        setConversationCompactionStatus(conversationId, previousCompactionStatus);
      }
      set({ lastError: normalized.message });
      throw normalized;
    } finally {
      conversationCompactionInProgress.delete(conversationId);
    }
  };

  const refreshConversationContextDiagnostics = async (
    conversationId: string,
    options?: {
      mode?: ConversationContextDiagnosticsRefreshMode;
      providerContext?: ConversationContextDiagnosticsProviderContext;
    },
  ): Promise<void> => {
    if (!conversationId) {
      return;
    }

    const mode = options?.mode ?? "full";
    if (mode === "live_stream") {
      const liveContext = resolveActiveLiveStreamDiagnosticsPayload(conversationId);
      if (!liveContext) {
        return;
      }
    }

    const requestId =
      (contextDiagnosticsRequestIds.get(conversationId) ?? 0) + 1;
    contextDiagnosticsRequestIds.set(conversationId, requestId);

    if (mode === "full") {
      markConversationContextDiagnosticsEstimating(conversationId);
    }

    const isStale = () =>
      contextDiagnosticsRequestIds.get(conversationId) !== requestId;

    try {
      if (mode === "live_stream") {
        const liveDiagnostics =
          await buildLiveStreamContextDiagnostics(conversationId);
        if (!liveDiagnostics) return;

        if (
          isStale() ||
          !isLiveStreamEstimateCurrent(
            conversationId,
            liveDiagnostics.liveEstimate,
          )
        ) {
          return;
        }
        publishConversationContextDiagnostics(
          conversationId,
          liveDiagnostics.diagnostics,
        );
        return;
      }

      await ensureMessagesLoadedForConversation(conversationId);
      await ensureToolsLoaded();

      const providerContext = resolveContextDiagnosticsProviderContext(
        options?.providerContext,
      );

      const conversation = get().conversations.find(
        (candidate) => candidate.id === conversationId,
      );
      const taskStatus = conversation?.task_id
        ? useTaskStore.getState().getTaskById(conversation.task_id)?.status ??
          null
        : null;
      const internalAgentProfile = resolveInternalAgentProfile({
        mode: useAppStore.getState().mode,
        taskStatus,
      });
      const allowedToolIds = await getAllowedToolIdsForCurrentMode(
        internalAgentProfile,
      );
      const preparedRequest = await prepareMessagesForRequest(
        conversationId,
        allowedToolIds,
        internalAgentProfile,
      );
      const toolDefinitions = getToolDefinitionsForIds(allowedToolIds);
      const currentCompactionState = await getConversationCompactionState(
        conversationId,
      );
      await useProviderStore
        .getState()
        .ensureSelectedModelContextMetadata(
          providerContext.providerId,
          providerContext.modelId,
          "pre_send",
        );
      const { footprintFields } = getSelectedModelContext(
        providerContext.providerId,
        providerContext.modelId,
        providerContext.providerType,
      );
      const budgetPolicy = await loadContextBudgetPolicy();

      const estimateSerializedPayloadTokens = (messages: StreamMessage[]) =>
        estimateSerializedPayloadTokensForProvider({
          messages,
          providerType: providerContext.providerType,
          providerId: providerContext.providerId,
          baseUrl: providerContext.baseUrl,
          modelId: providerContext.modelId,
        });
      const preparedMessagesForContext = normalizeMessagesForProviderContext(
        providerContext.providerType,
        preparedRequest.preparedMessages,
      );

      if (isStale()) {
        return;
      }

      const runtime = getConversationRuntimeSnapshot(
        get().conversationRuntimeById,
        conversationId,
      );
      const result = await buildCompactedMessagesForRequest({
        systemMessage: preparedRequest.systemMessage,
        preparedMessages: preparedMessagesForContext,
        orderedMessages: preparedRequest.orderedMessages,
        citations: preparedRequest.citations,
        toolDefinitions,
        ...footprintFields,
        currentCompactionState,
        estimateSerializedPayloadTokens,
        countProviderInputItems: shouldCountProviderInputItemsForContext(
          providerContext.providerType,
        ),
        mode: "blocking",
        budgetPolicy,
        generateSummary: async () =>
          currentCompactionState?.summaryText ?? null,
      });

      if (isStale()) {
        return;
      }

      const phase: ConversationContextDiagnostics["phase"] =
        isProviderRuntimeError(runtime)
          ? "provider_error"
          : result.footprintAfter.isHardStop
          ? "too_large"
            : isContextFootprintOverUsableBudget(result.footprintAfter)
              ? "needs_manual_compaction"
            : result.degraded
              ? "degraded"
              : result.compactionState
                ? "compacted"
                : "idle";

      const diagnostics = buildContextDiagnosticsFromFootprint({
        conversationId,
        providerId: providerContext.providerId,
        providerType: providerContext.providerType,
        modelId: providerContext.modelId,
        status: "ready",
        source: "full",
        phase,
        decision: result.decision,
        compactionPass: result.compactionState?.compactionPass,
        summaryFormatVersion: result.compactionState?.summaryFormatVersion,
        summarySource: result.compactionState?.summarySource,
        footprintBefore: result.footprintBefore,
        footprintAfter: result.footprintAfter,
        orderedMessages: preparedRequest.orderedMessages,
        preparedMessages: result.messages.slice(1),
        citations: preparedRequest.citations,
        compactionState: result.compactionState,
      });

      publishConversationContextDiagnostics(conversationId, diagnostics);
    } catch (error) {
      if (isStale()) {
        return;
      }
      if (mode === "live_stream") {
        devLogger.info(
          `Live context diagnostics failed for conversation=${conversationId}: ${toServiceError(error).message}`,
        );
        return;
      }
      const normalized = toServiceError(error);
      const providerState = useProviderStore.getState();
      const providerConfig = providerState.providerConfigs.find(
        (provider) => provider.id === providerState.selectedProviderId,
      );
      const orderedMessages = getOrderedConversationMessages(conversationId);
      const diagnostics = buildContextDiagnosticsFromFootprint({
        conversationId,
        providerId: providerState.selectedProviderId ?? undefined,
        providerType: providerConfig?.providerType,
        modelId: providerState.selectedModelId ?? undefined,
        status: "error",
        source: "full",
        phase: "too_large",
        orderedMessages,
        preparedMessages: [],
        citations: [],
        error: normalized.message,
      });
      publishConversationContextDiagnostics(conversationId, diagnostics);
    }
  };

  const runScheduledLiveContextDiagnosticsRefresh = (conversationId: string) => {
    const refreshState = getLiveContextDiagnosticsRefreshState(conversationId);
    if (refreshState.timeoutId !== null) {
      clearTimeout(refreshState.timeoutId);
      refreshState.timeoutId = null;
    }
    if (refreshState.inFlight) {
      refreshState.pending = true;
      return;
    }

    refreshState.inFlight = true;
    refreshState.pending = false;
    refreshState.lastStartedAt = Date.now();
    void refreshConversationContextDiagnostics(conversationId, { mode: "live_stream" })
      .finally(() => {
        refreshState.inFlight = false;
        if (refreshState.pending) {
          refreshState.pending = false;
          runScheduledLiveContextDiagnosticsRefresh(conversationId);
        }
      });
  };

  const scheduleLiveContextDiagnosticsRefresh = (
    conversationId: string,
    options?: { leading?: boolean },
  ) => {
    const refreshState = getLiveContextDiagnosticsRefreshState(conversationId);
    if (refreshState.inFlight) {
      refreshState.pending = true;
      return;
    }

    const now = Date.now();
    const elapsed = now - refreshState.lastStartedAt;
    if (options?.leading || elapsed >= LIVE_CONTEXT_DIAGNOSTICS_THROTTLE_MS) {
      runScheduledLiveContextDiagnosticsRefresh(conversationId);
      return;
    }

    if (refreshState.timeoutId !== null) {
      return;
    }
    refreshState.timeoutId = setTimeout(() => {
      runScheduledLiveContextDiagnosticsRefresh(conversationId);
    }, Math.max(0, LIVE_CONTEXT_DIAGNOSTICS_THROTTLE_MS - elapsed));
  };

  const recordLiveStreamContextEstimate = (params: {
    conversationId: string;
    sessionId: string;
    assistantMessageId: string;
    snapshot: LiveStreamContextSnapshot;
    baseline?: StreamContextDiagnosticsBaseline;
    leading?: boolean;
  }) => {
    let didRecord = false;
    set((state) => {
      const runtime = state.conversationRuntimeById[params.conversationId];
      if (
        runtime?.phase !== "streaming" ||
        runtime.sessionId !== params.sessionId ||
        runtime.assistantMessageId !== params.assistantMessageId
      ) {
        return state;
      }

      const previous =
        state.liveStreamContextEstimatesByConversationId[params.conversationId];
      if (
        previous &&
        previous.sessionId === params.sessionId &&
        previous.assistantMessageId === params.assistantMessageId &&
        params.snapshot.version < previous.version
      ) {
        return state;
      }
      const version = params.snapshot.version;
      const baseline = params.baseline
        ? cloneStreamContextDiagnosticsBaseline(params.baseline)
        : previous?.baseline
          ? cloneStreamContextDiagnosticsBaseline(previous.baseline)
          : undefined;
      didRecord = true;
      return {
        liveStreamContextEstimatesByConversationId: {
          ...state.liveStreamContextEstimatesByConversationId,
          [params.conversationId]: {
            sessionId: params.sessionId,
            assistantMessageId: params.assistantMessageId,
            version,
            baseline,
            visibleContent: params.snapshot.visibleContent,
            visibleContentLength: params.snapshot.visibleContentLength,
            hiddenContext: params.snapshot.hiddenContext,
            providerInputItems: cloneProviderInputItems(
              params.snapshot.providerInputItems,
            ),
            providerTurnState: params.snapshot.providerTurnState,
            toolTraces: params.snapshot.toolTraces,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
    if (!didRecord) {
      return;
    }
    scheduleLiveContextDiagnosticsRefresh(params.conversationId, {
      leading: params.leading,
    });
  };

  const startAssistantStream = (params: {
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
    providerConfig: NonNullable<
      ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
    >;
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
    skillToolIds: string[];
    runnableSkillToolIds: string[];
    maxTurns: ChatMaxTurnsPreference;
    abortController?: AbortController;
    compactionDecision?: ContextCompactionDecision;
    overflowRecoveryAttempted?: boolean;
    replayRecovery?: {
      replayId: string;
      onProgress: () => void;
      onFailedBeforeProgress: () => Promise<void>;
    };
  }) => {
    const streamTurnId = getMessageTurnId(params.assistantMessage);
    const abortController = params.abortController ?? new AbortController();
    if (abortController.signal.aborted) {
      return;
    }
    const preparationRuntime = getConversationRuntimeSnapshot(
      get().conversationRuntimeById,
      params.conversationId,
    );
    if (
      preparationRuntime.phase !== "preparing" ||
      preparationRuntime.sessionId !== params.sessionId ||
      preparationRuntime.turnId !== streamTurnId ||
      preparationRuntime.assistantMessageId !== params.assistantMessage.id ||
      preparationRuntime.abortController !== abortController
    ) {
      return;
    }
    const shouldAcceptStreamUpdate = (): boolean => {
      const runtime = getConversationRuntimeSnapshot(
        get().conversationRuntimeById,
        params.conversationId,
      );
      return (
        runtime.phase === "streaming" &&
        runtime.sessionId === params.sessionId &&
        runtime.assistantMessageId === params.assistantMessage.id &&
        runtime.turnId === streamTurnId
      );
    };
    setConversationRuntime(
      params.conversationId,
      {
        phase: "streaming",
        sessionId: params.sessionId,
        turnId: streamTurnId,
        assistantMessageId: params.assistantMessage.id,
        abortController,
        lastError: null,
      },
      { globalLastError: null },
    );
    const deleteEmptyAssistantMessageFromDb = async () => {
      if (
        latestConversationSessionIdByConversationId.get(
          params.conversationId,
        ) !== params.sessionId
      ) {
        return;
      }
      try {
        await deletePersistedMessagesAfter(
          chatPersistenceAdapters,
          params.conversationId,
          params.replyToMessageId,
        );
      } catch (error) {
        console.warn("Failed to delete empty assistant message after stream error:", error);
      }
    };
    const contextDiagnosticsBaseline: StreamContextDiagnosticsBaseline = {
      ...params.contextDiagnosticsBaselineSeed,
      sessionId: params.sessionId,
      assistantMessageId: params.assistantMessage.id,
      orderedMessages: getOrderedConversationMessages(
        params.conversationId,
      ).map(cloneChatMessageForDiagnostics),
    };
    recordLiveStreamContextEstimate({
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      assistantMessageId: params.assistantMessage.id,
      leading: true,
      baseline: contextDiagnosticsBaseline,
      snapshot: {
        version: 0,
        visibleContent: params.assistantMessage.content,
        visibleContentLength: params.assistantMessage.content.length,
        toolTraces: params.assistantMessage.tool_traces ?? [],
        hiddenContext: params.assistantMessage.hidden_context,
        providerInputItems: params.assistantMessage.provider_input_items,
        providerTurnState: params.assistantMessage.provider_turn_state,
      },
    });
    let pendingToolBoundaryCompaction: PendingToolBoundaryCompaction | null = null;
    let replayRecoveryFinalized = false;
    const finalizeReplayRecoveryAfterProgress = () => {
      if (!params.replayRecovery || replayRecoveryFinalized) return;
      replayRecoveryFinalized = true;
      params.replayRecovery.onProgress();
      void tauriIpc
        .dbFinalizeConversationReplay({
          conversationId: params.conversationId,
          replayId: params.replayRecovery.replayId,
        })
        .catch((error) => {
          console.error("Replay recovery finalization remains pending", error);
        });
    };

    const maybeMarkImplementTaskFailedAfterStreamError = async () => {
      if (
        abortController.signal.aborted ||
        params.modeAtSend !== "Implement" ||
        !params.resolvedTaskId
      ) {
        return;
      }

      const task = useTaskStore.getState().getTaskById(params.resolvedTaskId);
      if (!task || task.status === "Completed") {
        return;
      }

      try {
        await useTaskStore.getState().markTaskFailed(params.resolvedTaskId);
      } catch (error) {
        console.warn("Failed to mark task as failed after stream error:", error);
      }
    };

    let providerOverflowLimitRecorded = false;
    const recordProviderContextOverflowLimit = async (error: Error) => {
      if (providerOverflowLimitRecorded || !isProviderContextOverflowError(error)) {
        return;
      }
      const learnedContextLimit =
        extractContextLimitTokensFromErrorLike(error);
      if (!learnedContextLimit) {
        return;
      }
      providerOverflowLimitRecorded = true;
      try {
        await useProviderStore
          .getState()
          .recordProviderModelContextOverflowLimit(
            params.selectedProviderId,
            params.selectedModelId,
            learnedContextLimit,
          );
      } catch (persistError) {
        console.warn(
          "Failed to persist provider context overflow limit:",
          persistError,
        );
      }
    };

    const tryRecoverFromOverflow = async (
      error: Error,
      tokenControls: ChatStreamTokenControls,
    ): Promise<boolean> => {
      if (
        params.overflowRecoveryAttempted ||
        abortController.signal.aborted ||
        !shouldAcceptStreamUpdate() ||
        !isProviderContextOverflowError(error)
      ) {
        return false;
      }

      await recordProviderContextOverflowLimit(error);
      if (abortController.signal.aborted || !shouldAcceptStreamUpdate()) {
        return true;
      }
      tokenControls.flushNow();
      const assistantMessage = get().messages.find(
        (message) => message.id === params.assistantMessage.id,
      );
      const hasPartialAssistantProgress = Boolean(
        assistantMessage &&
          (assistantMessage.content.trim().length > 0 ||
            (assistantMessage.tool_traces?.length ?? 0) > 0),
      );
      if (hasPartialAssistantProgress) {
        return false;
      }

      tokenControls.dispose();
      clearLiveStreamContextEstimate(params.conversationId);
      setConversationCompactionStatus(params.conversationId, {
        phase: "recovering_overflow",
        updatedAt: new Date().toISOString(),
        kind: "stream_overflow",
        recoveredFromOverflow: true,
      });
      updateConversationRuntimeIfSessionMatches(
        params.conversationId,
        params.sessionId,
        () => ({
          phase: "overflow_recovery",
          sessionId: params.sessionId,
          turnId: streamTurnId,
          assistantMessageId: params.assistantMessage.id,
          abortController,
          lastError: null,
        }),
      );

      try {
        const streamLaunch = await prepareAssistantStreamLaunch({
          conversationId: params.conversationId,
          replyToMessageId: params.replyToMessageId,
          userContent: params.userContent,
          resolvedTaskId: params.resolvedTaskId,
          modeAtSend: params.modeAtSend,
          providerId: params.selectedProviderId,
          modelId: params.selectedModelId,
          reasoningEffort: params.selectedReasoningEffort,
          providerConfig: params.providerConfig,
          internalAgentProfile: params.internalAgentProfile,
          executionContext: params.executionContext,
          providerSupportsNativeToolCalling:
            params.providerSupportsNativeToolCalling,
          compactionMode: "stream_overflow",
          forceCompaction: true,
          forcePrune: true,
          compactionDisplayAfterMessageId: params.assistantMessage.id,
        });

        const runtimeAfterCompaction = getConversationRuntimeSnapshot(
          get().conversationRuntimeById,
          params.conversationId,
        );
        if (
          runtimeAfterCompaction.phase !== "overflow_recovery" ||
          runtimeAfterCompaction.sessionId !== params.sessionId ||
          runtimeAfterCompaction.turnId !== streamTurnId ||
          runtimeAfterCompaction.assistantMessageId !== params.assistantMessage.id ||
          runtimeAfterCompaction.abortController !== abortController ||
          abortController.signal.aborted
        ) {
          return true;
        }

        const currentStatus =
          get().conversationCompactionStatusById[params.conversationId];
        setConversationCompactionStatus(params.conversationId, {
          ...currentStatus,
          phase: "compacted",
          updatedAt: new Date().toISOString(),
          kind: "stream_overflow",
          recoveredFromOverflow: true,
        });

        updateConversationRuntimeIfSessionMatches(
          params.conversationId,
          params.sessionId,
          (runtime) =>
            runtime.phase === "overflow_recovery" &&
            runtime.turnId === streamTurnId &&
            runtime.assistantMessageId === params.assistantMessage.id
              ? {
                  phase: "preparing",
                  sessionId: params.sessionId,
                  turnId: streamTurnId,
                  assistantMessageId: params.assistantMessage.id,
                  abortController,
                  lastError: null,
                }
              : runtime,
        );
        startAssistantStream({
          ...params,
          messagesForRequest: streamLaunch.messagesForRequest,
          contextDiagnosticsBaselineSeed:
            streamLaunch.contextDiagnosticsBaselineSeed,
          executionContext: streamLaunch.executionContext,
          providerSupportsNativeToolCalling:
            params.providerSupportsNativeToolCalling,
          fileToolContext: streamLaunch.fileToolContext,
          allowedToolIds: streamLaunch.allowedToolIds,
          skillToolIds: streamLaunch.skillToolIds,
          runnableSkillToolIds: streamLaunch.runnableSkillToolIds,
          guidedToolRetry: streamLaunch.guidedToolRetry,
          showToolTraces: streamLaunch.showToolTraces,
          enableWebSearch: streamLaunch.enableWebSearch,
          enableWebFetch: streamLaunch.enableWebFetch,
          webSearchOptions: streamLaunch.webSearchOptions,
          mcpTools: streamLaunch.mcpTools,
          internalAgentProfile: streamLaunch.internalAgentProfile,
          maxTurns: streamLaunch.maxTurns,
          compactionDecision: streamLaunch.compactionDecision,
          overflowRecoveryAttempted: true,
        });
        return true;
      } catch (recoveryError) {
        const normalized = toServiceError(recoveryError);
        const message =
          normalized.message || OVERFLOW_RECOVERY_FAILURE_MESSAGE;
        setConversationCompactionStatus(params.conversationId, {
          phase: "too_large",
          updatedAt: new Date().toISOString(),
          reason: "hard_stop_ratio",
          kind: "stream_overflow",
          recoveredFromOverflow: true,
        });
        await maybeMarkImplementTaskFailedAfterStreamError();
        set((state) => {
          const currentRuntime =
            state.conversationRuntimeById[params.conversationId];
          if (!currentRuntime || currentRuntime.sessionId !== params.sessionId) {
            return state;
          }
          return {
            ...removeEmptyAssistantPlaceholderFromState(
              state,
              params.assistantMessage.id,
            ),
            ...buildConversationRuntimePatch(state, params.conversationId, {
              phase: "error",
              sessionId: params.sessionId,
              turnId: streamTurnId,
              assistantMessageId: null,
              abortController: null,
              lastError: message,
              lastErrorOrigin: "macro",
              lastErrorDisplayTarget: "composer",
            }),
            lastError: message,
            sendState: "error",
          };
        });
        await deleteEmptyAssistantMessageFromDb();
        return true;
      }
    };

    const compactFollowUpMessagesBeforeProviderRequest = async (request: {
      messages: StreamMessage[];
      turnCount: number;
      toolResultCount: number;
    }): Promise<{ messages: StreamMessage[]; compacted?: boolean } | void> => {
      if (
        abortController.signal.aborted ||
        !shouldAcceptStreamUpdate() ||
        request.toolResultCount <= 0
      ) {
        return;
      }

      const { systemMessage, preparedMessages } =
        splitSystemAndPreparedStreamMessages(request.messages);
      if (preparedMessages.length < 3) {
        return;
      }

      const orderedMessages = buildSyntheticOrderedMessagesForStreamRequest({
        conversationId: params.conversationId,
        taskId: params.resolvedTaskId,
        messages: preparedMessages,
      });
      const { footprintFields } = getSelectedModelContext(
        params.selectedProviderId,
        params.selectedModelId,
        params.providerConfig.providerType,
      );
      const budgetPolicy = await loadContextBudgetPolicy();
      const toolDefinitions = getToolDefinitionsForIds(params.allowedToolIds);
      const preparedMessagesForContext = normalizeMessagesForProviderContext(
        params.providerConfig.providerType,
        preparedMessages,
      );
      const countProviderInputItems = shouldCountProviderInputItemsForContext(
        params.providerConfig.providerType,
      );
      const estimateSerializedPayloadTokens = (messages: StreamMessage[]) =>
        estimateSerializedPayloadTokensForProvider({
          messages,
          providerType: params.providerConfig.providerType,
          providerId: params.selectedProviderId,
          baseUrl: params.providerConfig.baseUrl,
          modelId: params.selectedModelId,
        });
      const footprint = estimateConversationFootprint({
        systemMessage,
        preparedMessages: preparedMessagesForContext,
        orderedMessages,
        citations: contextDiagnosticsBaseline.citations,
        toolDefinitions,
        ...footprintFields,
        estimateSerializedPayloadTokens,
        countProviderInputItems,
        mode: "safety_prestream",
        budgetPolicy,
      });
      const latestToolBatchTokens = Math.ceil(
        JSON.stringify(preparedMessages.slice(-request.toolResultCount)).length / 4,
      );
      const previousStatus =
        get().conversationCompactionStatusById[params.conversationId] ?? null;

      let result: MaybeCompactConversationResult;
      let orchestration: Awaited<
        ReturnType<typeof runContextCompactionOrchestration>
      >;
      try {
        orchestration = await runContextCompactionOrchestration({
          boundary: "post_tool_batch",
          mode: "safety_prestream",
          systemMessage,
          preparedMessages: preparedMessagesForContext,
          orderedMessages,
          citations: contextDiagnosticsBaseline.citations,
          toolDefinitions,
          footprintFields,
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          modelId: params.selectedModelId,
          estimateSerializedPayloadTokens,
          countProviderInputItems,
          budgetPolicy,
          latestBoundaryPayloadTokens: latestToolBatchTokens,
          buildForceCompaction: true,
          forcePrune: true,
          syntheticBoundary: true,
          onCompactionStarted: () => {
            markConversationCompactionStarted(
              params.conversationId,
              "safety_prestream",
              previousStatus,
              params.assistantMessage.id,
            );
          },
          generateSummary: (input) =>
            generateCompactionSummary(
              params.providerConfig,
              params.selectedProviderId,
              params.selectedModelId,
              params.selectedReasoningEffort,
              input,
            ),
        });
      } catch (error) {
        clearLatestRunningSessionCompactionEvent(
          params.conversationId,
          "safety_prestream",
        );
        setConversationCompactionStatus(params.conversationId, previousStatus);
        await recordConversationCompactionEvent({
          conversationId: params.conversationId,
          trigger: "safety_prestream",
          providerId: params.selectedProviderId,
          modelId: params.selectedModelId,
          modelContextWindowTokens: footprint.modelContextWindowTokens,
          tokensBefore: footprint.totalEstimatedTokens,
          tokensAfter: footprint.totalEstimatedTokens,
          status: "failed",
          errorCode: isProviderContextOverflowError(error)
            ? "context_overflow"
            : "tool_boundary_compaction_error",
          reason: toServiceError(error).message,
          metadata: buildCompactionDecisionAuditMetadata({
            providerId: params.selectedProviderId,
            providerType: params.providerConfig.providerType,
            modelId: params.selectedModelId,
            trigger: "safety_prestream",
            status: "failed",
            footprint,
            footprintFields,
            budgetPolicy,
            reason: toServiceError(error).message,
            result: "tool_boundary_compaction_error",
          }),
        });
        throw error;
      }
      if (orchestration.outcome === "blocked") {
        throw buildSendError(orchestration.errorMessage);
      }
      if (orchestration.outcome === "manual_required") {
        throw buildSendError(orchestration.errorMessage);
      }
      if (orchestration.evaluation.decision !== "compact") {
        return;
      }
      result = orchestration.result;

      if (
        result.decision === "hard_stop" ||
        isContextFootprintOverUsableBudget(result.footprintAfter)
      ) {
        clearLatestRunningSessionCompactionEvent(
          params.conversationId,
          "safety_prestream",
        );
        setConversationCompactionStatus(params.conversationId, {
          phase: "too_large",
          updatedAt: new Date().toISOString(),
          reason: result.footprintAfter.reason,
          kind: "safety_prestream",
          footprintAfter: result.footprintAfter,
        });
        await recordConversationCompactionEvent({
          conversationId: params.conversationId,
          trigger: "safety_prestream",
          providerId: params.selectedProviderId,
          modelId: params.selectedModelId,
          modelContextWindowTokens: result.footprintAfter.modelContextWindowTokens,
          tokensBefore: result.footprintBefore.totalEstimatedTokens,
          tokensAfter: result.footprintAfter.totalEstimatedTokens,
          status: "blocked",
          reason: result.footprintAfter.reason,
          metadata: buildCompactionDecisionAuditMetadata({
            providerId: params.selectedProviderId,
            providerType: params.providerConfig.providerType,
            modelId: params.selectedModelId,
            trigger: "safety_prestream",
            status: "blocked",
            footprintBefore: result.footprintBefore,
            footprintAfter: result.footprintAfter,
            footprintFields,
            budgetPolicy,
            reason: result.footprintAfter.reason,
            result: "tool_boundary_context_too_large",
          }),
        });
        throw buildSendError(buildContextTooLargeErrorMessage(result.footprintAfter));
      }

      if (result.compactionState) {
        if (isSyntheticCompactionBoundaryState(result.compactionState)) {
          pendingToolBoundaryCompaction = {
            conversationId: params.conversationId,
            assistantMessageId: params.assistantMessage.id,
            providerId: params.selectedProviderId,
            providerType: params.providerConfig.providerType,
            modelId: params.selectedModelId,
            createdAt: new Date().toISOString(),
            compactionState: result.compactionState,
            footprintBefore: result.footprintBefore,
            footprintAfter: result.footprintAfter,
            messages: result.messages.map(cloneStreamMessage),
          };
        }
        completeLatestSessionCompactionEvent(
          params.conversationId,
          result.compactionState,
          "safety_prestream",
        );
        setConversationCompactionStatus(
          params.conversationId,
          resolveCompactionStatusFromState(result.compactionState),
        );
      } else {
        clearLatestRunningSessionCompactionEvent(
          params.conversationId,
          "safety_prestream",
        );
        setConversationCompactionStatus(params.conversationId, previousStatus);
      }

      await recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: "safety_prestream",
        providerId: params.selectedProviderId,
        modelId: params.selectedModelId,
        modelContextWindowTokens: result.footprintAfter.modelContextWindowTokens,
        tokensBefore: result.footprintBefore.totalEstimatedTokens,
        tokensAfter: result.footprintAfter.totalEstimatedTokens,
        status: result.degraded ? "degraded" : "success",
        reason: result.footprintAfter.reason,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          modelId: params.selectedModelId,
          trigger: "safety_prestream",
          status: result.degraded ? "degraded" : "success",
          footprintBefore: result.footprintBefore,
          footprintAfter: result.footprintAfter,
          footprintFields,
          budgetPolicy,
          reason: result.footprintAfter.reason,
          result: "tool_boundary_compaction",
        }),
      });

      return {
        messages: result.messages,
        compacted: Boolean(result.compactionState),
      };
    };

    const consolidatePendingToolBoundaryCompactionAfterPersistence = async () => {
      const pending = pendingToolBoundaryCompaction;
      pendingToolBoundaryCompaction = null;
      if (!pending) {
        return;
      }

      const { footprintFields } = getSelectedModelContext(
        params.selectedProviderId,
        params.selectedModelId,
        params.providerConfig.providerType,
      );
      const budgetPolicy = await loadContextBudgetPolicy();
      const preparedRequest = await prepareMessagesForRequest(
        params.conversationId,
        params.allowedToolIds,
        params.internalAgentProfile,
        params.modeAtSend,
      );
      const toolDefinitions = getToolDefinitionsForIds(params.allowedToolIds);
      const preparedMessagesForContext = normalizeMessagesForProviderContext(
        params.providerConfig.providerType,
        preparedRequest.preparedMessages,
      );
      const countProviderInputItems = shouldCountProviderInputItemsForContext(
        params.providerConfig.providerType,
      );
      const estimateSerializedPayloadTokens = (messages: StreamMessage[]) =>
        estimateSerializedPayloadTokensForProvider({
          messages,
          providerType: params.providerConfig.providerType,
          providerId: params.selectedProviderId,
          baseUrl: params.providerConfig.baseUrl,
          modelId: params.selectedModelId,
        });
      const consolidation = await consolidateCompletedAssistantTurnCompaction({
        pending,
        systemMessage: preparedRequest.systemMessage,
        preparedMessages: preparedMessagesForContext,
        orderedMessages: preparedRequest.orderedMessages,
        citations: preparedRequest.citations,
        toolDefinitions,
        footprintFields,
        providerId: params.selectedProviderId,
        providerType: params.providerConfig.providerType,
        modelId: params.selectedModelId,
        budgetPolicy,
        estimateSerializedPayloadTokens,
        countProviderInputItems,
        generateSummary: (input) =>
          generateCompactionSummary(
            params.providerConfig,
            params.selectedProviderId,
            params.selectedModelId,
            params.selectedReasoningEffort,
            input,
          ),
      });

      if (consolidation.outcome === "consolidated") {
        if (
          consolidation.shouldPersistCompaction &&
          consolidation.result.compactionState
        ) {
          await persistConversationCompactionState(
            consolidation.result.compactionState,
          );
        }
        await recordConversationCompactionEvent({
          conversationId: params.conversationId,
          trigger:
            consolidation.result.compactionState?.lastTrigger ??
            "safety_prestream",
          providerId: params.selectedProviderId,
          modelId: params.selectedModelId,
          modelContextWindowTokens:
            consolidation.result.footprintAfter.modelContextWindowTokens,
          tokensBefore: consolidation.result.footprintBefore.totalEstimatedTokens,
          tokensAfter: consolidation.result.footprintAfter.totalEstimatedTokens,
          status: consolidation.result.degraded ? "degraded" : "success",
          reason: consolidation.result.footprintAfter.reason,
          metadata: buildCompactionDecisionAuditMetadata({
            providerId: params.selectedProviderId,
            providerType: params.providerConfig.providerType,
            modelId: params.selectedModelId,
            trigger:
              consolidation.result.compactionState?.lastTrigger ??
              "safety_prestream",
            status: consolidation.result.degraded ? "degraded" : "success",
            footprintBefore: consolidation.result.footprintBefore,
            footprintAfter: consolidation.result.footprintAfter,
            footprintFields,
            budgetPolicy,
            reason: consolidation.result.footprintAfter.reason,
            result: "tool_boundary_consolidation",
          }),
        });
        return;
      }

      if (consolidation.outcome === "failed") {
        const footprint =
          consolidation.preflightFootprint ?? pending.footprintAfter;
        await recordConversationCompactionEvent({
          conversationId: params.conversationId,
          trigger: "safety_prestream",
          providerId: params.selectedProviderId,
          modelId: params.selectedModelId,
          modelContextWindowTokens: footprint.modelContextWindowTokens,
          tokensBefore: pending.footprintBefore.totalEstimatedTokens,
          tokensAfter: footprint.totalEstimatedTokens,
          status: "failed",
          errorCode: "tool_boundary_consolidation_failed",
          reason: consolidation.reason,
          metadata: buildCompactionDecisionAuditMetadata({
            providerId: params.selectedProviderId,
            providerType: params.providerConfig.providerType,
            modelId: params.selectedModelId,
            trigger: "safety_prestream",
            status: "failed",
            footprintBefore: pending.footprintBefore,
            footprintAfter: footprint,
            footprintFields,
            budgetPolicy,
            reason: consolidation.reason,
            result: "tool_boundary_consolidation_failed",
          }),
        });
      }

      devLogger.info(
        `Tool-boundary compaction consolidation ${consolidation.outcome} conversation=${params.conversationId} reason=${consolidation.reason}`,
      );
    };

    const streamLifecycle = createChatStreamLifecycleRuntime({
      stream: {
        conversationId: params.conversationId,
        sessionId: params.sessionId,
        turnId: streamTurnId,
        assistantMessageId: params.assistantMessage.id,
        modeAtSend: params.modeAtSend,
        resolvedTaskId: params.resolvedTaskId,
        providerContext: {
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          baseUrl: params.providerConfig.baseUrl ?? "",
          modelId: params.selectedModelId,
        },
      },
      adapters: {
        shouldAcceptStreamUpdate,
        isAbortSignalAborted: () => abortController.signal.aborted,
        appendTokenChunk: (messageId, tokenChunk) => {
          if (tokenChunk.length > 0) finalizeReplayRecoveryAfterProgress();
          get().appendToMessage(messageId, tokenChunk);
        },
        getAssistantMessage: (messageId) =>
          get().messages.find((message) => message.id === messageId),
        updateMessageFields: (messageId, fields) => {
          get().updateMessageFields(messageId, fields);
        },
        updateMessageContent: (messageId, content) => {
          get().updateMessageContent(messageId, content);
        },
        markProviderReachable: (providerId, modelId) => {
          useProviderStore
            .getState()
            .markProviderReachable(providerId, { modelId });
        },
        getTaskStatus: (taskId) =>
          useTaskStore.getState().getTaskById(taskId)?.status ?? null,
        markTaskAwaitingResponse: (taskId) =>
          useTaskStore.getState().markTaskAwaitingResponse(taskId),
        assistantTurnRequiresUserReply,
        updateConversationAfterCompletion: (conversationId, visibleContent) => {
          completionPersistenceOwnersByConversationId.set(conversationId, {
            sessionId: params.sessionId,
            turnId: streamTurnId,
            assistantMessageId: params.assistantMessage.id,
          });
          set((state) => ({
            conversations: state.conversations.map((conv) =>
              conv.id === conversationId
                ? {
                    ...conv,
                    last_message:
                      visibleContent.slice(0, 100) +
                      (visibleContent.length > 100 ? "..." : ""),
                    updated_at: new Date().toISOString(),
                  }
                : conv,
            ),
          }));
          updateConversationRuntimeIfSessionMatches(
            conversationId,
            params.sessionId,
            () => null,
          );
        },
        clearLiveStreamContextEstimate,
        refreshConversationContextDiagnostics: (
          conversationId,
          providerContext,
        ) =>
          refreshConversationContextDiagnostics(conversationId, {
            mode: "full",
            providerContext: {
              providerId: providerContext.providerId,
              providerType: providerContext.providerType,
              baseUrl: providerContext.baseUrl ?? "",
              modelId: providerContext.modelId,
            },
          }),
        persistAssistantStreamResult,
        persistAssistantPartialStreamResult,
        consolidatePendingToolBoundaryCompactionAfterPersistence,
        syncMacroMetadataAfterStream: async (mode, conversationId) => {
          await syncMacroMetadataAfterStreamService({
            mode,
            conversationId,
            trigger: "send",
          });
        },
        setCompletionPersistenceError: ({
          conversationId,
          sessionId,
          turnId,
          assistantMessageId,
          message,
        }) => {
          const currentRuntime = getConversationRuntimeSnapshot(
            get().conversationRuntimeById,
            conversationId,
          );
          const completionOwner =
            completionPersistenceOwnersByConversationId.get(conversationId);
          if (
            completionOwner?.sessionId !== sessionId ||
            completionOwner.turnId !== turnId ||
            completionOwner.assistantMessageId !== assistantMessageId ||
            currentRuntime.phase !== "idle"
          ) {
            return;
          }
          completionPersistenceOwnersByConversationId.delete(conversationId);
          setConversationRuntime(
            conversationId,
            {
              phase: "error",
              sessionId,
              turnId,
              assistantMessageId,
              abortController: null,
              lastError: message,
              lastErrorOrigin: "macro",
              lastErrorDisplayTarget: "composer",
            },
            { globalLastError: message },
          );
          set({ sendState: "error" });
        },
        clearCompletionPersistenceOwnership: ({
          conversationId,
          sessionId,
          turnId,
          assistantMessageId,
        }) => {
          const completionOwner =
            completionPersistenceOwnersByConversationId.get(conversationId);
          if (
            completionOwner?.sessionId === sessionId &&
            completionOwner.turnId === turnId &&
            completionOwner.assistantMessageId === assistantMessageId
          ) {
            completionPersistenceOwnersByConversationId.delete(conversationId);
          }
        },
        maybeMarkImplementTaskFailedAfterStreamError,
        tryRecoverFromOverflow,
        removeEmptyAssistantPlaceholder: (assistantMessageId) => {
          set((state) =>
            removeEmptyAssistantPlaceholderFromState(
              state,
              assistantMessageId,
            ),
          );
        },
        deleteEmptyAssistantMessageFromDb,
        recoverReplayBeforeProgress: params.replayRecovery
          ? params.replayRecovery.onFailedBeforeProgress
          : undefined,
        setStreamErrorState: ({
          presentation,
          assistantMessageId,
        }) => {
          updateConversationRuntimeIfSessionMatches(
            params.conversationId,
            params.sessionId,
            () => ({
              phase: "error",
              sessionId: params.sessionId,
              turnId: streamTurnId,
              assistantMessageId,
              abortController: null,
              lastError: presentation.message,
              lastErrorOrigin: presentation.origin,
              lastErrorDisplayTarget: presentation.displayTarget,
            }),
          );
          set(
            presentation.displayTarget === "composer"
              ? { lastError: presentation.message, sendState: "error" }
              : { sendState: "error" },
          );
        },
        warn: (message, error) => {
          console.warn(message, error);
        },
        info: (message) => {
          devLogger.info(message);
        },
      },
    });

    void runAssistantStream({
      conversationId: params.conversationId,
      mode: params.modeAtSend,
      internalAgentProfile: params.internalAgentProfile,
      providerId: params.selectedProviderId,
      providerType: params.providerConfig.providerType,
      baseUrl: params.providerConfig.baseUrl,
      apiKey: params.providerConfig.apiKey,
      modelId: params.selectedModelId,
      reasoningEffort: params.selectedReasoningEffort,
      messages: params.messagesForRequest,
      fileToolContext: params.fileToolContext,
      allowedToolIds: params.allowedToolIds,
      copilotSendTimeoutMs:
        params.providerConfig.providerType === "copilot"
          ? (useProviderStore.getState().providerSettingsById?.[params.selectedProviderId]
              ?.copilotSendTimeoutMs ?? null)
          : null,
      workspacePath: params.executionContext.workspacePath,
      defaultWorkspacePath: params.executionContext.defaultWorkspacePath,
      projectMounts: params.executionContext.projectMounts,
      virtualRootEnabled: params.executionContext.virtualRootEnabled,
      focusedProjectId: params.executionContext.focusedProjectId,
      guidedToolRetry: params.guidedToolRetry,
      showToolTraces: params.showToolTraces,
      enableWebSearch: params.enableWebSearch,
      enableWebFetch: params.enableWebFetch,
      webSearchOptions: params.webSearchOptions,
      mcpTools: params.mcpTools,
      skillToolIds: params.skillToolIds,
      runnableSkillToolIds: params.runnableSkillToolIds,
      maxTurns: params.maxTurns,
      sessionId: params.sessionId,
      signal: abortController.signal,
      lifecycle: streamLifecycle,
      onToolTracesUpdate: (toolTraces: ToolTrace[]) => {
        if (!shouldAcceptStreamUpdate()) {
          return;
        }
        if (toolTraces.length > 0) {
          finalizeReplayRecoveryAfterProgress();
        }
        get().updateMessageFields(params.assistantMessage.id, {
          tool_traces: toolTraces,
        });
      },
      onBeforeFollowUpRequest: compactFollowUpMessagesBeforeProviderRequest,
      onLiveContextUpdate: (snapshot) => {
        if (!shouldAcceptStreamUpdate()) {
          return;
        }
        recordLiveStreamContextEstimate({
          conversationId: params.conversationId,
          sessionId: params.sessionId,
          assistantMessageId: params.assistantMessage.id,
          snapshot,
        });
      },
      onTimeline: (event) => {
        devLogger.info("Provider stream timeline", {
          requestId: event.request_id,
          providerId: event.provider_id,
          providerType: event.provider_type,
          phase: event.phase,
          elapsedMs: event.elapsed_ms,
        });
      },
      onToolCall: (toolName, args, toolCallId) => {
        finalizeReplayRecoveryAfterProgress();
        return handleToolCall(
          {
            conversationId: params.conversationId,
            sessionId: params.sessionId,
            turnId: streamTurnId,
            assistantMessageId: params.assistantMessage.id,
            mode: params.modeAtSend,
            agentType: params.agentTypeAtSend ?? null,
            taskId: params.resolvedTaskId,
            executionContext: params.executionContext,
            signal: abortController.signal,
          },
          toolName,
          args,
          toolCallId,
        );
      },
    });
  };

  const persistAssistantPartialStreamResult = async (
    assistantMessage: ChatMessage,
  ) => {
    await persistAssistantPartialResult(
      chatPersistenceAdapters,
      assistantMessage,
    );
  };

  const persistAssistantStreamResult = async (
    conversationId: string,
    assistantMessageId: string,
    result: StreamCompletionResult,
  ) => {
    const persistedAssistant = get()
      .getConversationMessages(conversationId)
      .find((message) => message.id === assistantMessageId);
    try {
      await persistAssistantCompletionResult(chatPersistenceAdapters, {
        assistantMessageId,
        persistedAssistant,
        result,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      throw buildSendError(
        `Failed to save assistant response: ${normalized.message}`,
      );
    }
  };

  const logArchitectTranscriptEvent = (
    level: "info" | "warn",
    event: string,
    payload: Record<string, unknown>,
  ) => {
    const entry = {
      event,
      at: new Date().toISOString(),
      ...payload,
    };

    if (level === "warn") {
      console.warn(JSON.stringify(entry));
      return;
    }

    devLogger.info(JSON.stringify(entry));
  };

  const selectConversationInState = (
    conversationId: string,
    mode: AppMode,
  ): boolean => {
    const state = get();
    if (
      !state.conversations.some(
        (candidate) => candidate.id === conversationId,
      )
    ) {
      return false;
    }

    if (
      state.selectedConversationId &&
      state.selectedConversationId !== conversationId
    ) {
      clearConversationSecurityState(state.selectedConversationId);
    }

    set((current) => ({
      selectedConversationId: conversationId,
      selectedConversationIdsByMode: {
        ...current.selectedConversationIdsByMode,
        [mode]: conversationId,
      },
      conversations: current.conversations.map((candidate) =>
        candidate.id === conversationId
          ? { ...candidate, is_unread: false }
          : candidate,
      ),
    }));
    return true;
  };

  const applyConversationSelection = (
    conversationId: string,
    mode: AppMode = useAppStore.getState().mode,
  ): boolean => {
    let appState = useAppStore.getState();
    const state = get();
    const conversation = state.conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    if (!conversation) {
      return false;
    }

    if (
      mode === "Implement" &&
      conversation.task_id &&
      appState.selectedTaskId !== conversation.task_id
    ) {
      const resolvedTask = resolveImplementTaskForContext({
        selectedTaskId: conversation.task_id,
        tasks: useTaskStore.getState().tasks,
        standaloneProjects: appState.standaloneProjects,
        projectGroups: appState.projectGroups,
        selectedGroupId: appState.selectedGroupId,
        selectedProjectId: appState.selectedProjectId,
        localContext: null,
      });
      if (resolvedTask) {
        appState.setSelectedTask(resolvedTask.id);
        appState = useAppStore.getState();
      }
    }

    if (
      !isConversationAllowedForMode(
        conversation,
        mode,
        appState.selectedGroupId,
        appState.selectedProjectId,
        appState.selectedTaskId,
      )
    ) {
      return false;
    }

    return selectConversationInState(conversationId, mode);
  };

  const repairArchitectPlanConversationScope = async (params: {
    conversationId: string;
    fallbackProjectId?: string | null;
    fallbackGroupId?: string | null;
  }): Promise<Conversation | null> => {
    const appState = useAppStore.getState();
    const currentConversation =
      get().conversations.find(
        (conversation) => conversation.id === params.conversationId,
      ) ?? null;
    if (!currentConversation) {
      return null;
    }

    const repairedProjectId =
      params.fallbackProjectId !== undefined
        ? params.fallbackProjectId
        : currentConversation.project_id ?? appState.selectedProjectId ?? null;
    const repairedGroupId =
      params.fallbackGroupId !== undefined
        ? params.fallbackGroupId
        : appState.selectedGroupId ??
          getProjectGroupByProjectId(
            appState.projectGroups,
            repairedProjectId,
          )?.id ??
          currentConversation.group_id ??
          null;

    const repairedConversation: Conversation = {
      ...currentConversation,
      scope_mode: "Architect",
      task_id: null,
      group_id: repairedGroupId,
      project_id: repairedProjectId,
    };

    const needsRepair =
      currentConversation.scope_mode !== repairedConversation.scope_mode ||
      currentConversation.task_id !== repairedConversation.task_id ||
      currentConversation.group_id !== repairedConversation.group_id ||
      currentConversation.project_id !== repairedConversation.project_id;

    if (!needsRepair) {
      return currentConversation;
    }

    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === params.conversationId
          ? repairedConversation
          : conversation,
      ),
    }));

    if (tauriIpc.isTauriAvailable()) {
      try {
        await tauriIpc.updateConversationScope({
          id: params.conversationId,
          scopeMode: "Architect",
          taskId: null,
          groupId: repairedGroupId,
          projectId: repairedProjectId,
        });
      } catch (error) {
        logArchitectTranscriptEvent(
          "warn",
          "architect_conversation_scope_repair_failed",
          {
            conversationId: params.conversationId,
            error: toServiceError(error).message,
          },
        );
      }
    }

    return repairedConversation;
  };

  const clearConversationSelection = (mode: AppMode) => {
    const previousSelectedConversationId = get().selectedConversationId;
    if (previousSelectedConversationId) {
      clearConversationSecurityState(previousSelectedConversationId);
    }
    set((current) => ({
      selectedConversationId: null,
      selectedConversationIdsByMode: {
        ...current.selectedConversationIdsByMode,
        [mode]: null,
      },
    }));
  };

  const beginArchitectPlanSwitchSelection = (params?: { requestId?: number }) => {
    set((current) => ({
      selectedConversationId:
        useAppStore.getState().mode === "Architect"
          ? null
          : current.selectedConversationId,
      selectedConversationIdsByMode: {
        ...current.selectedConversationIdsByMode,
        Architect: null,
      },
      restoreStatus: "resolving",
      pendingArchitectPlanSwitchRequestId:
        params?.requestId ?? current.pendingArchitectPlanSwitchRequestId,
      lastError: null,
    }));
  };

  const isLightweightBlankArchitectPlanPayload = (
    payload: ArchitectPlanActivationPayload,
  ): boolean =>
    !payload.conversationId &&
    !payload.sharedConversation &&
    (payload.resolutionMode === "blank_fast_path" ||
      getArchitectPlanLifecyclePhase({
        status: payload.plan.status,
        nodes: payload.plan.nodes,
        predictedBranches: payload.plan.predictedBranches,
        chatMessageCount: payload.chatMessages.length,
      }) === "blank");

  const createConversationRecord = async (params: {
    title: string;
    taskId: string | null;
    projectId: string | null;
    groupId?: string | null;
    selectConversation?: boolean;
  }): Promise<Conversation> => {
    const {
      title,
      taskId,
      projectId,
      groupId,
      selectConversation = true,
    } = params;
    const appState = useAppStore.getState();
    const mode = appState.mode;
    const effectiveTaskId =
      mode === "Implement" ? (appState.selectedTaskId ?? taskId) : taskId;
    const linkedTask = effectiveTaskId
      ? useTaskStore.getState().getTaskById(effectiveTaskId)
      : undefined;
    const resolvedTitle =
      mode === "Implement" && linkedTask?.title
        ? `Task - ${linkedTask.title}`
        : title.trim() || "New Conversation";
    const resolvedTaskId =
      mode === "Chat" ? null : mode === "Implement" ? effectiveTaskId : taskId;
    const resolvedProjectId =
      mode === "Chat"
        ? null
        : mode === "Implement"
          ? (projectId ??
            linkedTask?.project_id ??
            appState.selectedProjectId ??
            null)
          : projectId;
    const resolvedGroupId =
      mode === "Chat"
        ? null
        : mode === "Implement"
          ? (groupId ?? appState.selectedGroupId ?? null)
          : (groupId ?? null);
    const initialAISelection = getCurrentSelection();

    if (mode === "Implement" && resolvedTaskId) {
      const existingConversation = getLatestConversationForTask(resolvedTaskId);
      if (existingConversation) {
        const previousConversationId = get().selectedConversationId;
        if (
          selectConversation &&
          applyConversationSelection(existingConversation.id, mode)
        ) {
          persistSelectionForConversationSwitch(
            mode,
            previousConversationId,
            existingConversation.id,
          );
          await runAiSelectionRestore({
            mode,
            conversationId: existingConversation.id,
            activeContextKey: get().activeContextKey,
            shouldShowResolving: true,
          });
        }
        return existingConversation;
      }
    }

    let newConversation: Conversation;

    if (tauriIpc.isTauriAvailable()) {
      try {
        const dbConversation = await tauriIpc.createConversation({
          title: resolvedTitle,
          scopeMode: mode,
          taskId: resolvedTaskId,
          groupId: resolvedGroupId,
          projectId: resolvedProjectId,
          providerId: initialAISelection?.providerId ?? null,
          modelId: initialAISelection?.modelId ?? null,
          reasoningEffort: initialAISelection?.reasoningEffort ?? null,
        });
        newConversation = mapDbConversationToConversation(dbConversation);
      } catch (error) {
        const normalized = toServiceError(error);
        set({ lastError: normalized.message });
        throw new Error(
          `Impossible de créer la conversation de manière durable : ${normalized.message}`,
        );
      }
    } else {
      newConversation = {
        id: `conv-${createConversationSessionId()}`,
        title: resolvedTitle,
        description: "",
        scope_mode: mode,
        task_id: resolvedTaskId,
        group_id: resolvedGroupId,
        project_id: resolvedProjectId,
        provider_id: initialAISelection?.providerId ?? null,
        model_id: initialAISelection?.modelId ?? null,
        reasoning_effort: initialAISelection?.reasoningEffort ?? null,
        last_message: "",
        message_count: 0,
        updated_at: new Date().toISOString(),
        is_unread: true,
      };
    }

    set((state) => ({
      conversations: [newConversation, ...state.conversations],
      messagesByConversationId: {
        ...state.messagesByConversationId,
        [newConversation.id]: state.messagesByConversationId[newConversation.id] ?? [],
      },
      messageLoadStatusByConversationId: {
        ...state.messageLoadStatusByConversationId,
        [newConversation.id]: "ready",
      },
    }));

    const previousConversationId = get().selectedConversationId;
    if (
      selectConversation &&
      applyConversationSelection(newConversation.id, mode)
    ) {
      persistSelectionForConversationSwitch(
        mode,
        previousConversationId,
        newConversation.id,
      );
      persistSelectionForContext(mode, newConversation.id);
      await runAiSelectionRestore({
        mode,
        conversationId: newConversation.id,
        activeContextKey: get().activeContextKey,
        shouldShowResolving: true,
      });
    }

    return newConversation;
  };

  const createPendingArchitectConversationRecord = (params: {
    planId: string;
    targetBranch: string;
    title: string;
    fallbackProjectId: string | null;
    fallbackGroupId: string | null;
  }): Conversation => {
    const id = `pending-architect-${params.targetBranch}-${params.planId}`;
    const existing = get().conversations.find(
      (conversation) => conversation.id === id,
    );
    pendingArchitectConversationIdsByPlanKey.set(
      getArchitectPlanConversationCacheKey(params.targetBranch, params.planId),
      id,
    );
    pendingArchitectConversationDetailsById.set(id, params);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const initialAISelection = getCurrentSelection();
    const conversation: Conversation = {
      id,
      title: params.title,
      description: "",
      scope_mode: "Architect",
      task_id: null,
      group_id: params.fallbackGroupId,
      project_id: params.fallbackProjectId,
      provider_id: initialAISelection?.providerId ?? null,
      model_id: initialAISelection?.modelId ?? null,
      reasoning_effort: initialAISelection?.reasoningEffort ?? null,
      last_message: "",
      message_count: 0,
      updated_at: now,
      is_unread: false,
    };

    set((state) => ({
      conversations: [conversation, ...state.conversations],
      messagesByConversationId: {
        ...state.messagesByConversationId,
        [id]: [],
      },
      messageLoadStatusByConversationId: {
        ...state.messageLoadStatusByConversationId,
        [id]: "ready",
      },
    }));

    return conversation;
  };

  const replacePendingArchitectConversationId = (
    pendingConversationId: string,
    materializedConversationId: string,
  ) => {
    pendingArchitectConversationDetailsById.delete(pendingConversationId);
    set((state) => ({
      conversations: state.conversations.filter(
        (conversation) => conversation.id !== pendingConversationId,
      ),
      selectedConversationId:
        state.selectedConversationId === pendingConversationId
          ? materializedConversationId
          : state.selectedConversationId,
      selectedConversationIdsByMode: {
        ...state.selectedConversationIdsByMode,
        Architect:
          state.selectedConversationIdsByMode.Architect === pendingConversationId
            ? materializedConversationId
            : state.selectedConversationIdsByMode.Architect,
      },
      messagesByConversationId: Object.fromEntries(
        Object.entries(state.messagesByConversationId).filter(
          ([conversationId]) => conversationId !== pendingConversationId,
        ),
      ),
      messageLoadStatusByConversationId: Object.fromEntries(
        Object.entries(state.messageLoadStatusByConversationId).filter(
          ([conversationId]) => conversationId !== pendingConversationId,
        ),
      ),
    }));
  };

  const materializePendingArchitectConversationIfNeeded = async (
    conversationId: string,
  ): Promise<string> => {
    const pendingDetails =
      pendingArchitectConversationDetailsById.get(conversationId);
    if (!pendingDetails) {
      return conversationId;
    }

    const materialized = await createConversationRecord({
      title: pendingDetails.title,
      taskId: null,
      projectId: pendingDetails.fallbackProjectId,
      groupId: pendingDetails.fallbackGroupId,
      selectConversation: false,
    });
    pendingArchitectConversationIdsByPlanKey.set(
      getArchitectPlanConversationCacheKey(
        pendingDetails.targetBranch,
        pendingDetails.planId,
      ),
      materialized.id,
    );
    replacePendingArchitectConversationId(conversationId, materialized.id);
    persistSelectionForContext("Architect", materialized.id);

    return materialized.id;
  };

  const appendImportedMessagesToState = (
    conversationId: string,
    importedMessages: tauriIpc.DbMessage[] | TranscriptComparableMessage[],
  ): number => {
    if (importedMessages.length === 0) {
      return 0;
    }

    const state = get();
    const existingMessageIds = new Set(
      state.messages.map((message) => message.id),
    );
    const conversationById = new Map(
      state.conversations.map((conversation) => [
        conversation.id,
        conversation,
      ]),
    );
    const normalizedMessages = importedMessages
      .map((message) => {
        if ("conversation_id" in message) {
          return mapDbMessageToChatMessage(message, conversationById);
        }
        return {
          id: message.id,
          task_id: conversationById.get(conversationId)?.task_id ?? "",
          conversation_id: conversationId,
          role: message.role,
          content: message.content,
          timestamp: message.createdAt,
        } satisfies ChatMessage;
      })
      .filter((message) => !existingMessageIds.has(message.id));

    if (normalizedMessages.length === 0) {
      return 0;
    }

    const mergedMessages = [...state.messages, ...normalizedMessages];
    const latestImportedTimestamp =
      normalizedMessages[normalizedMessages.length - 1]?.timestamp ??
      new Date().toISOString();
    const conversationMeta = recalcConversation(
      conversationId,
      mergedMessages,
      latestImportedTimestamp,
    );

    set({
      ...buildMessageState(mergedMessages),
      messageLoadStatusByConversationId: {
        ...state.messageLoadStatusByConversationId,
        [conversationId]: "ready",
      },
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, ...conversationMeta }
          : conversation,
      ),
    });
    scheduleImplementAwaitingResponseReconciliation();

    return normalizedMessages.length;
  };

  const importTranscriptSuffix = async (
    conversationId: string,
    transcript: TranscriptComparableMessage[],
  ): Promise<number> => {
    if (transcript.length === 0) {
      return 0;
    }

    if (tauriIpc.isTauriAvailable()) {
      try {
        const imported = await tauriIpc.importMessages(
          conversationId,
          transcript.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            created_at: message.createdAt,
          })),
        );
        return appendImportedMessagesToState(conversationId, imported);
      } catch (error) {
        console.error("Failed to import architect transcript into DB:", error);
        throw error;
      }
    }

    return appendImportedMessagesToState(conversationId, transcript);
  };

  const syncArchitectMetadataFromDb = async (params: {
    branchName: string;
    planId: string;
    conversationId: string;
    reason: ArchitectTranscriptState["relation"];
  }) => {
    try {
      await syncArchitectPlanChatFromConversation({
        branchName: params.branchName,
        planId: params.planId,
        conversationId: params.conversationId,
      });
      logArchitectTranscriptEvent(
        "info",
        "architect_transcript_metadata_synced",
        params,
      );
    } catch (error) {
      logArchitectTranscriptEvent(
        "warn",
        "architect_transcript_metadata_sync_failed",
        {
          ...params,
          error: toServiceError(error).message,
        },
      );
    }
  };

  const upsertArchitectConversationSync = async (params: {
    conversationId: string;
    planId: string;
    targetBranch: string;
    transcriptRevision?: string | null;
    messageCount: number;
  }) => {
    if (!tauriIpc.isTauriAvailable()) {
      return;
    }
    try {
      await tauriIpc.dbUpsertArchitectPlanConversationSync({
        conversation_id: params.conversationId,
        plan_id: params.planId,
        target_branch: params.targetBranch,
        transcript_revision: params.transcriptRevision ?? null,
        message_count: params.messageCount,
      });
    } catch {
      // Sync stamps are an optimization; transcript reconciliation remains authoritative.
    }
  };

  const reconcileArchitectPlanConversation = async (params: {
    plan: ArchitectPlanRecord;
    targetBranch: string;
    fallbackProjectId?: string;
    fallbackGroupId?: string;
    sharedConversation?: boolean;
    conversationIdHint?: string | null;
    chatMessagesHint?: ArchitectPlanActivationPayload["chatMessages"];
    chatMessagesLoaded?: boolean;
    chatTranscriptRevision?: string | null;
    chatMessageCount?: number;
  }): Promise<{
    conversationId: string | null;
    restoredTranscript: boolean;
    createdConversation: boolean;
  }> => {
    const {
      plan,
      targetBranch,
      fallbackProjectId,
      fallbackGroupId,
      sharedConversation = false,
      conversationIdHint,
      chatMessagesHint,
      chatMessagesLoaded = chatMessagesHint !== undefined,
      chatTranscriptRevision = null,
      chatMessageCount,
    } = params;
    const resolvedConversationId = conversationIdHint ?? plan.conversationId ?? null;
    const existingConversation = resolvedConversationId
      ? (get().conversations.find(
          (conversation) => conversation.id === resolvedConversationId,
        ) ?? null)
      : null;
    let conversation =
      existingConversation && !sharedConversation ? existingConversation : null;
    let createdConversation = false;
    let createdConversationId: string | null = null;
    let restoredTranscript = false;

    try {
    if (!conversation) {
      conversation = await createConversationRecord({
        title: getArchitectPlanConversationTitle(plan),
        taskId: null,
        projectId: fallbackProjectId ?? null,
        groupId: fallbackGroupId ?? null,
        selectConversation: false,
      });
      createdConversation = true;
      createdConversationId = conversation.id;
      await upsertLinkedConversationDeletionSaga({
        ownerType: "plan",
        ownerId: plan.id,
        conversationId: conversation.id,
        phase: "plan_conversation_created",
        targetBranch,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const repairedConversation = await repairArchitectPlanConversationScope({
      conversationId: conversation.id,
      fallbackProjectId,
      fallbackGroupId,
    });
    if (repairedConversation) {
      conversation = repairedConversation;
    }

    const expectedTranscriptCount =
      typeof chatMessageCount === "number" && Number.isFinite(chatMessageCount)
        ? Math.max(0, Math.floor(chatMessageCount))
        : (chatMessagesHint?.length ?? 0);

    if (
      chatMessagesLoaded === false &&
      !sharedConversation &&
      !createdConversation &&
      tauriIpc.isTauriAvailable()
    ) {
      const sync = await tauriIpc
        .dbGetArchitectPlanConversationSync(conversation.id)
        .catch(() => null);
      const conversationCount = conversation.message_count;
      const syncMatches =
        sync?.plan_id === plan.id &&
        sync.target_branch === targetBranch &&
        (sync.transcript_revision ?? null) === (chatTranscriptRevision ?? null) &&
        sync.message_count === expectedTranscriptCount &&
        conversationCount === expectedTranscriptCount;
      if (syncMatches) {
        return {
          conversationId: conversation.id,
          restoredTranscript: false,
          createdConversation: false,
        };
      }
    }

    const transcriptResult =
      chatMessagesLoaded === false
        ? await getArchitectPlanChatTranscript(targetBranch, plan.id).catch(
            () => null,
          )
        : null;
    const transcript = transcriptResult?.messages ?? chatMessagesHint ?? [];
    const resolvedTranscriptRevision =
      transcriptResult?.transcriptRevision ?? chatTranscriptRevision ?? null;

    await ensureMessagesLoadedForConversation(conversation.id);
    const localMessages = getOrderedConversationMessages(conversation.id).map(
      toComparableChatMessage,
    );
    const transcriptMessages = transcript.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
    const transcriptState = compareArchitectTranscriptState(
      localMessages,
      transcriptMessages,
    );

    if (transcriptState.relation === "db_prefix") {
      const importedCount = await importTranscriptSuffix(
        conversation.id,
        transcriptMessages.slice(localMessages.length),
      );
      restoredTranscript = importedCount > 0;
      if (importedCount > 0) {
        await upsertArchitectConversationSync({
          conversationId: conversation.id,
          planId: plan.id,
          targetBranch,
          transcriptRevision: resolvedTranscriptRevision,
          messageCount: transcriptMessages.length,
        });
        logArchitectTranscriptEvent(
          "info",
          "architect_transcript_restored_suffix",
          {
            planId: plan.id,
            conversationId: conversation.id,
            importedCount,
            dbCount: transcriptState.dbCount,
            metadataCount: transcriptState.metadataCount,
          },
        );
      }
    } else if (transcriptState.relation === "metadata_prefix") {
      await syncArchitectMetadataFromDb({
        branchName: targetBranch,
        planId: plan.id,
        conversationId: conversation.id,
        reason: transcriptState.relation,
      });
      await upsertArchitectConversationSync({
        conversationId: conversation.id,
        planId: plan.id,
        targetBranch,
        transcriptRevision: null,
        messageCount: localMessages.length,
      });
    } else if (transcriptState.relation === "diverged") {
      logArchitectTranscriptEvent("warn", "architect_transcript_diverged", {
        planId: plan.id,
        conversationId: conversation.id,
        dbCount: transcriptState.dbCount,
        metadataCount: transcriptState.metadataCount,
      });
      await syncArchitectMetadataFromDb({
        branchName: targetBranch,
        planId: plan.id,
        conversationId: conversation.id,
        reason: transcriptState.relation,
      });
      await upsertArchitectConversationSync({
        conversationId: conversation.id,
        planId: plan.id,
        targetBranch,
        transcriptRevision: null,
        messageCount: localMessages.length,
      });
    } else {
      await upsertArchitectConversationSync({
        conversationId: conversation.id,
        planId: plan.id,
        targetBranch,
        transcriptRevision: resolvedTranscriptRevision,
        messageCount: transcriptMessages.length,
      });
    }

    if (conversation.id !== resolvedConversationId) {
      try {
        await updateArchitectPlan({
          branchName: targetBranch,
          planId: plan.id,
          conversationId: conversation.id,
        });
      } catch (error) {
        const normalized = toServiceError(error);
        throw new Error(
          `Impossible d’associer durablement la conversation au plan : ${normalized.message}`,
        );
      }
    }

    if (createdConversation) {
      try {
        await removeLinkedConversationDeletionSaga("plan", plan.id);
      } catch (error) {
        // The persisted guard is safe to leave behind: bootstrap verifies the
        // plan binding before deciding whether it is a cleanup candidate.
        console.error("Plan conversation creation guard remains pending", error);
      }
    }

    } catch (error) {
      if (!createdConversation || !createdConversationId) {
        throw error;
      }
      const conversationId = createdConversationId;
      deletedConversationIds.add(conversationId);
      const lastError = toServiceError(error).message;
      try {
        await upsertLinkedConversationDeletionSaga({
          ownerType: "plan",
          ownerId: plan.id,
          conversationId,
          phase: "task_deleted",
          targetBranch,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastError,
        });
      } catch (sagaError) {
        console.error(
          "Plan conversation cleanup guard could not be updated",
          sagaError,
        );
      }
      try {
        await deletePersistedConversation(chatPersistenceAdapters, conversationId);
        await deleteConversationToolboxStateIfAvailable(conversationId);
        applyLocalConversationRemoval([conversationId]);
        try {
          await removeLinkedConversationDeletionSaga("plan", plan.id);
        } catch (sagaError) {
          console.error("Plan conversation cleanup guard remains pending", sagaError);
        }
      } catch (cleanupError) {
        const cleanupMessage = toServiceError(cleanupError).message;
        try {
          await upsertLinkedConversationDeletionSaga({
            ownerType: "plan",
            ownerId: plan.id,
            conversationId,
            phase: "task_deleted",
            targetBranch,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastError: cleanupMessage,
          });
        } catch (sagaError) {
          throw new Error(
            `Impossible d’annuler la conversation créée pour le plan : ${cleanupMessage}; le journal de reprise a aussi échoué : ${toServiceError(sagaError).message}`,
          );
        }
        throw new Error(
          `Impossible d’annuler la conversation créée pour le plan ; le nettoyage sera repris automatiquement : ${cleanupMessage}`,
        );
      }
      throw error;
    }

    return {
      conversationId: conversation.id,
      restoredTranscript,
      createdConversation,
    };
  };

  const hydrateChatSnapshot = async (): Promise<void> => {
    conversationCompactionStateCache.clear();
    agentCodeCheckpointLoadPromisesByConversationId.clear();
    messageLoadPromisesByConversationId.clear();
    let {
      conversations,
      messages,
      loadedConversationIds,
      bootstrapError,
    } = await loadChatBootstrapSnapshot(chatPersistenceAdapters);
    let replayRecoveryError: string | null = null;

    if (tauriIpc.isTauriAvailable()) {
      let restoredAnyReplay = false;
      for (const conversation of conversations) {
        const marker = await tauriIpc.dbGetAppSetting(
          `conversationReplayRecovery:${conversation.id}`,
        );
        if (!marker) continue;
        try {
          const recovery = JSON.parse(marker.value_json) as {
            replay_id?: unknown;
            session_id?: unknown;
            turn_id?: unknown;
            phase?: unknown;
          };
          const replayId = recovery.replay_id;
          const sessionId = recovery.session_id;
          const turnId = recovery.turn_id;
          if (
            typeof replayId !== "string" ||
            !replayId ||
            typeof sessionId !== "string" ||
            !sessionId ||
            typeof turnId !== "string" ||
            !turnId
          ) {
            throw new Error("The replay recovery marker is invalid.");
          }
          const restored = await tauriIpc.dbRestoreConversationReplay({
            conversationId: conversation.id,
            replayId,
            sessionId,
            turnId,
          });
          if (!restored) {
            // A launched replay that has already persisted output (or lost the
            // race to a later turn) must win over the old snapshot. Finalizing
            // only removes that exact launched marker; otherwise it remains
            // fail-closed and is retried at the next bootstrap.
            if (recovery.phase === "launched") {
              await tauriIpc.dbFinalizeConversationReplay({
                conversationId: conversation.id,
                replayId,
              });
              const remaining = await tauriIpc.dbGetAppSetting(
                `conversationReplayRecovery:${conversation.id}`,
              );
              if (!remaining) {
                replayRecoveryBlockedConversationIds.delete(conversation.id);
                continue;
              }
            }
            throw new Error("The replay recovery marker could not be applied safely.");
          }
          replayRecoveryBlockedConversationIds.delete(conversation.id);
          restoredAnyReplay = true;
        } catch (error) {
          replayRecoveryBlockedConversationIds.add(conversation.id);
          replayRecoveryError =
            "Replay recovery is pending for a conversation. Its transcript is preserved and editing is locked; reload Macro to retry.";
          console.error("Replay recovery is pending for conversation", conversation.id, error);
        }
      }
      if (restoredAnyReplay) {
        ({ conversations, messages, loadedConversationIds, bootstrapError } =
          await loadChatBootstrapSnapshot(chatPersistenceAdapters));
      }
    }

    if (bootstrapError) {
      console.warn(
        "Falling back to conversation-only chat hydration path:",
        bootstrapError,
      );
    }

    let pendingLinkedTaskDeletions;
    try {
      pendingLinkedTaskDeletions = await loadLinkedConversationDeletionSagas();
    } catch (error) {
      if (error instanceof LinkedConversationDeletionSagaCorruptionError) {
        error.recoverableConversationIds.forEach((conversationId) => {
          deletedConversationIds.add(conversationId);
        });
      }
      throw error;
    }
    const completedPendingConversationDeletionIds = new Set<string>();
    for (const saga of pendingLinkedTaskDeletions) {
      if (
        saga.ownerType === "plan" &&
        saga.phase === "plan_conversation_created"
      ) {
        if (!saga.targetBranch) {
          console.error(
            "Plan conversation creation guard has no target branch and remains fail-closed",
            saga.conversationId,
          );
          continue;
        }
        try {
          const plan = await getArchitectPlan(saga.targetBranch, saga.ownerId);
          if (plan?.conversationId === saga.conversationId) {
            await removeLinkedConversationDeletionSaga(saga.ownerType, saga.ownerId);
            continue;
          }
          await deletePersistedConversation(chatPersistenceAdapters, saga.conversationId);
          await deleteConversationToolboxStateIfAvailable(saga.conversationId);
          await removeLinkedConversationDeletionSaga(saga.ownerType, saga.ownerId);
          completedPendingConversationDeletionIds.add(saga.conversationId);
        } catch (error) {
          console.error(
            "Plan conversation creation cleanup remains pending",
            saga.conversationId,
            error,
          );
        }
        continue;
      }
      if (saga.ownerType === "plan" && saga.phase === "plan_deleting") {
        if (!saga.targetBranch) {
          console.error(
            "Plan deletion guard has no target branch and remains fail-closed",
            saga.conversationId,
          );
          continue;
        }
        try {
          const plan = await getArchitectPlan(saga.targetBranch, saga.ownerId);
          if (plan && plan.status !== "deleted") {
            continue;
          }
          await deletePersistedConversation(chatPersistenceAdapters, saga.conversationId);
          await deleteConversationToolboxStateIfAvailable(saga.conversationId);
          await removeLinkedConversationDeletionSaga(saga.ownerType, saga.ownerId);
          completedPendingConversationDeletionIds.add(saga.conversationId);
        } catch (error) {
          console.error("Plan conversation deletion remains pending", saga.conversationId, error);
        }
        continue;
      }
      if (
        (saga.ownerType !== "plan" && saga.ownerType !== "conversation") ||
        saga.phase !== "task_deleted"
      ) {
        continue;
      }
      try {
        await deletePersistedConversation(chatPersistenceAdapters, saga.conversationId);
        await deleteConversationToolboxStateIfAvailable(saga.conversationId);
        await removeLinkedConversationDeletionSaga(saga.ownerType, saga.ownerId);
        completedPendingConversationDeletionIds.add(saga.conversationId);
      } catch (error) {
        console.error("Plan conversation deletion remains pending", saga.conversationId, error);
      }
    }
    pendingLinkedTaskDeletions = await loadLinkedConversationDeletionSagas();
    const pendingConversationIds = new Set(
      pendingLinkedTaskDeletions
        .filter((saga) => saga.phase !== "prepared")
        .map((saga) => saga.conversationId),
    );
    completedPendingConversationDeletionIds.forEach((conversationId) => {
      pendingConversationIds.add(conversationId);
    });
    pendingConversationIds.forEach((conversationId) => {
      deletedConversationIds.add(conversationId);
    });
    const visibleConversations = conversations.filter(
      (conversation) =>
        !pendingConversationIds.has(conversation.id) &&
        !replayRecoveryBlockedConversationIds.has(conversation.id),
    );
    const visibleMessages = messages.filter(
      (message) =>
        !pendingConversationIds.has(message.conversation_id) &&
        !replayRecoveryBlockedConversationIds.has(message.conversation_id),
    );

    pruneConversationSelections(visibleConversations);

    const loadedImages = loadMessageImagesFromStorage();

    set({
      conversations: visibleConversations,
      ...buildMessageState(visibleMessages),
      messageLoadStatusByConversationId: Object.fromEntries(
        Array.from(loadedConversationIds)
          .filter((conversationId) => !pendingConversationIds.has(conversationId))
          .map((conversationId) => [
          conversationId,
          "ready" as const,
        ]),
      ),
      messageImagesByMessageId: loadedImages,
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      hydrationStatus: "ready",
      restoreStatus: "idle",
      activeContextKey: null,
      selectionRequestId: 0,
      pendingArchitectPlanSwitchRequestId: null,
      conversationRuntimeById: {},
      conversationCompactionStatusById: {},
      sessionCompactionEventsByConversationId: {},
      agentCodeCheckpointsByConversationId: {},
      contextDiagnosticsByConversationId: {},
      liveStreamContextEstimatesByConversationId: {},
      isLoading: false,
      isStreaming: false,
      sendState: "idle",
      lastError: replayRecoveryError ?? null,
      abortController: null,
    });
    scheduleImplementAwaitingResponseReconciliation();
  };

  const resolveConversationForCurrentContext = async (
    requestId: number,
    contextKey: ChatContextKey,
  ): Promise<ResolvedConversationForContext> => {
    const modeFallback = (
      conversationId: string | null,
    ): ResolvedConversationForContext => ({
      conversationId,
      source: "mode_fallback",
    });
    const activePlanResolution = (params: {
      conversationId: string;
      planId: string;
      targetBranch: string;
      fallbackProjectId?: string | null;
      fallbackGroupId?: string | null;
    }): ResolvedConversationForContext => ({
      conversationId: params.conversationId,
      source: "active_plan",
      planId: params.planId,
      targetBranch: params.targetBranch,
      fallbackProjectId: params.fallbackProjectId ?? null,
      fallbackGroupId: params.fallbackGroupId ?? null,
    });
    const isCurrentRequest = () => {
      const state = get();
      return (
        state.selectionRequestId === requestId &&
        state.activeContextKey === contextKey &&
        isChatContextKeyCurrent(contextKey)
      );
    };

    let appState = useAppStore.getState();
    let { mode, selectedGroupId, selectedProjectId, selectedTaskId } =
      appState;
    let state = get();
    const architectWorkspaceState =
      mode === "Architect"
        ? resolveProjectWorkspaceState({
            standaloneProjects: appState.standaloneProjects,
            projectGroups: appState.projectGroups,
            selectedGroupId,
            selectedProjectId,
          })
        : null;

    if (
      mode === "Architect" &&
      architectWorkspaceState &&
      isProjectWorkspaceMissing(architectWorkspaceState)
    ) {
      clearPendingArchitectConversationsExcept();
      return modeFallback(null);
    }

    if (mode === "Architect" && !appState.activeArchitectPlanId) {
      clearPendingArchitectConversationsExcept();
      return modeFallback(null);
    }

    if (mode !== "Architect" || !appState.activeArchitectPlanId) {
      clearPendingArchitectConversationsExcept();
    }

    if (mode === "Architect" && appState.activeArchitectPlanId) {
      const architectResolutionStartedAt = Date.now();
      try {
        const targetBranch = resolveTargetBranch(
          appState.activePlanContext?.targetBranch,
        );
        const architectPlanSwitch = appState.architectPlanSwitch;
        const currentScopedProjectIds = getScopedProjectIds(
          {
            standaloneProjects: appState.standaloneProjects,
            projectGroups: appState.projectGroups,
          },
          appState.selectedGroupId,
          appState.selectedProjectId,
        );
        const architectSwitchSummaryHint =
          architectPlanSwitch.targetPlanId === appState.activeArchitectPlanId
            ? architectPlanSwitch.summaryHint
            : null;
        const activationScopedProjectIdsHint =
          currentScopedProjectIds.length > 0
            ? currentScopedProjectIds
            : architectSwitchSummaryHint
              ? getArchitectPlanVisibleProjectIds(architectSwitchSummaryHint)
              : undefined;
        const sharedActivationPayload =
          appState.consumeArchitectPlanActivationPayload({
            planId: appState.activeArchitectPlanId,
            targetBranch,
          });
        const activationPayload: ArchitectPlanActivationPayload | null =
          sharedActivationPayload ??
          (await getArchitectPlanActivationPayload(
            targetBranch,
            appState.activeArchitectPlanId,
            {
              summaryHint: architectSwitchSummaryHint,
              scopedProjectIdsHint: activationScopedProjectIdsHint,
            },
          ));
        const activationPayloadSource = sharedActivationPayload
          ? "app_store"
          : "service";
        if (!isCurrentRequest()) return modeFallback(null);
        const activePlan =
          activationPayload?.plan ??
          (await getArchitectPlan(
            targetBranch,
            appState.activeArchitectPlanId,
          ));
        if (!isCurrentRequest()) return modeFallback(null);
        if (activePlan && activePlan.status !== "deleted") {
          const fallbackProjectId =
            resolvePlanProjectContextId(activePlan, selectedProjectId) ||
            getArchitectPlanVisibleProjectIds(activePlan)[0] ||
            selectedProjectId ||
            appState.standaloneProjects[0]?.id ||
            appState.projectGroups.flatMap((group) => group.projects)[0]?.id ||
            null;
          const fallbackGroupId = selectedGroupId ?? null;
          clearPendingArchitectConversationsExcept({
            targetBranch,
            planId: activePlan.id,
          });

          if (
            activationPayload &&
            isLightweightBlankArchitectPlanPayload(activationPayload)
          ) {
            const pendingConversationId = getPendingArchitectConversationId({
              targetBranch,
              planId: activePlan.id,
            });
            if (pendingConversationId) {
              await repairArchitectPlanConversationScope({
                conversationId: pendingConversationId,
                fallbackProjectId,
                fallbackGroupId,
              });
              return activePlanResolution({
                conversationId: pendingConversationId,
                planId: activePlan.id,
                targetBranch,
                fallbackProjectId,
                fallbackGroupId,
              });
            }

            const blankConversation = createPendingArchitectConversationRecord({
              planId: activePlan.id,
              targetBranch,
              title: getArchitectPlanConversationTitle(activePlan),
              fallbackProjectId: fallbackProjectId ?? null,
              fallbackGroupId: selectedGroupId ?? null,
            });
            if (!isCurrentRequest()) {
              return modeFallback(null);
            }
            logArchitectTranscriptEvent(
              "info",
              "architect_conversation_resolved",
              {
                planId: activePlan.id,
                conversationId: blankConversation.id,
                source: activationPayloadSource,
                resolutionMode:
                  activationPayload?.resolutionMode ?? "full",
                durationMs: Date.now() - architectResolutionStartedAt,
              },
            );
            return activePlanResolution({
              conversationId: blankConversation.id,
              planId: activePlan.id,
              targetBranch,
              fallbackProjectId,
              fallbackGroupId,
            });
          }

          clearPendingArchitectConversationForPlan({
            targetBranch,
            planId: activePlan.id,
          });
          const conversationId =
            activationPayload?.conversationId ??
            activePlan.conversationId ??
            null;
          let hasSharedConversation =
            activationPayload?.sharedConversation ?? false;
          if (!activationPayload && conversationId) {
            const plansSnapshot = await listArchitectPlans(
              targetBranch,
              true,
              true,
              {
                scopedProjectIdsHint: currentScopedProjectIds,
              },
            );
            if (!isCurrentRequest()) return modeFallback(null);
            hasSharedConversation = plansSnapshot.plans.some(
              (candidate) =>
                candidate.id !== activePlan.id &&
                candidate.conversationId === conversationId,
            );
          }
          const ensuredConversation = await reconcileArchitectPlanConversation({
            plan: activePlan,
            targetBranch,
            fallbackProjectId: fallbackProjectId ?? undefined,
            fallbackGroupId: fallbackGroupId ?? undefined,
            sharedConversation: hasSharedConversation,
            conversationIdHint: conversationId,
            chatMessagesHint: activationPayload?.chatMessages,
            chatMessagesLoaded: activationPayload?.chatMessagesLoaded,
            chatTranscriptRevision: activationPayload?.chatTranscriptRevision,
            chatMessageCount: activationPayload?.chatMessageCount,
          });
          if (!isCurrentRequest()) return modeFallback(null);
          if (ensuredConversation.conversationId) {
            logArchitectTranscriptEvent(
              "info",
              "architect_conversation_resolved",
              {
                planId: activePlan.id,
                conversationId: ensuredConversation.conversationId,
                source: activationPayloadSource,
                resolutionMode:
                  activationPayload?.resolutionMode ?? "full",
                restoredTranscript: ensuredConversation.restoredTranscript,
                createdConversation: ensuredConversation.createdConversation,
                durationMs: Date.now() - architectResolutionStartedAt,
              },
            );
            return activePlanResolution({
              conversationId: ensuredConversation.conversationId,
              planId: activePlan.id,
              targetBranch,
              fallbackProjectId,
              fallbackGroupId,
            });
          }
        }
      } catch (error) {
        logArchitectTranscriptEvent(
          "warn",
          "architect_conversation_resolution_failed",
          {
            planId: appState.activeArchitectPlanId,
            error: toServiceError(error).message,
          },
        );
      }
    }

    const localProjectContext = selectedGroupId
      ? await getLocalProjectContextState(selectedGroupId)
      : null;
    if (!isCurrentRequest()) return modeFallback(null);
    state = get();

    const localContextConversationId =
      mode === "Architect"
        ? localProjectContext?.architectConversationId
        : mode === "Implement"
          ? localProjectContext?.implementConversationId
          : null;
    const localContextConversation = localContextConversationId
      ? state.conversations.find(
          (conversation) => conversation.id === localContextConversationId,
        )
      : null;

    if (mode === "Implement" && !selectedTaskId) {
      return modeFallback(null);
    }

    if (
      localContextConversation &&
      isConversationAllowedForMode(
        localContextConversation,
        mode,
        selectedGroupId,
        selectedProjectId,
        selectedTaskId,
      )
    ) {
      return modeFallback(localContextConversation.id);
    }

    const rememberedId = state.selectedConversationIdsByMode[mode] ?? null;
    const archivedChatConversationPreference =
      mode === "Chat"
        ? await loadPreference<unknown>(
            PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS,
          )
        : null;
    const archivedChatConversationIds = Array.isArray(
      archivedChatConversationPreference,
    )
      ? new Set(
          archivedChatConversationPreference
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean),
        )
      : EMPTY_STRING_SET;
    const rememberedConversation = rememberedId
      ? state.conversations.find(
          (conversation) => conversation.id === rememberedId,
        )
      : null;

    if (
      rememberedConversation &&
      !archivedChatConversationIds.has(rememberedConversation.id) &&
      isConversationAllowedForMode(
        rememberedConversation,
        mode,
        selectedGroupId,
        selectedProjectId,
        selectedTaskId,
      )
    ) {
      return modeFallback(rememberedConversation.id);
    }

    const fallbackConversationId = getFallbackConversationIdForMode(
      state.conversations,
      mode,
      selectedGroupId,
      selectedProjectId,
      selectedTaskId,
      archivedChatConversationIds,
    );
    if (fallbackConversationId) {
      return modeFallback(fallbackConversationId);
    }

    if (mode === "Architect" && selectedGroupId) {
      const globalProject = getGlobalProjectById(
        appState.projectGroups,
        selectedGroupId,
      );
      const fallbackProjectId =
        getFocusedProjectForGroup(
          appState.projectGroups,
          selectedGroupId,
          selectedProjectId,
          localProjectContext,
        )?.id ??
        selectedProjectId ??
        null;
      const title = globalProject
        ? `Architect - ${globalProject.name}`
        : "Architect Session";
      const created = await createConversationRecord({
        title,
        taskId: null,
        projectId: fallbackProjectId,
        groupId: selectedGroupId,
        selectConversation: false,
      });
      if (!isCurrentRequest()) return modeFallback(null);
      return modeFallback(created.id);
    }

    if (mode === "Implement" && selectedTaskId) {
      const task = useTaskStore.getState().getTaskById(selectedTaskId);
      const projectId =
        task?.project_id ??
        task?.project_ids?.[0] ??
        getFocusedProjectForGroup(
          appState.projectGroups,
          selectedGroupId,
          selectedProjectId,
          localProjectContext,
        )?.id ??
        selectedProjectId;
      const created = await createConversationRecord({
        title: task ? `Task - ${task.title}` : "Task Session",
        taskId: selectedTaskId,
        projectId: projectId ?? null,
        groupId: selectedGroupId,
        selectConversation: false,
      });
      if (!isCurrentRequest()) return modeFallback(null);
      return modeFallback(created.id);
    }

    if (mode === "Implement") {
      const fallbackProjectId =
        getFocusedProjectForGroup(
          appState.projectGroups,
          selectedGroupId,
          selectedProjectId,
          localProjectContext,
        )?.id ??
        selectedProjectId ??
        null;
      const fallbackTitle = fallbackProjectId
        ? `Repository review`
        : "Implement Session";
      const created = await createConversationRecord({
        title: fallbackTitle,
        taskId: null,
        projectId: fallbackProjectId,
        groupId: selectedGroupId,
        selectConversation: false,
      });
      if (!isCurrentRequest()) return modeFallback(null);
      return modeFallback(created.id);
    }

    return modeFallback(null);
  };

  return {
    messages: [],
    messagesByConversationId: {},
    messageIndexById: {},
    messageLoadStatusByConversationId: {},
    conversations: [],
    selectedConversationId: null,
    selectedConversationIdsByMode: {},
    hydrationStatus: "idle",
    restoreStatus: "idle",
    activeContextKey: null,
    selectionRequestId: 0,
    pendingArchitectPlanSwitchRequestId: null,
    conversationRuntimeById: {},
    conversationCompactionStatusById: {},
    sessionCompactionEventsByConversationId: {},
    agentCodeCheckpointsByConversationId: {},
    contextDiagnosticsByConversationId: {},
    liveStreamContextEstimatesByConversationId: {},
    isLoading: false,
    isStreaming: false,
    sendState: "idle",
    lastError: null,
    abortController: null,
    messageImagesByMessageId: {},
    questionnaireDraftsByConversationId: loadQuestionnaireDraftsFromStorage(),
    pendingToolApprovalByConversationId: {},
    conversationApprovalGrantsByConversationId: {},
    skillTurnFeedbackByMessageId: {},
    architectPlanNamingRecovery: null,
    pendingComposerDraftByConversationId: {},
    composerDraftsByContextKey: {},
    composerContextRefs: [],

    addMessage: (message) => {
      set((state) => {
        const nextQuestionnaireDrafts =
          message.role === "user"
            ? clearQuestionnaireDraftsForConversations(
                state.questionnaireDraftsByConversationId,
                [message.conversation_id],
              )
            : state.questionnaireDraftsByConversationId;
        if (message.role === "user") {
          saveQuestionnaireDraftsToStorage(nextQuestionnaireDrafts);
        }
        const conversations = state.conversations.map((conv) =>
          conv.id === message.conversation_id
            ? {
                ...conv,
                last_message: message.content,
                message_count: conv.message_count + 1,
                updated_at: new Date().toISOString(),
                is_unread: message.role === "assistant" ? true : conv.is_unread,
              }
            : conv,
        );
        const nextMessages = [...state.messages, message];
        const nextConversationMessages = sortMessagesChronologically([
          ...getConversationMessagesFromState(state, message.conversation_id),
          message,
        ]);

        return {
          messages: nextMessages,
          messagesByConversationId: {
            ...state.messagesByConversationId,
            [message.conversation_id]: nextConversationMessages,
          },
          messageIndexById: {
            ...state.messageIndexById,
            [message.id]: nextMessages.length - 1,
          },
          messageLoadStatusByConversationId: {
            ...state.messageLoadStatusByConversationId,
            [message.conversation_id]: "ready",
          },
          conversations,
          questionnaireDraftsByConversationId: nextQuestionnaireDrafts,
        };
      });
      scheduleImplementAwaitingResponseReconciliation();
    },

    clearLastError: () =>
      set((state) => ({
        lastError: null,
        ...buildLegacyStreamingFlags({
          conversationRuntimeById: state.conversationRuntimeById,
          selectedConversationId: state.selectedConversationId,
        }),
      })),

    updateMessageContent: (messageId, content) => {
      set((state) => {
        const targetIndex = state.messageIndexById[messageId];
        const updatedMessage =
          typeof targetIndex === "number"
            ? state.messages[targetIndex]
            : undefined;
        if (!updatedMessage || typeof targetIndex !== "number") {
          return state;
        }

        const assistantPresentation =
          updatedMessage.role === "assistant"
            ? buildAssistantMessagePresentation(
                content,
                updatedMessage.hidden_context,
              )
            : null;
        const userPresentation =
          updatedMessage.role === "user"
            ? buildUserMessagePresentation(
                content,
                updatedMessage.hidden_context,
              )
            : null;

        const updatedMessages = [...state.messages];
        updatedMessages[targetIndex] = {
          ...updatedMessage,
          content:
            assistantPresentation?.content ??
            userPresentation?.content ??
            content,
          choices: assistantPresentation?.choices,
          allow_free_response: assistantPresentation?.allow_free_response,
          questionnaire: assistantPresentation?.questionnaire,
          questionnaire_response_summary:
            userPresentation?.questionnaire_response_summary,
        };

        const updatedConversationMessages = getConversationMessagesFromState(
          state,
          updatedMessage.conversation_id,
        ).map((message) =>
          message.id === messageId
            ? {
                ...message,
                content:
                  assistantPresentation?.content ??
                  userPresentation?.content ??
                  content,
                choices: assistantPresentation?.choices,
                allow_free_response: assistantPresentation?.allow_free_response,
                questionnaire: assistantPresentation?.questionnaire,
                questionnaire_response_summary:
                  userPresentation?.questionnaire_response_summary,
              }
            : message,
        );

        const conversationMeta = {
          message_count: updatedConversationMessages.length,
          last_message:
            updatedConversationMessages[updatedConversationMessages.length - 1]
              ?.content ?? "",
          updated_at: new Date().toISOString(),
        };

        const conversations = state.conversations.map((conv) =>
          conv.id === updatedMessage.conversation_id
            ? { ...conv, ...conversationMeta }
            : conv,
        );

        return {
          messages: updatedMessages,
          messagesByConversationId: {
            ...state.messagesByConversationId,
            [updatedMessage.conversation_id]: updatedConversationMessages,
          },
          messageIndexById: state.messageIndexById,
          conversations,
        };
      });
      scheduleImplementAwaitingResponseReconciliation();
    },

    updateMessageFields: (messageId, patch) => {
      set((state) => {
        const targetIndex = state.messageIndexById[messageId];
        if (typeof targetIndex !== "number") {
          return state;
        }

        const updatedMessages = [...state.messages];
        const currentMessage = updatedMessages[targetIndex]!;
        const assistantPresentation =
          currentMessage.role === "assistant"
            ? buildAssistantMessagePresentation(
                currentMessage.content,
                patch.hidden_context ?? currentMessage.hidden_context,
              )
            : null;
        const userPresentation =
          currentMessage.role === "user"
            ? buildUserMessagePresentation(
                currentMessage.content,
                patch.hidden_context ?? currentMessage.hidden_context,
              )
            : null;
        updatedMessages[targetIndex] = {
          ...currentMessage,
          ...patch,
          ...(assistantPresentation
            ? {
                content: assistantPresentation.content,
                choices: assistantPresentation.choices,
                allow_free_response: assistantPresentation.allow_free_response,
                questionnaire: assistantPresentation.questionnaire,
              }
            : {}),
          ...(userPresentation
            ? {
                content: userPresentation.content,
                questionnaire_response_summary:
                  userPresentation.questionnaire_response_summary,
              }
            : {}),
        };

        return {
          messages: updatedMessages,
          messagesByConversationId: {
            ...state.messagesByConversationId,
            [updatedMessages[targetIndex]!.conversation_id]:
              getConversationMessagesFromState(
                state,
                updatedMessages[targetIndex]!.conversation_id,
              ).map((message) =>
                message.id === messageId
                  ? updatedMessages[targetIndex]!
                  : message,
              ),
          },
          messageIndexById: state.messageIndexById,
        };
      });
      scheduleImplementAwaitingResponseReconciliation();
    },

    updateLastMessage: (content) =>
      set((state) => {
        const updatedMessages = [...state.messages];
        if (updatedMessages.length > 0) {
          const lastIndex = updatedMessages.length - 1;
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content,
          };
        }
        const updatedLastMessage = updatedMessages[updatedMessages.length - 1];
        if (!updatedLastMessage) {
          return state;
        }

        return {
          messages: updatedMessages,
          messagesByConversationId: {
            ...state.messagesByConversationId,
            [updatedLastMessage.conversation_id]:
              getConversationMessagesFromState(
                state,
                updatedLastMessage.conversation_id,
              ).map((message) =>
                message.id === updatedLastMessage.id
                  ? updatedLastMessage
                  : message,
              ),
          },
          messageIndexById: state.messageIndexById,
        };
      }),

    appendToLastMessage: (token) =>
      set((state) => {
        const updatedMessages = [...state.messages];
        if (updatedMessages.length > 0) {
          const lastIndex = updatedMessages.length - 1;
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content: updatedMessages[lastIndex].content + token,
          };
        }
        const updatedLastMessage = updatedMessages[updatedMessages.length - 1];
        if (!updatedLastMessage) {
          return state;
        }

        return {
          messages: updatedMessages,
          messagesByConversationId: {
            ...state.messagesByConversationId,
            [updatedLastMessage.conversation_id]:
              getConversationMessagesFromState(
                state,
                updatedLastMessage.conversation_id,
              ).map((message) =>
                message.id === updatedLastMessage.id
                  ? updatedLastMessage
                  : message,
              ),
          },
          messageIndexById: state.messageIndexById,
        };
      }),

    appendToMessage: (messageId, tokenChunk) =>
      set((state) => {
        const targetIndex = state.messageIndexById[messageId];
        if (typeof targetIndex !== "number") {
          return state;
        }

        const updatedMessages = [...state.messages];
        const targetMessage = updatedMessages[targetIndex];
        if (!targetMessage) {
          return state;
        }

        updatedMessages[targetIndex] = {
          ...targetMessage,
          content: targetMessage.content + tokenChunk,
        };
        return {
          messages: updatedMessages,
          messagesByConversationId: {
            ...state.messagesByConversationId,
            [targetMessage.conversation_id]: getConversationMessagesFromState(
              state,
              targetMessage.conversation_id,
            ).map((message) =>
              message.id === messageId
                ? updatedMessages[targetIndex]!
                : message,
            ),
          },
          messageIndexById: state.messageIndexById,
        };
      }),

    clearMessages: () => {
      conversationCompactionStateCache.clear();
      cancelAllLiveContextDiagnosticsRefreshSchedules();
      Object.keys(get().conversationRuntimeById).forEach((conversationId) => {
        stopConversationRuntimeLocally(conversationId);
      });
      latestConversationSessionIdByConversationId.clear();
      completionPersistenceOwnersByConversationId.clear();
      set({
        ...buildMessageState([]),
        messageLoadStatusByConversationId: {},
        conversationRuntimeById: {},
        conversationCompactionStatusById: {},
        sessionCompactionEventsByConversationId: {},
        agentCodeCheckpointsByConversationId: {},
        contextDiagnosticsByConversationId: {},
        liveStreamContextEstimatesByConversationId: {},
        ...buildLegacyStreamingFlags({
          conversationRuntimeById: {},
          selectedConversationId: get().selectedConversationId,
        }),
      });
      scheduleImplementAwaitingResponseReconciliation();
    },

    setMessageImages: (messageId, images) =>
      set((state) => {
        const next = { ...state.messageImagesByMessageId };
        if (images.length > 0) {
          next[messageId] = images;
        } else {
          delete next[messageId];
        }
        saveMessageImagesToStorage(next);
        return { messageImagesByMessageId: next };
      }),

    getMessageImages: (messageId) => {
      const state = get();
      return state.messageImagesByMessageId[messageId] || EMPTY_MESSAGE_IMAGES;
    },

    dismissArchitectPlanNamingRecovery: () =>
      set({ architectPlanNamingRecovery: null }),

    setArchitectPlanNamingRecoveryStage: (stage) =>
      set((state) =>
        state.architectPlanNamingRecovery
          ? {
              architectPlanNamingRecovery: {
                ...state.architectPlanNamingRecovery,
                stage,
                error: null,
              },
            }
          : state,
      ),

    retryArchitectPlanNamingRecovery: async () => {
      const recovery = get().architectPlanNamingRecovery;
      if (!recovery || recovery.isSubmitting) {
        return false;
      }

      set((state) => ({
        architectPlanNamingRecovery: state.architectPlanNamingRecovery
          ? {
              ...state.architectPlanNamingRecovery,
              stage: "choice",
              isSubmitting: true,
              error: null,
            }
          : null,
      }));

      const recoverablePlan = await loadRecoverableArchitectPlan({
        architectPlan: {
          planId: recovery.planId,
          targetBranch: recovery.targetBranch,
        },
        conversationId: recovery.conversationId,
      });

      if (!recoverablePlan) {
        set({ architectPlanNamingRecovery: null });
        return false;
      }

      try {
        const providerContext =
          await resolveMetadataGenerationProviderContext({
            providerId: recovery.providerId,
            modelId: recovery.modelId,
            reasoningEffort: recovery.reasoningEffort,
          });
        const metadata = await requestConversationMetadataWithRetries(
          {
            firstUserContent: recovery.firstUserContent,
            ...providerContext,
          },
          ARCHITECT_PLAN_METADATA_ATTEMPT_LIMIT,
        );
        const applied = await applyArchitectPlanInitialMetadata({
          architectPlan: {
            planId: recovery.planId,
            targetBranch: recovery.targetBranch,
          },
          conversationId: recovery.conversationId,
          metadata,
        });
        if (!applied) {
          set({ architectPlanNamingRecovery: null });
          return false;
        }
        return true;
      } catch (error) {
        set((state) => ({
          architectPlanNamingRecovery: state.architectPlanNamingRecovery
            ? {
                ...state.architectPlanNamingRecovery,
                stage: "choice",
                isSubmitting: false,
                error:
                  error instanceof Error && error.message.trim()
                    ? error.message
                    : "Macro could not generate a plan name automatically.",
              }
            : null,
        }));
        return false;
      }
    },

    submitArchitectPlanManualName: async (value) => {
      const recovery = get().architectPlanNamingRecovery;
      const trimmedValue = value.trim();
      if (!recovery || recovery.isSubmitting || !trimmedValue) {
        return false;
      }

      set((state) => ({
        architectPlanNamingRecovery: state.architectPlanNamingRecovery
          ? {
              ...state.architectPlanNamingRecovery,
              stage: "manual",
              isSubmitting: true,
              error: null,
            }
          : null,
      }));

      const recoverablePlan = await loadRecoverableArchitectPlan({
        architectPlan: {
          planId: recovery.planId,
          targetBranch: recovery.targetBranch,
        },
        conversationId: recovery.conversationId,
      });

      if (!recoverablePlan) {
        set({ architectPlanNamingRecovery: null });
        return false;
      }

      try {
        const updatedPlan = await updateArchitectPlan({
          branchName: recovery.targetBranch,
          planId: recoverablePlan.id,
          label: trimmedValue,
        });
        await syncConversationMetadataFromArchitectPlan(
          recovery.conversationId,
          updatedPlan,
        );
        await hydrateActiveArchitectPlanIfNeeded({
          updatedPlan,
          targetBranch: recovery.targetBranch,
        });
        set({ architectPlanNamingRecovery: null });
        return true;
      } catch (error) {
        set((state) => ({
          architectPlanNamingRecovery: state.architectPlanNamingRecovery
            ? {
                ...state.architectPlanNamingRecovery,
                stage: "manual",
                isSubmitting: false,
                error:
                  error instanceof Error && error.message.trim()
                    ? error.message
                    : "Failed to rename the plan.",
              }
            : null,
        }));
        return false;
      }
    },

    syncArchitectPlanConversationMetadata: async (
      conversationId,
      plan,
      descriptionOverride,
    ) => {
      await syncConversationMetadataFromArchitectPlan(
        conversationId,
        plan,
        descriptionOverride,
      );
    },

    replaceComposerContextRefs: (refs, conversationId) => {
      const nextRefs = refs.map((ref) => ({ ...ref }));
      composerContextRefsRevision += 1;
      set({ composerContextRefs: nextRefs });
      if (conversationId) {
        persistComposerContextRefsForConversation(conversationId, nextRefs);
      }
    },

    addComposerContextRef: (ref) => {
      let nextRefs: ContextReference[] | null = null;
      set((state) => {
        const exists = state.composerContextRefs.some(
          (r) => r.id === ref.id && r.kind === ref.kind,
        );
        if (exists) return state;
        composerContextRefsRevision += 1;
        nextRefs = [...state.composerContextRefs, ref];
        return { composerContextRefs: nextRefs };
      });
      if (nextRefs) {
        persistComposerContextRefsForConversation(
          get().selectedConversationId,
          nextRefs,
        );
      }
    },

    removeComposerContextRef: (id, kind) => {
      let nextRefs: ContextReference[] | null = null;
      set((state) => {
        composerContextRefsRevision += 1;
        nextRefs = state.composerContextRefs.filter(
          (r) => !(r.id === id && r.kind === kind),
        );
        return { composerContextRefs: nextRefs };
      });
      if (nextRefs) {
        persistComposerContextRefsForConversation(
          get().selectedConversationId,
          nextRefs,
        );
      }
    },

    clearComposerContextRefs: () => {
      composerContextRefsRevision += 1;
      set({ composerContextRefs: [] });
      persistComposerContextRefsForConversation(
        get().selectedConversationId,
        [],
      );
    },

    reconcileProjectRegistry: (validGroupIds, validProjectIds) => {
      const validGroupIdSet = new Set(validGroupIds);
      const validProjectIdSet = new Set(validProjectIds);
      set((state) => ({
        conversations: state.conversations.map((conversation) => ({
          ...conversation,
          group_id:
            conversation.group_id && validGroupIdSet.has(conversation.group_id)
              ? conversation.group_id
              : null,
          project_id:
            conversation.project_id &&
            validProjectIdSet.has(conversation.project_id)
              ? conversation.project_id
              : null,
        })),
      }));
      void get().ensureConversationForCurrentMode();
    },

    selectConversation: async (conversationId) => {
      if (get().hydrationStatus === "hydrating") {
        await waitForHydration();
      }
      const mode = useAppStore.getState().mode;
      const previousConversationId = get().selectedConversationId;
      const applied = applyConversationSelection(conversationId, mode);
      if (!applied) {
        return false;
      }
      persistSelectionForConversationSwitch(
        mode,
        previousConversationId,
        conversationId,
      );
      set({ restoreStatus: "resolving", lastError: null });
      await ensureMessagesLoadedForConversation(conversationId);
      await hydrateConversationCitationsIfAvailable(conversationId);
      await hydrateConversationToolboxStateIfAvailable(conversationId);
      await getConversationCompactionState(conversationId);
      await runAiSelectionRestore({
        mode,
        conversationId,
        activeContextKey: get().activeContextKey,
        shouldShowResolving: true,
      });
      return true;
    },

    createConversation: async (title, taskId, projectId, groupId) => {
      const appState = useAppStore.getState();
      const task = taskId ? useTaskStore.getState().getTaskById(taskId) : null;
      const executionTask = task
        ? retargetImplementTaskForSelection(task, {
            standaloneProjects: appState.standaloneProjects,
            projectGroups: appState.projectGroups,
            selectedGroupId: appState.selectedGroupId,
            selectedProjectId: appState.selectedProjectId,
          })
        : null;

      return createConversationRecord({
        title,
        taskId,
        projectId: executionTask?.project_id ?? projectId,
        groupId,
      });
    },

    beginArchitectPlanSwitch: (params) => {
      beginArchitectPlanSwitchSelection(params);
    },

    ensureArchitectConversationForPlan: async ({
      plan,
      targetBranch,
      fallbackProjectId,
      fallbackGroupId,
      sharedConversation = false,
    }) => {
      const ensuredConversation = await reconcileArchitectPlanConversation({
        plan,
        targetBranch,
        fallbackProjectId,
        fallbackGroupId,
        sharedConversation,
      });

      if (ensuredConversation.conversationId) {
        const mode = useAppStore.getState().mode;
        const previousConversationId = get().selectedConversationId;
        if (
          applyConversationSelection(ensuredConversation.conversationId, mode)
        ) {
          persistSelectionForConversationSwitch(
            mode,
            previousConversationId,
            ensuredConversation.conversationId,
          );
          await ensureMessagesLoadedForConversation(
            ensuredConversation.conversationId,
          );
          await hydrateConversationCitationsIfAvailable(
            ensuredConversation.conversationId,
          );
          await hydrateConversationToolboxStateIfAvailable(
            ensuredConversation.conversationId,
          );
          await runAiSelectionRestore({
            mode,
            conversationId: ensuredConversation.conversationId,
            activeContextKey: get().activeContextKey,
            shouldShowResolving: true,
          });
        }
      }

      return ensuredConversation;
    },

    ensureConversationForCurrentMode: async () => {
      await waitForHydration();

      let appState = useAppStore.getState();
      if (appState.mode === "Implement") {
        const localContext = appState.selectedGroupId
          ? await getLocalProjectContextState(appState.selectedGroupId)
          : null;
        const resolvedTask = resolveImplementTaskForContext({
          selectedTaskId: appState.selectedTaskId,
          tasks: useTaskStore.getState().tasks,
          standaloneProjects: appState.standaloneProjects,
          projectGroups: appState.projectGroups,
          selectedGroupId: appState.selectedGroupId,
          selectedProjectId: appState.selectedProjectId,
          localContext,
        });
        if (resolvedTask && appState.selectedTaskId !== resolvedTask.id) {
          appState.setSelectedTask(resolvedTask.id);
          appState = useAppStore.getState();
        } else if (!resolvedTask && appState.selectedTaskId) {
          appState.setSelectedTask(null);
          appState = useAppStore.getState();
        }
      }
      const mode = appState.mode;
      const contextKey = buildChatContextKey(appState);
      const stateBeforeResolve = get();
      const requestId =
        mode === "Architect" &&
        typeof stateBeforeResolve.pendingArchitectPlanSwitchRequestId ===
          "number"
          ? Math.max(
              stateBeforeResolve.selectionRequestId + 1,
              stateBeforeResolve.pendingArchitectPlanSwitchRequestId,
            )
          : stateBeforeResolve.selectionRequestId + 1;
      const contextChanged = stateBeforeResolve.activeContextKey !== contextKey;
      if (mode === "Architect" && contextChanged) {
        beginArchitectPlanSwitchSelection();
      }
      const shouldShowResolving =
        contextChanged ||
        !stateBeforeResolve.selectedConversationId ||
        stateBeforeResolve.restoreStatus === "error";

      set({
        selectionRequestId: requestId,
        pendingArchitectPlanSwitchRequestId: null,
        activeContextKey: contextKey,
        lastError: null,
        ...(shouldShowResolving ? { restoreStatus: "resolving" as const } : {}),
      });

      const isCurrentRequest = () => {
        const state = get();
        return (
          state.selectionRequestId === requestId &&
          state.activeContextKey === contextKey &&
          isChatContextKeyCurrent(contextKey)
        );
      };

      try {
        const resolution = await resolveConversationForCurrentContext(
          requestId,
          contextKey,
        );
        if (!isCurrentRequest()) {
          return get().selectedConversationId;
        }
        const conversationId = resolution.conversationId;

        const latestState = get();
        const isAlreadySelected =
          conversationId !== null
            ? latestState.selectedConversationId === conversationId &&
              latestState.selectedConversationIdsByMode[mode] === conversationId
            : latestState.selectedConversationId === null &&
              (latestState.selectedConversationIdsByMode[mode] ?? null) === null;

        if (conversationId) {
          let didSelect = isAlreadySelected;
          if (!didSelect) {
            didSelect = applyConversationSelection(conversationId, mode);
          }
          if (
            !didSelect &&
            resolution.source === "active_plan" &&
            mode === "Architect"
          ) {
            const repairedConversation =
              await repairArchitectPlanConversationScope({
                conversationId,
                fallbackProjectId: resolution.fallbackProjectId ?? null,
                fallbackGroupId: resolution.fallbackGroupId ?? null,
              });
            if (!isCurrentRequest()) {
              return get().selectedConversationId;
            }
            const latestAppState = useAppStore.getState();
            if (
              repairedConversation &&
              latestAppState.mode === "Architect" &&
              latestAppState.activeArchitectPlanId === resolution.planId &&
              getConversationScopeMode(repairedConversation) === "Architect" &&
              !repairedConversation.task_id
            ) {
              didSelect =
                applyConversationSelection(conversationId, mode) ||
                selectConversationInState(conversationId, mode);
            }
          }

          if (!didSelect) {
            if (isCurrentRequest()) {
              set({
                restoreStatus: "error",
                pendingArchitectPlanSwitchRequestId: null,
                lastError: "Failed to select the resolved conversation.",
              });
            }
            return get().selectedConversationId;
          }

          persistSelectionForConversationSwitch(
            mode,
            latestState.selectedConversationId,
            conversationId,
          );
          await ensureMessagesLoadedForConversation(conversationId);
          await hydrateConversationCitationsIfAvailable(conversationId);
          if (!isCurrentRequest()) {
            return get().selectedConversationId;
          }
          await hydrateConversationToolboxStateIfAvailable(conversationId);
          if (!isCurrentRequest()) {
            return get().selectedConversationId;
          }
          await getConversationCompactionState(conversationId);
          await runAiSelectionRestore({
            mode,
            conversationId,
            requestId,
            activeContextKey: contextKey,
            shouldShowResolving,
            clearPendingArchitectPlanSwitchRequestId: true,
          });
          return conversationId;
        }

        persistSelectionForConversationSwitch(
          mode,
          get().selectedConversationId,
          null,
        );
        if (!isAlreadySelected) {
          clearConversationSelection(mode);
        }
        await runAiSelectionRestore({
          mode,
          conversationId: null,
          requestId,
          activeContextKey: contextKey,
          shouldShowResolving,
          clearPendingArchitectPlanSwitchRequestId: true,
        });
        return null;
      } catch (error) {
        const normalized = toServiceError(error);
        if (isCurrentRequest()) {
          set({
            restoreStatus: "error",
            pendingArchitectPlanSwitchRequestId: null,
            lastError: normalized.message,
          });
        }
        return null;
      }
    },

    reapplySelectionForCurrentContext: async () => {
      await waitForHydration();
      await get().ensureConversationForCurrentMode();
    },

    renameConversation: async (conversationId, title) => {
      await renamePersistedConversation(
        chatPersistenceAdapters,
        conversationId,
        title,
      );
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, title } : conv,
        ),
      }));
    },

    clearSelectedConversation: () => {
      const mode = useAppStore.getState().mode;
      clearConversationSelection(mode);
      set({ activeContextKey: null, restoreStatus: "idle" });
    },

    togglePinConversation: async (conversationId) => {
      const conversation = get().conversations.find(
        (candidate) => candidate.id === conversationId,
      );
      if (!conversation || deletedConversationIds.has(conversationId)) {
        throw new Error("Conversation introuvable.");
      }

      if (!tauriIpc.isTauriAvailable()) {
        const isPinned = !conversation.is_pinned;
        set((state) => ({
          conversations: state.conversations.map((candidate) =>
            candidate.id === conversationId
              ? { ...candidate, is_pinned: isPinned }
              : candidate,
          ),
        }));
        return isPinned;
      }

      const isPinned = await tauriIpc.togglePinConversation(conversationId);
      if (deletedConversationIds.has(conversationId)) {
        return isPinned;
      }
      set((state) => ({
        conversations: state.conversations.map((candidate) =>
          candidate.id === conversationId
            ? { ...candidate, is_pinned: isPinned }
            : candidate,
        ),
      }));
      return isPinned;
    },

    deleteConversation: async (conversationId, confirmation) => {
      const conversation = get().conversations.find(
        (candidate) => candidate.id === conversationId,
      );
      if (!conversation) {
        throw new Error("Conversation introuvable.");
      }
      const linkedTask = conversation.task_id
        ? useTaskStore.getState().getTaskById(conversation.task_id)
        : undefined;

      const conversationScopeMode = getConversationScopeMode(conversation);

      if (conversationScopeMode === "Implement") {
        if (confirmation?.mode !== "implement") {
          throw new Error(
            "Suppression bloquée: une conversation Implement nécessite une confirmation explicite.",
          );
        }
      } else if (conversationScopeMode === "Architect") {
        const appState = useAppStore.getState();
        const projectName =
          (conversation.group_id
            ? getGlobalProjectById(
                appState.projectGroups,
                conversation.group_id,
              )?.name?.trim()
            : null) ||
          (conversation.project_id
            ? appState.getProjectById(conversation.project_id)?.name?.trim()
            : null) ||
          null;

        if (confirmation?.mode !== "architect") {
          throw new Error(
            "Suppression bloquée: une conversation Architect nécessite de confirmer le nom du projet.",
          );
        }

        if (
          projectName &&
          confirmation.typedProjectName?.trim() !== projectName
        ) {
          throw new Error("Le nom du projet ne correspond pas.");
        }
      } else if (confirmation && confirmation.mode !== "chat") {
        throw new Error(
          "Type de confirmation invalide pour une conversation Chat.",
        );
      }

      if (
        linkedTask &&
        linkedTask.task_source === "standalone" &&
        linkedTask.standalone_kind === "manual_feature" &&
        linkedTask.draft
      ) {
        await useTaskStore.getState().deleteTask(linkedTask.id);
        if (!get().conversations.some((candidate) => candidate.id === conversationId)) {
          return;
        }
      }

      deletedConversationIds.add(conversationId);
      pendingConversationDeletionIds.add(conversationId);
      latestConversationSessionIdByConversationId.delete(conversationId);
      completionPersistenceOwnersByConversationId.delete(conversationId);
      try {
        await beginStandaloneConversationDeletionSaga(conversationId);
      } catch (error) {
        deletedConversationIds.delete(conversationId);
        pendingConversationDeletionIds.delete(conversationId);
        throw error;
      }
      try {
        await deletePersistedConversation(chatPersistenceAdapters, conversationId);
      } catch (error) {
        try {
          await completeStandaloneConversationDeletionSaga(conversationId);
          deletedConversationIds.delete(conversationId);
        } catch (sagaError) {
          set({
            lastError: `La suppression de la conversation reste en attente : ${toServiceError(sagaError).message}`,
          });
        }
        throw error;
      } finally {
        pendingConversationDeletionIds.delete(conversationId);
      }
      const cleanupFailures: string[] = [];
      const runCleanup = async (label: string, cleanup: () => Promise<void>) => {
        try {
          await cleanup();
        } catch (error) {
          cleanupFailures.push(`${label}: ${toServiceError(error).message}`);
        }
      };
      stopConversationRuntimeLocally(conversationId);
      await runCleanup("toolbox", () =>
        deleteConversationToolboxStateIfAvailable(conversationId),
      );
      if (!cleanupFailures.some((failure) => failure.startsWith("toolbox"))) {
        await runCleanup("journal de nettoyage", () =>
          completeStandaloneConversationDeletionSaga(conversationId),
        );
      }
      conversationCompactionStateCache.delete(conversationId);
      clearAgentCodeCheckpoints(conversationId);
      clearConversationCitationsIfAvailable(conversationId);
      removeConversationSelectionData(conversationId);
      applyLocalConversationRemoval([conversationId]);
      await runCleanup("sélection", () =>
        hydrateSelectedConversationAfterRemoval([conversationId]),
      );

      if (cleanupFailures.length > 0) {
        const message = `Conversation supprimée, mais certaines ressources n'ont pas pu être nettoyées : ${cleanupFailures.join("; ")}`;
        set({ lastError: message });
        throw new Error(message);
      }
    },

    deleteChatConversations: async (conversationIds) => {
      const uniqueIds = Array.from(new Set(conversationIds));
      if (uniqueIds.length === 0) {
        return;
      }

      const conversationsById = new Map(
        get().conversations.map((conversation) => [
          conversation.id,
          conversation,
        ]),
      );
      uniqueIds.forEach((conversationId) => {
        const conversation = conversationsById.get(conversationId);
        if (!conversation) {
          throw new Error("Conversation introuvable.");
        }
        if (getConversationScopeMode(conversation) !== "Chat") {
          throw new Error(
            "La suppression groupée est réservée aux conversations Chat.",
          );
        }
      });

      uniqueIds.forEach((conversationId) => {
        deletedConversationIds.add(conversationId);
        pendingConversationDeletionIds.add(conversationId);
        latestConversationSessionIdByConversationId.delete(conversationId);
        completionPersistenceOwnersByConversationId.delete(conversationId);
      });
      try {
        for (const conversationId of uniqueIds) {
          await beginStandaloneConversationDeletionSaga(conversationId);
        }
      } catch (error) {
        uniqueIds.forEach((conversationId) => {
          deletedConversationIds.delete(conversationId);
          pendingConversationDeletionIds.delete(conversationId);
        });
        throw error;
      }

      let persistedDeletionCommitted = false;
      try {
        await deletePersistedConversations(chatPersistenceAdapters, uniqueIds);
        persistedDeletionCommitted = true;
        uniqueIds.forEach((conversationId) => {
          stopConversationRuntimeLocally(conversationId);
        });
        const cleanupFailures: string[] = [];
        await Promise.all(
          uniqueIds.map(async (conversationId) => {
            try {
              await deleteConversationToolboxStateIfAvailable(conversationId);
            } catch (error) {
              cleanupFailures.push(
                `toolbox ${conversationId}: ${toServiceError(error).message}`,
              );
            }
          }),
        );
        await Promise.all(
          uniqueIds
            .filter(
              (conversationId) =>
                !cleanupFailures.some((failure) =>
                  failure.startsWith(`toolbox ${conversationId}:`),
                ),
            )
            .map(async (conversationId) => {
              try {
                await completeStandaloneConversationDeletionSaga(conversationId);
              } catch (error) {
                cleanupFailures.push(
                  `journal de nettoyage ${conversationId}: ${toServiceError(error).message}`,
                );
              }
            }),
        );
        clearConversationCitationsBulkIfAvailable(uniqueIds);
        uniqueIds.forEach((conversationId) => {
          conversationCompactionStateCache.delete(conversationId);
          clearAgentCodeCheckpoints(conversationId);
          removeConversationSelectionData(conversationId);
        });
        applyLocalConversationRemoval(uniqueIds);
        try {
          await hydrateSelectedConversationAfterRemoval(uniqueIds);
        } catch (error) {
          cleanupFailures.push(`sélection: ${toServiceError(error).message}`);
        }
        if (cleanupFailures.length > 0) {
          const message = `Conversations supprimées, mais certaines ressources n'ont pas pu être nettoyées : ${cleanupFailures.join("; ")}`;
          set({ lastError: message });
          throw new Error(message);
        }
      } catch (error) {
        if (!persistedDeletionCommitted) {
          await Promise.all(
            uniqueIds.map(async (conversationId) => {
              try {
                await completeStandaloneConversationDeletionSaga(conversationId);
                deletedConversationIds.delete(conversationId);
              } catch (sagaError) {
                set({
                  lastError: `La suppression de la conversation reste en attente : ${toServiceError(sagaError).message}`,
                });
              }
            }),
          );
        }
        throw error;
      } finally {
        uniqueIds.forEach((conversationId) => {
          pendingConversationDeletionIds.delete(conversationId);
        });
      }
    },

    completeLinkedTaskConversationDeletion: async (conversationId) => {
      deletedConversationIds.add(conversationId);
      latestConversationSessionIdByConversationId.delete(conversationId);
      completionPersistenceOwnersByConversationId.delete(conversationId);
      stopConversationRuntimeLocally(conversationId);
      conversationCompactionStateCache.delete(conversationId);
      clearAgentCodeCheckpoints(conversationId);
      clearConversationCitationsIfAvailable(conversationId);
      removeConversationSelectionData(conversationId);
      applyLocalConversationRemoval([conversationId]);

      try {
        await deletePersistedConversation(chatPersistenceAdapters, conversationId);
        await deleteConversationToolboxStateIfAvailable(conversationId);
        await hydrateSelectedConversationAfterRemoval([conversationId]);
        return true;
      } catch (error) {
        const message = `La tâche a été supprimée, mais le nettoyage de sa conversation reste en attente : ${toServiceError(error).message}`;
        set({ lastError: message });
        return false;
      }
    },

    markAsRead: (conversationId) =>
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, is_unread: false } : conv,
        ),
      })),

    getConversationByTask: (taskId) => {
      return getLatestConversationForTask(taskId) ?? undefined;
    },

    getConversationMessages: (conversationId) => {
      return getOrderedConversationMessages(conversationId);
    },

    ensureMessagesLoaded: (conversationId) =>
      ensureMessagesLoadedForConversation(conversationId),

    getConversationRuntime: (conversationId) =>
      getConversationRuntimeSnapshot(
        get().conversationRuntimeById,
        conversationId,
      ),

    compactConversationNow: (conversationId) =>
      compactConversationNow(conversationId),

    refreshConversationContextDiagnostics: (conversationId, options) =>
      refreshConversationContextDiagnostics(conversationId, options),

    setComposerDraft: (conversationId, text) => {
      set((state) => ({
        pendingComposerDraftByConversationId: {
          ...state.pendingComposerDraftByConversationId,
          [conversationId]: text,
        },
      }));
    },

    consumeComposerDraft: (conversationId) => {
      const draft = get().pendingComposerDraftByConversationId[conversationId];
      if (draft === undefined) {
        return null;
      }
      set((state) => {
        if (!(conversationId in state.pendingComposerDraftByConversationId)) {
          return state;
        }
        const next = { ...state.pendingComposerDraftByConversationId };
        delete next[conversationId];
        return { pendingComposerDraftByConversationId: next };
      });
      return draft;
    },

    peekComposerDraft: (conversationId) => {
      return get().pendingComposerDraftByConversationId[conversationId] ?? null;
    },

    acknowledgeComposerDraft: (conversationId) => {
      set((state) => {
        if (!(conversationId in state.pendingComposerDraftByConversationId)) {
          return state;
        }
        const next = { ...state.pendingComposerDraftByConversationId };
        delete next[conversationId];
        return { pendingComposerDraftByConversationId: next };
      });
    },

    saveComposerDraftForContext: (contextKey, draft) => {
      if (!contextKey) return;
      set((state) => ({
        composerDraftsByContextKey: {
          ...state.composerDraftsByContextKey,
          [contextKey]: {
            text: draft.text,
            images: [...draft.images],
            contextRefs: draft.contextRefs.map((ref) => ({ ...ref })),
          },
        },
      }));
    },

    getComposerDraftForContext: (contextKey) => {
      const draft = get().composerDraftsByContextKey[contextKey];
      return draft
        ? {
            text: draft.text,
            images: [...draft.images],
            contextRefs: draft.contextRefs.map((ref) => ({ ...ref })),
          }
        : null;
    },

    clearComposerDraftForContext: (contextKey) => {
      set((state) => {
        if (!(contextKey in state.composerDraftsByContextKey)) return state;
        const next = { ...state.composerDraftsByContextKey };
        delete next[contextKey];
        return { composerDraftsByContextKey: next };
      });
    },

    migrateComposerDraftContext: (fromContextKey, toContextKey) => {
      if (!fromContextKey || !toContextKey || fromContextKey === toContextKey) return;
      set((state) => {
        const draft = state.composerDraftsByContextKey[fromContextKey];
        if (!draft) return state;
        const next = { ...state.composerDraftsByContextKey };
        delete next[fromContextKey];
        next[toContextKey] = draft;
        return { composerDraftsByContextKey: next };
      });
    },

    getPendingToolApproval: (conversationId) =>
      get().pendingToolApprovalByConversationId[conversationId] ?? null,

    approvePendingToolApprovalOnce: (conversationId) => {
      const pendingApproval =
        get().pendingToolApprovalByConversationId[conversationId];
      if (!pendingApproval) {
        return;
      }
      pendingToolApprovalResolvers
        .get(
          getPendingToolApprovalResolverKey(
            conversationId,
            pendingApproval.toolCallId,
          ),
        )
        ?.({ kind: "allow_once" });
    },

    approvePendingToolApprovalForConversation: (conversationId) => {
      const pendingApproval =
        get().pendingToolApprovalByConversationId[conversationId];
      if (!pendingApproval) {
        return;
      }
      pendingToolApprovalResolvers
        .get(
          getPendingToolApprovalResolverKey(
            conversationId,
            pendingApproval.toolCallId,
          ),
        )
        ?.({ kind: "allow_conversation" });
    },

    denyPendingToolApproval: (conversationId, reason) => {
      const pendingApproval =
        get().pendingToolApprovalByConversationId[conversationId];
      if (!pendingApproval) {
        return;
      }
      pendingToolApprovalResolvers
        .get(
          getPendingToolApprovalResolverKey(
            conversationId,
            pendingApproval.toolCallId,
          ),
        )
        ?.({ kind: "deny", reason });
    },

    getActiveQuestionnaire: (conversationId) => {
      return resolveConversationQuestionnaireFromState(get(), conversationId);
    },

    startQuestionnaireResponseEdit: (messageId) => {
      const state = get();
      const targetMessage = findChatMessageInState(state, messageId);
      if (
        !targetMessage ||
        targetMessage.role !== "user" ||
        !targetMessage.questionnaire_response_summary
      ) {
        return false;
      }

      const draft: ConversationQuestionnaireDraft = {
        mode: "editing_response",
        assistantMessageId:
          targetMessage.questionnaire_response_summary.assistantMessageId,
        responseMessageId: targetMessage.id,
        currentStepIndex: 0,
        answersByStepId: Object.fromEntries(
          targetMessage.questionnaire_response_summary.items.map((item) => [
            item.id,
            item.answer,
          ]),
        ),
        draftTextByStepId: {},
      };
      const resolved = resolveActiveConversationQuestionnaire(
        targetMessage.conversation_id,
        getConversationMessagesFromState(state, targetMessage.conversation_id),
        draft,
      );
      if (!resolved || resolved.mode !== "editing_response") {
        return false;
      }

      const nextDrafts = setQuestionnaireDraftForConversation(
        state.questionnaireDraftsByConversationId,
        targetMessage.conversation_id,
        {
          ...draft,
          answersByStepId: { ...resolved.answersByStepId },
          draftTextByStepId: { ...resolved.draftTextByStepId },
        },
      );
      saveQuestionnaireDraftsToStorage(nextDrafts);
      set({
        questionnaireDraftsByConversationId: nextDrafts,
      });
      return true;
    },

    cancelQuestionnaireSession: (conversationId) =>
      set((state) => {
        const nextDrafts = clearQuestionnaireDraftsForConversations(
          state.questionnaireDraftsByConversationId,
          [conversationId],
        );
        saveQuestionnaireDraftsToStorage(nextDrafts);
        return {
          questionnaireDraftsByConversationId: nextDrafts,
        };
      }),

    setActiveQuestionnaireStep: (conversationId, stepIndex) =>
      set((state) => {
        const activeQuestionnaire = resolveConversationQuestionnaireFromState(
          state,
          conversationId,
        );
        if (!activeQuestionnaire) {
          return state;
        }

        const boundedStepIndex = Math.min(
          Math.max(stepIndex, 0),
          activeQuestionnaire.totalSteps - 1,
        );
        if (boundedStepIndex === activeQuestionnaire.currentStepIndex) {
          return state;
        }

        const nextDrafts = setActiveQuestionnaireDraftStep(
          state.questionnaireDraftsByConversationId,
          activeQuestionnaire,
          boundedStepIndex,
        );
        saveQuestionnaireDraftsToStorage(nextDrafts);

        return {
          questionnaireDraftsByConversationId: nextDrafts,
        };
      }),

    setActiveQuestionnaireDraftText: (conversationId, value) =>
      set((state) => {
        const activeQuestionnaire = resolveConversationQuestionnaireFromState(
          state,
          conversationId,
        );
        if (!activeQuestionnaire) {
          return state;
        }

        const nextDrafts = setQuestionnaireDraftForConversation(
          state.questionnaireDraftsByConversationId,
          conversationId,
          {
            mode: activeQuestionnaire.mode,
            assistantMessageId: activeQuestionnaire.assistantMessageId,
            responseMessageId: activeQuestionnaire.responseMessageId,
            currentStepIndex: activeQuestionnaire.currentStepIndex,
            answersByStepId: { ...activeQuestionnaire.answersByStepId },
            draftTextByStepId: {
              ...activeQuestionnaire.draftTextByStepId,
              [activeQuestionnaire.currentStep.id]: value,
            },
          },
        );
        saveQuestionnaireDraftsToStorage(nextDrafts);

        return {
          questionnaireDraftsByConversationId: nextDrafts,
        };
      }),

    recordActiveQuestionnaireAnswer: (conversationId, answer) => {
      const normalizedAnswer = answer.trim();
      if (!normalizedAnswer) {
        return null;
      }

      let result:
        | { completed: boolean; state: ConversationQuestionnaireState | null }
        | null = null;

      set((state) => {
        const activeQuestionnaire = resolveConversationQuestionnaireFromState(
          state,
          conversationId,
        );
        if (!activeQuestionnaire) {
          result = null;
          return state;
        }

        const nextAnswersByStepId = {
          ...activeQuestionnaire.answersByStepId,
          [activeQuestionnaire.currentStep.id]: normalizedAnswer,
        };
        const nextDraftTextByStepId = Object.fromEntries(
          Object.entries(activeQuestionnaire.draftTextByStepId).filter(
            ([stepId]) => stepId !== activeQuestionnaire.currentStep.id,
          ),
        );
        const nextUnansweredStepIndex = findFirstUnansweredQuestionStepIndex(
          activeQuestionnaire.questionnaire,
          nextAnswersByStepId,
        );
        const nextStepIndex =
          nextUnansweredStepIndex === null
            ? activeQuestionnaire.currentStepIndex
            : activeQuestionnaire.isLastStep
              ? nextUnansweredStepIndex
              : activeQuestionnaire.currentStepIndex + 1;

        const nextDrafts = setQuestionnaireDraftForConversation(
          state.questionnaireDraftsByConversationId,
          conversationId,
          {
            mode: activeQuestionnaire.mode,
            assistantMessageId: activeQuestionnaire.assistantMessageId,
            responseMessageId: activeQuestionnaire.responseMessageId,
            currentStepIndex: nextStepIndex,
            answersByStepId: nextAnswersByStepId,
            draftTextByStepId: nextDraftTextByStepId,
          },
        );
        saveQuestionnaireDraftsToStorage(nextDrafts);

        const nextState = resolveActiveConversationQuestionnaire(
          conversationId,
          getConversationMessagesFromState(state, conversationId),
          nextDrafts[conversationId],
        );
        result = {
          completed:
            activeQuestionnaire.isLastStep && nextUnansweredStepIndex === null,
          state: nextState,
        };

        return {
          questionnaireDraftsByConversationId: nextDrafts,
        };
      });

      return result;
    },

    submitActiveQuestionnaire: async (conversationId) => {
      const activeQuestionnaire = resolveConversationQuestionnaireFromState(
        get(),
        conversationId,
      );
      if (!activeQuestionnaire) {
        return null;
      }

      const firstUnansweredStepIndex = findFirstUnansweredQuestionStepIndex(
        activeQuestionnaire.questionnaire,
        activeQuestionnaire.answersByStepId,
      );
      if (firstUnansweredStepIndex !== null) {
        set((state) => {
          const refreshedQuestionnaire = resolveConversationQuestionnaireFromState(
            state,
            conversationId,
          );
          if (!refreshedQuestionnaire) {
            return state;
          }

          const nextDrafts = setActiveQuestionnaireDraftStep(
            state.questionnaireDraftsByConversationId,
            refreshedQuestionnaire,
            firstUnansweredStepIndex,
          );
          saveQuestionnaireDraftsToStorage(nextDrafts);

          return {
            questionnaireDraftsByConversationId: nextDrafts,
          };
        });
        return null;
      }

      const responseArtifacts = buildQuestionnaireResponseArtifacts(
        activeQuestionnaire.assistantMessageId,
        activeQuestionnaire.questionnaire,
        activeQuestionnaire.answersByStepId,
        {
          originToolCallId: activeQuestionnaire.originToolCallId,
        },
      );
      const providerInputItems = buildQuestionnaireResponseProviderInputItems(
        activeQuestionnaire.questionnaire.source,
        buildProviderInputItemsFromContent("user", responseArtifacts.visibleContent),
        responseArtifacts.functionCallOutputItem,
      );

      if (
        activeQuestionnaire.mode === "editing_response" &&
        activeQuestionnaire.responseMessageId
      ) {
        await get().editMessage(
          activeQuestionnaire.responseMessageId,
          responseArtifacts.visibleContent,
          {
            hiddenContext: responseArtifacts.hiddenContext,
            providerInputItems,
            replaceStructuredFields: true,
            clearQuestionnaireSession: true,
          },
        );
        return null;
      }

      const result = await get().sendMessage({
        conversationId,
        content: responseArtifacts.visibleContent,
        taskId: activeQuestionnaire.taskId,
        hiddenContext: responseArtifacts.hiddenContext,
        providerInputItems,
      });

      if (result.status === "cancelled") {
        return result;
      }

      set((state) => {
        const nextDrafts = clearQuestionnaireDraftsForConversations(
          state.questionnaireDraftsByConversationId,
          [conversationId],
        );
        saveQuestionnaireDraftsToStorage(nextDrafts);
        return {
          questionnaireDraftsByConversationId: nextDrafts,
        };
      });

      return result;
    },

    sendMessage: async (payload) => {
      let {
        conversationId,
        content,
        taskId,
        images,
        internalAgentProfile,
        hiddenContext,
        providerInputItems,
      } = payload;
      const contextRefsForMessage = persistableContextRefs(get().composerContextRefs);
      const composerContextRefsRevisionAtSend = composerContextRefsRevision;
      let activeSessionId: string | null = null;
      let activeTurnId: string | null = null;
      let assistantMessageId: string | null = null;
      let launchError: unknown = null;
      // Capture every mutable selection before the first await.  This is the
      // operation boundary; later continuations are fenced by its session and
      // controller instead of consulting the current UI selection.
      const appStateAtSend = useAppStore.getState();
      const providerState = useProviderStore.getState();
      const modeAtSend = appStateAtSend.mode;
      const agentTypeAtSend =
        modeAtSend === "Implement" ? appStateAtSend.agentType : null;
      const activeArchitectPlanIdAtSend = appStateAtSend.activeArchitectPlanId;
      const architectPlanAtSend =
        modeAtSend === "Architect" && activeArchitectPlanIdAtSend
          ? {
              planId: activeArchitectPlanIdAtSend,
              targetBranch: resolveTargetBranch(
                appStateAtSend.activePlanContext?.targetBranch,
              ),
            }
          : undefined;
      const providerSelectionAtSend = {
        selectedProviderId: providerState.selectedProviderId,
        selectedModelId: providerState.selectedModelId,
        selectedReasoningEffort: providerState.selectedReasoningEffort,
        isLoading: providerState.isLoading,
        providerConfigs: providerState.providerConfigs.map((provider) => ({
          ...provider,
        })),
        resolveProviderApiKey: providerState.resolveProviderApiKey,
        supportsNativeToolCalling: providerState.selectedSupportsNativeToolCalling(),
      };
      const conversationAtSend = get().conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      const conversationTaskIdAtSend = conversationAtSend?.task_id ?? null;
      const selectedTaskIdAtSend =
        modeAtSend === "Implement" ? (appStateAtSend.selectedTaskId ?? "") : "";
      const resolvedTaskIdAtSend =
        modeAtSend === "Chat"
          ? ""
          : (taskId ?? conversationTaskIdAtSend ?? selectedTaskIdAtSend);
      const executionContextAtSend = resolveConversationExecutionContext(conversationId);
      const preparationAbortController = new AbortController();
      const cancelledResult = (): ChatSendCancelledResult => ({
        status: "cancelled",
        conversationId,
        turnId: activeTurnId ?? "",
        userMessageId: null,
        assistantMessageId: null,
      });
      const isCurrentPreparation = () => {
        const runtime = getConversationRuntimeSnapshot(
          get().conversationRuntimeById,
          conversationId,
        );
        return !deletedConversationIds.has(conversationId) &&
          !preparationAbortController.signal.aborted &&
          runtime.sessionId === activeSessionId &&
          runtime.turnId === activeTurnId &&
          runtime.phase === "preparing";
      };
      const sendTimelineStartedAt = Date.now();
      const emitSendTimeline = (phase: StreamTimelinePhase | string, context?: Record<string, unknown>) => {
        devLogger.info("Provider stream timeline", {
          requestId: activeSessionId,
          phase,
          elapsedMs: Date.now() - sendTimelineStartedAt,
          ...context,
        });
      };

      try {
        assertConversationRuntimeAvailableForSend(conversationId);
        activeSessionId = createConversationSessionId();
        activeTurnId = createConversationTurnId();
        latestConversationSessionIdByConversationId.set(
          conversationId,
          activeSessionId,
        );
        emitSendTimeline("send_requested", { conversationId });
        setConversationRuntime(
          conversationId,
          {
            phase: "preparing",
            sessionId: activeSessionId,
            turnId: activeTurnId,
            assistantMessageId: null,
            abortController: preparationAbortController,
            lastError: null,
          },
          { globalLastError: null },
        );
        await ensureMessagesLoadedForConversation(conversationId);
        const currentPreparingRuntime = getConversationRuntimeSnapshot(
          get().conversationRuntimeById,
          conversationId,
        );
        if (
          preparationAbortController.signal.aborted ||
          deletedConversationIds.has(conversationId) ||
          currentPreparingRuntime.sessionId !== activeSessionId ||
          currentPreparingRuntime.turnId !== activeTurnId
        ) {
          return cancelledResult();
        }
        emitSendTimeline("messages_ready", { conversationId });
        if (modeAtSend === "Architect" && !architectPlanAtSend) {
          throw buildSendError("Select a plan before sending an Architect message.");
        }

        const previousConversationId = conversationId;
        const hasPendingArchitectConversation =
          pendingArchitectConversationDetailsById.has(conversationId);
        if (hasPendingArchitectConversation) {
          conversationId =
            await materializePendingArchitectConversationIfNeeded(conversationId);
        }
        if (
          preparationAbortController.signal.aborted ||
          deletedConversationIds.has(previousConversationId)
        ) {
          return cancelledResult();
        }
        if (hasPendingArchitectConversation && conversationId !== previousConversationId) {
          if (
            !transferConversationSessionOwnership(
              previousConversationId,
              conversationId,
              activeSessionId,
            )
          ) {
            abortAndClearPreparingRuntimeIfSessionMatches(
              previousConversationId,
              activeSessionId,
              activeTurnId,
              preparationAbortController,
            );
            return cancelledResult();
          }
          setConversationRuntime(previousConversationId, null);
          setConversationRuntime(
            conversationId,
            {
              phase: "preparing",
              sessionId: activeSessionId,
              turnId: activeTurnId,
              assistantMessageId: null,
              abortController: preparationAbortController,
              lastError: null,
            },
            { globalLastError: null },
          );
        }
        const {
          selectedProviderId,
          selectedModelId,
          selectedReasoningEffort,
          providerConfigs,
        } = providerSelectionAtSend;
        persistSelectionForContext(modeAtSend, conversationId);

        if (providerSelectionAtSend.isLoading) {
          throw buildSendError("Provider settings are still loading.");
        }

        if (!selectedProviderId || !selectedModelId) {
          throw buildSendError(
            "Select a provider and model before sending a message.",
          );
        }

        const providerConfig = providerConfigs.find(
          (p) => p.id === selectedProviderId,
        );
        if (!providerConfig) {
          throw buildSendError("Provider configuration not found.");
        }
        const resolvedApiKey =
          providerConfig.isLocal || providerHasAuthSession(providerConfig)
            ? providerConfig.apiKey
            : await providerSelectionAtSend.resolveProviderApiKey(selectedProviderId);
        if (!isCurrentPreparation()) {
          return cancelledResult();
        }
        const providerConfigForUse = {
          ...providerConfig,
          apiKey: resolvedApiKey,
          apiKeyLoaded:
            providerConfig.apiKeyLoaded || resolvedApiKey !== undefined,
        };

        const resolvedTaskId = resolvedTaskIdAtSend;
        let taskForSend = resolvedTaskIdAtSend
          ? useTaskStore.getState().getTaskById(resolvedTaskId)
          : undefined;
        let finalizedManualFeatureDraft = false;
        let manualFeatureDraftRecovery: ManualFeatureDraftRecovery | null = null;

        if (modeAtSend === "Implement" && resolvedTaskId) {
          if (
            taskForSend?.task_source === "standalone" &&
            taskForSend.standalone_kind === "manual_feature" &&
            taskForSend.draft === true
          ) {
            manualFeatureDraftRecovery =
              await maybeFinalizeManualFeatureDraftForAssistantRequest({
                conversationId,
                taskId: resolvedTaskId,
                userContent: content,
                providerId: selectedProviderId,
                providerType: providerConfigForUse.providerType,
                baseUrl: providerConfigForUse.baseUrl,
                apiKey: providerConfigForUse.apiKey,
                modelId: selectedModelId,
                reasoningEffort: selectedReasoningEffort,
              });
            if (!isCurrentPreparation()) {
              return cancelledResult();
            }
            finalizedManualFeatureDraft = manualFeatureDraftRecovery !== null;
          }

          taskForSend =
            (await assertImplementTaskReadyForSend(resolvedTaskId)) ??
            taskForSend;
          if (!isCurrentPreparation()) {
            return cancelledResult();
          }
          assertStandaloneTaskExecutionContextReady(taskForSend);
        }

        const userMessageCountBeforeSend = getOrderedConversationMessages(
          conversationId,
        ).filter((message) => message.role === "user").length;

        const userMessage = await buildUserMessageForSend({
          conversationId,
          turnId: activeTurnId,
          taskId: resolvedTaskId,
          content,
          hiddenContext,
          providerInputItems,
          contextRefs: contextRefsForMessage,
        });
        const publishUserMessage = () => {
          get().addMessage(userMessage);
          if (images && images.length > 0) {
            get().setMessageImages(userMessage.id, images);
          }
          for (const ref of contextRefsForMessage?.filter(isFileContextRef) ?? []) {
            const path = getFileRefPath(ref);
            useCitationsStore.getState().addCitation({
              type: "file",
              scope: "context",
              source: path,
              title: ref.title,
              path,
              messageId: userMessage.id,
              conversationId,
            });
          }
        };
        const sentWithoutAssistantResult = () => ({
          status: "sent" as const,
          conversationId,
          turnId: activeTurnId ?? "",
          userMessageId: userMessage.id,
          assistantMessageId: null,
        });
        if (!isCurrentPreparation()) {
          publishUserMessage();
          clearComposerContextRefsIfRevisionMatches(
            conversationId,
            composerContextRefsRevisionAtSend,
          );
          return sentWithoutAssistantResult();
        }

        publishUserMessage();
        clearComposerContextRefsIfRevisionMatches(
          conversationId,
          composerContextRefsRevisionAtSend,
        );

        if (userMessageCountBeforeSend === 0 && !finalizedManualFeatureDraft) {
          let skipMetadataGeneration = false;
          const architectPlan = architectPlanAtSend;
          if (architectPlan) {
            const bindingSucceeded =
              await bindPendingArchitectConversationIfNeeded({
                architectPlan,
                conversationId,
              });
            if (!bindingSucceeded) {
              skipMetadataGeneration = true;
            } else {
              await syncArchitectMetadataFromDb({
                branchName: architectPlan.targetBranch,
                planId: architectPlan.planId,
                conversationId,
                reason: "metadata_prefix",
              });
            }
          }

          if (!skipMetadataGeneration) {
            void maybeGenerateConversationMetadata({
              conversationId,
              firstUserContent: content,
              providerId: selectedProviderId,
              providerType: providerConfigForUse.providerType,
              baseUrl: providerConfigForUse.baseUrl,
              apiKey: providerConfigForUse.apiKey,
              modelId: selectedModelId,
              reasoningEffort: selectedReasoningEffort,
              architectPlan,
            });
          }
        }

        try {
          const streamLaunch = await prepareAssistantStreamLaunch({
            conversationId,
            replyToMessageId: userMessage.id,
            userContent: content,
            resolvedTaskId,
            modeAtSend,
            agentTypeAtSend,
            providerId: selectedProviderId,
            modelId: selectedModelId,
            reasoningEffort: selectedReasoningEffort,
            providerConfig: providerConfigForUse,
            internalAgentProfile,
            executionContext: executionContextAtSend,
            providerSupportsNativeToolCalling:
              providerSelectionAtSend.supportsNativeToolCalling,
          });
          if (!isCurrentPreparation()) {
            return sentWithoutAssistantResult();
          }
          emitSendTimeline("compaction_done", {
            conversationId,
            providerId: selectedProviderId,
            providerType: providerConfigForUse.providerType,
          });

          const assistantMessage = await buildAssistantMessageForSend({
            conversationId,
            turnId: activeTurnId,
            taskId: resolvedTaskId,
          });
          if (!isCurrentPreparation()) {
            if (
              latestConversationSessionIdByConversationId.get(
                conversationId,
              ) === activeSessionId
            ) {
              await deletePersistedMessagesAfter(
                chatPersistenceAdapters,
                conversationId,
                userMessage.id,
              ).catch(() => undefined);
            }
            return sentWithoutAssistantResult();
          }
          rememberAssistantTurnContext(
            assistantMessage.id,
            conversationId,
            modeAtSend,
            agentTypeAtSend,
          );
          assistantMessageId = assistantMessage.id;
          get().addMessage(assistantMessage);
          setConversationRuntime(
            conversationId,
            {
              phase: "preparing",
              sessionId: activeSessionId,
              turnId: activeTurnId,
              assistantMessageId: assistantMessage.id,
              abortController: preparationAbortController,
              lastError: null,
            },
            { globalLastError: null },
          );

          emitSendTimeline("provider_stream_start_requested", {
            conversationId,
            providerId: selectedProviderId,
            providerType: providerConfigForUse.providerType,
          });
          startAssistantStream({
            sessionId: activeSessionId,
            assistantMessage,
            conversationId,
            replyToMessageId: userMessage.id,
            userContent: content,
            modeAtSend,
            agentTypeAtSend,
            resolvedTaskId,
            selectedProviderId,
            selectedModelId,
            selectedReasoningEffort,
            providerConfig: providerConfigForUse,
            internalAgentProfile: streamLaunch.internalAgentProfile,
            messagesForRequest: streamLaunch.messagesForRequest,
            contextDiagnosticsBaselineSeed:
              streamLaunch.contextDiagnosticsBaselineSeed,
            executionContext: executionContextAtSend,
            providerSupportsNativeToolCalling:
              providerSelectionAtSend.supportsNativeToolCalling,
            fileToolContext: streamLaunch.fileToolContext,
            allowedToolIds: streamLaunch.allowedToolIds,
            skillToolIds: streamLaunch.skillToolIds,
            runnableSkillToolIds: streamLaunch.runnableSkillToolIds,
            guidedToolRetry: streamLaunch.guidedToolRetry,
            showToolTraces: streamLaunch.showToolTraces,
            enableWebSearch: streamLaunch.enableWebSearch,
            enableWebFetch: streamLaunch.enableWebFetch,
            webSearchOptions: streamLaunch.webSearchOptions,
            mcpTools: streamLaunch.mcpTools,
            maxTurns: streamLaunch.maxTurns,
            compactionDecision: streamLaunch.compactionDecision,
            abortController: preparationAbortController,
          });
        } catch (error) {
          launchError = error;
          if (manualFeatureDraftRecovery) {
            await rollbackManualFeatureDraftAfterFailedLaunch(
              manualFeatureDraftRecovery,
            );
          }
          throw error;
        }

        if (!activeTurnId) {
          throw buildSendError("Conversation turn was not created before sending.");
        }

        return {
          status: "sent",
          conversationId,
          turnId: activeTurnId,
          userMessageId: userMessage.id,
          assistantMessageId,
        };
      } catch (error) {
        const normalized = toServiceError(error);
        if (preparationAbortController.signal.aborted) {
          return cancelledResult();
        }
        if (activeSessionId) {
          const result = applyAssistantLaunchError(
            conversationId,
            activeSessionId,
            assistantMessageId,
            normalized,
            { setSendState: true },
          );
          if (!result.applied) {
            if (launchError) {
              throw normalized;
            }
            return cancelledResult();
          }
        } else {
          set({ sendState: "error", lastError: normalized.message });
        }
        throw normalized;
      }
    },

    stopConversationStream: (conversationId) => {
      stopConversationRuntimeLocally(conversationId);
    },

    clearConversationRuntimeError: (conversationId) => {
      const runtime = getConversationRuntimeSnapshot(
        get().conversationRuntimeById,
        conversationId,
      );
      if (runtime.phase !== "error") {
        return;
      }

      setConversationRuntime(conversationId, null);
    },

    stopStreaming: () => {
      const selectedConversationId = get().selectedConversationId;
      if (!selectedConversationId) {
        return;
      }
      stopConversationRuntimeLocally(selectedConversationId);
    },

    getAgentCodeReplayPreview: async (messageId) => {
      const state = get();
      const target = state.messages.find((message) => message.id === messageId);
      if (!target || target.role !== "user") {
        return null;
      }
      const conversationMessages = getConversationMessagesFromState(
        state,
        target.conversation_id,
      );
      const checkpoints = await getLoadedAgentCodeCheckpoints(
        target.conversation_id,
      );
      const preview = buildAgentCodeReplayPreview(
        target.conversation_id,
        messageId,
        conversationMessages,
        checkpoints,
      );
      return hydrateAgentCodeReplayPreviewCurrentState(preview);
    },

    restoreAgentCodeForReplay: async (preview) => {
      if (preview.affectedFiles.length === 0) {
        return;
      }
      try {
        const rollback = await restoreAgentCodeReplayPreview(preview);
        pendingAgentCodeReplayRollbacksByConversationId.set(
          preview.conversationId,
          rollback,
        );
      } catch (error) {
        const normalized = toServiceError(error);
        set({ lastError: normalized.message, sendState: "error" });
        throw buildSendError(
          `Failed to restore code checkpoint before replay: ${normalized.message}`,
        );
      }
    },

    editMessage: async (messageId, newContent, options) => {
      const providerStateAtEdit = useProviderStore.getState();
      const {
        selectedProviderId,
        selectedModelId,
        selectedReasoningEffort,
        providerConfigs,
      } = providerStateAtEdit;
      const appStateAtEdit = useAppStore.getState();
      const modeAtEdit = appStateAtEdit.mode;
      const agentTypeAtEdit =
        modeAtEdit === "Implement" ? appStateAtEdit.agentType : null;
      if (!selectedProviderId || !selectedModelId) {
        const message = "Select a provider and model before sending a message.";
        set({ lastError: message, sendState: "error" });
        throw buildSendError(message);
      }

      const providerConfig = providerConfigs.find(
        (p) => p.id === selectedProviderId,
      );
      if (!providerConfig) {
        const message = "Provider configuration not found.";
        set({ lastError: message, sendState: "error" });
        throw buildSendError(message);
      }
      const state = get();
      const target = state.messages.find((message) => message.id === messageId);
      if (!target) {
        const message = "The message to edit is no longer available.";
        set({ lastError: message, sendState: "error" });
        throw buildSendError(message);
      }
      if (!options?.skipAgentCodeReplayCheck) {
        const replayPreview = await get().getAgentCodeReplayPreview(messageId);
        if (replayPreview && replayPreview.affectedFiles.length > 0) {
          const message =
            "Replay blocked: confirm the code checkpoint restore before editing this earlier message.";
          set({ lastError: message, sendState: "error" });
          return;
        }
      }

      const conversationId = target.conversation_id;
      if (replayRecoveryBlockedConversationIds.has(conversationId)) {
        const message =
          "Replay recovery is pending for this conversation. Refresh the workspace to retry the recovery.";
        set({ lastError: message, sendState: "error" });
        throw buildSendError(message);
      }
      const turnId = getMessageTurnId(target);
      const sessionId = createConversationSessionId();
      const replayId = createConversationSessionId();
      const replayConversationMessages = getConversationMessagesFromState(
        state,
        conversationId,
      );
      const replayConversationMessageIds = new Set(
        replayConversationMessages.map((message) => message.id),
      );
      const replayLocalSnapshot = {
        conversation: state.conversations.find(
          (conversation) => conversation.id === conversationId,
        ) ?? null,
        messages: replayConversationMessages,
        messageImagesByMessageId: Object.fromEntries(
          Object.entries(state.messageImagesByMessageId).filter(([messageId]) =>
            replayConversationMessageIds.has(messageId),
          ),
        ),
        questionnaireDrafts: state.questionnaireDraftsByConversationId[
          conversationId
        ],
        agentCodeCheckpoints: state.agentCodeCheckpointsByConversationId[
          conversationId
        ],
        sessionCompactionEvents: state.sessionCompactionEventsByConversationId[
          conversationId
        ],
        citations: useCitationsStore
          .getState()
          .citations.filter((citation) => citation.conversationId === conversationId),
      };
      let replayPrepared = false;
      let replayRecoveryActive = false;
      const abortController = new AbortController();
      const executionContextAtEdit = resolveConversationExecutionContext(conversationId);
      let manualFeatureDraftRecovery: ManualFeatureDraftRecovery | null = null;
      let committedCodeReplay = !options?.skipAgentCodeReplayCheck;
      assertConversationRuntimeAvailableForSend(conversationId);
      latestConversationSessionIdByConversationId.set(conversationId, sessionId);
      setConversationRuntime(
        conversationId,
        {
          phase: "preparing",
          sessionId,
          turnId,
          assistantMessageId: null,
          abortController,
          lastError: null,
        },
        { globalLastError: null },
      );
      const isCurrentPreparation = () => {
        const runtime = getConversationRuntimeSnapshot(
          get().conversationRuntimeById,
          conversationId,
        );
        return (
          !deletedConversationIds.has(conversationId) &&
          !abortController.signal.aborted &&
          runtime.phase === "preparing" &&
          runtime.sessionId === sessionId &&
          runtime.turnId === turnId &&
          runtime.abortController === abortController
        );
      };
      const restoreReplayRecovery = async (): Promise<void> => {
        if (!replayRecoveryActive) return;
        const runtime = getConversationRuntimeSnapshot(
          get().conversationRuntimeById,
          conversationId,
        );
        const ownsReplayFence =
          latestConversationSessionIdByConversationId.get(conversationId) === sessionId &&
          runtime.sessionId === sessionId &&
          runtime.turnId === turnId;
        if (!ownsReplayFence) return;
        try {
          const restored = await tauriIpc.dbRestoreConversationReplay({
            conversationId,
            replayId,
            sessionId,
            turnId,
          });
          if (!restored) {
            throw new Error("The replay recovery marker no longer matches this session.");
          }
          const latestRuntime = getConversationRuntimeSnapshot(
            get().conversationRuntimeById,
            conversationId,
          );
          if (
            latestConversationSessionIdByConversationId.get(conversationId) !== sessionId ||
            latestRuntime.sessionId !== sessionId ||
            latestRuntime.turnId !== turnId
          ) {
            throw new Error("A newer replay session won before recovery could update the local transcript.");
          }
          set((current) => {
            const currentConversationMessages = getConversationMessagesFromState(
              current,
              conversationId,
            );
            const currentConversationMessageIds = new Set(
              currentConversationMessages.map((message) => message.id),
            );
            const nextQuestionnaireDrafts = {
              ...current.questionnaireDraftsByConversationId,
            };
            if (replayLocalSnapshot.questionnaireDrafts) {
              nextQuestionnaireDrafts[conversationId] =
                replayLocalSnapshot.questionnaireDrafts;
            } else {
              delete nextQuestionnaireDrafts[conversationId];
            }
            const nextAgentCodeCheckpoints = {
              ...current.agentCodeCheckpointsByConversationId,
            };
            if (replayLocalSnapshot.agentCodeCheckpoints) {
              nextAgentCodeCheckpoints[conversationId] =
                replayLocalSnapshot.agentCodeCheckpoints;
            } else {
              delete nextAgentCodeCheckpoints[conversationId];
            }
            const nextCompactionEvents = {
              ...current.sessionCompactionEventsByConversationId,
            };
            if (replayLocalSnapshot.sessionCompactionEvents) {
              nextCompactionEvents[conversationId] =
                replayLocalSnapshot.sessionCompactionEvents;
            } else {
              delete nextCompactionEvents[conversationId];
            }
            const nextMessageImages = Object.fromEntries(
              Object.entries(current.messageImagesByMessageId).filter(
                ([messageId]) => !currentConversationMessageIds.has(messageId),
              ),
            );
            Object.assign(
              nextMessageImages,
              replayLocalSnapshot.messageImagesByMessageId,
            );
            return {
              ...buildMessageState([
                ...current.messages.filter(
                  (message) => message.conversation_id !== conversationId,
                ),
                ...replayLocalSnapshot.messages,
              ]),
              conversations: replayLocalSnapshot.conversation
                ? current.conversations.map((conversation) =>
                    conversation.id === conversationId
                      ? replayLocalSnapshot.conversation!
                      : conversation,
                  )
                : current.conversations,
              messageImagesByMessageId: nextMessageImages,
              questionnaireDraftsByConversationId: nextQuestionnaireDrafts,
              agentCodeCheckpointsByConversationId: nextAgentCodeCheckpoints,
              sessionCompactionEventsByConversationId: nextCompactionEvents,
            };
          });
          const currentCitations = useCitationsStore.getState().citations;
          useCitationsStore.setState({
            citations: [
              ...currentCitations.filter(
                (citation) => citation.conversationId !== conversationId,
              ),
              ...replayLocalSnapshot.citations,
            ],
          });
          conversationCompactionStateCache.delete(conversationId);
          replayRecoveryActive = false;
        } catch (recoveryError) {
          replayRecoveryBlockedConversationIds.add(conversationId);
          const normalized = toServiceError(recoveryError);
          set({
            lastError: `Replay recovery is pending and this conversation is locked: ${normalized.message}`,
            sendState: "error",
          });
        }
      };

      try {
        const resolvedApiKey =
          providerConfig.isLocal || providerHasAuthSession(providerConfig)
            ? providerConfig.apiKey
            : await providerStateAtEdit.resolveProviderApiKey(selectedProviderId);
        if (!isCurrentPreparation()) {
          return;
        }
        const providerConfigForUse = {
          ...providerConfig,
          apiKey: resolvedApiKey,
          apiKeyLoaded:
            providerConfig.apiKeyLoaded || resolvedApiKey !== undefined,
        };

        if (modeAtEdit === "Implement" && target.task_id) {
          manualFeatureDraftRecovery =
            await maybeFinalizeManualFeatureDraftForAssistantRequest({
              conversationId,
              taskId: target.task_id,
              userContent: newContent,
              providerId: selectedProviderId,
              providerType: providerConfigForUse.providerType,
              baseUrl: providerConfigForUse.baseUrl,
              apiKey: providerConfigForUse.apiKey,
              modelId: selectedModelId,
              reasoningEffort: selectedReasoningEffort,
            });
          if (!isCurrentPreparation()) {
            return;
          }
          await assertImplementTaskReadyForSend(target.task_id);
          if (!isCurrentPreparation()) {
            return;
          }
        }

        const nextHiddenContext = options?.replaceStructuredFields
          ? options.hiddenContext
          : target.hidden_context;
        const nextProviderInputItems = options?.replaceStructuredFields
          ? cloneProviderInputItems(options.providerInputItems)
          : target.provider_input_items;
        if (!tauriIpc.isTauriAvailable()) {
          await persistEditedUserMessage({
            messageId,
            turnId,
            content: newContent,
            hiddenContext: options?.hiddenContext,
            providerInputItems: options?.providerInputItems,
            replaceStructuredFields: options?.replaceStructuredFields,
          });
        }
        if (!isCurrentPreparation()) return;
        const updatedTargetMessage: ChatMessage = tauriIpc.isTauriAvailable()
          ? {
              ...target,
              content: newContent,
              turn_id: turnId,
              hidden_context: nextHiddenContext,
              provider_input_items: nextProviderInputItems,
            }
          : get().messages.find((message) => message.id === messageId) ?? target;

        try {
          await trimConversationAfterMessage({
            conversationId,
            messageId,
            clearQuestionnaireSession: options?.clearQuestionnaireSession,
            updatedMessage: updatedTargetMessage,
            replayRecovery: tauriIpc.isTauriAvailable()
              ? {
                  sessionId,
                  turnId,
                  replayId,
                  content: newContent,
                  hiddenContext: nextHiddenContext,
                  providerInputItems: nextProviderInputItems,
                }
              : undefined,
          });
          replayPrepared = tauriIpc.isTauriAvailable();
          replayRecoveryActive = replayPrepared;
        } catch (trimError) {
          if (!tauriIpc.isTauriAvailable()) {
            await persistEditedUserMessage({
              messageId,
              turnId: getMessageTurnId(target),
              content: target.content,
              hiddenContext: target.hidden_context,
              providerInputItems: target.provider_input_items,
              replaceStructuredFields: true,
            });
          }
          throw trimError;
        }
        if (!isCurrentPreparation()) {
          return;
        }

        if (replayPrepared) {
          await tauriIpc.dbCompleteConversationReplay({ conversationId, replayId });
        }
        if (!isCurrentPreparation()) {
          return;
        }

        await restartAssistantFromEditedMessage({
          sessionId,
          turnId,
          messageId,
          conversationId,
          taskId: target.task_id ?? "",
          userContent: newContent,
          modeAtSend: modeAtEdit,
          providerId: selectedProviderId,
          modelId: selectedModelId,
          reasoningEffort: selectedReasoningEffort,
          providerConfig: providerConfigForUse,
          executionContext: executionContextAtEdit,
          providerSupportsNativeToolCalling:
            providerStateAtEdit.selectedSupportsNativeToolCalling(),
          abortController,
          manualFeatureDraftRecovery,
          agentTypeAtSend: agentTypeAtEdit,
          replayRecovery: replayPrepared
            ? {
                replayId,
                onLaunched: () => {
                  replayPrepared = false;
                },
                onProgress: () => {
                  replayRecoveryActive = false;
                },
                onFailedBeforeProgress: restoreReplayRecovery,
              }
            : undefined,
        });
        committedCodeReplay = true;
        pendingAgentCodeReplayRollbacksByConversationId.delete(conversationId);
      } catch (error) {
        await restoreReplayRecovery();
        if (!committedCodeReplay) {
          const rollback = pendingAgentCodeReplayRollbacksByConversationId.get(
            conversationId,
          );
          pendingAgentCodeReplayRollbacksByConversationId.delete(conversationId);
          if (rollback) {
            try {
              await rollback();
            } catch (rollbackError) {
              console.error("Failed to roll back replayed code:", rollbackError);
            }
          }
        }
        if (manualFeatureDraftRecovery) {
          await rollbackManualFeatureDraftAfterFailedLaunch(
            manualFeatureDraftRecovery,
          );
        }
        if (isCurrentPreparation()) {
          applyAssistantLaunchError(conversationId, sessionId, null, error, {
            setSendState: true,
          });
        }
      }
    },

    initializeCritical: async () => {
      Object.values(get().conversationRuntimeById).forEach((runtime) => {
        runtime?.abortController?.abort();
      });
      latestConversationSessionIdByConversationId.clear();
      completionPersistenceOwnersByConversationId.clear();
      deletedConversationIds.clear();
      pendingConversationDeletionIds.forEach((conversationId) => {
        deletedConversationIds.add(conversationId);
      });
      messageLoadPromisesByConversationId.clear();
      agentCodeCheckpointLoadPromisesByConversationId.clear();
      contextDiagnosticsRequestIds.clear();
      cancelAllLiveContextDiagnosticsRefreshSchedules();
      pendingArchitectConversationIdsByPlanKey.clear();
      pendingArchitectConversationDetailsById.clear();
      pendingAgentCodeReplayRollbacksByConversationId.clear();
      cancelStream();
      set({
        conversationRuntimeById: {},
        conversationCompactionStatusById: {},
        sessionCompactionEventsByConversationId: {},
        agentCodeCheckpointsByConversationId: {},
        contextDiagnosticsByConversationId: {},
        liveStreamContextEstimatesByConversationId: {},
        skillTurnFeedbackByMessageId: {},
        isLoading: true,
        isStreaming: false,
        sendState: "idle",
        lastError: null,
        abortController: null,
        hydrationStatus: "hydrating",
        restoreStatus: "idle",
        activeContextKey: null,
        selectionRequestId: 0,
        pendingArchitectPlanSwitchRequestId: null,
        messageLoadStatusByConversationId: {},
      });
      try {
        aiSelections = normalizeAIContextSelections(
          await loadPreference<PersistedAIContextSelections>(
            PREF_KEYS.AI_CONTEXT_SELECTIONS,
          ),
        );
        aiSelectionsLoaded = true;
        ensureProviderSelectionSync();
        ensureContextSelectionSync();

        hydrationPromise = hydrateChatSnapshot();
        await hydrationPromise;
        hydrationPromise = null;
      } catch (error) {
        hydrationPromise = null;
        const normalized = toServiceError(error);
        console.error("Failed to initialize chat store:", normalized.message);
        const messageImagesByMessageId = loadMessageImagesFromStorage();
        set({
          conversations: [],
          ...buildMessageState([]),
          messageLoadStatusByConversationId: {},
          messageImagesByMessageId,
          selectedConversationId: null,
          selectedConversationIdsByMode: {},
          hydrationStatus: "error",
          restoreStatus: "error",
          activeContextKey: null,
          selectionRequestId: 0,
          pendingArchitectPlanSwitchRequestId: null,
          conversationRuntimeById: {},
          conversationCompactionStatusById: {},
          sessionCompactionEventsByConversationId: {},
          agentCodeCheckpointsByConversationId: {},
          contextDiagnosticsByConversationId: {},
          liveStreamContextEstimatesByConversationId: {},
          isLoading: false,
          isStreaming: false,
          sendState: "error",
          lastError: normalized.message,
          abortController: null,
        });

        aiSelectionsLoaded = true;
        ensureProviderSelectionSync();
        ensureContextSelectionSync();
      }
    },

    resumeAfterInitialize: async () => {
      try {
        await get().ensureConversationForCurrentMode();
      } catch (error) {
        const normalized = toServiceError(error);
        console.error("Failed to resume chat context:", normalized.message);
        set({
          restoreStatus: "error",
          lastError: normalized.message,
        });
      }
    },

    initialize: async () => {
      await get().initializeCritical();
      await get().resumeAfterInitialize();
    },
  };
});
