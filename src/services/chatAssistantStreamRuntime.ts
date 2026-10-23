import type { ChatAdmissionContext } from './ipc/chatAdmission';
import { safeProviderFailure } from './chatErrorPresentation';
import { snapshotScopedMcpServers } from "./mcp/runtimeSnapshot";
import { createChatToolDispatch, type ChatToolDispatchPorts } from "./chatToolDispatch";
import type { ConversationCompactionStatus } from "./contextCompactionSession";
import type { AppMode, ChatMessage, ToolTrace } from "../types";
import type { AssistantStreamLaunch, FrozenToolCallContext, PrepareAssistantStreamParams, StreamContextDiagnosticsBaseline } from "./chatStreamContracts";
import { getMessageTurnId } from "../domains/chat/runtimeState";
import type { ChatTurnRuntime, ChatTurnIdentity } from "./chatTurnRuntime";
import { runAssistantStream, type ChatStreamTokenControls, type ChatStreamTransport } from "./chatStreamOrchestrator";
import type { GenerationAttempt } from "./ai/contracts";
import { mergeGenerationAttempts } from "./ai/generationAttemptState";
import { createChatStreamLifecycleRuntime, type ChatStreamLifecycleRuntimeAdapters } from "./chatStreamLifecycleRuntime";
import { deleteMessagesAfter as deletePersistedMessagesAfter, type ChatPersistenceAdapters } from "./chatPersistenceService";
import { extractContextLimitTokensFromErrorLike, isContextOverflowErrorLike as isProviderContextOverflowError } from "./contextOverflow";
import { toServiceError } from "./contracts/errors";
import { assistantTurnRequiresUserReply } from "./chatDbMappers";
import type { LiveStreamContextSnapshot, StreamMessage } from "./streamingChat";
import { devLogger } from "../utils/devLogger";
const OVERFLOW_RECOVERY_FAILURE_MESSAGE = "The selected model still rejected this conversation after an aggressive compaction pass. Macro kept your message; continue with a larger-context model or compact manually before retrying.";

type Lifecycle = ChatStreamLifecycleRuntimeAdapters;
export interface ChatAssistantStreamPorts {
 owner: ChatTurnRuntime;
 admission: {
  finishResponse(context: ChatAdmissionContext, conversationId: string, message: ChatMessage): Promise<void>;
  closePreparation(context: ChatAdmissionContext, conversationId: string): Promise<void>;
 };
 isDeleted(id: string): boolean;
 messages: {
  get(id: string): ChatMessage | undefined;
  ordered(id: string): ChatMessage[];
  append: Lifecycle["appendTokenChunk"];
  fields: Lifecycle["updateMessageFields"];
  content: Lifecycle["updateMessageContent"];
  completed: Lifecycle["updateConversationAfterCompletion"];
  removeEmpty(id: string): void;
 };
 persistence: {
  adapters: ChatPersistenceAdapters;
  complete: Lifecycle["persistAssistantStreamResult"];
  partial: Lifecycle["persistAssistantPartialStreamResult"];
  failed(params: {assistantMessage: ChatMessage; message: string; sessionId: string; turnId: string | null}): void;
  sync(mode: AppMode, conversationId: string, plan?: {planId: string; targetBranch: string}): Promise<void>;
 };
 tasks: { status: Lifecycle["getTaskStatus"]; failed(id: string, pilotActionToken?: symbol): Promise<void>; awaitingResponse(id: string, pilotActionToken?: symbol): Promise<void> | void };
 provider: { reachable: Lifecycle["markProviderReachable"]; recordOverflowLimit(providerId: string, modelId: string, limit: number): Promise<void>; copilotTimeout(id: string): number | null };
 diagnostics: {
  record(params: {conversationId: string; sessionId: string; assistantMessageId: string; snapshot: LiveStreamContextSnapshot; baseline?: StreamContextDiagnosticsBaseline; leading?: boolean}): void;
  clear: Lifecycle["clearLiveStreamContextEstimate"];
  refresh: Lifecycle["refreshConversationContextDiagnostics"];
 };
 prepare(params: PrepareAssistantStreamParams): Promise<Pick<AssistantStreamLaunch, "messagesForRequest" | "contextDiagnosticsBaselineSeed" | "executionContext" | "fileToolContext" | "allowedToolIds" | "riskLevel" | "scopedTurnConfiguration" | "skillToolIds" | "runnableSkillToolIds" | "guidedToolRetry" | "showToolTraces" | "enableWebSearch" | "enableWebFetch" | "webSearchOptions" | "mcpTools" | "mcpServers" | "internalAgentProfile" | "maxTurns" | "compactionDecision">>;
 compaction: {
  status(id: string): ConversationCompactionStatus | undefined;
  setStatus(id: string, status: ConversationCompactionStatus): void;
  create(params: AssistantStreamLaunch, baseline: StreamContextDiagnosticsBaseline, accepts: () => boolean, ownsCompletion: () => boolean): {
   compactFollowUpMessagesBeforeProviderRequest(request: {messages: StreamMessage[]; turnCount: number; toolResultCount: number}): Promise<{messages: StreamMessage[]; compacted?: boolean} | void>;
   consolidatePendingToolBoundaryCompactionAfterPersistence(): Promise<void>;
  };
 };
 tools: ChatToolDispatchPorts;
 replay: { finalize(params: {conversationId: string; replayId: string}): Promise<unknown> };
 transport: ChatStreamTransport;
}

interface AdmittedStreamGroup {
  active: Set<symbol>;
  effects: Set<Promise<unknown>>;
  done: Promise<void>;
  finish?: () => Promise<void>;
  finishing?: Promise<void>;
  settle(): void;
}

export function createAssistantStreamRuntime(ports: ChatAssistantStreamPorts) {
  // Overflow recovery shares the same admitted parent. Its predecessor still
  // owns callbacks and writes until both physical lifecycles have returned.
  const admittedStreams = new Map<string, AdmittedStreamGroup>();
  const start = (input: AssistantStreamLaunch): void => {
    // Capture execution authority before transport callbacks can suspend or UI selections change.
    const params: AssistantStreamLaunch = {
      ...input,
      providerConfig: { ...input.providerConfig },
      architectPlanAtSend: input.architectPlanAtSend ? { ...input.architectPlanAtSend } : undefined,
      architectPlanContext: structuredClone(input.architectPlanContext),
      executionContext: structuredClone(input.executionContext),
      scopedTurnConfiguration: structuredClone(input.scopedTurnConfiguration),
      allowedToolIds: [...input.allowedToolIds],
      mcpServers: snapshotScopedMcpServers(input.mcpServers),
      mcpTools: structuredClone(input.mcpTools),
      skillToolIds: [...input.skillToolIds],
      runnableSkillToolIds: [...input.runnableSkillToolIds],
      guidedToolRetry: structuredClone(input.guidedToolRetry),
      webSearchOptions: structuredClone(input.webSearchOptions),
      abortController: input.abortController ?? new AbortController(),
    };
    const streamTurnId = getMessageTurnId(params.assistantMessage);
    const identity: ChatTurnIdentity = { conversationId: params.conversationId, sessionId: params.sessionId,
      turnId: streamTurnId, assistantMessageId: params.assistantMessage.id };
    const abortController = params.abortController ?? new AbortController();
    if (abortController.signal.aborted) {
      throw new DOMException('Assistant preparation was cancelled before dispatch.', 'AbortError');
    }
    const shouldAcceptStreamUpdate = ports.owner.claimStream(identity, abortController);
    if (!shouldAcceptStreamUpdate) throw new Error("Assistant preparation no longer owns this turn.");
    const admissionHandle = params.providerAdmission.kind === 'globalChat' ? params.providerAdmission.context.handle : null;
    let group = admissionHandle ? admittedStreams.get(admissionHandle) : undefined;
    if (group?.finishing) throw new Error('Chat admission is already finalizing.');
    if (admissionHandle && !group) {
      let settle!: () => void;
      const done = new Promise<void>(resolve => { settle = resolve; });
      group = { active: new Set(), effects: new Set(), done, settle };

    }
    const pendingEffects = group?.effects ?? new Set<Promise<unknown>>();
    const trackEffect = <T>(pending: Promise<T>): Promise<T> => {
      pendingEffects.add(pending);
      void pending.then(() => pendingEffects.delete(pending), () => pendingEffects.delete(pending));
      return pending;
    };
    const drainEffects = async () => {
      while (pendingEffects.size) await Promise.allSettled([...pendingEffects]);
    };
    const operation: FrozenToolCallContext = Object.freeze({
          providerAdmission: params.providerAdmission,
          architectPlanAtSend: params.architectPlanAtSend,
          conversationId: params.conversationId,
          sessionId: params.sessionId,
          turnId: streamTurnId,
          assistantMessageId: params.assistantMessage.id,
          mode: params.modeAtSend,
          agentType: params.agentTypeAtSend ?? null,
          taskId: params.resolvedTaskId,
          executionContext: params.executionContext,
          scopedTurnConfiguration: params.scopedTurnConfiguration,
          allowedToolIds: params.allowedToolIds,
          mcpServers: params.mcpServers,
          riskLevel: params.riskLevel,
          signal: abortController.signal,
    });

    const deleteEmptyAssistantMessageFromDb = async () => {
      if (
        ports.owner.latestSession(params.conversationId) !== params.sessionId
      ) {
        return;
      }
      try {
        await deletePersistedMessagesAfter(
          ports.persistence.adapters,
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
      orderedMessages: ports.messages.ordered(
        params.conversationId,
      ).map(message => structuredClone(message)),
    };
    ports.diagnostics.record({
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
    let latestProviderDeltaText: string | undefined;
    let replayRecoveryFinalized = false;
    const finalizeReplayRecoveryAfterProgress = () => {
      if (!params.replayRecovery || replayRecoveryFinalized) return;
      replayRecoveryFinalized = true;
      void (async () => {
        await params.replayRecovery!.onProgress();
        await ports.replay.finalize({
          conversationId: params.conversationId,
          replayId: params.replayRecovery!.replayId,
        });
      })().catch((error) => {
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

      const status = ports.tasks.status(params.resolvedTaskId);
      if (!status || status === "Completed") {
        return;
      }

      try {
        await ports.tasks.failed(params.resolvedTaskId, params.pilotActionToken);
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
        await ports.provider.recordOverflowLimit(
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
      const assistantMessage = ports.messages.get(params.assistantMessage.id);
      const hasPartialAssistantProgress = Boolean(
        assistantMessage &&
          (assistantMessage.content.trim().length > 0 ||
            (assistantMessage.tool_traces?.length ?? 0) > 0),
      );
      if (hasPartialAssistantProgress) {
        return false;
      }

      tokenControls.dispose();
      ports.diagnostics.clear(params.conversationId);
      ports.compaction.setStatus(params.conversationId, {
        phase: "recovering_overflow",
        updatedAt: new Date().toISOString(),
        kind: "stream_overflow",
        recoveredFromOverflow: true,
      });
      ports.owner.update(
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
        const streamLaunch = await ports.prepare({
          turnCapabilities: params,
          providerAdmission: params.providerAdmission,
          conversationId: params.conversationId,
          replyToMessageId: params.replyToMessageId,
          userContent: params.userContent,
          resolvedTaskId: params.resolvedTaskId,
          modeAtSend: params.modeAtSend,
          agentTypeAtSend: params.agentTypeAtSend,
          providerId: params.selectedProviderId,
          modelId: params.selectedModelId,
          reasoningEffort: params.selectedReasoningEffort,
          providerConfig: params.providerConfig,
          internalAgentProfile: params.internalAgentProfile,
          executionContext: params.executionContext,
          scopedTurnConfigurationOverride: params.scopedTurnConfiguration,
          providerSupportsNativeToolCalling:
            params.providerSupportsNativeToolCalling,
          compactionMode: "stream_overflow",
          forceCompaction: true,
          forcePrune: true,
          compactionDisplayAfterMessageId: params.assistantMessage.id,
        });

        const runtimeAfterCompaction = ports.owner.read(params.conversationId);
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
          ports.compaction.status(params.conversationId);
        ports.compaction.setStatus(params.conversationId, {
          ...currentStatus,
          phase: "compacted",
          updatedAt: new Date().toISOString(),
          kind: "stream_overflow",
          recoveredFromOverflow: true,
        });

        ports.owner.update(
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
        start({
          ...params,
          messagesForRequest: streamLaunch.messagesForRequest,
          contextDiagnosticsBaselineSeed:
            streamLaunch.contextDiagnosticsBaselineSeed,
          executionContext: streamLaunch.executionContext,
          providerSupportsNativeToolCalling:
            params.providerSupportsNativeToolCalling,
          fileToolContext: streamLaunch.fileToolContext,
          allowedToolIds: streamLaunch.allowedToolIds,
          riskLevel: streamLaunch.riskLevel,
          scopedTurnConfiguration: streamLaunch.scopedTurnConfiguration,
          skillToolIds: streamLaunch.skillToolIds,
          runnableSkillToolIds: streamLaunch.runnableSkillToolIds,
          guidedToolRetry: streamLaunch.guidedToolRetry,
          showToolTraces: streamLaunch.showToolTraces,
          enableWebSearch: streamLaunch.enableWebSearch,
          enableWebFetch: streamLaunch.enableWebFetch,
          webSearchOptions: streamLaunch.webSearchOptions,
          mcpTools: streamLaunch.mcpTools,
          mcpServers: streamLaunch.mcpServers,
          internalAgentProfile: streamLaunch.internalAgentProfile,
          maxTurns: streamLaunch.maxTurns,
          compactionDecision: streamLaunch.compactionDecision,
          overflowRecoveryAttempted: true,
        });
        return true;
      } catch (recoveryError) {
        if (abortController.signal.aborted || !ports.owner.matches(identity, "overflow_recovery")) return true;
        const normalized = toServiceError(recoveryError);
        const message =
          normalized.message || OVERFLOW_RECOVERY_FAILURE_MESSAGE;
        ports.compaction.setStatus(params.conversationId, {
          phase: "too_large",
          updatedAt: new Date().toISOString(),
          reason: "hard_stop_ratio",
          kind: "stream_overflow",
          recoveredFromOverflow: true,
        });
        await maybeMarkImplementTaskFailedAfterStreamError();
        if (ports.owner.matches(identity, "overflow_recovery")) {
          const recordedMessage = ports.messages.get(params.assistantMessage.id);
          const hasRecordedAttempt = Boolean(recordedMessage?.generation_attempts?.length);
          if (!hasRecordedAttempt) ports.messages.removeEmpty(params.assistantMessage.id);
          ports.owner.set(params.conversationId, {
            phase: "error", sessionId: params.sessionId, turnId: streamTurnId,
            assistantMessageId: hasRecordedAttempt ? params.assistantMessage.id : null,
            abortController: null, lastError: message,
            lastErrorOrigin: "macro", lastErrorDisplayTarget: "composer",
          }, { globalLastError: message });
          if (hasRecordedAttempt && recordedMessage) {
            try {
              await ports.persistence.partial(recordedMessage);
            } catch (persistError) {
              console.warn("Failed to persist generation attempts after overflow recovery error:", persistError);
            }
          } else {
            await deleteEmptyAssistantMessageFromDb();
          }
        }
        return true;
      }
    };

    const {
      compactFollowUpMessagesBeforeProviderRequest,
      consolidatePendingToolBoundaryCompactionAfterPersistence,
    } = ports.compaction.create(params, contextDiagnosticsBaseline, shouldAcceptStreamUpdate,
      () => ports.owner.ownsCompletion(identity));

    let activeGenerationAttempt: GenerationAttempt | undefined;
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
        isTurnCurrent: () => !ports.isDeleted(params.conversationId) && ports.owner.latestSession(params.conversationId) === params.sessionId,
        appendTokenChunk: (messageId, tokenChunk) => {
          if (tokenChunk.length > 0) finalizeReplayRecoveryAfterProgress();
          ports.messages.append(messageId, tokenChunk);
        },
        getAssistantMessage: ports.messages.get,
        getInterruptedProviderText: () => latestProviderDeltaText,
        updateMessageFields: (messageId, fields) => {
          ports.messages.fields(messageId, fields);
        },
        updateMessageContent: (messageId, content) => {
          ports.messages.content(messageId, content);
        },
        markProviderReachable: ports.provider.reachable,
        getTaskStatus: ports.tasks.status,
        markTaskAwaitingResponse: id => ports.tasks.awaitingResponse(id, params.pilotActionToken),
        assistantTurnRequiresUserReply,
        updateConversationAfterCompletion: (conversationId, visibleContent) => {
          if (ports.owner.beginCompletion(identity)) ports.messages.completed(conversationId, visibleContent);
        },
        clearLiveStreamContextEstimate: ports.diagnostics.clear,
        refreshConversationContextDiagnostics: ports.diagnostics.refresh,
        persistAssistantStreamResult: (...args) => trackEffect(ports.persistence.complete(...args)),
        persistAssistantPartialStreamResult: (...args) => trackEffect(ports.persistence.partial(...args)),
        consolidatePendingToolBoundaryCompactionAfterPersistence,
        syncMacroMetadataAfterStream: (mode, conversationId) => trackEffect(ports.persistence.sync(mode, conversationId, params.architectPlanAtSend)),
        setCompletionPersistenceError: ({ message }) => {
          ports.owner.failCompletion(identity, () => {
            const assistantMessage = ports.messages.get(identity.assistantMessageId);
            if (assistantMessage?.role === "assistant") ports.persistence.failed({
              assistantMessage, message, sessionId: identity.sessionId, turnId: identity.turnId,
            });
          });
        },
        clearCompletionPersistenceOwnership: () => {
          if (params.providerAdmission.kind !== 'globalChat') ports.owner.releaseCompletion(identity);
        },
        maybeMarkImplementTaskFailedAfterStreamError,
        tryRecoverFromOverflow,
        removeEmptyAssistantPlaceholder: ports.messages.removeEmpty,
        deleteEmptyAssistantMessageFromDb,
        recoverReplayBeforeProgress: params.replayRecovery
          ? params.replayRecovery.onFailedBeforeProgress
          : undefined,
        setStreamErrorState: ({
          presentation,
          assistantMessageId,
        }) => {
          if (
            ports.isDeleted(params.conversationId) ||
            ports.owner.latestSession(params.conversationId) !== params.sessionId
          ) {
            return;
          }
          ports.owner.set(params.conversationId, {
            phase: "error",
            sessionId: params.sessionId,
            turnId: streamTurnId,
            assistantMessageId,
            abortController: null,
            lastError: presentation.message,
            lastErrorOrigin: presentation.origin,
            providerFailure: safeProviderFailure(presentation),
            lastErrorDisplayTarget: presentation.displayTarget,
          }, presentation.displayTarget === "composer" ? { globalLastError: presentation.message } : undefined);

        },
        warn: (message, error) => {
          console.warn(message, error);
        },
        info: (message) => {
          devLogger.info(message);
        },
      },
    });

    const dispatchTool = createChatToolDispatch(operation, ports.tools, shouldAcceptStreamUpdate, finalizeReplayRecoveryAfterProgress, params.mcpTools);
    if (group) group.finish = async () => {
          const admission = params.providerAdmission;
          if (admission.kind !== 'globalChat') return;
          const message = ports.messages.get(params.assistantMessage.id);
          try {
            // A failed save remains under its existing explicit recovery flow.
            if (message?.persistence_state === 'failed' || message?.persistence_state === 'retrying') return;
            if (message) await ports.admission.finishResponse(admission.context, params.conversationId, message);
            else await ports.admission.closePreparation(admission.context, params.conversationId);
          } catch (error) {
            if (ports.owner.latestSession(params.conversationId) === params.sessionId) {
              ports.owner.set(params.conversationId, {
                phase: 'error', sessionId: params.sessionId, turnId: streamTurnId,
                assistantMessageId: message?.id ?? null, abortController: null,
                lastError: toServiceError(error).message, lastErrorOrigin: 'macro', lastErrorDisplayTarget: 'composer',
              });
            }
          } finally {
            ports.owner.releaseCompletion(identity);
          }
    };
    const streamTicket = Symbol();
    group?.active.add(streamTicket);
    if (group && admissionHandle) admittedStreams.set(admissionHandle, group);
    const streamPromise = runAssistantStream({
      streamChatImpl: ports.transport,
      providerAdmission: params.providerAdmission,
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
          ? ports.provider.copilotTimeout(params.selectedProviderId)
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
      lifecycle: {
        ...streamLifecycle,
        onAbort: (controls) => {
          const message = ports.messages.get(params.assistantMessage.id);
          if (activeGenerationAttempt && message && shouldAcceptStreamUpdate()) {
            ports.messages.fields(message.id, {
              generation_attempts: mergeGenerationAttempts(message.generation_attempts, [activeGenerationAttempt]),
            });
          }
          return streamLifecycle.onAbort(controls);
        },
      },
      onToolTracesUpdate: (toolTraces: ToolTrace[]) => {
        if (!shouldAcceptStreamUpdate()) {
          return;
        }
        if (toolTraces.length > 0) {
          finalizeReplayRecoveryAfterProgress();
        }
        ports.messages.fields(params.assistantMessage.id, {
          tool_traces: toolTraces,
        });
      },
      onGenerationAttemptsUpdate: async (generationAttempts) => {
        if (!shouldAcceptStreamUpdate()) return;
        const previousAttempts = ports.messages.get(params.assistantMessage.id)?.generation_attempts;
        ports.messages.fields(params.assistantMessage.id, {
          generation_attempts: mergeGenerationAttempts(previousAttempts, generationAttempts),
        });
        if (generationAttempts.some((attempt) => attempt.id === activeGenerationAttempt?.id)) {
          activeGenerationAttempt = undefined;
        }
        const message = ports.messages.get(params.assistantMessage.id);
        if (message) {
          try {
            await trackEffect(ports.persistence.partial(message));
          } catch (error) {
            console.warn("Failed to persist generation attempts during stream:", error);
          }
        }
      },
      onGenerationAttemptProgress: (attempt) => {
        if (shouldAcceptStreamUpdate()) activeGenerationAttempt = attempt;
      },
      onBeforeFollowUpRequest: async (request) => {
        const compacted = await compactFollowUpMessagesBeforeProviderRequest(request);
        const compactedMessages = Array.isArray(compacted)
          ? compacted
          : compacted?.messages ?? request.messages;
        if (!shouldAcceptStreamUpdate()) return request.messages;
        return [...compactedMessages, ...ports.owner.consumeSteers(identity)];
      },
      consumePendingSteers: () => shouldAcceptStreamUpdate() ? ports.owner.consumeSteers(identity) : [],
      onLiveContextUpdate: (snapshot) => {
        if (!shouldAcceptStreamUpdate()) {
          return;
        }
        latestProviderDeltaText = snapshot.providerDeltaText;
        ports.diagnostics.record({
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
      onToolCall: (...args) => trackEffect(dispatchTool(...args)),
    });
    const finished = params.providerAdmission.kind === 'globalChat'
      ? streamPromise.finally(async () => {
          const shared = group!;
          shared.active.delete(streamTicket);
          if (shared.active.size) return shared.done;
          await drainEffects();
          if (shared.active.size) return shared.done;
          shared.finishing ??= (async () => {
            try { await shared.finish!(); }
            finally {
              if (admissionHandle && admittedStreams.get(admissionHandle) === shared) admittedStreams.delete(admissionHandle);
              shared.settle();
            }
          })();
          await shared.finishing;
        })
      : streamPromise;
    ports.owner.track(params.conversationId, finished);
  };
  return { start };
}
