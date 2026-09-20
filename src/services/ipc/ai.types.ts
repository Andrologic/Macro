/** ai IPC DTOs. Kept separate for generated Rust binding integration. */

import type {
  ChatCompletionReason,
  ProviderTurnState,
  ToolTrace,
} from "../../types";

export interface MacroAiProvisioningStatusDto {
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  activatedNow: boolean;
}

export interface DevProviderOverrideConfig {
  name?: string;
  providerType?: string;
  apiKey?: string;
  baseUrl?: string;
  isLocal?: boolean;
}

export interface DevProviderOverridesFile {
  providers?: Record<string, DevProviderOverrideConfig>;
}

export interface AiChatMessageImageUrl {
  url: string;
}

export interface AiChatMessagePart {
  type: string;
  text?: string;
  image_url?: AiChatMessageImageUrl;
}

export type AiChatMessageContent = string | AiChatMessagePart[];

export interface AiChatMessage {
  role: string;
  content: AiChatMessageContent;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
  provider_input_items?: unknown[];
  provider_turn_state?: ProviderTurnState;
}

export interface AiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface AiStreamChunkEvent {
  request_id: string;
  delta: string;
}

export interface AiStreamToolTraceEvent {
  request_id: string;
  tool_trace: ToolTrace;
}

export interface AiToolRequestEvent {
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
}

export interface AiStreamDoneEvent {
  request_id: string;
  output_text: string;
  tool_calls: AiToolCall[];
  response_id?: string | null;
  output_items?: unknown[] | null;
  provider_input_items?: unknown[] | null;
  provider_turn_state?: ProviderTurnState | null;
  reasoning_summary?: string | null;
  tool_traces?: ToolTrace[] | null;
  hidden_context?: string | null;
  completion_reason?: ChatCompletionReason | null;
}

export interface AiStreamErrorEvent {
  request_id: string;
  message: string;
}

export interface AiStreamTimelineEvent {
  request_id: string;
  provider_id: string;
  provider_type: string;
  phase: string;
  elapsed_ms: number;
}

export interface AiAuthStartedEvent {
  request_id: string;
  provider_id: string;
}

export interface AiAuthSuccessEvent {
  request_id: string;
  provider_id: string;
}

export interface AiAuthCancelledEvent {
  request_id: string;
  provider_id: string;
}

export interface AiAuthErrorEvent {
  request_id: string;
  provider_id: string;
  code: string;
  message: string;
}

export interface CopilotStatusDto {
  ok: boolean;
  runtime_source: "managed" | "system" | "none";
  runtime_status:
    | "ready"
    | "missing"
    | "downloading"
    | "update_required"
    | "error";
  runtime_version: string | null;
  min_cli_version: string;
  auth_status: string;
  auth_source: string | null;
  account_label: string | null;
  status_message: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface CopilotDownloadProgressEvent {
  request_id: string;
  provider_id: string;
  phase: string;
  message: string;
  downloaded_bytes: number;
  total_bytes: number | null;
}

export interface CopilotDownloadCompleteEvent {
  request_id: string;
  provider_id: string;
  runtime_version: string;
  runtime_source: "managed" | "system" | "none";
  status?: CopilotStatusDto;
}

export interface CopilotDownloadErrorEvent {
  request_id: string;
  provider_id: string;
  code: string;
  message: string;
}

export interface CopilotAuthProgressEvent {
  request_id: string;
  provider_id: string;
  phase: string;
  message: string;
  verification_url: string | null;
  user_code: string | null;
}

export interface CopilotAuthCompleteEvent {
  request_id: string;
  provider_id: string;
}

export interface CopilotAuthCancelledEvent {
  request_id: string;
  provider_id: string;
}

export interface CopilotAuthErrorEvent {
  request_id: string;
  provider_id: string;
  code: string;
  message: string;
}
