import { create } from "zustand";
import {
  AppMode,
  ChatMessage,
  ConversationApprovalGrant,
  ConversationExecutionPhase,
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
  PendingToolApproval,
  ProjectGroup,
  ReasoningEffort,
  ToolRiskLevel,
  ToolTrace,
} from "../types";
import { toServiceError } from "../services/contracts/errors";
import {
  buildProviderErrorTranscriptMarkdown,
  resolveChatErrorPresentation,
} from "../services/chatErrorPresentation";
import { providerHasCredentials, useProviderStore } from "./useProviderStore";
import { useCitationsStore } from "./useCitationsStore";
import type { Citation, SourcePassageKind } from "./useCitationsStore";
import {
  streamChat,
  cancelStream,
  sendChatNonStreaming,
  estimateChatCompletionSerializedPayloadTokens,
  type StreamCompletionResult,
  type StreamMessage,
  type StreamTimelinePhase,
  type ToolCallResolution,
} from "../services/streamingChat";
import { getStreamingWebSearchConfig } from "../services/webSearchSettings";
import {
  fetchWebPage,
  formatSearchResultsAsContext,
  webSearch,
} from "../services/webSearch";
import { useToolsStore } from "./useToolsStore";
import { useAppStore } from "./useAppStore";
import { useTaskStore, type ImplementTask } from "./useTaskStore";
import { getToolModePolicy as getLocalToolModePolicy } from "../services/toolModePolicy";
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
import {
  type ChatMaxTurnsPreference,
  normalizeChatMaxTurns,
} from "../services/chatTurnLimits";
import { useNeedsStore } from "./useNeedsStore";
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
  getArchitectPlanNeeds,
  hasPersistedArchitectStrategy,
  isArchitectPlanReplicaDivergenceError,
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
  buildToolRiskLevelSystemInstruction,
  DEFAULT_TOOL_RISK_LEVEL,
  evaluateToolSecurity,
  filterDeniedToolIdsForRiskLevel,
} from "../services/toolSecurityPolicy";
import {
  mergeToolTracesPreservingDeniedStatus,
  parseToolTracesJson,
} from "../services/toolTraceState";
import {
  renderStandaloneFeatureBranchName,
} from "../services/architectGitNaming";
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
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from "../services/projectWorkspaceState";
import { syncMacroMetadataAfterStream as syncMacroMetadataAfterStreamService } from "../services/macroSyncService";
import { resolveProjectExecutionContext } from "../services/projectExecutionContext";
import { parseMessageQuickReplies } from "../services/chatQuickReplies";
import {
  buildQuestionnaireResponseArtifacts,
  buildQuestionnaireResponseProviderInputItems,
  buildQuestionnaireHiddenContextBlock,
  DEFAULT_QUESTIONNAIRE_INTRO,
  findFirstUnansweredQuestionStepIndex,
  parseAssistantQuestionnaireState,
  parseUserQuestionnaireResponseState,
  resolveActiveConversationQuestionnaire,
  validateQuestionToolArgs,
} from "../services/chatQuestionnaires";
import {
  buildContextTooLargeErrorMessage,
  buildCompactedMessagesForRequest,
  invalidateCompactionFromMessage,
  resolveModelContextWindowTokens,
  type ContextBudgetPolicy,
  type ContextCompactionDecision,
  type MaybeCompactConversationResult,
  type SummaryGenerationInput,
} from "../services/contextCompaction";
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
} from "../shared/macroToolRegistry";

const METADATA_MAX_TITLE_LENGTH = 72;
const METADATA_MAX_DESCRIPTION_LENGTH = 180;
const MANUAL_FEATURE_MAX_SLUG_LENGTH = 64;
const MANUAL_FEATURE_METADATA_ATTEMPT_LIMIT = 4;
const ARCHITECT_PLAN_METADATA_ATTEMPT_LIMIT = 3;
const metadataGenerationInFlight = new Set<string>();
const conversationCompactionStateCache = new Map<
  string,
  ConversationCompactionState | null
>();
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const EMPTY_MESSAGE_IMAGES: MessageImageAttachment[] = [];

const createTokenBatcher = (appendChunk: (chunk: string) => void) => {
  let buffer = "";
  let rafId: number | null = null;

  const flush = () => {
    rafId = null;
    if (!buffer) return;
    const chunk = buffer;
    buffer = "";
    appendChunk(chunk);
  };

  return {
    push: (token: string) => {
      buffer += token;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(flush);
    },
    flushNow: () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (!buffer) return;
      const chunk = buffer;
      buffer = "";
      appendChunk(chunk);
    },
    dispose: () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      buffer = "";
    },
  };
};

const CONTEXT_OVERFLOW_ERROR_PATTERNS = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /too many tokens/i,
  /request entity too large/i,
  /\b413\b/i,
  /prompt is too long/i,
  /context window/i,
];

const isProviderContextOverflowError = (error: unknown): boolean => {
  const candidate = error as {
    kind?: unknown;
    status?: unknown;
    message?: unknown;
  };
  if (candidate?.kind === "context_overflow" || candidate?.status === 413) {
    return true;
  }
  const message =
    typeof candidate?.message === "string"
      ? candidate.message
      : error instanceof Error
        ? error.message
        : String(error ?? "");
  return CONTEXT_OVERFLOW_ERROR_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
};

const OVERFLOW_RECOVERY_FAILURE_MESSAGE =
  "The selected model still rejected this conversation after an aggressive compaction pass. Macro kept your message; continue with a larger-context model or compact manually before retrying.";

const EMPTY_CONVERSATION_RUNTIME: ConversationRuntimeState = Object.freeze({
  phase: "idle" as ConversationExecutionPhase,
  sessionId: null,
  assistantMessageId: null,
  abortController: null,
  lastError: null,
  lastErrorOrigin: null,
  lastErrorDisplayTarget: null,
});

const EMPTY_CONTEXT_DIAGNOSTICS_COUNTS: ConversationContextDiagnostics["counts"] =
  Object.freeze({
    messages: 0,
    visibleLines: 0,
    hiddenContextLines: 0,
    providerInputItems: 0,
    providerInputItemLines: 0,
    reasoningContentLines: 0,
    toolResultLines: 0,
    citations: 0,
    activeFiles: 0,
    toolFacts: 0,
  });

const countTextLines = (value: unknown): number => {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).length;
};

const countStreamContentLines = (content: StreamMessage["content"]): number => {
  if (typeof content === "string") return countTextLines(content);
  return content.reduce((total, part) => {
    if (part.type !== "text") return total;
    return total + countTextLines(part.text);
  }, 0);
};

const safeJsonLineCount = (value: unknown): number => {
  try {
    return countTextLines(JSON.stringify(value, null, 2));
  } catch {
    return 0;
  }
};

const inspectProviderInputValue = (
  value: unknown,
  parentKey = "",
  depth = 0,
): { reasoningLines: number; toolResultLines: number } => {
  if (depth > 8 || value == null) {
    return { reasoningLines: 0, toolResultLines: 0 };
  }

  const normalizedKey = parentKey.toLowerCase();
  if (typeof value === "string") {
    const lines = countTextLines(value);
    if (
      normalizedKey.includes("reasoning") ||
      normalizedKey.includes("thinking")
    ) {
      return { reasoningLines: lines, toolResultLines: 0 };
    }
    if (
      normalizedKey.includes("tool") ||
      normalizedKey.includes("result") ||
      normalizedKey.includes("output")
    ) {
      return { reasoningLines: 0, toolResultLines: lines };
    }
    return { reasoningLines: 0, toolResultLines: 0 };
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => {
        const inspected = inspectProviderInputValue(item, parentKey, depth + 1);
        return {
          reasoningLines: total.reasoningLines + inspected.reasoningLines,
          toolResultLines: total.toolResultLines + inspected.toolResultLines,
        };
      },
      { reasoningLines: 0, toolResultLines: 0 },
    );
  }

  if (typeof value !== "object") {
    return { reasoningLines: 0, toolResultLines: 0 };
  }

  const record = value as Record<string, unknown>;
  const typeHint = String(record.type ?? record.role ?? "").toLowerCase();
  const isToolLike =
    typeHint.includes("tool") ||
    typeHint.includes("function_call_output") ||
    typeHint.includes("function_result");

  return Object.entries(record).reduce(
    (total, [key, child]) => {
      const effectiveKey = isToolLike ? `${parentKey}.${key}.tool_result` : key;
      const inspected = inspectProviderInputValue(child, effectiveKey, depth + 1);
      return {
        reasoningLines: total.reasoningLines + inspected.reasoningLines,
        toolResultLines: total.toolResultLines + inspected.toolResultLines,
      };
    },
    { reasoningLines: 0, toolResultLines: 0 },
  );
};

const buildContextDiagnosticsFromFootprint = (params: {
  conversationId: string;
  providerId?: string;
  providerType?: string;
  modelId?: string;
  status: ConversationContextDiagnosticsStatus;
  phase?: ConversationCompactionPhase | "provider_error";
  decision?: ContextCompactionDecision;
  compactionPass?: CompactionPass;
  summaryFormatVersion?: number;
  summarySource?: CompactionSummarySource;
  footprintBefore?: ContextFootprint;
  footprintAfter?: ContextFootprint;
  orderedMessages: ChatMessage[];
  preparedMessages: StreamMessage[];
  citations: Citation[];
  compactionState?: ConversationCompactionState | null;
  error?: string;
}): ConversationContextDiagnostics => {
  const footprint = params.footprintAfter ?? params.footprintBefore;
  const providerInputItems = params.preparedMessages.flatMap(
    (message) => message.provider_input_items ?? [],
  );
  const providerInputInspection = inspectProviderInputValue(providerInputItems);
  const hiddenContextLines = params.orderedMessages.reduce(
    (total, message) => total + countTextLines(message.hidden_context),
    0,
  );
  const visibleLines = params.preparedMessages.reduce(
    (total, message) => total + countStreamContentLines(message.content),
    0,
  );
  const counts: ConversationContextDiagnostics["counts"] = {
    messages: params.orderedMessages.length,
    visibleLines,
    hiddenContextLines,
    providerInputItems: providerInputItems.length,
    providerInputItemLines: safeJsonLineCount(providerInputItems),
    reasoningContentLines: providerInputInspection.reasoningLines,
    toolResultLines:
      providerInputInspection.toolResultLines + hiddenContextLines,
    citations: params.citations.length,
    activeFiles: params.citations.filter(
      (citation) => citation.type === "file" || citation.type === "document",
    ).length,
    toolFacts: params.compactionState?.toolDigest?.length ?? 0,
  };

  const breakdown: ConversationContextDiagnosticsBreakdownItem[] = footprint
    ? [
        {
          id: "serialized_payload",
          label: "Payload sérialisé final",
          tokens: footprint.serializedPayloadTokens,
        },
        {
          id: "visible_messages",
          label: "Messages visibles",
          tokens: footprint.visibleMessageTokens,
          lines: visibleLines,
          count: params.orderedMessages.length,
        },
        {
          id: "provider_input_items",
          label: "Historique provider",
          tokens: footprint.providerInputTokens,
          lines: counts.providerInputItemLines,
          count: counts.providerInputItems,
        },
        {
          id: "hidden_context",
          label: "Contexte masqué / outils",
          tokens: footprint.hiddenContextTokens,
          lines: hiddenContextLines,
        },
        {
          id: "system_prompt",
          label: "Prompt système",
          tokens: footprint.systemTokens,
        },
        {
          id: "tool_schema",
          label: "Schémas d'outils",
          tokens: footprint.toolSchemaTokens,
        },
        {
          id: "citations",
          label: "Citations et sources",
          tokens: footprint.citationTokens,
          count: params.citations.length,
        },
        {
          id: "summary",
          label: "Résumé compacté",
          tokens: footprint.summaryTokens,
          count: params.compactionState ? 1 : 0,
        },
        {
          id: "latest_user",
          label: "Dernier tour utilisateur",
          tokens: footprint.latestUserContextTokens,
        },
      ]
    : [];

  const topContributors = [...breakdown]
    .filter((item) => typeof item.tokens === "number" && item.tokens > 0)
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))
    .slice(0, 5);

  return {
    status: params.status,
    conversationId: params.conversationId,
    updatedAt: new Date().toISOString(),
    providerId: params.providerId,
    providerType: params.providerType,
    modelId: params.modelId,
    phase: params.phase,
    decision: params.decision,
    compactionPass: params.compactionPass,
    summaryFormatVersion: params.summaryFormatVersion,
    summarySource: params.summarySource,
    footprintBefore: params.footprintBefore,
    footprintAfter: params.footprintAfter,
    ratio: Math.max(0, footprint?.totalContextRatio ?? 0),
    usableRatio: Math.max(0, footprint?.usableContextRatio ?? 0),
    isHardStop: Boolean(footprint?.isHardStop),
    error: params.error,
    counts,
    breakdown,
    topContributors,
  };
};

const createConversationSessionId = (): string =>
  `conversation-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const isConversationRuntimeActive = (
  runtime: ConversationRuntimeState | undefined,
): boolean =>
  runtime?.phase === "preparing" ||
  runtime?.phase === "overflow_recovery" ||
  runtime?.phase === "streaming";

const getConversationRuntimeSnapshot = (
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>,
  conversationId: string | null | undefined,
): ConversationRuntimeState => {
  if (!conversationId) {
    return EMPTY_CONVERSATION_RUNTIME;
  }

  return conversationRuntimeById[conversationId] ?? EMPTY_CONVERSATION_RUNTIME;
};

const buildLegacyStreamingFlags = (params: {
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>;
  selectedConversationId: string | null;
}) => {
  const runtimes = Object.values(params.conversationRuntimeById);
  const hasPreparingConversation = runtimes.some(
    (runtime) =>
      runtime?.phase === "preparing" ||
      runtime?.phase === "overflow_recovery",
  );
  const streamingRuntime =
    runtimes.find((runtime) => runtime?.phase === "streaming") ?? null;
  const errorRuntime =
    runtimes.find((runtime) => runtime?.phase === "error") ?? null;
  const selectedRuntime = getConversationRuntimeSnapshot(
    params.conversationRuntimeById,
    params.selectedConversationId,
  );

  return {
    isLoading:
      hasPreparingConversation || streamingRuntime !== null,
    isStreaming: streamingRuntime !== null,
    sendState: (
      hasPreparingConversation
        ? "preparing"
        : streamingRuntime
          ? "streaming"
          : errorRuntime
            ? "error"
            : "idle"
    ) as ChatSendState,
    abortController:
      selectedRuntime.abortController ??
      streamingRuntime?.abortController ??
      null,
  };
};

const buildConversationRuntimePatch = (
  state: Pick<
    ChatStore,
    | "conversationRuntimeById"
    | "selectedConversationId"
  >,
  conversationId: string,
  runtime: ConversationRuntimeState | null,
) => {
  const nextConversationRuntimeById = { ...state.conversationRuntimeById };
  if (runtime) {
    nextConversationRuntimeById[conversationId] = runtime;
  } else {
    delete nextConversationRuntimeById[conversationId];
  }

  return {
    conversationRuntimeById: nextConversationRuntimeById,
    ...buildLegacyStreamingFlags({
      conversationRuntimeById: nextConversationRuntimeById,
      selectedConversationId: state.selectedConversationId,
    }),
  };
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
} => {
  const parsed = extractJsonObjectFromModelOutput(raw) as {
    title?: unknown;
    description?: unknown;
    featureSlug?: unknown;
  };

  if (
    typeof parsed.title !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.featureSlug !== "string"
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

  if (!title || !description || !featureSlug) {
    throw new Error("Empty manual feature metadata values");
  }

  return { title, description, featureSlug };
};

const buildManualFeatureFallbackMetadata = (content: string) => {
  const title = getConversationFallbackTitle(content);
  const description = getConversationFallbackDescription(content);
  const featureSlug = normalizeManualFeatureSlugInput(title || content);
  return { title, description, featureSlug };
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

const MESSAGE_IMAGES_STORAGE_KEY = "macro_chat_message_images";
const QUESTIONNAIRE_DRAFTS_STORAGE_KEY = "macro_chat_questionnaire_drafts";

type AISelectionModeKey = "Chat" | "Architect" | "Implement";

interface PersistedAISelection {
  providerId: string | null;
  modelId: string | null;
  reasoningEffort?: ReasoningEffort | null;
  updatedAt: string;
}

interface PersistedAIProviderSelection {
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  updatedAt: string;
}

interface PersistedAIContextSelections {
  version: 2;
  modeSelections: Partial<Record<AISelectionModeKey, PersistedAISelection>>;
  conversationSelections: Record<string, PersistedAISelection>;
  providerSelectionsByConversationId: Record<
    string,
    Record<string, PersistedAIProviderSelection>
  >;
  providerSelectionsByMode: Partial<
    Record<AISelectionModeKey, Record<string, PersistedAIProviderSelection>>
  >;
}

const EMPTY_AI_CONTEXT_SELECTIONS: PersistedAIContextSelections = {
  version: 2,
  modeSelections: {},
  conversationSelections: {},
  providerSelectionsByConversationId: {},
  providerSelectionsByMode: {},
};

const getSelectionModeKey = (mode: AppMode): AISelectionModeKey => {
  if (mode === "Chat") {
    return "Chat";
  }
  if (mode === "Architect") {
    return "Architect";
  }
  return "Implement";
};

const normalizePersistedSelection = (
  value: unknown,
): PersistedAISelection | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    providerId?: unknown;
    modelId?: unknown;
    reasoningEffort?: unknown;
    updatedAt?: unknown;
  };

  const providerId =
    candidate.providerId === null || typeof candidate.providerId === "string"
      ? candidate.providerId
      : null;
  const modelId =
    candidate.modelId === null || typeof candidate.modelId === "string"
      ? candidate.modelId
      : null;

  if (!providerId || !modelId) {
    return null;
  }

  return {
    providerId,
    modelId,
    reasoningEffort:
      candidate.reasoningEffort === null ||
      typeof candidate.reasoningEffort === "string"
        ? ((candidate.reasoningEffort as ReasoningEffort | null | undefined) ??
          null)
        : null,
    updatedAt:
      typeof candidate.updatedAt === "string" &&
      candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
};

const normalizePersistedProviderSelection = (
  value: unknown,
): PersistedAIProviderSelection | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    modelId?: unknown;
    reasoningEffort?: unknown;
    updatedAt?: unknown;
  };

  if (typeof candidate.modelId !== "string" || !candidate.modelId.trim()) {
    return null;
  }

  return {
    modelId: candidate.modelId,
    reasoningEffort:
      candidate.reasoningEffort === null ||
      typeof candidate.reasoningEffort === "string"
        ? ((candidate.reasoningEffort as ReasoningEffort | null | undefined) ??
          null)
        : null,
    updatedAt:
      typeof candidate.updatedAt === "string" &&
      candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
};

const normalizePersistedProviderSelectionMap = (
  value: unknown,
): Record<string, PersistedAIProviderSelection> => {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([providerId, selection]) => [
        providerId,
        normalizePersistedProviderSelection(selection),
      ])
      .filter((entry): entry is [string, PersistedAIProviderSelection] =>
        Boolean(entry[1]),
      ),
  );
};

const normalizeAIContextSelections = (
  value: unknown,
): PersistedAIContextSelections => {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_AI_CONTEXT_SELECTIONS };
  }

  const raw = value as {
    version?: unknown;
    modeSelections?: unknown;
    conversationSelections?: unknown;
    providerSelectionsByConversationId?: unknown;
    providerSelectionsByMode?: unknown;
  };

  const modeSelections: Partial<
    Record<AISelectionModeKey, PersistedAISelection>
  > = {};
  if (raw.modeSelections && typeof raw.modeSelections === "object") {
    const modeMap = raw.modeSelections as Record<string, unknown>;
    for (const key of ["Chat", "Architect", "Implement"] as AISelectionModeKey[]) {
      const normalized = normalizePersistedSelection(modeMap[key]);
      if (normalized) {
        modeSelections[key] = normalized;
      }
    }
    if (!modeSelections.Chat) {
      const legacyChatSelection = normalizePersistedSelection(modeMap.ChatDebug);
      if (legacyChatSelection) {
        modeSelections.Chat = legacyChatSelection;
      }
    }
  }

  const conversationSelections: Record<string, PersistedAISelection> = {};
  if (
    raw.conversationSelections &&
    typeof raw.conversationSelections === "object"
  ) {
    for (const [conversationId, selection] of Object.entries(
      raw.conversationSelections as Record<string, unknown>,
    )) {
      const normalized = normalizePersistedSelection(selection);
      if (normalized) {
        conversationSelections[conversationId] = normalized;
      }
    }
  }

  const providerSelectionsByConversationId: Record<
    string,
    Record<string, PersistedAIProviderSelection>
  > = {};
  if (
    raw.providerSelectionsByConversationId &&
    typeof raw.providerSelectionsByConversationId === "object"
  ) {
    for (const [conversationId, selectionMap] of Object.entries(
      raw.providerSelectionsByConversationId as Record<string, unknown>,
    )) {
      const normalizedSelectionMap =
        normalizePersistedProviderSelectionMap(selectionMap);
      if (Object.keys(normalizedSelectionMap).length > 0) {
        providerSelectionsByConversationId[conversationId] =
          normalizedSelectionMap;
      }
    }
  }

  const providerSelectionsByMode: Partial<
    Record<AISelectionModeKey, Record<string, PersistedAIProviderSelection>>
  > = {};
  if (
    raw.providerSelectionsByMode &&
    typeof raw.providerSelectionsByMode === "object"
  ) {
    const rawModeSelections = raw.providerSelectionsByMode as Record<
      string,
      unknown
    >;
    for (const key of ["Chat", "Architect", "Implement"] as AISelectionModeKey[]) {
      const normalizedSelectionMap = normalizePersistedProviderSelectionMap(
        rawModeSelections[key],
      );
      if (Object.keys(normalizedSelectionMap).length > 0) {
        providerSelectionsByMode[key] = normalizedSelectionMap;
      }
    }
  }

  return {
    version: 2,
    modeSelections,
    conversationSelections,
    providerSelectionsByConversationId,
    providerSelectionsByMode,
  };
};

export interface MessageImageAttachment {
  id: string;
  mimeType: string;
  dataUrl: string;
  width?: number;
  height?: number;
  createdAt: string;
}

const loadQuestionnaireDraftsFromStorage = (): Record<
  string,
  ConversationQuestionnaireDraft
> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(QUESTIONNAIRE_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(
      raw,
    ) as Record<string, ConversationQuestionnaireDraft>;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => {
        return (
          value &&
          typeof value === "object" &&
          (value.mode === undefined ||
            value.mode === "pending_reply" ||
            value.mode === "editing_response") &&
          typeof value.assistantMessageId === "string" &&
          (value.responseMessageId === undefined ||
            typeof value.responseMessageId === "string") &&
          typeof value.currentStepIndex === "number" &&
          value.answersByStepId &&
          typeof value.answersByStepId === "object" &&
          value.draftTextByStepId &&
          typeof value.draftTextByStepId === "object"
        );
      }),
    );
  } catch {
    return {};
  }
};

const saveQuestionnaireDraftsToStorage = (
  draftsByConversationId: Record<string, ConversationQuestionnaireDraft>,
) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      QUESTIONNAIRE_DRAFTS_STORAGE_KEY,
      JSON.stringify(draftsByConversationId),
    );
  } catch {
    // Ignore storage errors
  }
};

const loadMessageImagesFromStorage = (): Record<
  string,
  MessageImageAttachment[]
> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(MESSAGE_IMAGES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, MessageImageAttachment[]>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
};

const saveMessageImagesToStorage = (
  imagesByMessageId: Record<string, MessageImageAttachment[]>,
) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MESSAGE_IMAGES_STORAGE_KEY,
      JSON.stringify(imagesByMessageId),
    );
  } catch {
    // Ignore storage errors
  }
};

type ChatHydrationStatus = "idle" | "hydrating" | "ready" | "error";
type ChatRestoreStatus = "idle" | "resolving" | "ready" | "error";
type ChatContextKey = string;
type ChatSendState = "idle" | "preparing" | "streaming" | "error";

interface ChatSendResult {
  status: "sent";
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
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

export type ConversationCompactionPhase =
  | "idle"
  | "compacting"
  | "overflow_recovery"
  | "compacted"
  | "degraded"
  | "too_large";

export interface ConversationCompactionStatus {
  phase: ConversationCompactionPhase;
  upToMessageId?: string;
  summaryText?: string;
  updatedAt?: string;
  reason?: ContextFootprintReason | null;
  kind?: ContextCompactionKind;
  footprintAfter?: ContextFootprint;
  recoveredFromOverflow?: boolean;
  summaryFormatVersion?: number;
  summarySource?: CompactionSummarySource;
}

export type ConversationContextDiagnosticsStatus = "estimating" | "ready" | "error";

export interface ConversationContextDiagnosticsBreakdownItem {
  id: string;
  label: string;
  tokens?: number;
  lines?: number;
  count?: number;
}

export interface ConversationContextDiagnostics {
  status: ConversationContextDiagnosticsStatus;
  conversationId: string;
  updatedAt: string;
  providerId?: string;
  providerType?: string;
  modelId?: string;
  phase?: ConversationCompactionPhase | "provider_error";
  decision?: ContextCompactionDecision;
  compactionPass?: CompactionPass;
  summaryFormatVersion?: number;
  summarySource?: CompactionSummarySource;
  footprintBefore?: ContextFootprint;
  footprintAfter?: ContextFootprint;
  ratio: number;
  usableRatio: number;
  isHardStop: boolean;
  error?: string;
  counts: {
    messages: number;
    visibleLines: number;
    hiddenContextLines: number;
    providerInputItems: number;
    providerInputItemLines: number;
    reasoningContentLines: number;
    toolResultLines: number;
    citations: number;
    activeFiles: number;
    toolFacts: number;
  };
  breakdown: ConversationContextDiagnosticsBreakdownItem[];
  topContributors: ConversationContextDiagnosticsBreakdownItem[];
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
  contextDiagnosticsByConversationId: Record<
    string,
    ConversationContextDiagnostics | undefined
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
  architectPlanNamingRecovery: ArchitectPlanNamingRecoveryState | null;
  addMessage: (message: ChatMessage) => void;
  clearLastError: () => void;
  updateMessageContent: (messageId: string, content: string) => void;
  updateMessageFields: (
    messageId: string,
    patch: Partial<
      Pick<
        ChatMessage,
        | "tool_traces"
        | "hidden_context"
        | "provider_input_items"
        | "provider_turn_state"
        | "completion_reason"
      >
    >,
  ) => void;
  updateLastMessage: (content: string) => void;
  appendToLastMessage: (token: string) => void;
  appendToMessage: (messageId: string, tokenChunk: string) => void;
  clearMessages: () => void;
  selectConversation: (conversationId: string) => Promise<boolean>;
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
  deleteConversation: (
    conversationId: string,
    confirmation?: {
      mode: "chat" | "implement" | "architect";
      typedProjectName?: string;
    },
  ) => Promise<void>;
  deleteChatConversations: (conversationIds: string[]) => Promise<void>;
  markAsRead: (conversationId: string) => void;
  getConversationByTask: (taskId: string) => Conversation | undefined;
  getConversationMessages: (conversationId: string) => ChatMessage[];
  ensureMessagesLoaded: (conversationId: string) => Promise<void>;
  getConversationRuntime: (conversationId: string) => ConversationRuntimeState;
  compactConversationNow: (conversationId: string) => Promise<void>;
  refreshConversationContextDiagnostics: (conversationId: string) => Promise<void>;
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
  ) => Promise<ChatSendResult | null>;
  sendMessage: (payload: {
    conversationId: string;
    content: string;
    taskId?: string | null;
    images?: MessageImageAttachment[];
    internalAgentProfile?: InternalAgentProfile | null;
    hiddenContext?: string;
    providerInputItems?: unknown[];
  }) => Promise<ChatSendResult>;
  stopConversationStream: (conversationId: string) => void;
  clearConversationRuntimeError: (conversationId: string) => void;
  stopStreaming: () => void;
  editMessage: (
    messageId: string,
    newContent: string,
    options?: {
      hiddenContext?: string;
      providerInputItems?: unknown[];
      replaceStructuredFields?: boolean;
      clearQuestionnaireSession?: boolean;
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

const mapDbConversationToConversation = (
  conversation: tauriIpc.DbConversation,
): Conversation => ({
  id: conversation.id,
  title: conversation.title,
  description: conversation.description || "",
  scope_mode: conversation.scope_mode,
  task_id: conversation.task_id,
  group_id: conversation.group_id,
  project_id: conversation.project_id,
  last_message: conversation.last_message || "",
  message_count: conversation.message_count,
  updated_at: conversation.updated_at,
  is_unread: false,
});

const parseDbProviderTurnState = (
  raw: string | null,
): ChatMessage["provider_turn_state"] | undefined => {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as ChatMessage["provider_turn_state"] | null;
    if (
      !parsed ||
      parsed.provider !== "chatgpt" ||
      !Array.isArray(parsed.output_items)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};

const parseDbProviderInputItems = (
  raw: string | null,
): ChatMessage["provider_input_items"] | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const buildAssistantMessagePresentation = (
  content: string,
  hiddenContext?: string,
): Pick<
  ChatMessage,
  "content" | "choices" | "allow_free_response" | "questionnaire"
> => {
  const questionnaireState = parseAssistantQuestionnaireState(
    content,
    hiddenContext,
  );
  const legacyQuickReplies = parseMessageQuickReplies(content);

  return {
    content: questionnaireState.content,
    choices: legacyQuickReplies.choices,
    allow_free_response: legacyQuickReplies.allowFreeResponse,
    questionnaire: questionnaireState.questionnaire,
  };
};

const assistantTurnRequiresUserReply = (
  content: string,
  hiddenContext?: string,
): boolean =>
  parseAssistantQuestionnaireState(content, hiddenContext).requiresUserReply;

const buildUserMessagePresentation = (
  content: string,
  hiddenContext?: string,
): Pick<ChatMessage, "content" | "questionnaire_response_summary"> => {
  const questionnaireResponseState = parseUserQuestionnaireResponseState(
    content,
    hiddenContext,
  );

  return {
    content: questionnaireResponseState.content,
    questionnaire_response_summary:
      questionnaireResponseState.questionnaireResponseSummary,
  };
};

const mapDbMessageToChatMessage = (
  message: tauriIpc.DbMessage,
  conversationById: Map<string, Conversation>,
): ChatMessage => {
  const taskId = conversationById.get(message.conversation_id)?.task_id ?? "";
  if (message.role === "assistant") {
    const presentation = buildAssistantMessagePresentation(
      message.content,
      message.hidden_context ?? undefined,
    );
    return {
      id: message.id,
      task_id: taskId,
      conversation_id: message.conversation_id,
      role: message.role as "user" | "assistant",
      content: presentation.content,
      timestamp: message.created_at,
      choices: presentation.choices,
      allow_free_response: presentation.allow_free_response,
      questionnaire: presentation.questionnaire,
      tool_traces: parseToolTracesJson(message.tool_traces_json),
      hidden_context: message.hidden_context ?? undefined,
      provider_input_items: parseDbProviderInputItems(
        message.provider_input_items_json,
      ),
      provider_turn_state: parseDbProviderTurnState(
        message.provider_turn_state_json,
      ),
    };
  }

  const userPresentation = buildUserMessagePresentation(
    message.content,
    message.hidden_context ?? undefined,
  );
  return {
    id: message.id,
    task_id: taskId,
    conversation_id: message.conversation_id,
    role: message.role as "user" | "assistant",
    content: userPresentation.content,
    timestamp: message.created_at,
    questionnaire_response_summary:
      userPresentation.questionnaire_response_summary,
    tool_traces: parseToolTracesJson(message.tool_traces_json),
    hidden_context: message.hidden_context ?? undefined,
    provider_input_items: parseDbProviderInputItems(
      message.provider_input_items_json,
    ),
    provider_turn_state: parseDbProviderTurnState(
      message.provider_turn_state_json,
    ),
  };
};

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

export const resolveImplementTaskForContext = ({
  selectedTaskId,
  tasks,
  projectGroups,
  selectedGroupId,
  selectedProjectId,
  localContext,
}: ResolveImplementTaskForContextInput): ImplementTask | null => {
  const scopedProjectIds = getScopedProjectIds(
    projectGroups,
    selectedGroupId,
    selectedProjectId,
  );
  const eligibleTasks = tasks.filter((task) =>
    !task.archived_at && taskMatchesScopedProjectIds(task, scopedProjectIds)
  );
  const findEligibleTask = (taskId?: string | null): ImplementTask | null =>
    taskId
      ? eligibleTasks.find((task) => task.id === taskId) ?? null
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

const sortMessagesChronologically = (messages: ChatMessage[]): ChatMessage[] =>
  [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

const indexMessagesByConversation = (
  messages: ChatMessage[],
): Record<string, ChatMessage[]> => {
  const grouped: Record<string, ChatMessage[]> = {};

  for (const message of messages) {
    const existing = grouped[message.conversation_id];
    if (existing) {
      existing.push(message);
    } else {
      grouped[message.conversation_id] = [message];
    }
  }

  Object.keys(grouped).forEach((conversationId) => {
    grouped[conversationId] = sortMessagesChronologically(
      grouped[conversationId]!,
    );
  });

  return grouped;
};

const indexMessagesById = (messages: ChatMessage[]): Record<string, number> =>
  Object.fromEntries(messages.map((message, index) => [message.id, index]));

const buildMessageState = (messages: ChatMessage[]) => ({
  messages,
  messagesByConversationId: indexMessagesByConversation(messages),
  messageIndexById: indexMessagesById(messages),
});

const getConversationMessagesFromState = (
  state: Pick<ChatStore, "messages" | "messagesByConversationId">,
  conversationId: string,
): ChatMessage[] => {
  const indexedMessages = state.messagesByConversationId[conversationId];
  if (indexedMessages) {
    return indexedMessages;
  }

  const fallbackMessages = state.messages.filter(
    (msg) => msg.conversation_id === conversationId,
  );
  return fallbackMessages.length > 0
    ? sortMessagesChronologically(fallbackMessages)
    : EMPTY_CHAT_MESSAGES;
};

const findChatMessageInState = (
  state: Pick<
    ChatStore,
    "messages" | "messagesByConversationId" | "messageIndexById"
  >,
  messageId: string,
): ChatMessage | null => {
  const indexedMessageIndex = state.messageIndexById[messageId];
  const indexedMessage =
    typeof indexedMessageIndex === "number"
      ? state.messages[indexedMessageIndex]
      : undefined;
  if (indexedMessage?.id === messageId) {
    return indexedMessage;
  }

  const directMessage = state.messages.find((message) => message.id === messageId);
  if (directMessage) {
    return directMessage;
  }

  for (const conversationMessages of Object.values(state.messagesByConversationId)) {
    const message = conversationMessages?.find(
      (candidate) => candidate.id === messageId,
    );
    if (message) {
      return message;
    }
  }

  return null;
};

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

const setQuestionnaireDraftForConversation = (
  draftsByConversationId: Record<string, ConversationQuestionnaireDraft>,
  conversationId: string,
  draft: ConversationQuestionnaireDraft,
): Record<string, ConversationQuestionnaireDraft> => ({
  ...draftsByConversationId,
  [conversationId]: draft,
});

const clearQuestionnaireDraftsForConversations = (
  draftsByConversationId: Record<string, ConversationQuestionnaireDraft>,
  conversationIds: string[],
): Record<string, ConversationQuestionnaireDraft> => {
  if (conversationIds.length === 0) {
    return draftsByConversationId;
  }
  const next = { ...draftsByConversationId };
  conversationIds.forEach((conversationId) => {
    delete next[conversationId];
  });
  return next;
};

const setActiveQuestionnaireDraftStep = (
  draftsByConversationId: Record<string, ConversationQuestionnaireDraft>,
  activeQuestionnaire: ConversationQuestionnaireState,
  stepIndex: number,
): Record<string, ConversationQuestionnaireDraft> =>
  setQuestionnaireDraftForConversation(
    draftsByConversationId,
    activeQuestionnaire.conversationId,
    {
      mode: activeQuestionnaire.mode,
      assistantMessageId: activeQuestionnaire.assistantMessageId,
      responseMessageId: activeQuestionnaire.responseMessageId,
      currentStepIndex: stepIndex,
      answersByStepId: { ...activeQuestionnaire.answersByStepId },
      draftTextByStepId: { ...activeQuestionnaire.draftTextByStepId },
    },
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
  let providerSelectionUnsubscribe: (() => void) | null = null;
  let contextSelectionUnsubscribe: (() => void) | null = null;
  let taskAwaitingResponseSyncUnsubscribe: (() => void) | null = null;
  let hydrationPromise: Promise<void> | null = null;
  const messageLoadPromisesByConversationId = new Map<string, Promise<void>>();
  const contextDiagnosticsRequestIds = new Map<string, number>();
  let awaitingResponseReconciliationScheduled = false;
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
      projects: appState.projectGroups.flatMap((group) => group.projects),
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

  const toPersistedProviderSelection = (
    selection: PersistedAISelection,
  ): PersistedAIProviderSelection => ({
    modelId: selection.modelId!,
    reasoningEffort: selection.reasoningEffort ?? null,
    updatedAt: selection.updatedAt,
  });

  const toPersistedSelectionFromProvider = (
    providerId: string,
    selection: PersistedAIProviderSelection | null,
  ): PersistedAISelection | null => {
    if (!selection) {
      return null;
    }

    return {
      providerId,
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort ?? null,
      updatedAt: selection.updatedAt,
    };
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

  const getConversationProviderSelection = (
    conversationId: string | null,
    providerId: string,
  ): PersistedAISelection | null => {
    if (!conversationId) {
      return null;
    }

    return toPersistedSelectionFromProvider(
      providerId,
      aiSelections.providerSelectionsByConversationId[conversationId]?.[
        providerId
      ] ?? null,
    );
  };

  const getModeProviderSelection = (
    mode: AppMode,
    providerId: string,
  ): PersistedAISelection | null =>
    toPersistedSelectionFromProvider(
      providerId,
      aiSelections.providerSelectionsByMode[getSelectionModeKey(mode)]?.[
        providerId
      ] ?? null,
    );

  const cloneAiSelections = (
    source: PersistedAIContextSelections = aiSelections,
  ): PersistedAIContextSelections => ({
    version: source.version,
    modeSelections: { ...source.modeSelections },
    conversationSelections: { ...source.conversationSelections },
    providerSelectionsByConversationId: Object.fromEntries(
      Object.entries(source.providerSelectionsByConversationId).map(
        ([conversationId, selectionMap]) => [
          conversationId,
          { ...selectionMap },
        ],
      ),
    ),
    providerSelectionsByMode: Object.fromEntries(
      Object.entries(source.providerSelectionsByMode).map(
        ([modeKey, selectionMap]) => [modeKey, { ...selectionMap }],
      ),
    ) as PersistedAIContextSelections["providerSelectionsByMode"],
  });

  const commitAiSelections = (nextSelections: PersistedAIContextSelections) => {
    aiSelections = nextSelections;
    persistAiSelections();
  };

  const upsertSelectionForContext = (
    target: PersistedAIContextSelections,
    mode: AppMode,
    conversationId: string | null,
    selection: PersistedAISelection | null,
  ): boolean => {
    if (!selection?.providerId || !selection.modelId) {
      return false;
    }

    const providerId = selection.providerId;
    const modeKey = getSelectionModeKey(mode);
    target.modeSelections[modeKey] = selection;
    target.providerSelectionsByMode[modeKey] = {
      ...(target.providerSelectionsByMode[modeKey] ?? {}),
      [providerId]: toPersistedProviderSelection(selection),
    };

    if (conversationId) {
      target.conversationSelections[conversationId] = selection;
      target.providerSelectionsByConversationId[conversationId] = {
        ...(target.providerSelectionsByConversationId[conversationId] ?? {}),
        [providerId]: toPersistedProviderSelection(selection),
      };
    }

    return true;
  };

  const removeConversationSelectionInTarget = (
    target: PersistedAIContextSelections,
    conversationId: string,
  ): boolean => {
    if (!target.conversationSelections[conversationId]) {
      return false;
    }

    delete target.conversationSelections[conversationId];
    return true;
  };

  const removeConversationProviderSelectionInTarget = (
    target: PersistedAIContextSelections,
    conversationId: string,
    providerId: string,
  ): boolean => {
    const conversationSelections =
      target.providerSelectionsByConversationId[conversationId];
    if (!conversationSelections?.[providerId]) {
      return false;
    }

    delete conversationSelections[providerId];
    if (Object.keys(conversationSelections).length === 0) {
      delete target.providerSelectionsByConversationId[conversationId];
    }
    return true;
  };

  const removeConversationSelectionDataInTarget = (
    target: PersistedAIContextSelections,
    conversationId: string,
  ): boolean => {
    const removedConversationSelection =
      removeConversationSelectionInTarget(target, conversationId);
    const hadProviderSelections =
      !!target.providerSelectionsByConversationId[conversationId];
    if (hadProviderSelections) {
      delete target.providerSelectionsByConversationId[conversationId];
    }
    return removedConversationSelection || hadProviderSelections;
  };

  const removeModeSelectionInTarget = (
    target: PersistedAIContextSelections,
    mode: AppMode,
  ): boolean => {
    const modeKey = getSelectionModeKey(mode);
    if (!target.modeSelections[modeKey]) {
      return false;
    }

    delete target.modeSelections[modeKey];
    return true;
  };

  const removeModeProviderSelectionInTarget = (
    target: PersistedAIContextSelections,
    mode: AppMode,
    providerId: string,
  ): boolean => {
    const modeKey = getSelectionModeKey(mode);
    const modeSelections = target.providerSelectionsByMode[modeKey];
    if (!modeSelections?.[providerId]) {
      return false;
    }

    delete modeSelections[providerId];
    if (Object.keys(modeSelections).length === 0) {
      delete target.providerSelectionsByMode[modeKey];
    }
    return true;
  };

  const persistSelectionForContext = (
    mode: AppMode,
    conversationId: string | null,
  ) => {
    const selection = getCurrentSelection();
    if (!selection) return;

    const nextSelections = cloneAiSelections();
    if (!upsertSelectionForContext(nextSelections, mode, conversationId, selection)) {
      return;
    }

    commitAiSelections(nextSelections);
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
    const nextSelections = cloneAiSelections();
    if (!removeConversationSelectionDataInTarget(nextSelections, conversationId)) {
      return;
    }

    commitAiSelections(nextSelections);
  };

  type AiSelectionResolutionStep =
    | {
        kind: "candidate";
        selection: PersistedAISelection;
        invalidate: (target: PersistedAIContextSelections) => boolean;
      }
    | { kind: "provider_fallback"; providerId: string }
    | { kind: "global_fallback"; excludedProviderIds: string[] };

  const buildAiSelectionRestorePlan = (params: {
    mode: AppMode;
    conversationId: string | null;
    preferredProviderId?: string | null;
    currentSelection: PersistedAISelection | null;
  }): AiSelectionResolutionStep[] => {
    const { mode, conversationId, preferredProviderId, currentSelection } =
      params;
    const steps: AiSelectionResolutionStep[] = [];
    const seenSelectionKeys = new Set<string>();
    const seenFallbackProviders = new Set<string>();
    const modeKey = getSelectionModeKey(mode);
    const conversationSelection = conversationId
      ? aiSelections.conversationSelections[conversationId] ?? null
      : null;
    const modeSelection = aiSelections.modeSelections[modeKey] ?? null;
    const conversationProviderId =
      preferredProviderId ??
      conversationSelection?.providerId ??
      currentSelection?.providerId ??
      modeSelection?.providerId ??
      null;
    const modeProviderId =
      preferredProviderId ??
      modeSelection?.providerId ??
      currentSelection?.providerId ??
      conversationSelection?.providerId ??
      null;
    const fallbackProviderId =
      preferredProviderId ??
      currentSelection?.providerId ??
      conversationSelection?.providerId ??
      modeSelection?.providerId ??
      null;

    const pushCandidate = (
      selection: PersistedAISelection | null,
      invalidate: (target: PersistedAIContextSelections) => boolean,
    ) => {
      if (!selection?.providerId || !selection.modelId) {
        return;
      }
      if (preferredProviderId && selection.providerId !== preferredProviderId) {
        return;
      }

      const key = `${selection.providerId}::${selection.modelId}::${
        selection.reasoningEffort ?? ""
      }`;
      if (seenSelectionKeys.has(key)) {
        return;
      }

      seenSelectionKeys.add(key);
      seenFallbackProviders.add(selection.providerId);
      steps.push({
        kind: "candidate",
        selection,
        invalidate,
      });
    };

    pushCandidate(conversationSelection, (target) =>
      conversationId
        ? removeConversationSelectionInTarget(target, conversationId)
        : false,
    );

    if (conversationProviderId) {
      pushCandidate(
        getConversationProviderSelection(conversationId, conversationProviderId),
        (target) =>
          conversationId
            ? removeConversationProviderSelectionInTarget(
                target,
                conversationId,
                conversationProviderId,
              )
            : false,
      );
    }

    pushCandidate(modeSelection, (target) =>
      removeModeSelectionInTarget(target, mode),
    );

    if (modeProviderId) {
      pushCandidate(getModeProviderSelection(mode, modeProviderId), (target) =>
        removeModeProviderSelectionInTarget(target, mode, modeProviderId),
      );
    }

    if (fallbackProviderId) {
      seenFallbackProviders.add(fallbackProviderId);
      steps.push({ kind: "provider_fallback", providerId: fallbackProviderId });
    }

    steps.push({
      kind: "global_fallback",
      excludedProviderIds: Array.from(seenFallbackProviders),
    });

    return steps;
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
      const nextSelections = cloneAiSelections();
      let selectionsChanged = false;
      let appliedSelection: PersistedAISelection | null = null;
      let restoreMessage: string | null = null;
      const currentSelection = getCurrentSelection();
      const resolutionPlan = buildAiSelectionRestorePlan({
        mode: params.mode,
        conversationId: params.conversationId,
        preferredProviderId: params.preferredProviderId ?? null,
        currentSelection,
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
    const existingConversationIds = new Set(
      conversations.map((conversation) => conversation.id),
    );
    const nextConversationSelections: Record<string, PersistedAISelection> = {};

    Object.entries(aiSelections.conversationSelections).forEach(
      ([conversationId, selection]) => {
        if (existingConversationIds.has(conversationId)) {
          nextConversationSelections[conversationId] = selection;
        }
      },
    );

    const nextProviderSelectionsByConversationId = Object.fromEntries(
      Object.entries(aiSelections.providerSelectionsByConversationId).filter(
        ([conversationId]) => existingConversationIds.has(conversationId),
      ),
    );

    const conversationSelectionsChanged =
      Object.keys(nextConversationSelections).length !==
      Object.keys(aiSelections.conversationSelections).length;
    const providerSelectionsChanged =
      Object.keys(nextProviderSelectionsByConversationId).length !==
      Object.keys(aiSelections.providerSelectionsByConversationId).length;

    if (conversationSelectionsChanged || providerSelectionsChanged) {
      aiSelections = {
        ...aiSelections,
        conversationSelections: nextConversationSelections,
        providerSelectionsByConversationId: nextProviderSelectionsByConversationId,
      };
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
    if (!conversationId) {
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

      if (!tauriIpc.isTauriAvailable()) {
        markConversationMessagesReady(conversationId);
        return;
      }

      try {
        const dbMessages = await tauriIpc.listMessages(conversationId);
        const conversationById = new Map(
          get().conversations.map((conversation) => [
            conversation.id,
            conversation,
          ]),
        );
        replaceLoadedConversationMessages(
          conversationId,
          dbMessages.map((message) =>
            mapDbMessageToChatMessage(message, conversationById),
          ),
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

  const buildSendError = (message: string): Error => new Error(message);

  const assertConversationRuntimeAvailableForSend = (conversationId: string) => {
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

  const stopConversationRuntimeLocally = (conversationId: string) => {
    const runtime = getConversationRuntimeSnapshot(
      get().conversationRuntimeById,
      conversationId,
    );
    clearConversationSecurityState(conversationId);
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

  const getToolDefinitionsForIds = (toolIds: string[]) => {
    const allowedIdSet = new Set(toolIds);
    return MACRO_TOOL_REGISTRY.filter((entry) => allowedIdSet.has(entry.id));
  };

  const getSelectedModelContextWindowTokens = (
    providerId: string,
    modelId: string,
    providerType: string,
  ): number => {
    const providerState = useProviderStore.getState();
    const selectedModel = (
      providerState.modelsByProvider[providerId] || []
    ).find((model) => model.id === modelId);
    return resolveModelContextWindowTokens({
      providerType,
      providerId,
      baseUrl: providerState.providerConfigs.find(
        (provider) => provider.id === providerId,
      )?.baseUrl,
      modelId,
      modelContextWindowTokens: selectedModel?.contextWindowTokens,
    });
  };

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
      case "overflow_recovery":
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

  const normalizeSummaryFormatVersion = (
    value: number | null | undefined,
  ): number => (
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : 1
  );

  const resolveCompactionStatusFromState = (
    state: ConversationCompactionState,
  ): ConversationCompactionStatus => {
    const footprintAfter = state.footprintAfter;
    const phase: ConversationCompactionPhase =
      footprintAfter?.isHardStop === true
        ? "too_large"
        : state.degradedReason
          ? "degraded"
          : "compacted";

    return {
      phase,
      upToMessageId: state.upToMessageId,
      summaryText: state.summaryText,
      updatedAt: state.updatedAt,
      reason: state.degradedReason ?? null,
      kind: state.compactionKind,
      summaryFormatVersion: state.summaryFormatVersion,
      summarySource: state.summarySource,
      footprintAfter,
    };
  };

  const setConversationCompactionStatus = (
    conversationId: string,
    status: ConversationCompactionStatus | null,
  ) => {
    set((state) => {
      const next = { ...state.conversationCompactionStatusById };
      if (status) {
        next[conversationId] = status;
      } else {
        delete next[conversationId];
      }
      return { conversationCompactionStatusById: next };
    });
  };

  const markConversationCompactionStarted = (
    conversationId: string,
    kind: ContextCompactionKind,
    fallbackStatus?: ConversationCompactionStatus | null,
  ) => {
    const previous =
      get().conversationCompactionStatusById[conversationId] ?? fallbackStatus;
    setConversationCompactionStatus(conversationId, {
      ...previous,
      phase: kind === "overflow_recovery" ? "overflow_recovery" : "compacting",
      updatedAt: new Date().toISOString(),
      kind,
    });
  };

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
  });

  const getConversationCompactionState = async (
    conversationId: string,
  ): Promise<ConversationCompactionState | null> => {
    if (conversationCompactionStateCache.has(conversationId)) {
      const cachedState =
        conversationCompactionStateCache.get(conversationId) ?? null;
      setConversationCompactionStatus(
        conversationId,
        cachedState ? resolveCompactionStatusFromState(cachedState) : null,
      );
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
      setConversationCompactionStatus(
        conversationId,
        state ? resolveCompactionStatusFromState(state) : null,
      );
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

  const prepareCompactionSummaryMessages = (
    input: SummaryGenerationInput,
  ): StreamMessage[] => {
    const compactedTranscript = input.compactableMessages
      .map((message) => {
        const content =
          message.role === "assistant"
            ? sanitizeAssistantContentForModel(message.content)
            : message.content;
        return `${message.role.toUpperCase()} [${message.id}]\n${content.trim() || "[empty]"}`;
      })
      .join("\n\n---\n\n");

    const retainedContext = input.retainedMessages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-6)
      .map((message) => {
        const content =
          message.role === "assistant"
            ? sanitizeAssistantContentForModel(message.content)
            : message.content;
        return `${message.role.toUpperCase()} [${message.id}]\n${content.trim() || "[empty]"}`;
      })
      .join("\n\n---\n\n");

    const toolDigest = input.toolDigest
      .map(
        (entry) =>
          `- kind=${entry.kind}; tool=${entry.tool_name}; target=${entry.target}; evidence=${entry.evidence_excerpt}`,
      )
      .join("\n");

    const usedPassages = input.usedSourcePassages
      .map(
        (citation) =>
          `- ${citation.title}${citation.source ? ` (${citation.source})` : ""}: ${citation.snippet || ""}`,
      )
      .join("\n");

    const interestingPassages = input.interestingSourcePassages
      .map(
        (citation) =>
          `- ${citation.title}${citation.source ? ` (${citation.source})` : ""}: ${citation.snippet || ""}`,
      )
      .join("\n");

    return [
      {
        role: "system",
        content:
          "Compact older conversation history for a programming agent into schema v2. Return ONLY valid JSON with keys " +
          '"currentObjective", "userInstructions", "decisions", "discoveries", "openQuestions", "activeFiles", "toolFacts", "remainingWork", "summary". ' +
          'Use short factual strings. "userInstructions", "decisions", "discoveries", "openQuestions", "activeFiles", "toolFacts", and "remainingWork" must be arrays of strings. ' +
          "Preserve acceptance criteria, user preferences, exact file paths, commands run, errors, decisions, and remaining work. Do not invent facts.",
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

  const formatCompactionSummaryFromModelOutput = (raw: string): string => {
    const parsed = extractJsonObjectFromModelOutput(raw) as {
      currentObjective?: unknown;
      userInstructions?: unknown;
      decisions?: unknown;
      discoveries?: unknown;
      openQuestions?: unknown;
      activeFiles?: unknown;
      toolFacts?: unknown;
      remainingWork?: unknown;
      summary?: unknown;
    };

    const currentObjective =
      typeof parsed.currentObjective === "string"
        ? parsed.currentObjective.trim()
        : "";
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const decisions = Array.isArray(parsed.decisions)
      ? parsed.decisions.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const discoveries = Array.isArray(parsed.discoveries)
      ? parsed.discoveries.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const userInstructions = Array.isArray(parsed.userInstructions)
      ? parsed.userInstructions.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const openQuestions = Array.isArray(parsed.openQuestions)
      ? parsed.openQuestions.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const activeFiles = Array.isArray(parsed.activeFiles)
      ? parsed.activeFiles.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const toolFacts = Array.isArray(parsed.toolFacts)
      ? parsed.toolFacts.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const remainingWork = Array.isArray(parsed.remainingWork)
      ? parsed.remainingWork.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];

    return [
      currentObjective ? `Current objective: ${currentObjective}` : "",
      userInstructions.length > 0
        ? `User instructions:\n${userInstructions.map((item) => `- ${item}`).join("\n")}`
        : "",
      decisions.length > 0
        ? `Decisions made:\n${decisions.map((item) => `- ${item}`).join("\n")}`
        : "",
      discoveries.length > 0
        ? `Discoveries:\n${discoveries.map((item) => `- ${item}`).join("\n")}`
        : "",
      openQuestions.length > 0
        ? `Open questions:\n${openQuestions.map((item) => `- ${item}`).join("\n")}`
        : "",
      activeFiles.length > 0
        ? `Active files/projects:\n${activeFiles.map((item) => `- ${item}`).join("\n")}`
        : "",
      toolFacts.length > 0
        ? `Tool facts:\n${toolFacts.map((item) => `- ${item}`).join("\n")}`
        : "",
      remainingWork.length > 0
        ? `Remaining work:\n${remainingWork.map((item) => `- ${item}`).join("\n")}`
        : "",
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
    try {
      const output = await sendChatNonStreaming({
        providerId,
        providerType: providerConfig.providerType,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        modelId,
        reasoningEffort,
        messages: prepareCompactionSummaryMessages(input),
        onComplete: () => {},
        onError: () => {},
      });
      const summary = formatCompactionSummaryFromModelOutput(output);
      return summary || null;
    } catch (error) {
      devLogger.info(
        `Compaction summary generation failed for provider=${providerConfig.providerType}: ${toServiceError(error).message}`,
      );
      return null;
    }
  };

  const loadContextBudgetPolicy = async (): Promise<ContextBudgetPolicy> => {
    const [auto, prune, reservedTokens] = await Promise.all([
      loadPreference<boolean>(PREF_KEYS.COMPACTION_AUTO),
      loadPreference<boolean>(PREF_KEYS.COMPACTION_PRUNE),
      loadPreference<number | null>(PREF_KEYS.COMPACTION_RESERVED_TOKENS),
    ]);
    return {
      auto,
      prune,
      reservedTokens,
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
  }) => {
    const toolDefinitions = getToolDefinitionsForIds(params.allowedToolIds);
    const previousCompactionStatus =
      get().conversationCompactionStatusById[params.conversationId] ?? null;
    const currentCompactionState = await getConversationCompactionState(
      params.conversationId,
    );
    const statusBeforeNewCompaction =
      get().conversationCompactionStatusById[params.conversationId] ??
      previousCompactionStatus;
    const modelContextWindowTokens = getSelectedModelContextWindowTokens(
      params.providerId,
      params.modelId,
      params.providerConfig.providerType,
    );
    const budgetPolicy = await loadContextBudgetPolicy();

    let result: MaybeCompactConversationResult;
    try {
      result = await buildCompactedMessagesForRequest({
        systemMessage: params.systemMessage,
        preparedMessages: params.preparedMessages,
        orderedMessages: params.orderedMessages,
        citations: params.citations,
        toolDefinitions,
        modelContextWindowTokens,
        currentCompactionState,
        estimateSerializedPayloadTokens: (messages) =>
          estimateChatCompletionSerializedPayloadTokens({
            messages,
            providerType: params.providerConfig.providerType,
            providerId: params.providerId,
            baseUrl: params.providerConfig.baseUrl,
            modelId: params.modelId,
          }),
        mode: params.mode,
        budgetPolicy,
        forceCompaction: params.forceCompaction,
        forcePrune: params.forcePrune,
        onCompactionStarted: () => {
          markConversationCompactionStarted(
            params.conversationId,
            params.mode,
            statusBeforeNewCompaction,
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
      setConversationCompactionStatus(params.conversationId, statusBeforeNewCompaction);
      throw error;
    }

    const hadCompaction = Boolean(currentCompactionState);
    const hasCompaction = Boolean(result.compactionState);
    if (hasCompaction) {
      await persistConversationCompactionState(result.compactionState);
    } else if (hadCompaction) {
      await deleteConversationCompactionState(params.conversationId);
    } else {
      setConversationCompactionStatus(params.conversationId, statusBeforeNewCompaction);
    }

    if (result.degraded) {
      devLogger.info(
        `Context compaction degraded conversation=${params.conversationId} ratio=${result.footprintAfter.totalContextRatio.toFixed(3)} reason=${result.footprintAfter.reason}`,
      );
    }

    return result;
  };

  const ensureToolsLoaded = async (): Promise<void> => {
    const toolsState = useToolsStore.getState();
    if (Object.keys(toolsState.internalTools).length > 0) return;
    await toolsState.loadSettings();
  };

  const getModePolicyForCurrentMode = async (): Promise<{
    allowedToolIds: string[];
    enforceMacroOnlyWrites: boolean;
  }> => {
    const mode = useAppStore.getState().mode;
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

  const isSourceToolEnabled = async (toolId: string): Promise<boolean> => {
    const mode = useAppStore.getState().mode;
    const modePolicy = await getModePolicyForCurrentMode();
    if (!modePolicy.allowedToolIds.includes(toolId)) {
      return false;
    }

    const toolsState = useToolsStore.getState();
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

  const readConversationFileContext = (
    conversationId: string,
    args: Record<string, unknown>,
  ): string => {
    const requestedRaw = typeof args.file === "string" ? args.file.trim() : "";
    const requested = normalizeContextLookup(requestedRaw);
    const extractText = args.extract_text === true;
    const fileCitations = useCitationsStore
      .getState()
      .getConversationContextCitations(conversationId)
      .filter((citation) => citation.type === "file" || citation.type === "document");
    const available = fileCitations
      .map((citation) => citation.path || citation.title || citation.source)
      .filter(Boolean);

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

    if (!match) {
      return `File not found in context: "${requestedRaw}". Available files: ${
        available.join(", ") || "none"
      }`;
    }

    const label = match.path || match.title || match.source;
    const content = getCitationBody(match);
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

  const readConversationSources = (
    conversationId: string,
    args: Record<string, unknown>,
  ): string => {
    const rawKind = typeof args.kind === "string" ? args.kind : "all";
    const kind = rawKind === "interesting" || rawKind === "used" ? rawKind : "all";
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(50, Math.max(1, Math.floor(args.limit)))
        : 50;
    const includeSnippet = args.include_snippet !== false;
    const citations = useCitationsStore
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
    const target = await resolveTaskTodoTarget({
      args,
      executionContext: resolveConversationExecutionContext(conversationId),
      selectedTaskId: useAppStore.getState().selectedTaskId,
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

  const handleToolCall = async (
    conversationId: string,
    assistantMessageId: string,
    toolName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<ToolCallResolution | string | void> => {
    const normalizedToolName = normalizeArchitectToolId(toolName);

    if (!(await isSourceToolEnabled(normalizedToolName))) {
      return `Tool ${normalizedToolName} is disabled for the current mode.`;
    }

    let executionContext = resolveConversationExecutionContext(conversationId);
    const riskLevel = await loadToolRiskLevelPreference();
    const securityEvaluation = evaluateToolSecurity(normalizedToolName, args, {
      mode: useAppStore.getState().mode,
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
        rememberKey: securityEvaluation.normalizedCall.rememberKey,
      };

      const resolution = await new Promise<PendingToolApprovalResolution>(
        (resolve) => {
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
      useCitationsStore.getState().addCitation({
        type: "web",
        scope: "context",
        source: fetched.url,
        title: fetched.title,
        snippet: fetched.snippet,
        content: fetched.content,
        url: fetched.url,
        messageId: assistantMessageId,
        conversationId,
      });
      return `TITLE: ${fetched.title}\nURL: ${fetched.url}\n\n${fetched.content}`;
    }

    if (normalizedToolName === "read_file") {
      return readConversationFileContext(conversationId, args);
    }

    if (normalizedToolName === "mark_source_passage") {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const passage = typeof args.passage === "string" ? args.passage.trim() : "";
      if (!title || !passage) {
        return "Missing title or passage for mark_source_passage.";
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
      return readConversationSources(conversationId, args);
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
      getNeedsState: () => useNeedsStore.getState(),
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
      const mode = useAppStore.getState().mode;
      let appState = useAppStore.getState();
      let promotedProjectIdsForTool: string[] = [];

      if (mode === "Implement") {
        const selectedTaskId = appState.selectedTaskId;
        const selectedTask = selectedTaskId
          ? useTaskStore.getState().getTaskById(selectedTaskId)
          : undefined;
        const explicitProjectTargets = resolveExplicitMutatingToolProjectTargets(
          normalizedToolName,
          args,
          {
            workspacePath: executionContext.workspacePath,
            defaultWorkspacePath: executionContext.defaultWorkspacePath,
            projectId: executionContext.projectId,
            focusedProjectId: executionContext.focusedProjectId,
            groupId: executionContext.groupId,
            projectMounts: executionContext.projectMounts,
            virtualRootEnabled: executionContext.virtualRootEnabled,
            workspacePathsByProjectId: executionContext.workspacePathsByProjectId,
          },
        );
        const contextProjectIdSet = new Set(selectedTask?.context_project_ids || []);
        const actionableProjectIdSet = new Set(executionContext.actionableProjectIds);
        const promotableProjectIds = explicitProjectTargets.filter(
          (projectId) =>
            contextProjectIdSet.has(projectId) &&
            !actionableProjectIdSet.has(projectId),
        );

        if (selectedTask && promotableProjectIds.length > 0) {
          const promotion = await useTaskStore
            .getState()
            .promoteTaskContextProjects(selectedTask.id, promotableProjectIds, {
              triggerTool: normalizedToolName,
            });
          promotedProjectIdsForTool = promotion?.promotedProjectIds || [];
          executionContext = resolveConversationExecutionContext(conversationId);
          appState = useAppStore.getState();
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
          const explicitProject = appState.getProjectById(explicitProjectId);
          if (explicitProject?.isReadOnly) {
            return `Error executing terminal_create_session: subproject "${explicitProject.name}" is read-only.`;
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
              ? Math.max(1, Math.floor(args.timeout_ms))
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
        workspacePath: executionContext.workspacePath,
        defaultWorkspacePath: executionContext.defaultWorkspacePath,
        projectId: executionContext.projectId,
        focusedProjectId: executionContext.focusedProjectId,
        groupId: executionContext.groupId,
        projectMounts: executionContext.projectMounts,
        virtualRootEnabled: executionContext.virtualRootEnabled,
        workspacePathsByProjectId: executionContext.workspacePathsByProjectId,
      });
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
    messageWithImagesId?: string,
  ) => {
    const appState = useAppStore.getState();
    const executionContext = resolveConversationExecutionContext(conversationId);
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
    const availableFiles = fileCitations
      .map((c) => c.path || c.title || c.source)
      .filter(Boolean)
      .join(", ");
    const orderedMessages = getOrderedConversationMessages(conversationId);
    const lastUserIndex = orderedMessages
      .map((m) => m.role)
      .lastIndexOf("user");
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
          const contextBlock = citations
            .map((c, i) => {
              const kind =
                c.scope === "source" ? "Important Source" : "Context";
              return `[${kind} ${i + 1}: ${c.title}]\n${c.snippet || c.source || ""}`;
            })
            .join("\n\n---\n\n");
          blocks.push(`CONTEXT INFORMATION:\n\n${contextBlock}`);
        }

        const contextRefs = get().composerContextRefs;
        if (contextRefs.length > 0) {
          const refsBlock = contextRefs
            .map((ref) => {
              const lines: string[] = [`[${ref.kind}: ${ref.title}]`];
              if (ref.subtitle) lines.push(`Category: ${ref.subtitle}`);
              if ("description" in ref.data && ref.data.description) {
                lines.push(`Description: ${ref.data.description}`);
              }
              if ("status" in ref.data && ref.data.status) {
                lines.push(`Status: ${ref.data.status}`);
              }
              if ("priority" in ref.data && ref.data.priority) {
                lines.push(`Priority: ${ref.data.priority}`);
              }
              if (
                "tags" in ref.data &&
                Array.isArray(ref.data.tags) &&
                ref.data.tags.length > 0
              ) {
                lines.push(`Tags: ${ref.data.tags.join(", ")}`);
              }
              if ("type" in ref.data && ref.data.type) {
                lines.push(`Type: ${ref.data.type}`);
              }
              if (
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
        "Use edit_source_passage only when the user asks to update, reclassify, or delete saved source passages.",
      );
    }
    if (allowedToolIds.includes("question")) {
      systemInstructions.push(
        'Use the question tool only for blocking structured clarifications. If the user explicitly asks you to use the question tool, you must call it instead of asking in plain text. Do not use it for open brainstorming. Make at most one question tool call per assistant turn, with 1 to 5 sequential questions total, and exactly 3 suggested choices per question. If you use it, stop after the tool call and wait for the user questionnaire response.',
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
    const appMode = appState.mode;
    const agentType = appMode === "Implement" ? appState.agentType : null;
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

    if (
      agentType === "plan" &&
      internalAgentProfile !== "task_reviewer" &&
      internalAgentProfile !== "repo_auditor"
    ) {
      systemInstructions.push(
        "Agent type is PLAN. Focus on planning before execution: clarify goals, propose a step-by-step implementation plan, identify risks/dependencies, and ask for confirmation before suggesting direct file edits. Do not claim code was changed unless a tool call actually performed the change.",
      );
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
        `[Execution Context] global_project="${executionContext.groupName || executionContext.groupId || "none"}", default_subproject="${executionContext.projectName || executionContext.projectId || "none"}", focused_subproject="${executionContext.focusedProjectId || "none"}", scoped_projects="${scopedProjects}", task="${executionContext.taskId || "none"}", branch="${executionContext.branchName || "none"}", virtual_root="${executionContext.virtualRootEnabled ? "enabled" : "disabled"}", project_mounts="${mountSummary}". When virtual_root is enabled, the visible workspace root is virtual and its first level contains only subproject mounts such as \`api/\` or \`web/\`. Use virtual paths like \`api/src/server.ts\` for filesystem tools, or pass \`project_id\` to target one subproject explicitly. Git and terminal operations must target exactly one subproject; there is no git or terminal at the virtual root.`,
      );
    }

    const implementContextTaskId =
      executionContext.taskId ||
      get().conversations.find((conversation) => conversation.id === conversationId)?.task_id ||
      appState.selectedTaskId ||
      null;
    if (appMode === "Implement" && implementContextTaskId) {
      const task = useTaskStore.getState().getTaskById(implementContextTaskId);
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
    }

    if (appMode === "Architect") {
      systemInstructions.push(buildArchitectPlanToolFollowUpInstruction());
      systemInstructions.push(
        "In Architect mode, use `need_add`, `need_list`, `need_get`, and `need_update` to keep the active plan's needs structured and up to date instead of only describing requirements in prose. Use `need_list` as a compact id/title/priority index, then call `need_get` when the user asks for details about one need or before making a targeted update. Do not treat `need_list` as complete need detail.",
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
        "Git workflow for plans is strict: each plan has an immutable technical id plus a logical `slug` once it is locked. In mainline mode, where the development target and main branch are the same, create feature work only and do not propose release, hotfix, or bugfix branches. Feature plans integrate on rendered `plan/*` branches. The Architect AI should propose `plan_slug` and unique per-node `featureSlug` values, not raw git branch names. Task work branches are rendered later from each subproject Git workflow profile and merge into the plan integration branch.",
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
            ? "This is a Release plan. First inspect likely version files and relevant repositories, then use the question tool to confirm per-repository versions and actionable repositories before generating the stabilization checklist. Do not create tags or GitHub releases."
            : planKind === "hotfix"
              ? "This is a Hotfix plan. Ask the user to describe the production bug if they have not already done so. Then inspect from the main-branch mindset, infer affected repositories, propose a concise hotfix slug and patch versions per repository, and use the question tool to confirm scope/version/slug before generating the fix checklist."
              : planKind === "bugfix"
                ? "This is a Bugfix plan. Ask the user to describe the bug if they have not already done so. Then inspect from the development-branch mindset, infer affected repositories, propose a concise bugfix slug, and use the question tool to confirm scope/slug before generating the fix checklist."
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
      return conversation.task_id === selectedTaskId;
    }

    return false;
  };

  const getFallbackConversationIdForMode = (
    conversations: Conversation[],
    mode: AppMode,
    selectedGroupId: string | null,
    selectedProjectId: string | null,
    selectedTaskId: string | null,
  ): string | null => {
    const scoped = conversations
      .filter((conversation) =>
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
  ): Conversation | null =>
    conversations
      .filter(
        (conversation) =>
          getConversationScopeMode(conversation) === "Implement" &&
          conversation.task_id === taskId,
      )
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0] ?? null;

  type ConversationRemovalSnapshot = Pick<
    ChatStore,
    | "conversations"
    | "messages"
    | "messagesByConversationId"
    | "messageIndexById"
    | "messageLoadStatusByConversationId"
    | "messageImagesByMessageId"
    | "questionnaireDraftsByConversationId"
    | "pendingToolApprovalByConversationId"
    | "conversationApprovalGrantsByConversationId"
    | "conversationRuntimeById"
    | "selectedConversationId"
    | "selectedConversationIdsByMode"
  >;

  const buildConversationRemovalSnapshot = (): ConversationRemovalSnapshot => {
    const state = get();
    return {
      conversations: state.conversations,
      messages: state.messages,
      messagesByConversationId: state.messagesByConversationId,
      messageIndexById: state.messageIndexById,
      messageLoadStatusByConversationId: state.messageLoadStatusByConversationId,
      messageImagesByMessageId: state.messageImagesByMessageId,
      questionnaireDraftsByConversationId:
        state.questionnaireDraftsByConversationId,
      pendingToolApprovalByConversationId:
        state.pendingToolApprovalByConversationId,
      conversationApprovalGrantsByConversationId:
        state.conversationApprovalGrantsByConversationId,
      conversationRuntimeById: state.conversationRuntimeById,
      selectedConversationId: state.selectedConversationId,
      selectedConversationIdsByMode: state.selectedConversationIdsByMode,
    };
  };

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
    const nextMessageLoadStatusByConversationId = Object.fromEntries(
      Object.entries(state.messageLoadStatusByConversationId).filter(
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
      messageImagesByMessageId: nextImages,
      questionnaireDraftsByConversationId: nextQuestionnaireDrafts,
      pendingToolApprovalByConversationId: nextPendingToolApprovals,
      conversationApprovalGrantsByConversationId:
        nextConversationApprovalGrants,
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
    conversationIds.forEach((conversationId) => {
      clearConversationSecurityState(conversationId);
    });
    set((state) => buildConversationRemovalState(state, conversationIds));
  };

  const restoreConversationRemovalSnapshot = (
    snapshot: ConversationRemovalSnapshot,
  ) => {
    saveMessageImagesToStorage(snapshot.messageImagesByMessageId);
    saveQuestionnaireDraftsToStorage(snapshot.questionnaireDraftsByConversationId);
    set({
      ...snapshot,
      ...buildLegacyStreamingFlags({
        conversationRuntimeById: snapshot.conversationRuntimeById,
        selectedConversationId: snapshot.selectedConversationId,
      }),
    });
  };

  const getAllowedToolIdsForCurrentMode = async (
    internalAgentProfile?: InternalAgentProfile | null,
  ): Promise<string[]> => {
    if (!useProviderStore.getState().selectedSupportsNativeToolCalling()) {
      return [];
    }

    const riskLevel = await loadToolRiskLevelPreference();
    const providerState = useProviderStore.getState();
    const selectedProvider = providerState.providerConfigs.find(
      (provider) => provider.id === providerState.selectedProviderId,
    );
    const strategyFilterForSelectedProvider = (toolIds: string[]): string[] =>
      applyEditingStrategyToToolIds(
        toolIds,
        selectedProvider?.providerType,
        providerState.selectedModelId,
      );
    const filterForSelectedProvider = (toolIds: string[]): string[] =>
      selectedProvider?.providerType === "copilot"
        ? filterCopilotSupportedToolIds(
            strategyFilterForSelectedProvider(toolIds),
          )
        : strategyFilterForSelectedProvider(toolIds);
    const finalizeAllowedToolIds = (toolIds: string[]): string[] => {
      const filteredToolIds = filterToolIdsForInternalAgentProfile(
        filterForSelectedProvider(toolIds),
        internalAgentProfile,
      );
      const riskFilteredToolIds = filterDeniedToolIdsForRiskLevel(
        filteredToolIds,
        riskLevel,
      );

      if (
        internalAgentProfile === "task_reviewer" &&
        toolIds.includes("apply_patch") &&
        !riskFilteredToolIds.includes("apply_patch")
      ) {
        return Array.from(new Set([...riskFilteredToolIds, "apply_patch"]));
      }

      return riskFilteredToolIds;
    };

    const mode = useAppStore.getState().mode;
    const modePolicy = await getModePolicyForCurrentMode();
    const toolsState = useToolsStore.getState();

    if (mode === "Chat") {
      const enabledChatTools = toolsState.getEnabledChatToolIds();
      return finalizeAllowedToolIds(
        enabledChatTools.filter((toolId) =>
          modePolicy.allowedToolIds.includes(toolId),
        ),
      );
    }

    const enabledTools = Object.values(toolsState.internalTools)
      .filter((tool) => toolsState.isToolEnabled(tool.id))
      .map((tool) => tool.id);

    return finalizeAllowedToolIds(
      enabledTools.filter((toolId) =>
        modePolicy.allowedToolIds.includes(toolId),
      ),
    );
  };

  const buildGuidedToolRetryPolicy = (params: {
    userContent: string;
    allowedToolIds: string[];
    fileToolContext: Array<{
      title: string;
      source: string;
      path?: string;
      snippet?: string;
      content?: string;
    }>;
  }) => {
    if (!useProviderStore.getState().selectedSupportsNativeToolCalling()) {
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
    firstUserContent: string,
    unavailableBranchNames: string[] = [],
  ) => {
    const unavailableBranchSummary =
      unavailableBranchNames.length > 0
        ? ` These branch names are already taken and must not be reused: ${unavailableBranchNames.join(", ")}. Return a different featureSlug.`
        : "";

    return [
      {
        role: "system" as const,
        content:
          "Generate concise metadata for a standalone implementation feature. Return ONLY valid JSON with keys: title, description, featureSlug. " +
          "title: 3-7 words, specific and action-oriented. description: one clear sentence under 180 characters. " +
          "featureSlug: lowercase kebab-case branch slug without any branch prefix; the concrete branch name is rendered later from each subproject's independent feature template." +
          unavailableBranchSummary,
      },
      {
        role: "user" as const,
        content: firstUserContent,
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

    const planNeeds = await getArchitectPlanNeeds(
      params.targetBranch,
      params.updatedPlan.id,
    );
    useNeedsStore.getState().hydrateNeedsForPlan(params.updatedPlan.id, planNeeds);
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

    const appState = useAppStore.getState();
    const projectIds = Array.from(
      new Set(
        [...(task.project_ids || []), task.project_id].filter(
          (projectId): projectId is string =>
            typeof projectId === "string" && projectId.trim().length > 0,
        ),
      ),
    );

    const renderManualFeatureBranchCandidates = (
      featureSlug: string,
    ): Array<{ projectId: string; branchName: string }> => {
      const projectIdsToCheck =
        projectIds.length > 0
          ? projectIds
          : appState.selectedGroupId
            ? getScopedActionableProjectIds(
                appState.projectGroups,
                appState.selectedGroupId,
                null,
              )
            : [];

      return projectIdsToCheck.map((projectId) => ({
        projectId,
        branchName: renderStandaloneFeatureBranchName({
          featureSlug,
          settings: appState.getProjectById(projectId)?.gitFlowSettings,
        }),
      }));
    };

    const findConflictingBranchCandidates = async (
      featureSlug: string,
    ): Promise<Array<{ projectId: string; branchName: string }>> => {
      if (!tauriIpc.isTauriAvailable()) {
        return [];
      }

      const branchCandidates = renderManualFeatureBranchCandidates(featureSlug);

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
        providerId: params.providerId,
        providerType: params.providerType,
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        modelId: params.modelId,
        reasoningEffort: params.reasoningEffort,
        messages: prepareManualFeatureMetadataMessages(
          params.firstUserContent,
          unavailableBranchNames,
        ),
        onComplete: () => {},
        onError: () => {},
      });
      return extractManualFeatureMetadataFromModelOutput(output);
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
          await findConflictingBranchCandidates(candidateSlug);
        if (conflictingCandidates.length === 0) {
          return candidateSlug;
        }
      }

      return `work-${Date.now().toString(36)}`;
    };

    let metadata = buildManualFeatureFallbackMetadata(params.firstUserContent);
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
          metadata = buildManualFeatureFallbackMetadata(
            params.firstUserContent,
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
                providerId,
                providerType,
                baseUrl,
                apiKey,
                modelId,
                reasoningEffort,
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

      const metadata = await requestConversationMetadata(params).catch(() => ({
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

  const applyStreamCompletion = (
    messageId: string,
    result: StreamCompletionResult,
  ) => {
    const existingToolTraces =
      get().messages.find((message) => message.id === messageId)?.tool_traces ??
      [];
    const mergedToolTraces = mergeToolTracesPreservingDeniedStatus(
      result.toolTraces,
      existingToolTraces,
    );

    get().updateMessageFields(messageId, {
      tool_traces: mergedToolTraces,
      hidden_context: result.hiddenContext,
      provider_input_items: result.providerInputItems,
      provider_turn_state: result.providerTurnState,
      ...(result.completionReason ? { completion_reason: result.completionReason } : {}),
    });
    get().updateMessageContent(messageId, result.visibleContent);
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

    if (!tauriIpc.isTauriAvailable()) {
      get().updateMessageFields(messageId, {
        provider_input_items: providerInputItems,
      });
      return;
    }

    try {
      await tauriIpc.updateMessage(messageId, message.content, {
        toolTraces: message.tool_traces,
        hiddenContext: message.hidden_context,
        providerInputItems,
        providerTurnState: message.provider_turn_state,
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
    taskId: string;
    content: string;
    hiddenContext?: string;
    providerInputItems?: unknown[];
  }): Promise<ChatMessage> => {
    const presentation = buildUserMessagePresentation(
      params.content,
      params.hiddenContext,
    );
    let userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      task_id: params.taskId,
      conversation_id: params.conversationId,
      role: "user",
      content: presentation.content,
      timestamp: new Date().toISOString(),
      hidden_context: params.hiddenContext,
      provider_input_items: cloneProviderInputItems(params.providerInputItems),
      questionnaire_response_summary:
        presentation.questionnaire_response_summary,
    };

    if (tauriIpc.isTauriAvailable()) {
      try {
        const dbMessage = await tauriIpc.createMessage(
          params.conversationId,
          "user",
          params.content,
          {
            hiddenContext: params.hiddenContext,
            providerInputItems: params.providerInputItems,
          },
        );
        const dbPresentation = buildUserMessagePresentation(
          dbMessage.content,
          dbMessage.hidden_context ?? undefined,
        );
        userMessage = {
          id: dbMessage.id,
          task_id: params.taskId,
          conversation_id: dbMessage.conversation_id,
          role: "user",
          content: dbPresentation.content,
          timestamp: dbMessage.created_at,
          hidden_context: dbMessage.hidden_context ?? undefined,
          provider_input_items: parseDbProviderInputItems(
            dbMessage.provider_input_items_json,
          ),
          questionnaire_response_summary:
            dbPresentation.questionnaire_response_summary,
        };
      } catch (error) {
        const normalized = toServiceError(error);
        throw buildSendError(
          `Failed to save the message before sending: ${normalized.message}`,
        );
      }
    }

    return userMessage;
  };

  const prepareAssistantStreamLaunch = async (params: {
    conversationId: string;
    replyToMessageId: string;
    userContent: string;
    resolvedTaskId: string;
    modeAtSend: AppMode;
    providerId: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
    providerConfig: NonNullable<
      ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
    >;
    internalAgentProfile?: InternalAgentProfile | null;
    compactionMode?: ContextCompactionKind;
    forceCompaction?: boolean;
    forcePrune?: boolean;
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
    const allowedToolIds = await getAllowedToolIdsForCurrentMode(
      internalAgentProfile,
    );
    const showToolTraces = false;
    const preparedRequest = await prepareMessagesForRequest(
      params.conversationId,
      allowedToolIds,
      internalAgentProfile,
      params.replyToMessageId,
    );
    const compactedRequest = await compactConversationMessages({
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
      mode: params.compactionMode ?? "blocking",
      forceCompaction: params.forceCompaction,
      forcePrune: params.forcePrune,
    });
    if (compactedRequest.decision === "hard_stop") {
      setConversationCompactionStatus(params.conversationId, {
        phase: "too_large",
        updatedAt: new Date().toISOString(),
        reason: compactedRequest.footprintAfter.reason,
        kind: params.compactionMode ?? "blocking",
        footprintAfter: compactedRequest.footprintAfter,
      });
      throw buildSendError(
        buildContextTooLargeErrorMessage(compactedRequest.footprintAfter),
      );
    }
    const fileToolContext = useCitationsStore
      .getState()
      .getConversationContextCitations(params.conversationId)
      .filter((c) => c.type === "file" || c.type === "document")
      .map((c) => ({
        title: c.title,
        source: c.source,
        path: c.path,
        snippet: c.snippet,
        content: c.content,
      }));
    const { enableWebSearch, enableWebFetch, webSearchOptions } =
      getStreamingWebSearchConfig();
    const guidedToolRetry = buildGuidedToolRetryPolicy({
      userContent: params.userContent,
      allowedToolIds,
      fileToolContext,
    });
    const maxTurns = normalizeChatMaxTurns(
      await loadPreference<ChatMaxTurnsPreference>(PREF_KEYS.CHAT_MAX_TURNS),
    );

    await persistProviderInputItemsForMessage(
      params.replyToMessageId,
      preparedRequest.providerInputItemsByMessageId[params.replyToMessageId],
    );

    return {
      allowedToolIds,
      showToolTraces,
      messagesForRequest: compactedRequest.messages,
      executionContext: preparedRequest.executionContext,
      fileToolContext,
      internalAgentProfile,
      enableWebSearch,
      enableWebFetch,
      webSearchOptions,
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
    assistantMessageId: string,
    error: unknown,
    options?: { setSendState?: boolean },
  ) => {
    const normalized = toServiceError(error);
    set((state) => ({
      ...removeEmptyAssistantPlaceholderFromState(state, assistantMessageId),
      ...buildConversationRuntimePatch(state, conversationId, {
        phase: "error",
        sessionId,
        assistantMessageId: null,
        abortController: null,
        lastError: normalized.message,
        lastErrorOrigin: "macro",
        lastErrorDisplayTarget: "composer",
      }),
      lastError: normalized.message,
      ...(options?.setSendState ? { sendState: "error" as const } : {}),
    }));
    return normalized;
  };

  const replaceUserMessagePresentationLocally = (params: {
    messageId: string;
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

    if (!tauriIpc.isTauriAvailable()) {
      if (params.replaceStructuredFields) {
        replaceUserMessagePresentationLocally({
          messageId: params.messageId,
          content: params.content,
          hiddenContext: nextHiddenContext,
          providerInputItems: nextProviderInputItems,
        });
      } else {
        get().updateMessageContent(params.messageId, params.content);
      }
      return;
    }

    try {
      await tauriIpc.updateMessage(params.messageId, params.content, {
        toolTraces: currentMessage.tool_traces,
        hiddenContext: nextHiddenContext,
        providerInputItems: nextProviderInputItems,
        providerTurnState: currentMessage.provider_turn_state,
      });
      if (params.replaceStructuredFields) {
        replaceUserMessagePresentationLocally({
          messageId: params.messageId,
          content: params.content,
          hiddenContext: nextHiddenContext,
          providerInputItems: nextProviderInputItems,
        });
      } else {
        get().updateMessageContent(params.messageId, params.content);
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
  }) => {
    if (tauriIpc.isTauriAvailable()) {
      try {
        await tauriIpc.deleteMessagesAfter(
          params.conversationId,
          params.messageId,
        );
      } catch (error) {
        const normalized = toServiceError(error);
        set({ lastError: normalized.message, sendState: "error" });
        throw buildSendError(
          `Failed to trim the conversation before retrying: ${normalized.message}`,
        );
      }
    }

    set((current) => {
      const currentMessages = params.updatedMessage
        ? current.messages.map((message) =>
            message.id === params.updatedMessage!.id
              ? params.updatedMessage!
              : message,
          )
        : current.messages;
      const conversationMessages = currentMessages
        .filter(
          (message) => message.conversation_id === params.conversationId,
        )
        .sort(
          (a, b) =>
            new Date(a.timestamp).getTime() -
            new Date(b.timestamp).getTime(),
        );

      const targetIndex = conversationMessages.findIndex(
        (message) => message.id === params.messageId,
      );
      if (targetIndex === -1) {
        return current;
      }

      const allowedIds = new Set(
        conversationMessages
          .slice(0, targetIndex + 1)
          .map((message) => message.id),
      );

      const trimmedMessages = currentMessages.filter((message) =>
        message.conversation_id === params.conversationId
          ? allowedIds.has(message.id)
          : true,
      );

      const conversationMeta = recalcConversation(
        params.conversationId,
        trimmedMessages,
      );

      const conversations = current.conversations.map((conv) =>
        conv.id === params.conversationId
          ? { ...conv, ...conversationMeta }
          : conv,
      );

      const keptConversationMessageIds = new Set(
        trimmedMessages
          .filter(
            (message) => message.conversation_id === params.conversationId,
          )
          .map((message) => message.id),
      );
      const nextImages = { ...current.messageImagesByMessageId };
      Object.keys(nextImages).forEach((messageIdKey) => {
        const message = trimmedMessages.find((m) => m.id === messageIdKey);
        if (
          !message ||
          (message.conversation_id === params.conversationId &&
            !keptConversationMessageIds.has(messageIdKey))
        ) {
          delete nextImages[messageIdKey];
        }
      });
      saveMessageImagesToStorage(nextImages);

      const nextQuestionnaireDrafts = params.clearQuestionnaireSession
        ? clearQuestionnaireDraftsForConversations(
            current.questionnaireDraftsByConversationId,
            [params.conversationId],
          )
        : current.questionnaireDraftsByConversationId;
      if (params.clearQuestionnaireSession) {
        saveQuestionnaireDraftsToStorage(nextQuestionnaireDrafts);
      }

      return {
        ...buildMessageState(trimmedMessages),
        conversations,
        messageImagesByMessageId: nextImages,
        questionnaireDraftsByConversationId: nextQuestionnaireDrafts,
        lastError: null,
      };
    });

    const keptConversationMessageIds = get()
      .messages.filter(
        (message) => message.conversation_id === params.conversationId,
      )
      .map((message) => message.id);
    useCitationsStore
      .getState()
      .pruneConversationSourceCitations(
        params.conversationId,
        keptConversationMessageIds,
      );

    const currentOrderedMessages = getOrderedConversationMessages(
      params.conversationId,
    );
    const existingCompactionState = await getConversationCompactionState(
      params.conversationId,
    );
    if (
      invalidateCompactionFromMessage(
        existingCompactionState,
        currentOrderedMessages,
        params.messageId,
      )
    ) {
      await deleteConversationCompactionState(params.conversationId);
    }
  };

  const restartAssistantFromEditedMessage = async (params: {
    sessionId: string;
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
    manualFeatureDraftRecovery?: ManualFeatureDraftRecovery | null;
  }) => {
    const assistantMessage: ChatMessage = {
      id: `msg-${Date.now()}-assistant`,
      task_id: params.taskId,
      conversation_id: params.conversationId,
      role: "assistant",
      content: "",
      tool_traces: [],
      timestamp: new Date().toISOString(),
    };

    get().addMessage(assistantMessage);
    setConversationRuntime(
      params.conversationId,
      {
        phase: "preparing",
        sessionId: params.sessionId,
        assistantMessageId: assistantMessage.id,
        abortController: null,
        lastError: null,
      },
      { globalLastError: null },
    );

    try {
      const streamLaunch = await prepareAssistantStreamLaunch({
        conversationId: params.conversationId,
        replyToMessageId: params.messageId,
        userContent: params.userContent,
        resolvedTaskId: params.taskId ?? "",
        modeAtSend: params.modeAtSend,
        providerId: params.providerId,
        modelId: params.modelId,
        reasoningEffort: params.reasoningEffort,
        providerConfig: params.providerConfig,
      });

      startAssistantStream({
        sessionId: params.sessionId,
        assistantMessage,
        conversationId: params.conversationId,
        replyToMessageId: params.messageId,
        userContent: params.userContent,
        modeAtSend: params.modeAtSend,
        resolvedTaskId: params.taskId ?? "",
        selectedProviderId: params.providerId,
        selectedModelId: params.modelId,
        selectedReasoningEffort: params.reasoningEffort,
        providerConfig: params.providerConfig,
        internalAgentProfile: streamLaunch.internalAgentProfile,
        messagesForRequest: streamLaunch.messagesForRequest,
        executionContext: streamLaunch.executionContext,
        fileToolContext: streamLaunch.fileToolContext,
        allowedToolIds: streamLaunch.allowedToolIds,
        guidedToolRetry: streamLaunch.guidedToolRetry,
        showToolTraces: streamLaunch.showToolTraces,
        enableWebSearch: streamLaunch.enableWebSearch,
        enableWebFetch: streamLaunch.enableWebFetch,
        webSearchOptions: streamLaunch.webSearchOptions,
        maxTurns: streamLaunch.maxTurns,
        compactionDecision: streamLaunch.compactionDecision,
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
        assistantMessage.id,
        error,
      );
    }
  };

  const refreshBackgroundCompaction = async (params: {
    conversationId: string;
    providerId: string;
    modelId: string;
    reasoningEffort?: ReasoningEffort | null;
    providerConfig: NonNullable<
      ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
    >;
    allowedToolIds: string[];
    internalAgentProfile?: InternalAgentProfile | null;
  }) => {
    try {
      const preparedRequest = await prepareMessagesForRequest(
        params.conversationId,
        params.allowedToolIds,
        params.internalAgentProfile,
      );
      await compactConversationMessages({
        conversationId: params.conversationId,
        providerId: params.providerId,
        modelId: params.modelId,
        reasoningEffort: params.reasoningEffort,
        providerConfig: params.providerConfig,
        allowedToolIds: params.allowedToolIds,
        systemMessage: preparedRequest.systemMessage,
        preparedMessages: preparedRequest.preparedMessages,
        orderedMessages: preparedRequest.orderedMessages,
        citations: preparedRequest.citations,
        mode: "background",
      });
    } catch (error) {
      devLogger.info(
        `Background compaction failed for conversation=${params.conversationId}: ${toServiceError(error).message}`,
      );
    }
  };

  const compactConversationNow = async (conversationId: string): Promise<void> => {
    if (!conversationId) {
      return;
    }
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
      });

      if (!result.compactionState) {
        setConversationCompactionStatus(conversationId, {
          ...previousCompactionStatus,
          phase: result.footprintAfter.isHardStop ? "too_large" : "compacted",
          updatedAt: new Date().toISOString(),
          reason: result.footprintAfter.reason,
          kind: "manual",
          footprintAfter: result.footprintAfter,
        });
      }
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
    }
  };

  const refreshConversationContextDiagnostics = async (
    conversationId: string,
  ): Promise<void> => {
    if (!conversationId) {
      return;
    }

    const requestId =
      (contextDiagnosticsRequestIds.get(conversationId) ?? 0) + 1;
    contextDiagnosticsRequestIds.set(conversationId, requestId);

    set((state) => {
      const previous = state.contextDiagnosticsByConversationId[conversationId];
      return {
        contextDiagnosticsByConversationId: {
          ...state.contextDiagnosticsByConversationId,
          [conversationId]: {
            status: "estimating",
            conversationId,
            updatedAt: new Date().toISOString(),
            providerId: previous?.providerId,
            providerType: previous?.providerType,
            modelId: previous?.modelId,
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

    const isStale = () =>
      contextDiagnosticsRequestIds.get(conversationId) !== requestId;

    try {
      await ensureMessagesLoadedForConversation(conversationId);
      await ensureToolsLoaded();

      const providerState = useProviderStore.getState();
      const {
        selectedProviderId,
        selectedModelId,
        providerConfigs,
      } = providerState;
      if (!selectedProviderId || !selectedModelId) {
        throw buildSendError("Select a provider and model to inspect context.");
      }

      const providerConfig = providerConfigs.find(
        (provider) => provider.id === selectedProviderId,
      );
      if (!providerConfig) {
        throw buildSendError("Provider configuration not found.");
      }

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
      const modelContextWindowTokens = getSelectedModelContextWindowTokens(
        selectedProviderId,
        selectedModelId,
        providerConfig.providerType,
      );
      const budgetPolicy = await loadContextBudgetPolicy();

      const result = await buildCompactedMessagesForRequest({
        systemMessage: preparedRequest.systemMessage,
        preparedMessages: preparedRequest.preparedMessages,
        orderedMessages: preparedRequest.orderedMessages,
        citations: preparedRequest.citations,
        toolDefinitions,
        modelContextWindowTokens,
        currentCompactionState,
        estimateSerializedPayloadTokens: (messages) =>
          estimateChatCompletionSerializedPayloadTokens({
            messages,
            providerType: providerConfig.providerType,
            providerId: selectedProviderId,
            baseUrl: providerConfig.baseUrl,
            modelId: selectedModelId,
          }),
        mode: "blocking",
        budgetPolicy,
        generateSummary: async () =>
          currentCompactionState?.summaryText ?? null,
      });

      if (isStale()) {
        return;
      }

      const runtime = getConversationRuntimeSnapshot(
        get().conversationRuntimeById,
        conversationId,
      );
      const isProviderError =
        runtime.lastErrorOrigin === "provider" ||
        runtime.lastErrorDisplayTarget === "transcript";
      const phase: ConversationContextDiagnostics["phase"] = isProviderError
        ? "provider_error"
        : result.footprintAfter.isHardStop
          ? "too_large"
          : result.degraded
            ? "degraded"
            : result.compactionState
              ? "compacted"
              : "idle";

      const diagnostics = buildContextDiagnosticsFromFootprint({
        conversationId,
        providerId: selectedProviderId,
        providerType: providerConfig.providerType,
        modelId: selectedModelId,
        status: "ready",
        phase,
        decision: result.decision,
        compactionPass: result.compactionState?.compactionPass,
        summaryFormatVersion:
          (result.compactionState ?? currentCompactionState)?.summaryFormatVersion,
        summarySource:
          (result.compactionState ?? currentCompactionState)?.summarySource,
        footprintBefore: result.footprintBefore,
        footprintAfter: result.footprintAfter,
        orderedMessages: preparedRequest.orderedMessages,
        preparedMessages: result.messages.slice(1),
        citations: preparedRequest.citations,
        compactionState: result.compactionState ?? currentCompactionState,
      });

      set((state) => ({
        contextDiagnosticsByConversationId: {
          ...state.contextDiagnosticsByConversationId,
          [conversationId]: diagnostics,
        },
      }));
    } catch (error) {
      if (isStale()) {
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
        phase: "too_large",
        orderedMessages,
        preparedMessages: [],
        citations: [],
        error: normalized.message,
      });
      set((state) => ({
        contextDiagnosticsByConversationId: {
          ...state.contextDiagnosticsByConversationId,
          [conversationId]: diagnostics,
        },
      }));
    }
  };

  const startAssistantStream = (params: {
    sessionId: string;
    assistantMessage: ChatMessage;
    conversationId: string;
    replyToMessageId: string;
    userContent: string;
    modeAtSend: AppMode;
    resolvedTaskId: string;
    selectedProviderId: string;
    selectedModelId: string;
    selectedReasoningEffort?: ReasoningEffort | null;
    providerConfig: NonNullable<
      ReturnType<typeof useProviderStore.getState>["providerConfigs"][number]
    >;
    internalAgentProfile?: InternalAgentProfile | null;
    messagesForRequest: StreamMessage[];
    executionContext: {
      workspacePath: string | null;
      defaultWorkspacePath: string | null;
      projectMounts: ReturnType<
        typeof resolveProjectExecutionContext
      >["projectMounts"];
      virtualRootEnabled: boolean;
      focusedProjectId: string | null;
    };
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
    maxTurns: ChatMaxTurnsPreference;
    compactionDecision?: ContextCompactionDecision;
    overflowRecoveryAttempted?: boolean;
  }) => {
    const abortController = new AbortController();
    setConversationRuntime(
      params.conversationId,
      {
        phase: "streaming",
        sessionId: params.sessionId,
        assistantMessageId: params.assistantMessage.id,
        abortController,
        lastError: null,
      },
      { globalLastError: null },
    );
    const tokenBatcher = createTokenBatcher((tokenChunk) => {
      get().appendToMessage(params.assistantMessage.id, tokenChunk);
    });

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

    const tryRecoverFromOverflow = async (error: Error): Promise<boolean> => {
      if (
        params.overflowRecoveryAttempted ||
        abortController.signal.aborted ||
        !isProviderContextOverflowError(error)
      ) {
        return false;
      }

      tokenBatcher.flushNow();
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

      tokenBatcher.dispose();
      setConversationCompactionStatus(params.conversationId, {
        phase: "overflow_recovery",
        updatedAt: new Date().toISOString(),
        kind: "overflow_recovery",
        recoveredFromOverflow: true,
      });
      const initialPayloadTokens = estimateChatCompletionSerializedPayloadTokens({
        messages: params.messagesForRequest,
        providerType: params.providerConfig.providerType,
        providerId: params.selectedProviderId,
        baseUrl: params.providerConfig.baseUrl,
        modelId: params.selectedModelId,
      });
      updateConversationRuntimeIfSessionMatches(
        params.conversationId,
        params.sessionId,
        () => ({
          phase: "overflow_recovery",
          sessionId: params.sessionId,
          assistantMessageId: params.assistantMessage.id,
          abortController: null,
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
          compactionMode: "overflow_recovery",
          forceCompaction: true,
          forcePrune: true,
        });
        const recoveredPayloadTokens = estimateChatCompletionSerializedPayloadTokens({
          messages: streamLaunch.messagesForRequest,
          providerType: params.providerConfig.providerType,
          providerId: params.selectedProviderId,
          baseUrl: params.providerConfig.baseUrl,
          modelId: params.selectedModelId,
        });
        if (recoveredPayloadTokens >= initialPayloadTokens) {
          throw new Error(
            `${OVERFLOW_RECOVERY_FAILURE_MESSAGE} Payload estimate did not shrink after forced compaction ` +
              `(${recoveredPayloadTokens} tokens after, ${initialPayloadTokens} tokens before).`,
          );
        }

        const currentStatus =
          get().conversationCompactionStatusById[params.conversationId];
        setConversationCompactionStatus(params.conversationId, {
          ...currentStatus,
          phase: "compacted",
          updatedAt: new Date().toISOString(),
          kind: "overflow_recovery",
          recoveredFromOverflow: true,
        });

        startAssistantStream({
          ...params,
          messagesForRequest: streamLaunch.messagesForRequest,
          executionContext: streamLaunch.executionContext,
          fileToolContext: streamLaunch.fileToolContext,
          allowedToolIds: streamLaunch.allowedToolIds,
          guidedToolRetry: streamLaunch.guidedToolRetry,
          showToolTraces: streamLaunch.showToolTraces,
          enableWebSearch: streamLaunch.enableWebSearch,
          enableWebFetch: streamLaunch.enableWebFetch,
          webSearchOptions: streamLaunch.webSearchOptions,
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
          kind: "overflow_recovery",
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
        return true;
      }
    };

    const handleAssistantStreamError = async (error: Error) => {
      if (await tryRecoverFromOverflow(error)) {
        return;
      }

      tokenBatcher.flushNow();
      tokenBatcher.dispose();
      await maybeMarkImplementTaskFailedAfterStreamError();

      const assistantMessage = get().messages.find(
        (message) => message.id === params.assistantMessage.id,
      );
      const hasPartialAssistantProgress = Boolean(
        assistantMessage &&
          (assistantMessage.content.trim().length > 0 ||
            (assistantMessage.tool_traces?.length ?? 0) > 0),
      );
      const errorPresentation = resolveChatErrorPresentation(error, {
        providerId: params.selectedProviderId,
        providerType: params.providerConfig.providerType,
        modelId: params.selectedModelId,
      });

      if (errorPresentation.displayTarget === "transcript") {
        const providerErrorMarkdown =
          buildProviderErrorTranscriptMarkdown(errorPresentation);
        const nextAssistantContent = hasPartialAssistantProgress && assistantMessage
          ? `${assistantMessage.content.trimEnd()}\n\n---\n\n${providerErrorMarkdown}`
          : providerErrorMarkdown;
        get().updateMessageContent(
          params.assistantMessage.id,
          nextAssistantContent,
        );
        const updatedAssistantMessage = get().messages.find(
          (message) => message.id === params.assistantMessage.id,
        );
        if (updatedAssistantMessage) {
          try {
            await persistAssistantPartialStreamResult(
              params.conversationId,
              updatedAssistantMessage,
            );
          } catch (persistError) {
            console.warn(
              "Failed to persist provider error after stream error:",
              persistError,
            );
          }
        }
      } else if (hasPartialAssistantProgress && assistantMessage) {
        try {
          await persistAssistantPartialStreamResult(
            params.conversationId,
            assistantMessage,
          );
        } catch (persistError) {
          console.warn(
            "Failed to persist partial assistant response after stream error:",
            persistError,
          );
        }
      } else {
        set((state) => removeEmptyAssistantPlaceholderFromState(
          state,
          params.assistantMessage.id,
        ));
      }

      updateConversationRuntimeIfSessionMatches(
        params.conversationId,
        params.sessionId,
        () => ({
          phase: "error",
          sessionId: params.sessionId,
          assistantMessageId:
            errorPresentation.displayTarget === "composer" &&
            !hasPartialAssistantProgress
              ? null
              : params.assistantMessage.id,
          abortController: null,
          lastError: errorPresentation.message,
          lastErrorOrigin: errorPresentation.origin,
          lastErrorDisplayTarget: errorPresentation.displayTarget,
        }),
      );
      set(
        errorPresentation.displayTarget === "composer"
          ? { lastError: errorPresentation.message, sendState: "error" }
          : { sendState: "error" },
      );
    };

    void (async () => {
      try {
        await streamChat({
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
          maxTurns: params.maxTurns,
          sessionId: params.sessionId,
          signal: abortController.signal,
          onToken: (token) => {
            tokenBatcher.push(token);
          },
          onToolTracesUpdate: (toolTraces: ToolTrace[]) => {
            get().updateMessageFields(params.assistantMessage.id, {
              tool_traces: toolTraces,
            });
          },
          onComplete: (result) => {
            tokenBatcher.flushNow();
            applyStreamCompletion(params.assistantMessage.id, result);
            useProviderStore
              .getState()
              .markProviderReachable(params.selectedProviderId, { modelId: params.selectedModelId });

            const taskAfterStream = params.resolvedTaskId
              ? useTaskStore.getState().getTaskById(params.resolvedTaskId)
              : undefined;
            const shouldMarkTaskAwaitingResponse =
              params.modeAtSend === "Implement" &&
              params.resolvedTaskId &&
              taskAfterStream &&
              taskAfterStream.status !== "Completed" &&
              taskAfterStream.status !== "Failed" &&
              assistantTurnRequiresUserReply(
                result.visibleContent,
                result.hiddenContext,
              );

            if (shouldMarkTaskAwaitingResponse) {
              void useTaskStore
                .getState()
                .markTaskAwaitingResponse(params.resolvedTaskId);
            }

            set((state) => ({
              conversations: state.conversations.map((conv) =>
                conv.id === params.conversationId
                  ? {
                      ...conv,
                      last_message:
                        result.visibleContent.slice(0, 100) +
                        (result.visibleContent.length > 100 ? "..." : ""),
                      updated_at: new Date().toISOString(),
                    }
                  : conv,
              ),
            }));
            updateConversationRuntimeIfSessionMatches(
              params.conversationId,
              params.sessionId,
              () => null,
            );

            void persistAssistantStreamResult(params.conversationId, result).catch(
              (error) => {
                const normalized = toServiceError(error);
                setConversationRuntime(
                  params.conversationId,
                  {
                    phase: "error",
                    sessionId: params.sessionId,
                    assistantMessageId: params.assistantMessage.id,
                    abortController: null,
                    lastError: normalized.message,
                  },
                  { globalLastError: normalized.message },
                );
                set({ sendState: "error" });
              },
            );
            void refreshBackgroundCompaction({
              conversationId: params.conversationId,
              providerId: params.selectedProviderId,
              modelId: params.selectedModelId,
              reasoningEffort: params.selectedReasoningEffort,
              providerConfig: params.providerConfig,
              allowedToolIds: params.allowedToolIds,
              internalAgentProfile: params.internalAgentProfile,
            });
            void syncMacroMetadataAfterStreamService({
              mode: params.modeAtSend,
              conversationId: params.conversationId,
              trigger: "send",
            });
            tokenBatcher.dispose();
          },
          onError: (error) => {
            void (async () => {
              await handleAssistantStreamError(error);
            })();
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
            return handleToolCall(
              params.conversationId,
              params.assistantMessage.id,
              toolName,
              args,
              toolCallId,
            );
          },
        });
      } catch (error) {
        const normalized = toServiceError(error);
        await handleAssistantStreamError(
          error instanceof Error ? error : new Error(normalized.message),
        );
      }
    })();
  };

  const persistAssistantPartialStreamResult = async (
    conversationId: string,
    assistantMessage: ChatMessage,
  ) => {
    if (!tauriIpc.isTauriAvailable()) return;
    if (
      assistantMessage.content.trim().length === 0 &&
      (assistantMessage.tool_traces?.length ?? 0) === 0
    ) {
      return;
    }

    await tauriIpc.createMessage(
      conversationId,
      "assistant",
      assistantMessage.content,
      {
        toolTraces: assistantMessage.tool_traces,
        hiddenContext: assistantMessage.hidden_context,
      },
    );
  };

  const persistAssistantStreamResult = async (
    conversationId: string,
    result: StreamCompletionResult,
  ) => {
    if (!tauriIpc.isTauriAvailable()) return;
    const persistedToolTraces =
      get()
        .getConversationMessages(conversationId)
        .filter((message) => message.role === "assistant")
        .at(-1)?.tool_traces ?? result.toolTraces;
    try {
      await tauriIpc.createMessage(
        conversationId,
        "assistant",
        result.visibleContent,
        {
          toolTraces: persistedToolTraces,
          hiddenContext: result.hiddenContext,
          providerInputItems: result.providerInputItems,
          providerTurnState: result.providerTurnState,
        },
      );
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
        projectGroups: appState.projectGroups,
        selectedGroupId: appState.selectedGroupId,
        selectedProjectId: appState.selectedProjectId,
        localContext: null,
      });
      if (resolvedTask?.id === conversation.task_id) {
        appState.setSelectedTask(conversation.task_id);
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
        needCount: payload.needs.length,
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
        });
        newConversation = mapDbConversationToConversation(dbConversation);
      } catch (error) {
        console.error("Failed to create conversation in DB:", error);
        newConversation = {
          id: `conv-${Date.now()}`,
          title: resolvedTitle,
          description: "",
          scope_mode: mode,
          task_id: resolvedTaskId,
          group_id: resolvedGroupId,
          project_id: resolvedProjectId,
          last_message: "",
          message_count: 0,
          updated_at: new Date().toISOString(),
          is_unread: true,
        };
      }
    } else {
      newConversation = {
        id: `conv-${Date.now()}`,
        title: resolvedTitle,
        description: "",
        scope_mode: mode,
        task_id: resolvedTaskId,
        group_id: resolvedGroupId,
        project_id: resolvedProjectId,
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
    const conversation: Conversation = {
      id,
      title: params.title,
      description: "",
      scope_mode: "Architect",
      task_id: null,
      group_id: params.fallbackGroupId,
      project_id: params.fallbackProjectId,
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
    let restoredTranscript = false;

    if (!conversation) {
      conversation = await createConversationRecord({
        title: getArchitectPlanConversationTitle(plan),
        taskId: null,
        projectId: fallbackProjectId ?? null,
        groupId: fallbackGroupId ?? null,
        selectConversation: false,
      });
      createdConversation = true;
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
      } catch {
        // Keep local conversation even if metadata cannot be rewritten right now.
      }
    }

    return {
      conversationId: conversation.id,
      restoredTranscript,
      createdConversation,
    };
  };

  const hydrateChatSnapshot = async (): Promise<void> => {
    conversationCompactionStateCache.clear();
    messageLoadPromisesByConversationId.clear();
    let conversations: Conversation[] = [];
    let messages: ChatMessage[] = [];

    if (tauriIpc.isTauriAvailable()) {
      try {
        const snapshot = await tauriIpc.getChatBootstrapSnapshot();
        conversations = snapshot.conversations.map(
          mapDbConversationToConversation,
        );
        const conversationById = new Map(
          conversations.map((conversation) => [conversation.id, conversation]),
        );
        messages = Object.values(snapshot.messages_by_conversation_id)
          .flatMap((items) => items ?? [])
          .map((message) => mapDbMessageToChatMessage(message, conversationById));
      } catch (bootstrapError) {
        console.warn(
          "Falling back to conversation-only chat hydration path:",
          bootstrapError,
        );
        const dbConversations = await tauriIpc.listConversations();
        conversations = dbConversations.map(mapDbConversationToConversation);
      }
    }

    pruneConversationSelections(conversations);

    const loadedImages = loadMessageImagesFromStorage();
    const loadedConversationIds = new Set(
      messages.map((message) => message.conversation_id),
    );

    set({
      conversations,
      ...buildMessageState(messages),
      messageLoadStatusByConversationId: Object.fromEntries(
        Array.from(loadedConversationIds).map((conversationId) => [
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
      contextDiagnosticsByConversationId: {},
      isLoading: false,
      isStreaming: false,
      sendState: "idle",
      lastError: null,
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
              summaryHint:
                architectPlanSwitch.targetPlanId ===
                appState.activeArchitectPlanId
                  ? architectPlanSwitch.summaryHint
                  : null,
              scopedProjectIdsHint:
                architectPlanSwitch.targetPlanId ===
                appState.activeArchitectPlanId
                  ? architectPlanSwitch.summaryHint
                    ? getArchitectPlanVisibleProjectIds(architectPlanSwitch.summaryHint)
                    : undefined
                  : undefined,
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
    const rememberedConversation = rememberedId
      ? state.conversations.find(
          (conversation) => conversation.id === rememberedId,
        )
      : null;

    if (
      rememberedConversation &&
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
    contextDiagnosticsByConversationId: {},
    isLoading: false,
    isStreaming: false,
    sendState: "idle",
    lastError: null,
    abortController: null,
    messageImagesByMessageId: {},
    questionnaireDraftsByConversationId: loadQuestionnaireDraftsFromStorage(),
    pendingToolApprovalByConversationId: {},
    conversationApprovalGrantsByConversationId: {},
    architectPlanNamingRecovery: null,
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
      Object.keys(get().conversationRuntimeById).forEach((conversationId) => {
        stopConversationRuntimeLocally(conversationId);
      });
      set({
        ...buildMessageState([]),
        messageLoadStatusByConversationId: {},
        conversationRuntimeById: {},
        conversationCompactionStatusById: {},
        contextDiagnosticsByConversationId: {},
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
          await resolveConversationMetadataProviderContext({
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

    addComposerContextRef: (ref) =>
      set((state) => {
        const exists = state.composerContextRefs.some(
          (r) => r.id === ref.id && r.kind === ref.kind,
        );
        if (exists) return state;
        return { composerContextRefs: [...state.composerContextRefs, ref] };
      }),

    removeComposerContextRef: (id, kind) =>
      set((state) => ({
        composerContextRefs: state.composerContextRefs.filter(
          (r) => !(r.id === id && r.kind === kind),
        ),
      })),

    clearComposerContextRefs: () => set({ composerContextRefs: [] }),

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
      await getConversationCompactionState(conversationId);
      await runAiSelectionRestore({
        mode,
        conversationId,
        activeContextKey: get().activeContextKey,
        shouldShowResolving: true,
      });
      return true;
    },

    createConversation: async (title, taskId, projectId, groupId) =>
      createConversationRecord({
        title,
        taskId,
        projectId,
        groupId,
      }),

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
          projectGroups: appState.projectGroups,
          selectedGroupId: appState.selectedGroupId,
          selectedProjectId: appState.selectedProjectId,
          localContext,
        });
        if (resolvedTask && appState.selectedTaskId !== resolvedTask.id) {
          appState.setSelectedTask(resolvedTask.id);
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
      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.renameConversation(conversationId, title);
      }
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, title } : conv,
        ),
      }));
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
        await useTaskStore.getState().deleteManualFeatureDraft(linkedTask.id);
      }

      stopConversationRuntimeLocally(conversationId);
      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.deleteConversation(conversationId);
      }
      conversationCompactionStateCache.delete(conversationId);
      removeConversationSelectionData(conversationId);
      applyLocalConversationRemoval([conversationId]);
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

      const snapshot = buildConversationRemovalSnapshot();
      uniqueIds.forEach((conversationId) => {
        stopConversationRuntimeLocally(conversationId);
      });
      applyLocalConversationRemoval(uniqueIds);

      try {
        if (tauriIpc.isTauriAvailable()) {
          await tauriIpc.deleteConversations(uniqueIds);
        }
        uniqueIds.forEach((conversationId) => {
          conversationCompactionStateCache.delete(conversationId);
          removeConversationSelectionData(conversationId);
        });
      } catch (error) {
        restoreConversationRemovalSnapshot(snapshot);
        throw error;
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

    refreshConversationContextDiagnostics: (conversationId) =>
      refreshConversationContextDiagnostics(conversationId),

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
      let activeSessionId: string | null = null;
      let assistantMessageId: string | null = null;
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
        emitSendTimeline("send_requested", { conversationId });
        setConversationRuntime(
          conversationId,
          {
            phase: "preparing",
            sessionId: activeSessionId,
            assistantMessageId: null,
            abortController: null,
            lastError: null,
          },
          { globalLastError: null },
        );
        await ensureMessagesLoadedForConversation(conversationId);
        emitSendTimeline("messages_ready", { conversationId });
        const previousConversationId = conversationId;
        const hasPendingArchitectConversation =
          pendingArchitectConversationDetailsById.has(conversationId);
        if (hasPendingArchitectConversation) {
          conversationId =
            await materializePendingArchitectConversationIfNeeded(conversationId);
        }
        if (hasPendingArchitectConversation && conversationId !== previousConversationId) {
          setConversationRuntime(previousConversationId, null);
          setConversationRuntime(
            conversationId,
            {
              phase: "preparing",
              sessionId: activeSessionId,
              assistantMessageId: null,
              abortController: null,
              lastError: null,
            },
            { globalLastError: null },
          );
        }
        const providerState = useProviderStore.getState();
        const {
          selectedProviderId,
          selectedModelId,
          selectedReasoningEffort,
          providerConfigs,
        } = providerState;
        const modeAtSend = useAppStore.getState().mode;
        persistSelectionForContext(modeAtSend, conversationId);

        if (providerState.isLoading) {
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
            : await providerState.resolveProviderApiKey(selectedProviderId);
        const providerConfigForUse = {
          ...providerConfig,
          apiKey: resolvedApiKey,
          apiKeyLoaded:
            providerConfig.apiKeyLoaded || resolvedApiKey !== undefined,
        };

        const conversationTaskId =
          get().conversations.find(
            (conversation) => conversation.id === conversationId,
          )?.task_id ?? null;
        const selectedTaskIdForMode =
          modeAtSend === "Implement"
            ? (useAppStore.getState().selectedTaskId ?? "")
            : "";
        const resolvedTaskId =
          modeAtSend === "Chat"
            ? ""
            : (taskId ?? conversationTaskId ?? selectedTaskIdForMode);
        let taskForSend = resolvedTaskId
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
            finalizedManualFeatureDraft = manualFeatureDraftRecovery !== null;
          }

          taskForSend =
            (await assertImplementTaskReadyForSend(resolvedTaskId)) ??
            taskForSend;
        }

        const userMessageCountBeforeSend = getOrderedConversationMessages(
          conversationId,
        ).filter((message) => message.role === "user").length;

        const userMessage = await buildUserMessageForSend({
          conversationId,
          taskId: resolvedTaskId,
          content,
          hiddenContext,
          providerInputItems,
        });

        get().addMessage(userMessage);
        if (images && images.length > 0) {
          get().setMessageImages(userMessage.id, images);
        }
        get().clearComposerContextRefs();

        if (userMessageCountBeforeSend === 0 && !finalizedManualFeatureDraft) {
          const appState = useAppStore.getState();
          let skipMetadataGeneration = false;
          let architectPlan =
            modeAtSend === "Architect" && appState.activeArchitectPlanId
              ? {
                  planId: appState.activeArchitectPlanId,
                  targetBranch: resolveTargetBranch(
                    appState.activePlanContext?.targetBranch,
                  ),
                }
              : undefined;
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

        const assistantMessage: ChatMessage = {
          id: `msg-${Date.now()}-assistant`,
          task_id: resolvedTaskId,
          conversation_id: conversationId,
          role: "assistant",
          content: "",
          tool_traces: [],
          timestamp: new Date().toISOString(),
        };
        assistantMessageId = assistantMessage.id;

        get().addMessage(assistantMessage);
        setConversationRuntime(
          conversationId,
          {
            phase: "preparing",
            sessionId: activeSessionId,
            assistantMessageId: assistantMessage.id,
            abortController: null,
            lastError: null,
          },
          { globalLastError: null },
        );

        try {
          const streamLaunch = await prepareAssistantStreamLaunch({
            conversationId,
            replyToMessageId: userMessage.id,
            userContent: content,
            resolvedTaskId,
            modeAtSend,
            providerId: selectedProviderId,
            modelId: selectedModelId,
            reasoningEffort: selectedReasoningEffort,
            providerConfig: providerConfigForUse,
            internalAgentProfile,
          });
          emitSendTimeline("compaction_done", {
            conversationId,
            providerId: selectedProviderId,
            providerType: providerConfigForUse.providerType,
          });

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
            resolvedTaskId,
            selectedProviderId,
            selectedModelId,
            selectedReasoningEffort,
            providerConfig: providerConfigForUse,
            internalAgentProfile: streamLaunch.internalAgentProfile,
            messagesForRequest: streamLaunch.messagesForRequest,
            executionContext: streamLaunch.executionContext,
            fileToolContext: streamLaunch.fileToolContext,
            allowedToolIds: streamLaunch.allowedToolIds,
            guidedToolRetry: streamLaunch.guidedToolRetry,
            showToolTraces: streamLaunch.showToolTraces,
            enableWebSearch: streamLaunch.enableWebSearch,
            enableWebFetch: streamLaunch.enableWebFetch,
            webSearchOptions: streamLaunch.webSearchOptions,
            maxTurns: streamLaunch.maxTurns,
            compactionDecision: streamLaunch.compactionDecision,
          });
        } catch (error) {
          if (manualFeatureDraftRecovery) {
            await rollbackManualFeatureDraftAfterFailedLaunch(
              manualFeatureDraftRecovery,
            );
          }
          applyAssistantLaunchError(
            conversationId,
            activeSessionId,
            assistantMessage.id,
            error,
            {
            setSendState: true,
            },
          );
        }

        return {
          status: "sent",
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
        };
      } catch (error) {
        const normalized = toServiceError(error);
        if (activeSessionId) {
          setConversationRuntime(
            conversationId,
            {
              phase: "error",
              sessionId: activeSessionId,
              assistantMessageId,
              abortController: null,
              lastError: normalized.message,
            },
            { globalLastError: normalized.message },
          );
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

    editMessage: async (messageId, newContent, options) => {
      const {
        selectedProviderId,
        selectedModelId,
        selectedReasoningEffort,
        providerConfigs,
      } = useProviderStore.getState();
      const modeAtEdit = useAppStore.getState().mode;
      if (!selectedProviderId || !selectedModelId) {
        set({
          lastError: "Select a provider and model before sending a message.",
        });
        return;
      }

      const providerConfig = providerConfigs.find(
        (p) => p.id === selectedProviderId,
      );
      if (!providerConfig) {
        set({ lastError: "Provider configuration not found." });
        return;
      }
      const resolvedApiKey =
        providerConfig.isLocal || providerHasAuthSession(providerConfig)
          ? providerConfig.apiKey
          : await useProviderStore
              .getState()
              .resolveProviderApiKey(selectedProviderId);
      const providerConfigForUse = {
        ...providerConfig,
        apiKey: resolvedApiKey,
        apiKeyLoaded:
          providerConfig.apiKeyLoaded || resolvedApiKey !== undefined,
      };

      const state = get();
      const target = state.messages.find((message) => message.id === messageId);
      if (!target) return;

      const conversationId = target.conversation_id;
      let manualFeatureDraftRecovery: ManualFeatureDraftRecovery | null = null;
      assertConversationRuntimeAvailableForSend(conversationId);
      if (modeAtEdit === "Implement" && target.task_id) {
        try {
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
          await assertImplementTaskReadyForSend(target.task_id);
        } catch (error) {
          const normalized = toServiceError(error);
          set({ lastError: normalized.message });
          return;
        }
      }

      await persistEditedUserMessage({
        messageId,
        content: newContent,
        hiddenContext: options?.hiddenContext,
        providerInputItems: options?.providerInputItems,
        replaceStructuredFields: options?.replaceStructuredFields,
      });
      const updatedTargetMessage =
        get().messages.find((message) => message.id === messageId) ?? target;

      await trimConversationAfterMessage({
        conversationId,
        messageId,
        clearQuestionnaireSession: options?.clearQuestionnaireSession,
        updatedMessage: updatedTargetMessage,
      });

      const sessionId = createConversationSessionId();
      setConversationRuntime(
        conversationId,
        {
          phase: "preparing",
          sessionId,
          assistantMessageId: null,
          abortController: null,
          lastError: null,
        },
        { globalLastError: null },
      );

      await restartAssistantFromEditedMessage({
        sessionId,
        messageId,
        conversationId,
        taskId: target.task_id ?? "",
        userContent: newContent,
        modeAtSend: modeAtEdit,
        providerId: selectedProviderId,
        modelId: selectedModelId,
        reasoningEffort: selectedReasoningEffort,
        providerConfig: providerConfigForUse,
        manualFeatureDraftRecovery,
      });
    },

    initializeCritical: async () => {
      Object.values(get().conversationRuntimeById).forEach((runtime) => {
        runtime?.abortController?.abort();
      });
      messageLoadPromisesByConversationId.clear();
      contextDiagnosticsRequestIds.clear();
      pendingArchitectConversationIdsByPlanKey.clear();
      pendingArchitectConversationDetailsById.clear();
      cancelStream();
      set({
        conversationRuntimeById: {},
        conversationCompactionStatusById: {},
        contextDiagnosticsByConversationId: {},
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
          contextDiagnosticsByConversationId: {},
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
