import type { AIModel, ProviderConfig, ReasoningEffort } from "../../types";
import type { GoalAuditProvider, GoalAuditProviderPorts } from "./providerExecutor";

export interface GoalAuditProviderSelection {
  providerId: string;
  modelId: string;
  effort?: ReasoningEffort;
  workspacePath?: string;
}

export interface GoalAuditProviderSnapshot {
  config?: ProviderConfig;
  model?: AIModel;
  hasCredentials: boolean;
  availableReasoningEfforts: readonly ReasoningEffort[];
  transportUnavailable: boolean;
  requiresApiKey: boolean;
}

export interface GoalAuditProviderResolutionPort {
  readSnapshot(providerId: string, modelId: string): GoalAuditProviderSnapshot;
  resolveApiKey(providerId: string): Promise<string | undefined>;
}

const abortError = () => new DOMException("Aborted", "AbortError");

const awaitKey = (
  port: GoalAuditProviderResolutionPort,
  providerId: string,
  signal: AbortSignal,
): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    port.resolveApiKey(providerId).then(
      (key) => resolve(key),
      (error) => reject(error),
    ).finally(() => signal.removeEventListener("abort", onAbort));
  });

/** Bind an explicit selection at audit start; UI selection changes cannot redirect the child. */
export function createGoalAuditProviderResolver(
  selection: GoalAuditProviderSelection,
  port: GoalAuditProviderResolutionPort,
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
      const snapshot = port.readSnapshot(providerId, modelId);
      const { config, model } = snapshot;
      if (snapshot.transportUnavailable) {
        throw new Error("Goal auditor provider configuration changed during resolution.");
      }
      if (!config?.isEnabled || !snapshot.hasCredentials || !config.baseUrl?.trim()) {
        throw new Error("Goal auditor provider is unavailable or disabled.");
      }
      if (!model || model.isEnabled === false || model.provider_id !== providerId) {
        throw new Error("Goal auditor model is unavailable or disabled.");
      }
      if (effort && !snapshot.availableReasoningEfforts.includes(effort)) {
        throw new Error("Goal auditor reasoning effort is unavailable for this model.");
      }
      return { ...snapshot, config, model };
    };

    const { config } = resolveConfig();
    const apiKey = await awaitKey(port, providerId, signal);
    if (signal.aborted) throw abortError();
    const currentSnapshot = resolveConfig();
    const current = currentSnapshot.config;
    const initial = config;
    if (current.providerType !== initial.providerType || current.baseUrl !== initial.baseUrl ||
      current.isLocal !== initial.isLocal || current.authStatus !== initial.authStatus) {
      throw new Error("Goal auditor provider configuration changed during resolution.");
    }
    if (currentSnapshot.requiresApiKey && !apiKey?.trim()) {
      throw new Error("Goal auditor provider API key is unavailable.");
    }
    if (currentSnapshot.requiresApiKey && current.apiKey !== apiKey) {
      throw new Error("Goal auditor provider API key changed during resolution.");
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
