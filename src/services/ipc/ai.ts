/** ai IPC wrappers and frontend adapters. */

import type {
  ProjectMount,
  ProviderTurnState,
  ToolTrace,
} from "../../types";
import { invoke } from "../tauriRuntimeBridge";
import { parseToolTracesJson as parseSerializedToolTracesJson } from "../toolTraceState";
import type {
  AiChatMessage,
  CopilotStatusDto,
  DevProviderOverridesFile,
  MacroAiProvisioningStatusDto,
} from "./ai.types";
import type {
  DbAiModel,
  DbProviderConfig,
} from "./providers.types";

export const parseProviderInputItemsJson = (
  raw: string | null,
): unknown[] | undefined => {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const parseProviderTurnStateJson = (
  raw: string | null,
): ProviderTurnState | undefined => {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as ProviderTurnState | null;
    if (!parsed || parsed.provider !== "chatgpt" || !Array.isArray(parsed.output_items)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};

export const parseToolTracesJson = (raw: string | null): ToolTrace[] | undefined => {
  return parseSerializedToolTracesJson(raw);
};

export async function aiStartChatGptAuth(params: {
  requestId: string;
  providerId?: string;
}): Promise<void> {
  return invoke("ai_start_chatgpt_auth", {
    requestId: params.requestId,
    providerId: params.providerId ?? null,
  });
}

export async function aiCancelChatGptAuth(requestId: string): Promise<void> {
  return invoke("ai_cancel_chatgpt_auth", { requestId });
}

export async function aiGetCopilotStatus(
  providerId?: string,
): Promise<CopilotStatusDto> {
  return invoke<CopilotStatusDto>("ai_get_copilot_status", {
    providerId: providerId ?? null,
  });
}

export async function aiDownloadCopilotRuntime(params: {
  requestId: string;
  providerId?: string;
}): Promise<void> {
  return invoke("ai_download_copilot_runtime", {
    requestId: params.requestId,
    providerId: params.providerId ?? null,
  });
}

export async function aiCancelCopilotRuntimeDownload(
  requestId: string,
): Promise<void> {
  return invoke("ai_cancel_copilot_runtime_download", { requestId });
}

export async function aiStartCopilotAuth(params: {
  requestId: string;
  providerId?: string;
}): Promise<void> {
  return invoke("ai_start_copilot_auth", {
    requestId: params.requestId,
    providerId: params.providerId ?? null,
  });
}

export async function aiCancelCopilotAuth(requestId: string): Promise<void> {
  return invoke("ai_cancel_copilot_auth", { requestId });
}

export async function aiDisconnectProviderAuth(
  providerId: string,
): Promise<DbProviderConfig> {
  return invoke<DbProviderConfig>("ai_disconnect_provider_auth", {
    providerId,
  });
}

export async function aiSyncProviderModels(
  providerId: string,
): Promise<DbAiModel[]> {
  return invoke<DbAiModel[]>("ai_sync_provider_models", { providerId });
}

export async function aiProvisionMacroAi(): Promise<MacroAiProvisioningStatusDto> {
  return invoke<MacroAiProvisioningStatusDto>("ai_provision_macro_ai");
}

export async function aiGetDevProviderOverrides(): Promise<DevProviderOverridesFile | null> {
  return invoke<DevProviderOverridesFile | null>(
    "ai_get_dev_provider_overrides",
  );
}

export async function aiStreamChat(params: {
  requestId: string;
  providerId: string;
  modelId: string;
  reasoningEffort?: string | null;
  conversationId?: string | null;
  messages: AiChatMessage[];
  tools?: unknown[];
  toolChoice?: string;
  parallelToolCalls?: boolean;
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  allowedToolIds?: string[];
  copilotSendTimeoutMs?: number | null;
}): Promise<void> {
  return invoke("ai_stream_chat", {
    request: {
      request_id: params.requestId,
      provider_id: params.providerId,
      model_id: params.modelId,
      reasoning_effort: params.reasoningEffort ?? null,
      conversation_id: params.conversationId ?? null,
      messages: params.messages,
      tools: params.tools ?? [],
      tool_choice: params.toolChoice ?? "auto",
      parallel_tool_calls: params.parallelToolCalls ?? false,
      workspace_path: params.workspacePath ?? null,
      default_workspace_path: params.defaultWorkspacePath ?? null,
      project_mounts: (params.projectMounts ?? []).map((mount) => ({
        project_id: mount.projectId,
        mount_name: mount.mountName,
        workspace_path: mount.workspacePath ?? null,
        display_name: mount.displayName,
      })),
      virtual_root_enabled: params.virtualRootEnabled ?? null,
      focused_project_id: params.focusedProjectId ?? null,
      allowed_tool_ids: params.allowedToolIds ?? [],
      copilot_send_timeout_ms: params.copilotSendTimeoutMs ?? null,
    },
  });
}

export async function aiCancelStream(requestId: string): Promise<void> {
  return invoke("ai_cancel_stream", { requestId });
}

export async function aiSubmitToolResult(params: {
  requestId: string;
  toolCallId: string;
  submissionId?: string;
  result: string;
  blocks?: import('../../shared/toolResultContent').ToolResultBlock[];
  hiddenContext?: string | null;
  visibleContent?: string | null;
  interrupt?: boolean;
  isError?: boolean;
  errorKind?: "validation" | "permission" | "execution" | "aborted";
}): Promise<void> {
  return invoke("ai_submit_tool_result", {
    request: {
      request_id: params.requestId,
      tool_call_id: params.toolCallId,
      ...(params.submissionId ? { submission_id: params.submissionId } : {}),
      result: params.result,
      ...(params.blocks ? { blocks: params.blocks } : {}),
      hidden_context: params.hiddenContext ?? null,
      visible_content: params.visibleContent ?? null,
      interrupt: params.interrupt ?? false,
      is_error: params.isError ?? false,
      error_kind: params.errorKind ?? null,
    },
  });
}
