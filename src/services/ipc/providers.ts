/** providers IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type {
  DbAiModel,
  DbProviderConfig,
  DbProviderModelInput,
  DbProviderSettings,
} from "./providers.types";

export async function listProviderConfigs(): Promise<DbProviderConfig[]> {
  return invoke<DbProviderConfig[]>("db_list_provider_configs");
}

export async function getProviderConfig(
  id: string,
): Promise<DbProviderConfig | null> {
  return invoke<DbProviderConfig | null>("db_get_provider_config", { id });
}

export async function revealProviderApiKey(id: string): Promise<string | null> {
  return invoke<string | null>("db_reveal_provider_api_key", { id });
}

export async function updateProviderConfig(params: {
  id: string;
  name?: string;
  providerType?: string;
  baseUrl?: string;
  apiKey?: string;
  isLocal?: boolean;
  isEnabled?: boolean;
}): Promise<void> {
  return invoke("db_update_provider_config", {
    params: {
      id: params.id,
      name: params.name ?? null,
      providerType: params.providerType ?? null,
      baseUrl: params.baseUrl ?? null,
      apiKey: params.apiKey ?? null,
      isLocal: params.isLocal ?? null,
      isEnabled: params.isEnabled ?? null,
    },
  });
}

export async function createProviderConfig(params: {
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  isLocal: boolean;
}): Promise<DbProviderConfig> {
  return invoke<DbProviderConfig>("db_create_provider_config", {
    name: params.name,
    providerType: params.providerType,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey ?? null,
    isLocal: params.isLocal,
  });
}

export async function deleteProviderConfig(id: string): Promise<void> {
  return invoke("db_delete_provider_config", { id });
}

export async function listProviderModels(
  providerId: string,
): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_list_provider_models", { providerId });
}

export async function upsertProviderModels(params: {
  providerId: string;
  models: DbProviderModelInput[];
  replaceDiscovered?: boolean;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_upsert_provider_models", {
    providerId: params.providerId,
    models: params.models,
    replaceDiscovered: params.replaceDiscovered ?? false,
  });
}

export async function registerManualModel(params: {
  providerId: string;
  modelId: string;
  name: string;
  reasoning?: {
    reasoningEfforts: string[];
    defaultReasoningEffort: string | null;
  } | null;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_register_manual_model", {
    providerId: params.providerId,
    modelId: params.modelId,
    name: params.name,
    reasoning: params.reasoning ?? null,
  });
}

export async function updateManualModel(params: {
  providerId: string;
  currentModelId: string;
  nextModelId: string;
  name: string;
  reasoning?: {
    reasoningEfforts: string[];
    defaultReasoningEffort: string | null;
  } | null;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_update_manual_model", {
    providerId: params.providerId,
    currentModelId: params.currentModelId,
    nextModelId: params.nextModelId,
    name: params.name,
    reasoning: params.reasoning ?? null,
  });
}

export async function deleteManualModel(params: {
  providerId: string;
  modelId: string;
}): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("db_delete_manual_model", {
    providerId: params.providerId,
    modelId: params.modelId,
  });
}

export async function setProviderModelEnabled(params: {
  providerId: string;
  modelId: string;
  enabled: boolean;
}): Promise<void> {
  return invoke("db_set_provider_model_enabled", {
    providerId: params.providerId,
    modelId: params.modelId,
    enabled: params.enabled,
  });
}

export async function setAllProviderModelsEnabled(params: {
  providerId: string;
  enabled: boolean;
}): Promise<void> {
  return invoke("db_set_all_provider_models_enabled", {
    providerId: params.providerId,
    enabled: params.enabled,
  });
}

export async function getProviderSettings(
  providerId: string,
): Promise<DbProviderSettings> {
  return invoke<DbProviderSettings>("db_get_provider_settings", { providerId });
}

export async function updateProviderSettings(params: {
  providerId: string;
  filterFreeModels?: boolean;
  copilotSendTimeoutMs?: number | null;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    providerId: params.providerId,
  };
  if (Object.prototype.hasOwnProperty.call(params, "filterFreeModels")) {
    payload.filterFreeModels = params.filterFreeModels;
  }
  if (Object.prototype.hasOwnProperty.call(params, "copilotSendTimeoutMs")) {
    payload.copilotSendTimeoutMs = params.copilotSendTimeoutMs ?? null;
  }
  return invoke("db_update_provider_settings", payload);
}
