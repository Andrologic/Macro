import type { ChatMessage } from '../../types';
import type { PrepareAssistantStreamParams } from '../chatStreamContracts';
import {
  createAssistantPlaceholderMessage, createUserMessage, deleteMessagesAfter,
} from '../chatPersistenceService';
import { toServiceError } from '../contracts/errors';
import type {
  ChatSendInput, ChatSendPorts, ChatSendResult, ChatSendSnapshot,
  SendLease, SendTask,
} from './contracts';

/** One send operation. The caller captures selections and checks shutdown synchronously. */
export async function sendMessage<Task extends SendTask, Recovery, Launch>(
  input: ChatSendInput,
  snapshot: ChatSendSnapshot,
  ports: ChatSendPorts<Task, Recovery, Launch>,
): Promise<ChatSendResult> {
  const { owner, messages, preparation, configuration, tasks, projection, stream } = ports;
  let conversationId = input.conversationId;
  const { content, images, hiddenContext, providerInputItems, internalAgentProfile } = input;
  const contextRefs = input.contextRefs ?? snapshot.composerContextRefs;
  const clearComposerRevision = input.contextRefs === undefined ? snapshot.composerRevision : undefined;
  const { mode, agentType, architectPlan, executionContext, provider } = snapshot;
  const resolvedTaskId = mode === 'Chat' ? '' : (input.taskId ?? snapshot.conversationTaskId ?? snapshot.selectedTaskId);
  const abortController = new AbortController();
  let lease: SendLease | null = null;
  let assistantMessageId: string | null = null;
  let launchError: unknown = null;
  const startedAt = Date.now();
  const timeline = (phase: string, context: Record<string, unknown> = {}) =>
    projection.timeline(phase, { requestId: lease?.sessionId ?? null, elapsedMs: Date.now() - startedAt, ...context });
  const cancelled = (): ChatSendResult => ({
    status: 'cancelled', conversationId, turnId: lease?.turnId ?? '',
    userMessageId: null, assistantMessageId: null,
  });
  const ownsTurn = (id = conversationId) => {
    const runtime = owner.read(id);
    return lease !== null && !preparation.isDeleted(id) && !abortController.signal.aborted &&
      runtime.sessionId === lease.sessionId && runtime.turnId === lease.turnId &&
      runtime.abortController === abortController;
  };
  const isCurrent = (id = conversationId) => ownsTurn(id) && owner.read(id).phase === 'preparing';
  const setPreparing = (id: string, current: SendLease, assistantId: string | null = null) =>
    owner.set(id, {
      phase: 'preparing', ...current, assistantMessageId: assistantId, lastError: null,
    }, { globalLastError: null });
  const sentWithoutAssistant = (message: ChatMessage): ChatSendResult => ({
    status: 'sent', conversationId, turnId: lease?.turnId ?? '',
    userMessageId: message.id, assistantMessageId: null,
  });
  const publishUser = (message: ChatMessage) => projection.publishUser(message, {
    images, contextRefs, clearComposerRevision,
  });
  const saveUser = async (current: SendLease) => {
    let message: ChatMessage;
    try {
      message = await createUserMessage(messages.persistence, {
        conversationId, turnId: current.turnId, taskId: resolvedTaskId,
        content, hiddenContext, providerInputItems, contextRefs,
      });
    } catch (error) {
      throw new Error(`Failed to save the message before sending: ${toServiceError(error).message}`);
    }
    messages.onUserPersisted?.(message);
    return message;
  };

  try {
    preparation.assertCanSend(conversationId);
    lease = { sessionId: preparation.createSessionId(), turnId: input.submissionTurnId ?? preparation.createTurnId(), abortController };
    const current = lease;
    owner.rememberSession(conversationId, current.sessionId);
    timeline('send_requested', { conversationId });
    setPreparing(conversationId, current);
    await messages.ensureLoaded(conversationId);
    if (!isCurrent()) return cancelled();
    timeline('messages_ready', { conversationId });
    if (mode === 'Architect' && !architectPlan) {
      throw new Error('Select a plan before sending an Architect message.');
    }

    const previousConversationId = conversationId;
    const pendingArchitect = preparation.hasPendingArchitectConversation(conversationId);
    if (pendingArchitect) {
      conversationId = await preparation.materializeArchitectConversation(conversationId);
    }
    if (abortController.signal.aborted || preparation.isDeleted(previousConversationId)) return cancelled();
    if (pendingArchitect && conversationId !== previousConversationId) {
      if (!owner.transfer(previousConversationId, conversationId, current.sessionId)) {
        const runtime = owner.read(previousConversationId);
        if (runtime.phase === 'preparing' && runtime.sessionId === current.sessionId &&
          runtime.turnId === current.turnId && runtime.abortController === abortController) {
          abortController.abort();
          if (owner.latestSession(previousConversationId) === current.sessionId) owner.forgetSession(previousConversationId);
          owner.update(previousConversationId, current.sessionId, () => null);
        }
        return cancelled();
      }
      owner.set(previousConversationId, null);
      setPreparing(conversationId, current);
    }
    const scopedConfiguration = await configuration.load({
      projectIds: executionContext.projectIds, focusProjectId: executionContext.focusedProjectId, mode,
    });
    if (!isCurrent()) return cancelled();
    const scopedModel = snapshot.modelSelectionCaptured
      ? null : configuration.selectScoped(scopedConfiguration, snapshot, internalAgentProfile);
    const providerId = scopedModel?.providerId ?? provider.selectedProviderId;
    const modelId = scopedModel?.modelId ?? provider.selectedModelId;
    const reasoningEffort = scopedModel ? scopedModel.reasoningEffort : provider.selectedReasoningEffort;
    projection.persistSelection(mode, conversationId);
    if (provider.isLoading) throw new Error('Provider settings are still loading.');
    if (!providerId || !modelId) throw new Error('Select a provider and model before sending a message.');
    const providerConfig = provider.providerConfigs.find((candidate) => candidate.id === providerId);
    if (!providerConfig || !providerConfig.isEnabled) {
      throw new Error(scopedModel
        ? 'The model configured for this project uses an unavailable provider.'
        : 'Provider configuration not found.');
    }
    const apiKey = providerConfig.isLocal || configuration.hasAuthSession(providerConfig)
      ? providerConfig.apiKey : await configuration.resolveApiKey(providerId);
    if (!isCurrent()) return cancelled();
    const providerForUse = { ...providerConfig, apiKey, apiKeyLoaded: providerConfig.apiKeyLoaded || apiKey !== undefined };
    const model = { providerId, modelId, reasoningEffort, providerType: providerForUse.providerType, baseUrl: providerForUse.baseUrl, apiKey };
    let task = resolvedTaskId ? tasks.read(resolvedTaskId) : undefined;
    let recovery: Recovery | null = null;
    let finalizedDraft = false;
    let userMessage: ChatMessage | null = null;
    let userCountBeforeSend = messages.list(conversationId).filter((message) => message.role === 'user').length;
    const firstManualFeatureMessage = mode === 'Implement' && Boolean(resolvedTaskId) &&
      task?.task_source === 'standalone' && task.standalone_kind === 'manual_feature' &&
      task.draft === true && userCountBeforeSend === 0;
    if (firstManualFeatureMessage) {
      userMessage = await saveUser(current);
      publishUser(userMessage);
      if (!isCurrent()) {
        return sentWithoutAssistant(userMessage);
      }
      tasks.beginLaunch({ conversationId, taskId: resolvedTaskId, userMessageId: userMessage.id, sessionId: current.sessionId });
    }
    if (mode === 'Implement' && resolvedTaskId) {
      if (task?.task_source === 'standalone' && task.standalone_kind === 'manual_feature' && task.draft === true) {
        recovery = await tasks.finalizeDraft({
          ...model, conversationId, taskId: resolvedTaskId, userContent: content,
          onStep: (step) => tasks.setLaunchStep(conversationId, current.sessionId, step),
        });
        if (!isCurrent()) return cancelled();
        finalizedDraft = recovery !== null;
      }
      task = (await tasks.assertReady(resolvedTaskId)) ?? task;
      if (!isCurrent()) return cancelled();
      tasks.assertExecutionContextReady(task);
      if (firstManualFeatureMessage) tasks.setLaunchStep(conversationId, current.sessionId, 'starting_agent');
    }
    if (!userMessage) {
      userCountBeforeSend = messages.list(conversationId).filter((message) => message.role === 'user').length;
      userMessage = await saveUser(current);
    }
    const persistedUserMessage = userMessage;
    const returnSavedUser = () => {
      if (!firstManualFeatureMessage) publishUser(persistedUserMessage);
      return sentWithoutAssistant(persistedUserMessage);
    };
    if (!isCurrent()) return returnSavedUser();
    if (messages.hasInterruptedApproval(conversationId)) {
      await messages.clearApprovalRecovery(conversationId)
        .catch((error) => projection.approvalRecoveryError(toServiceError(error).message));
      if (!isCurrent()) return returnSavedUser();
      projection.clearSecurity(conversationId);
    }
    if (!isCurrent()) {
      return returnSavedUser();
    }
    if (!firstManualFeatureMessage) publishUser(persistedUserMessage);
    if (userCountBeforeSend === 0 && !finalizedDraft) {
      let skipMetadata = false;
      if (architectPlan) {
        const bound = await preparation.bindArchitectConversation({ architectPlan, conversationId });
        if (!isCurrent()) return sentWithoutAssistant(persistedUserMessage);
        if (!bound) skipMetadata = true;
        else {
          await preparation.syncArchitectMetadata({
            branchName: architectPlan.targetBranch, planId: architectPlan.planId, conversationId, reason: 'metadata_prefix',
          });
          if (!isCurrent()) return sentWithoutAssistant(persistedUserMessage);
        }
      }
      if (!skipMetadata) void preparation.generateMetadata({ ...model, conversationId, firstUserContent: content, architectPlan });
    }
    try {
      const request: PrepareAssistantStreamParams = {
        conversationId, replyToMessageId: persistedUserMessage.id, userContent: content, resolvedTaskId,
        modeAtSend: mode, agentTypeAtSend: agentType, providerId, modelId, reasoningEffort,
        providerConfig: providerForUse, internalAgentProfile, executionContext,
        scopedTurnConfigurationOverride: scopedConfiguration,
        providerSupportsNativeToolCalling: configuration.supportsNativeToolCalling(providerId, modelId),
      };
      const launch = await stream.prepare(request);
      if (!isCurrent()) return sentWithoutAssistant(persistedUserMessage);
      timeline('compaction_done', { conversationId, providerId, providerType: providerForUse.providerType });
      let assistant: ChatMessage;
      try {
        assistant = await createAssistantPlaceholderMessage(messages.persistence, {
          conversationId, turnId: current.turnId, taskId: resolvedTaskId,
        });
      } catch (error) {
        throw new Error(`Failed to create the assistant message before streaming: ${toServiceError(error).message}`);
      }
      if (!isCurrent()) {
        if (owner.latestSession(conversationId) === current.sessionId) {
          await deleteMessagesAfter(messages.persistence, conversationId, persistedUserMessage.id).catch(() => undefined);
        }
        return sentWithoutAssistant(persistedUserMessage);
      }
      assistantMessageId = assistant.id;
      projection.publishAssistant(assistant, mode, agentType);
      setPreparing(conversationId, current, assistant.id);
      timeline('provider_stream_start_requested', { conversationId, providerId, providerType: providerForUse.providerType });
      stream.start({
        ...request, sessionId: current.sessionId, assistantMessage: assistant,
        architectPlanAtSend: architectPlan, abortController,
        providerSupportsNativeToolCalling: configuration.supportsNativeToolCalling(providerId, modelId),
      }, launch);
      if (firstManualFeatureMessage) tasks.completeLaunch(conversationId, current.sessionId);
    } catch (error) {
      if (!ownsTurn()) return sentWithoutAssistant(persistedUserMessage);
      launchError = error;
      if (recovery) await tasks.rollbackDraft(recovery);
      throw error;
    }
    if (!current.turnId) throw new Error('Conversation turn was not created before sending.');
    return { status: 'sent', conversationId, turnId: current.turnId, userMessageId: persistedUserMessage.id, assistantMessageId };
  } catch (error) {
    const normalized = toServiceError(error);
    if (lease) {
      const launch = tasks.readLaunch(conversationId);
      if (launch?.sessionId === lease.sessionId) {
        tasks.failLaunch({
          conversationId, sessionId: lease.sessionId, error: normalized.message,
          canRetry: tasks.read(launch.taskId)?.draft === true,
        });
      }
    }
    if (abortController.signal.aborted) return cancelled();
    if (lease) {
      const result = projection.launchError(conversationId, lease.sessionId, assistantMessageId, normalized);
      if (!result.applied) {
        if (launchError) throw normalized;
        return cancelled();
      }
    } else projection.sendError(normalized.message);
    throw normalized;
  }
}
