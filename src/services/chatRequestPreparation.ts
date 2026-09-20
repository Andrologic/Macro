import { ChatTurnSupersededError } from "./chatTurnRuntime";
import type {
  AgentType, AppMode, ChatMessage, ContextCompactionKind, ContextFootprint,
  ContextReference, MCPServer, MCPTool, PersistedContextReference,
  SkillPermissionSnapshot, SkillTurnFeedback, ToolRiskLevel,
} from "../types";
import type { Citation } from "../types/citation";
import type { MacroToolRegistryEntry } from "../shared/macroToolRegistry";
import type { AssistantStreamLaunch, PrepareAssistantStreamParams, StreamContextDiagnosticsBaselineSeed } from "./chatStreamContracts";
import type { StreamMessage } from "./streamingChat";
import type { CatalogedImplementTask } from "./implementTaskCatalog";
import type { InternalAgentProfile, resolveInternalAgentProfile, filterToolIdsForInternalAgentProfile } from "./internalAgentProfile";
import type { ProjectExecutionContext } from "./projectExecutionContext";
import type { RepositoryInstructionContext } from "./repositoryInstructions";
import type { ContextLimitFootprintFields } from "./modelContextLimits";
import type { loadScopedTurnConfiguration, applyScopedToolRestrictions } from "./configurationClient";
import type { resolveScopedMcpRuntime, ScopedMcpRuntimeFailure } from "./scopedMcpRuntime";
import type { getStreamingWebSearchConfig } from "./webSearchSettings";
import { normalizeChatMaxTurns, type ChatMaxTurnsPreference } from "./chatTurnLimits";
import { toServiceError } from "./contracts/errors";
import { selectInjectableMCPToolIds } from "./mcp/injection";
import { isMCPToolId } from "./mcpToolNames";
import { filterDeniedToolIdsForRiskLevel } from "./toolSecurityPolicy";
import {
  cloneStreamMessage, normalizeMessagesForProviderContext, shouldCountProviderInputItemsForContext,
} from "./chatStreamCompactionMessages";
import {
  buildContextTooLargeErrorMessage, buildManualCompactionRequiredErrorMessage,
  estimateConversationFootprint, isBlockableContextOverUsableBudget,
  isContextFootprintOverUsableBudget,
  type ContextBudgetPolicy, type MaybeCompactConversationResult,
} from "./contextCompaction";
import {
  buildAppliedCompactionAuditDetails, buildCompactionDecisionAuditMetadata,
  type CompactionRuntimeAdapters,
} from "./contextCompactionOrchestrator";
import { shouldProactivelyCompactContext } from "./contextCompactionPlanner";
import { getCompactionEventTrigger, type ConversationCompactionStatus } from "./contextCompactionSession";

export type PreparedAssistantStreamLaunch = Pick<AssistantStreamLaunch,
  "allowedToolIds" | "riskLevel" | "scopedTurnConfiguration" | "showToolTraces" |
  "messagesForRequest" | "contextDiagnosticsBaselineSeed" | "executionContext" |
  "fileToolContext" | "internalAgentProfile" | "enableWebSearch" | "enableWebFetch" |
  "webSearchOptions" | "mcpTools" | "mcpServers" | "skillToolIds" |
  "runnableSkillToolIds" | "guidedToolRetry" | "maxTurns" | "compactionDecision"
>;

/** Materialized context; skills and repository instructions belong to this request. */
export interface PreparedChatRequestContext {
  systemMessage: string;
  preparedMessages: StreamMessage[];
  orderedMessages: ChatMessage[];
  citations: Citation[];
  executionContext: ProjectExecutionContext;
  repositoryInstructionContext: RepositoryInstructionContext;
  skillPermissionSnapshot: SkillPermissionSnapshot | null;
  skillTurnFeedback: SkillTurnFeedback | null;
  persistableProviderInputItemsByMessageId: Record<string, unknown[] | undefined>;
}

export type PrepareChatRequestCompaction = Pick<PrepareAssistantStreamParams,
  "conversationId" | "providerId" | "modelId" | "reasoningEffort" | "providerConfig" |
  "forceCompaction" | "forcePrune"
> & Pick<PreparedChatRequestContext,
  "systemMessage" | "preparedMessages" | "orderedMessages" | "citations"
> & {
  allowedToolIds: string[];
  mode: ContextCompactionKind;
  displayAfterMessageId?: string | null;
};

/** Capabilities supplied by the composition layer, without exposing store state. */
export interface ChatRequestPreparationPorts {
  isCurrent(): boolean;
  tasks: { find(id: string): CatalogedImplementTask | undefined };
  policy: {
    resolveInternalAgentProfile: typeof resolveInternalAgentProfile;
    filterForInternalAgentProfile: typeof filterToolIdsForInternalAgentProfile;
  };
  tools: {
    ensureLoaded(): Promise<void>;
    loadStatus(): { lastError: string | null; hasInternalTools: boolean };
    /** Capture one registry version; read enabled tools only on the legacy path. */
    mcpSnapshot(): { servers: MCPServer[]; enabledTools(): MCPTool[] };
    allowedForMode(
      profile: InternalAgentProfile | null, mode: AppMode, agentType: AgentType | null | undefined,
      provider: { supportsNativeToolCalling: boolean; providerConfig: PrepareAssistantStreamParams["providerConfig"]; modelId: string },
      riskLevel: ToolRiskLevel, projectId: string | null,
    ): Promise<string[]>;
    filterForImplementTask(ids: string[], task: CatalogedImplementTask | undefined): string[];
    filterForArchitectPlan(ids: string[], context: ProjectExecutionContext): string[];
    resolveScopedMcp: typeof resolveScopedMcpRuntime;
    reportUnavailableMcpServers(failures: ScopedMcpRuntimeFailure[], description: string): void;
    definitions(ids: string[], mcpTools: readonly MCPTool[]): MacroToolRegistryEntry[];
    guidedRetry(params: {
      userContent: string;
      allowedToolIds: string[];
      supportsNativeToolCalling?: boolean;
      fileToolContext: AssistantStreamLaunch["fileToolContext"];
    }): AssistantStreamLaunch["guidedToolRetry"];
  };
  configuration: {
    loadScoped: typeof loadScopedTurnConfiguration;
    restrictTools: typeof applyScopedToolRestrictions;
    loadRiskLevel(): Promise<ToolRiskLevel>;
    loadMaxTurns(): Promise<ChatMaxTurnsPreference | undefined>;
    webSearch: typeof getStreamingWebSearchConfig;
  };
  skills: {
    createPermissionSnapshot(conversationId: string, turnId: string): SkillPermissionSnapshot;
    publishFeedback(replyToMessageId: string, feedback: SkillTurnFeedback | null): void;
    toolIdsForRequest(ids: string[], snapshot: SkillPermissionSnapshot | null): {
      skillToolIds: string[];
      runnableSkillToolIds: string[];
    };
  };
  context: {
    executionContext(conversationId: string): ProjectExecutionContext;
    prepareMessages(
      conversationId: string, allowedToolIds: string[], profile: InternalAgentProfile | null,
      mode: AppMode, agentType: AgentType | null | undefined, replyToMessageId: string,
      skillSnapshot: SkillPermissionSnapshot, executionContext: ProjectExecutionContext,
      riskLevel: ToolRiskLevel,
    ): Promise<PreparedChatRequestContext>;
    citations(conversationId: string): Citation[];
    fileRefPath(ref: (ContextReference | PersistedContextReference) & { kind: "file" }): string;
  };
  provider: {
    supportsNativeToolCalling(): boolean;
    ensureContextMetadata(providerId: string, modelId: string, reason: "pre_send"): Promise<unknown>;
    modelContext(providerId: string, modelId: string, providerType: string): {
      footprintFields: ContextLimitFootprintFields;
    };
    estimateSerializedPayloadTokens(params: {
      messages: StreamMessage[];
      providerType?: string | null;
      providerId?: string | null;
      baseUrl?: string | null;
      modelId: string;
    }): number;
  };
  compaction: {
    loadBudgetPolicy(): Promise<ContextBudgetPolicy>;
    status(conversationId: string): ConversationCompactionStatus | null | undefined;
    setStatus(conversationId: string, status: ConversationCompactionStatus): void;
    compact(params: PrepareChatRequestCompaction): Promise<MaybeCompactConversationResult>;
    recordEvent: CompactionRuntimeAdapters["recordCompactionAuditEvent"];
  };
  persistence: {
    providerInputItems(messageId: string, items: unknown[] | undefined): Promise<void>;
  };
}

export const prepareAssistantStreamLaunch = async (
  params: PrepareAssistantStreamParams,
  ports: ChatRequestPreparationPorts,
): Promise<PreparedAssistantStreamLaunch> => {
  const assertCurrent = () => {
    if (!ports.isCurrent()) throw new ChatTurnSupersededError();
  };
  const waitForCurrent = async <T>(pending: Promise<T> | T): Promise<T> => {
    try { return await pending; } finally { assertCurrent(); }
  };
  assertCurrent();
  try {
    await waitForCurrent(ports.tools.ensureLoaded());
    const { lastError, hasInternalTools } = ports.tools.loadStatus();
    if (lastError && !hasInternalTools) {
      throw new Error(`Failed to load tool settings: ${lastError}`);
    }
  } catch (error) {
    if (error instanceof ChatTurnSupersededError) throw error;
    const normalized = toServiceError(error);
    throw new Error(normalized.message);
  }

  const taskStatus = params.resolvedTaskId
    ? ports.tasks.find(params.resolvedTaskId)?.status ??
      null
    : null;
  const internalAgentProfile = ports.policy.resolveInternalAgentProfile({
    mode: params.modeAtSend,
    taskStatus,
    overrideProfile: params.internalAgentProfile,
  });
  const taskForToolScope = params.resolvedTaskId
    ? ports.tasks.find(params.resolvedTaskId)
    : undefined;
  const executionContext =
    params.executionContext ?? ports.context.executionContext(params.conversationId);
  const scopedTurnConfiguration = params.scopedTurnConfigurationOverride !== undefined
    ? params.scopedTurnConfigurationOverride
    : await waitForCurrent(ports.configuration.loadScoped({
        projectIds: executionContext.projectIds,
        focusProjectId: executionContext.focusedProjectId,
        mode: params.modeAtSend,
      }));
  const riskLevel =
    scopedTurnConfiguration?.riskLevel ?? await waitForCurrent(ports.configuration.loadRiskLevel());
  const baseAllowedToolIds = await waitForCurrent(ports.tools.allowedForMode(
    internalAgentProfile,
    params.modeAtSend,
    params.agentTypeAtSend,
    {
      supportsNativeToolCalling:
        params.providerSupportsNativeToolCalling ??
        ports.provider.supportsNativeToolCalling(),
      providerConfig: params.providerConfig,
      modelId: params.modelId,
    },
    riskLevel,
    executionContext.focusedProjectId,
  ));
  let taskAllowedToolIds = baseAllowedToolIds;
  if (params.modeAtSend === "Implement") {
    taskAllowedToolIds = ports.tools.filterForImplementTask(
      baseAllowedToolIds,
      taskForToolScope,
    );
  } else if (params.modeAtSend === "Architect") {
    taskAllowedToolIds = ports.tools.filterForArchitectPlan(
      baseAllowedToolIds,
      executionContext,
    );
  }
  const toolsSnapshot = ports.tools.mcpSnapshot();
  const providerSupportsNativeToolCalling =
    params.providerSupportsNativeToolCalling ??
    ports.provider.supportsNativeToolCalling();
  const scopedMcpRuntime = scopedTurnConfiguration
    ? await waitForCurrent(ports.tools.resolveScopedMcp(
        scopedTurnConfiguration.mcpServers,
        toolsSnapshot.servers,
        { projectIds: scopedTurnConfiguration.projectIds },
      ))
    : {
        // Compatibility path for runtimes without the scoped configuration
        // API. Tool execution still acquires an authoritative backend key.
        servers: toolsSnapshot.servers,
        tools: toolsSnapshot.enabledTools(),
        failures: [],
      };
  if (scopedMcpRuntime.failures.length > 0) {
    const unavailableServers = scopedMcpRuntime.failures
      .map((failure) => `${failure.serverId} (${failure.code})`)
      .join(", ");
    ports.tools.reportUnavailableMcpServers(scopedMcpRuntime.failures, unavailableServers);
  }
  const scopedMcpTools = scopedMcpRuntime.tools;
  const injectableMcpToolIds = selectInjectableMCPToolIds({
    enabledToolIds: scopedMcpTools.map((tool) => tool.id),
    supportsNativeToolCalling: providerSupportsNativeToolCalling,
    providerType: params.providerConfig.providerType,
    mode: params.modeAtSend,
    agentType: params.agentTypeAtSend ?? null,
  });
  const policyAllowedMcpToolIds = ports.configuration.restrictTools(
    filterDeniedToolIdsForRiskLevel(
      ports.policy.filterForInternalAgentProfile(
        injectableMcpToolIds,
        internalAgentProfile,
      ),
      riskLevel,
      params.modeAtSend,
    ),
    scopedTurnConfiguration,
  );
  const injectableMcpToolIdsSet = new Set(policyAllowedMcpToolIds);
  const allowedToolIds = Array.from(new Set(ports.configuration.restrictTools(
    [
      ...taskAllowedToolIds.filter((toolId) => !isMCPToolId(toolId)),
      ...policyAllowedMcpToolIds,
    ],
    scopedTurnConfiguration,
  )));
  const mcpTools = scopedMcpTools.filter((tool) =>
    injectableMcpToolIdsSet.has(tool.id),
  );
  const showToolTraces = false;
  const skillPermissionSnapshot = ports.skills.createPermissionSnapshot(params.conversationId, params.replyToMessageId);
  const preparedRequest = await waitForCurrent(ports.context.prepareMessages(
    params.conversationId,
    allowedToolIds,
    internalAgentProfile,
    params.modeAtSend,
    params.agentTypeAtSend,
    params.replyToMessageId,
    skillPermissionSnapshot,
    executionContext,
    riskLevel,
  ));
  ports.skills.publishFeedback(params.replyToMessageId, preparedRequest.skillTurnFeedback);
  const toolDefinitions = ports.tools.definitions(allowedToolIds, mcpTools);
  await waitForCurrent(ports.provider.ensureContextMetadata(
    params.providerId,
    params.modelId,
    "pre_send",
  ));
  const { footprintFields } = ports.provider.modelContext(
    params.providerId,
    params.modelId,
    params.providerConfig.providerType,
  );
  const budgetPolicy = await waitForCurrent(ports.compaction.loadBudgetPolicy());
  const preparedMessagesForContext = normalizeMessagesForProviderContext(
    params.providerConfig.providerType,
    preparedRequest.preparedMessages,
  );
  const countProviderInputItems = shouldCountProviderInputItemsForContext(
    params.providerConfig.providerType,
  );
  const estimateSerializedPayloadTokens = (messages: StreamMessage[]) =>
    ports.provider.estimateSerializedPayloadTokens({
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
    providerType: params.providerConfig.providerType,
    providerId: params.providerId,
    baseUrl: params.providerConfig.baseUrl,
    modelId: params.modelId,
    estimateSerializedPayloadTokens,
    countProviderInputItems,
    mode: params.compactionMode ?? "blocking",
    budgetPolicy,
  });
  const markSafetyPrestreamCompacting = (footprintAfter: ContextFootprint) => {
    const previousStatus =
      ports.compaction.status(params.conversationId) ?? null;
    ports.compaction.setStatus(params.conversationId, {
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
    ports.compaction.compact({
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
    shouldProactivelyCompactContext({
      boundary: "pre_send",
      footprint: initialFootprint,
    });
  let compactedRequest: MaybeCompactConversationResult;
  if (needsSafetyPrestream) {
    markSafetyPrestreamCompacting(initialFootprint);
    compactedRequest = await waitForCurrent(compactPreparedRequest({
      mode: "safety_prestream",
      forcePrune: true,
    }));
  } else {
    compactedRequest = await waitForCurrent(compactPreparedRequest());
    needsSafetyPrestream =
      autoCompactionEnabled &&
      !params.compactionMode &&
      shouldProactivelyCompactContext({
        boundary: "pre_send",
        footprint: compactedRequest.footprintAfter,
      });
    if (needsSafetyPrestream) {
      markSafetyPrestreamCompacting(compactedRequest.footprintAfter);
      compactedRequest = await waitForCurrent(compactPreparedRequest({
        mode: "safety_prestream",
        forcePrune: true,
      }));
    }
  }
  if (
    compactedRequest.decision === "hard_stop" ||
    isBlockableContextOverUsableBudget(compactedRequest.footprintAfter)
  ) {
    const latestUserContextTokens =
      compactedRequest.footprintAfter.latestUserBlockableTokens ??
      compactedRequest.footprintAfter.latestUserContextTokens ??
      0;
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
    ports.compaction.setStatus(params.conversationId, {
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
    await waitForCurrent(ports.compaction.recordEvent({
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
        completionReason:
          [...preparedRequest.orderedMessages]
            .reverse()
            .find((message) => message.role === "assistant")
            ?.completion_reason ?? null,
        ...buildAppliedCompactionAuditDetails({
          result: compactedRequest,
        }),
      }),
    }));
    throw new Error(
      autoCompactionBlocked
        ? buildManualCompactionRequiredErrorMessage(blockedFootprint)
        : buildContextTooLargeErrorMessage(blockedFootprint),
    );
  }
  const fileRefToolContext = preparedRequest.orderedMessages
    .flatMap((message) => message.context_refs ?? [])
    .filter((ref): ref is typeof ref & { kind: "file" } => ref.kind === "file")
    .map((ref) => {
      const path = ports.context.fileRefPath(ref);
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
  ports.context.citations(params.conversationId)
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
    ports.configuration.webSearch();
  const guidedToolRetry = ports.tools.guidedRetry({
    userContent: params.userContent,
    allowedToolIds,
    supportsNativeToolCalling: params.providerSupportsNativeToolCalling,
    fileToolContext,
  });
  const maxTurns = scopedTurnConfiguration?.maxTurns !== null
    && scopedTurnConfiguration?.maxTurns !== undefined
    ? normalizeChatMaxTurns(scopedTurnConfiguration.maxTurns)
    : normalizeChatMaxTurns(
        await waitForCurrent(ports.configuration.loadMaxTurns()),
      );
  const { skillToolIds, runnableSkillToolIds } =
    ports.skills.toolIdsForRequest(
      allowedToolIds,
      preparedRequest.skillPermissionSnapshot,
    );

  await waitForCurrent(ports.persistence.providerInputItems(
    params.replyToMessageId,
    preparedRequest.persistableProviderInputItemsByMessageId[params.replyToMessageId],
  ));

  return {
    allowedToolIds,
    riskLevel,
    scopedTurnConfiguration,
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
      toolDefinitions: ports.tools.definitions(allowedToolIds, mcpTools),
      messagesForRequest: compactedRequest.messages.map(cloneStreamMessage),
      citations: preparedRequest.citations.map((citation) => ({ ...citation })),
      repositoryInstructionSources:
        preparedRequest.repositoryInstructionContext.sources.map(
          ({ projectId, projectName, sourcePath, relativePath, depth, sizeBytes }) => ({
            projectId, projectName, sourcePath, relativePath, depth, sizeBytes,
          }),
        ),
      repositoryInstructionIssues:
        preparedRequest.repositoryInstructionContext.issues.map((issue) => ({ ...issue })),
      compactionDecision: compactedRequest.decision,
    } satisfies StreamContextDiagnosticsBaselineSeed,
    executionContext: preparedRequest.executionContext,
    fileToolContext,
    internalAgentProfile,
    enableWebSearch,
    enableWebFetch,
    webSearchOptions,
    mcpTools,
    mcpServers: scopedMcpRuntime.servers,
    skillToolIds,
    runnableSkillToolIds,
    guidedToolRetry,
    maxTurns,
    compactionDecision: compactedRequest.decision,
  };
};
