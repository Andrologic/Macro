import { createGoalAuditProviderResolver, type GoalAuditProviderResolutionPort, type GoalAuditProviderSelection } from "../services/conversationGoalAudit/providerResolver";
import { isLinkedProviderType, isProviderTransportUnavailable, providerHasCredentials, useProviderStore } from "./useProviderStore";

export const goalAuditProviderPort: GoalAuditProviderResolutionPort = {
  readSnapshot(providerId, modelId) {
    const state = useProviderStore.getState();
    const config = state.providerConfigs.find((entry) => entry.id === providerId);
    return {
      config,
      model: state.modelsByProvider[providerId]?.find((entry) => entry.id === modelId),
      hasCredentials: config ? providerHasCredentials(config) : false,
      availableReasoningEfforts: state.getAvailableReasoningEfforts(providerId, modelId),
      transportUnavailable: isProviderTransportUnavailable(providerId),
      requiresApiKey: !!config && !config.isLocal && !isLinkedProviderType(config.providerType),
    };
  },
  resolveApiKey(providerId) {
    return useProviderStore.getState().resolveProviderApiKey(providerId);
  },
};

export const createStoreGoalAuditProviderResolver = (selection: GoalAuditProviderSelection) =>
  createGoalAuditProviderResolver(selection, goalAuditProviderPort);
