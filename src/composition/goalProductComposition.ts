import type { ReasoningEffort } from '../types';
import i18n from '../i18n';
import { useChatStore } from '../stores/useChatStore';
import { useConversationGoalStore } from '../stores/useConversationGoalStore';
import { isProviderTransportUnavailable, useProviderStore } from '../stores/useProviderStore';
import { useAppStore } from '../stores/useAppStore';
import { notify } from '../components/ui/toastService';
import { isLinkedProviderType, providerHasUsableCredentials } from '../services/providerCredentials';
import { getAllProjects } from '../services/globalProjects';
import { createNativeGoalAuditVerdictPort, listRecoverableConversationGoalAudits } from '../services/ipc/conversationGoals';
import { createDurableGoalAuditCoordinator } from '../services/conversationGoalAudit/durableCoordinator';
import { resolveNativeGoalAuditChildConversation } from '../services/conversationGoalAudit/nativeChildConversation';
import { executeNativeGoalAuditReadTool } from '../services/conversationGoalAudit/nativeReadTool';
import { createGoalAuditProviderResolver } from '../services/conversationGoalAudit/providerResolver';
import { ConversationGoalProductRepository } from '../services/conversationGoalAudit/productRepository';
import { ConversationGoalProductFlow, type GoalProductFlowPorts } from '../services/conversationGoalAudit/productFlow';
import { saveGoalAuditArtifact } from './goalArtifactComposition';

const nativePorts = (): GoalProductFlowPorts => ({
  repository: new ConversationGoalProductRepository(),
  readRuntime: (id) => useChatStore.getState().getConversationRuntime(id),
  readMessages: (id) => useChatStore.getState().getConversationMessages(id),
  readQueuedCount: (id) => useChatStore.getState().pendingQueuedSubmissions.filter((entry) => entry.conversationId === id).length,
  readQueuedTurnIds: (id) => useChatStore.getState().pendingQueuedSubmissions.filter((entry) => entry.conversationId === id).map((entry) => entry.id),
  readQueuedAttemptedTurnIds: (id) => useChatStore.getState().attemptedQueuedSubmissions.filter((entry) => entry.conversationId === id).map((entry) => entry.id),
  sendContinuation: (id, content) => useChatStore.getState().sendMessage({ conversationId: id, content }),
  listRecoverable: listRecoverableConversationGoalAudits,
  subscribe: (listener) => useChatStore.subscribe(listener),
  publish: (id, goal) => useConversationGoalStore.getState().hydrateGoal(id, goal),
  onArtifactFailure: (message) => notify.error(i18n.t('goal.artifactSaveFailed', 'Could not save the Goal review artifact'), { description: message }),
  audit: (goal, turnId, summary) => {
    const auditId = crypto.randomUUID();
    const provider = useProviderStore.getState();
    const conversation = useChatStore.getState().conversations.find((item) => item.id === goal.conversationId);
    const app = useAppStore.getState();
    const project = getAllProjects(app.projectGroups, app.standaloneProjects).find((item) => item.id === conversation?.project_id);
    const providerId = goal.providerId ?? conversation?.provider_id ?? provider.selectedProviderId;
    const modelId = goal.modelId ?? conversation?.model_id ?? provider.selectedModelId;
    if (!providerId || !modelId) throw new Error('No model is configured for the goal auditor.');
    const selection = { providerId, modelId, effort: (goal.reasoningEffort ?? undefined) as ReasoningEffort | undefined, workspacePath: project?.path };
    const resolver = createGoalAuditProviderResolver(selection, {
      readSnapshot: (id, model) => {
        const state = useProviderStore.getState();
        const config = state.providerConfigs.find((item) => item.id === id);
        return {
          config,
          model: state.modelsByProvider[id]?.find((item) => item.id === model),
          hasCredentials: Boolean(config && providerHasUsableCredentials(config)),
          availableReasoningEfforts: state.getAvailableReasoningEfforts(id, model),
          transportUnavailable: isProviderTransportUnavailable(id),
          requiresApiKey: Boolean(config && !config.isLocal && !isLinkedProviderType(config.providerType)),
        };
      },
      resolveApiKey: (id) => useProviderStore.getState().resolveProviderApiKey(id),
    });
    const coordinator = createDurableGoalAuditCoordinator({
      goalClaim: { auditId, conversationId: goal.conversationId, executorTurnId: turnId, goalId: goal.goalId, expectedRevision: goal.revision },
      verdictPort: createNativeGoalAuditVerdictPort(auditId, turnId),
      providerPorts: {
        resolveProvider: resolver,
        resolveChildConversation: resolveNativeGoalAuditChildConversation,
        executeReadTool: executeNativeGoalAuditReadTool,
      },
    });
    const handle = coordinator.startAudit({
      conversationId: goal.conversationId,
      goalId: goal.goalId,
      goalRevision: goal.revision,
      objective: goal.objective,
      successCriteria: goal.successCriteria.length ? goal.successCriteria : [goal.objective],
      lastExecutorTurn: { turnId, summary },
      userPolicy: { capabilities: ['workspace.read', 'git.read', 'delegate'] },
      parentPolicy: { capabilities: ['workspace.read', 'git.read', 'delegate'] },
      timeoutMs: 120_000,
    });
    void handle.result.finally(() => coordinator.dispose());
    return Object.assign(handle, { auditId });
  },
  saveArtifact: async ({ auditId, runId, goal, turnId, messageId, result }) => {
    const conversation = useChatStore.getState().conversations.find((item) => item.id === goal.conversationId);
    if (!conversation?.project_id) throw new Error('A project is required for goal audit artifacts.');
    await saveGoalAuditArtifact({ projectId: conversation.project_id, conversationId: goal.conversationId,
      goalId: goal.goalId, goalRevision: goal.revision, executorTurnId: turnId,
      runId, auditId, messageId, result });
  },
});

export const conversationGoalProductFlow = new ConversationGoalProductFlow(nativePorts());
