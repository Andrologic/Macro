import type { ConversationCompactionState, SkillPermissionSnapshot } from '../../src/types';
import type { ProjectExecutionContext } from '../../src/services/projectExecutionContext';
import type { ContextLimitFootprintFields } from '../../src/services/modelContextLimits';
import type { PortableProjection } from '../../src/services/ai/portableHistoryArchive';
import { prepareChatMessages, type ChatMessagePreparationPorts } from '../../src/services/chatMessagePreparation';
import { prepareAssistantStreamLaunch, type ChatRequestPreparationPorts } from '../../src/services/chatRequestPreparation';
import { buildCompactedMessagesForRequest } from '../../src/services/contextCompaction';
import { estimateChatCompletionSerializedPayloadTokens } from '../../src/services/ai/chatCompletionsCodec';
import { shouldCountProviderInputItemsForContext } from '../../src/services/chatStreamCompactionMessages';
import { projectNativeMessages } from '../../src/services/ai/nativeMessageProjection';
import { TransferPorts } from './connect-transfer-ports';
import { ensure, integer, preparationQuote } from './connect-transfer-values';
import type { Facts } from './connect-transfer-protocol';

export const REFERENCE_INSTRUCTION = 'Continue from the complete archived conversation. This is a synthetic local preparation reference.';
const unavailable = (): never => { throw new Error('required_external_context'); };
const globalContext = (): ProjectExecutionContext => ({ groupId: null, groupName: null, projectIds: [], actionableProjectIds: [], contextProjectIds: [],
  projectMounts: [], focusedProjectId: null, virtualRootEnabled: false, workspacePathsByProjectId: {}, defaultWorkspacePath: null,
  projectId: null, projectName: null, taskId: null, branchName: null, workspacePath: null });

/** A local reference draft. It never writes settings, grants tools or builds a provider body. */
export async function prepareReference(ports: TransferPorts, projection: PortableProjection, root: Facts): Promise<void> {
  const h = ports.client.start.handles.target;
  const target: Facts = {};
  for (const name of ['conversationId', 'providerId', 'modelId', 'baseUrl', 'modePrompt', 'reasoningEffort', 'currentCheckpoint', 'contextWarning']) {
    target[name] = root.fields[name] === null ? null : await ports.text(h, root.fields[name], name === 'currentCheckpoint');
  }
  ensure(target.conversationId && target.providerId && target.modelId, 2);
  const release = ports.budget.reserve(preparationQuote({ projection, target, root },
    projection.messages.length + projection.citations.length + Object.values(projection.images).reduce((n, a) => n + a.length, 0) + 16));
  try {
    const context = globalContext();
    const referenceId = `${projection.binding.importKey}:synthetic-reference`;
    const messages = projection.messages.map(message => ({ ...message, conversation_id: target.conversationId }));
    messages.push({ id: referenceId, task_id: '', conversation_id: target.conversationId, role: 'user', content: REFERENCE_INSTRUCTION,
      timestamp: new Date(messages.length).toISOString(), portable_history: projection.binding });
    const snapshot: SkillPermissionSnapshot = { conversationId: target.conversationId, turnId: referenceId, capturedAt: '1970-01-01T00:00:00.000Z', skills: {} };
    const draft: Facts = { reference: 'synthetic', feedback: [], status: [], events: [], providerInputItems: [], compaction: [] };
    const footprint: ContextLimitFootprintFields = { ...root.footprint,
      inputLimitTokens: root.footprint.inputLimitTokens ?? undefined, outputLimitTokens: root.footprint.outputLimitTokens ?? undefined,
      contextLimitWarning: target.contextWarning ?? undefined };
    const budgetPolicy = { ...root.budget_policy, reservedTokens: root.budget_policy.reservedTokens ?? undefined,
      preserveRecentTokens: root.budget_policy.preserveRecentTokens ?? undefined };
    const messagePorts: ChatMessagePreparationPorts = {
      app: () => ({ mode: 'Chat', agentType: 'build', getProjectById: unavailable, activePlanContext: null, planNodes: [], selectedTaskId: null }),
      skills: () => ({ prepareSkillsForTurn: async ({ contextRefs }) => {
        ensure(!contextRefs?.length, 5);
        return { activatedSkills: [], systemInstructionBlocks: [], explicitSkillIds: [], warnings: [], toolsAvailable: false, permissionSnapshot: snapshot };
      }, getSkillById: unavailable, getEnabledLoadableSkills: unavailable }),
      executionContext: () => context, loadRiskLevel: async () => root.risk,
      repositoryInstructions: async execution => { ensure(execution.projectIds.length === 0, 5); return { contextBlock: null, sources: [], issues: [], totalBytes: 0 }; },
      contextCitations: () => projection.citations.filter(c => c.scope === 'context'), sourceCitations: () => projection.citations.filter(c => c.scope === 'source'),
      orderedMessages: () => messages, composerContextRefs: unavailable, messageImages: () => projection.images,
      loadModePrompt: async () => target.modePrompt, internalAgentProfilePromptKey: () => null, loadPrompt: unavailable,
      conversationTaskId: () => null, task: unavailable, previousAssistantContext: () => null,
      standaloneTaskInstruction: unavailable, taskArtifactContext: unavailable, architectPlanInstructions: unavailable,
    };
    const estimate: ChatRequestPreparationPorts['provider']['estimateSerializedPayloadTokens'] = params => estimateChatCompletionSerializedPayloadTokens({ ...params,
      providerType: params.providerType ?? undefined, providerId: params.providerId ?? undefined, baseUrl: params.baseUrl ?? undefined });
    const requestPorts: ChatRequestPreparationPorts = {
      isCurrent: () => true, // Native policy freshness remains mandatory on every fd boundary.
      tasks: { find: unavailable }, policy: { resolveInternalAgentProfile: unavailable, filterForInternalAgentProfile: unavailable },
      tools: { ensureLoaded: unavailable, loadStatus: unavailable, mcpSnapshot: unavailable, allowedForMode: unavailable,
        filterForImplementTask: unavailable, filterForArchitectPlan: unavailable, resolveScopedMcp: unavailable, reportUnavailableMcpServers: unavailable,
        definitions: ids => { ensure(ids.length === 0); return []; }, guidedRetry: unavailable },
      configuration: { loadScoped: unavailable, restrictTools: unavailable, loadRiskLevel: unavailable, loadMaxTurns: unavailable, webSearch: unavailable },
      skills: { createPermissionSnapshot: () => snapshot, publishFeedback: (id, value) => { draft.feedback.push({ id, value }); }, toolIdsForRequest: unavailable },
      context: { executionContext: () => context, prepareMessages: async () => prepareChatMessages({ conversationId: target.conversationId,
        allowedToolIds: [], modeAtSend: 'Chat', skillPermissionSnapshot: snapshot, executionContextOverride: context, riskLevelOverride: root.risk }, messagePorts),
        citations: () => projection.citations, fileRefPath: unavailable },
      provider: { supportsNativeToolCalling: unavailable,
        ensureContextMetadata: async (provider, model) => { ensure(provider === target.providerId && model === target.modelId, 5); return footprint; },
        modelContext: () => ({ footprintFields: footprint }), estimateSerializedPayloadTokens: estimate },
      compaction: { loadBudgetPolicy: async () => budgetPolicy, status: () => draft.status.at(-1)?.value ?? null,
        setStatus: (id, value) => { draft.status.push({ id, value }); }, recordEvent: async value => { draft.events.push(value); },
        compact: async params => {
          const result = await buildCompactedMessagesForRequest({ ...params, ...footprint, budgetPolicy, toolDefinitions: [],
            providerType: root.provider_type, currentCompactionState: target.currentCheckpoint as ConversationCompactionState | null,
            previousModelContextWindowTokens: target.currentCheckpoint?.modelContextWindowTokens, projectIdentity: `conversation:${target.conversationId}`,
            estimateSerializedPayloadTokens: values => estimate({ messages: values, providerType: root.provider_type, providerId: target.providerId,
              baseUrl: target.baseUrl, modelId: target.modelId }), countProviderInputItems: shouldCountProviderInputItemsForContext(root.provider_type), summaryPolicy: 'existing_only' });
          draft.compaction.push({ state: result.compactionState, usedExisting: result.usedExistingCompaction, degraded: result.degraded });
          return result;
        } },
      persistence: { providerInputItems: async (id, items) => { draft.providerInputItems.push({ id, items }); } },
    };
    const launch = await prepareAssistantStreamLaunch({ providerAdmission: { kind: 'conversation' }, conversationId: target.conversationId,
      replyToMessageId: referenceId, userContent: REFERENCE_INSTRUCTION, resolvedTaskId: '', modeAtSend: 'Chat', providerId: target.providerId,
      modelId: target.modelId, reasoningEffort: target.reasoningEffort, executionContext: context,
      providerConfig: { id: target.providerId, name: target.providerId, providerType: root.provider_type, baseUrl: target.baseUrl,
        hasStoredApiKey: false, isEnabled: true, isLocal: true },
      turnCapabilities: { allowedToolIds: [], riskLevel: root.risk, scopedTurnConfiguration: null, showToolTraces: false, internalAgentProfile: null,
        mcpTools: [], mcpServers: [], skillToolIds: [], runnableSkillToolIds: [], enableWebSearch: false, enableWebFetch: false,
        webSearchOptions: {}, guidedToolRetry: undefined, maxTurns: integer(root.max_turns) } }, requestPorts);
    await ports.policy();
    const sink = ports.client.start.handles.draft;
    const { messagesForRequest: diagnosticMessages, citations: diagnosticCitations, ...diagnosticSeed } = launch.contextDiagnosticsBaselineSeed;
    const requestMetadata = [{ kind: 'reference-request', reference: 'synthetic', provider_type: root.provider_type, provider_id: target.providerId,
      model_id: target.modelId, base_url: target.baseUrl, reasoning_effort: target.reasoningEffort, diagnostics: diagnosticSeed,
      diagnostic_messages: diagnosticMessages.length, diagnostic_citations: diagnosticCitations.length,
      compactionDecision: launch.compactionDecision, native_builder_required: true },
      ...diagnosticMessages.map((value, index) => ({ kind: 'diagnostic-message', index, value })),
      ...diagnosticCitations.map((value, index) => ({ kind: 'diagnostic-citation', index, value }))];
    for (const [kind, values] of [['message', projection.messages], ['citation', projection.citations], ['image', Object.entries(projection.images).map(([messageId, images]) => ({ messageId, images }))],
      ['reference-message', [messages.at(-1)]], ['prepared-message', projectNativeMessages(launch.messagesForRequest, root.provider_type)],
      ['effect-draft', [draft]], ['request-metadata', requestMetadata]] as const) {
      await ports.collection(sink, kind, values);
    }
    await ports.policy();
  } finally { release(); }
}
