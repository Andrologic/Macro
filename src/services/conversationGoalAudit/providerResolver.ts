import { useProviderStore, providerHasCredentials, isLinkedProviderType } from "../../stores/useProviderStore";
import type { ReasoningEffort } from "../../types";
import type { GoalAuditProvider, GoalAuditProviderPorts } from "./providerExecutor";

export interface GoalAuditProviderSelection {
  providerId: string;
  modelId: string;
  effort?: ReasoningEffort;
  workspacePath?: string;
}

const abortError = () => new DOMException("Aborted", "AbortError");

const awaitKey = (providerId: string, signal: AbortSignal): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    useProviderStore.getState().resolveProviderApiKey(providerId).then(
      (key) => resolve(key),
      (error) => reject(error),
    ).finally(() => signal.removeEventListener("abort", onAbort));
  });

/** Bind an explicit selection at audit start; UI selection changes cannot redirect the child. */
export function createGoalAuditProviderResolver(
  selection: GoalAuditProviderSelection,
): GoalAuditProviderPorts["resolveProvider"] {
  const { providerId, modelId, effort, workspacePath } = { ...selection };
  return async (input, signal): Promise<GoalAuditProvider> => {
    if (signal.aborted) throw abortError();
    if (!providerId?.trim() || !modelId?.trim() ||
      (input.authorization.model && input.authorization.model !== modelId) ||
      (input.authorization.effort && input.authorization.effort !== effort)) {
      throw new Error("Goal auditor provider selection conflicts with its authorization.");
    }

    const resolveConfig = () => {
      const state = useProviderStore.getState();
      const config = state.providerConfigs.find((entry) => entry.id === providerId);
      const model = state.modelsByProvider[providerId]?.find((entry) => entry.id === modelId);
      if (!config?.isEnabled || !providerHasCredentials(config) || !config.baseUrl?.trim()) {
        throw new Error("Goal auditor provider is unavailable or disabled.");
      }
      if (!model || model.isEnabled === false || model.provider_id !== providerId) {
        throw new Error("Goal auditor model is unavailable or disabled.");
      }
      if (effort && !state.getAvailableReasoningEfforts(providerId, modelId).includes(effort)) {
        throw new Error("Goal auditor reasoning effort is unavailable for this model.");
      }
      return config;
    };

    const config = resolveConfig();
    const apiKey = await awaitKey(providerId, signal);
    if (signal.aborted) throw abortError();
    const current = resolveConfig();
    if (current.providerType !== config.providerType || current.baseUrl !== config.baseUrl ||
      current.isLocal !== config.isLocal || current.authStatus !== config.authStatus) {
      throw new Error("Goal auditor provider configuration changed during resolution.");
    }
    if (!current.isLocal && !isLinkedProviderType(current.providerType) && !apiKey?.trim()) {
      throw new Error("Goal auditor provider API key is unavailable.");
    }
    return {
      providerId,
      providerType: current.providerType,
      baseUrl: current.baseUrl,
      apiKey,
      modelId,
      reasoningEffort: effort,
      workspacePath,
    };
  };
}
