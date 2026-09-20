import type { OmitFields } from './compatibility.types';
import type {
AiAuthCancelledEvent as NativeAiAuthCancelledEvent,
AiAuthErrorEvent as NativeAiAuthErrorEvent,
AiAuthStartedEvent as NativeAiAuthStartedEvent,
AiAuthSuccessEvent as NativeAiAuthSuccessEvent,
AiChatMessage as NativeAiChatMessage,
AiChatMessageContent as NativeAiChatMessageContent,
AiChatImageUrl as NativeAiChatMessageImageUrl,
AiChatMessagePart as NativeAiChatMessagePart,
AiStreamChunkEvent as NativeAiStreamChunkEvent,
AiStreamDoneEvent as NativeAiStreamDoneEvent,
AiStreamErrorEvent as NativeAiStreamErrorEvent,
AiStreamTimelineEvent as NativeAiStreamTimelineEvent,
AiStreamToolTraceEvent as NativeAiStreamToolTraceEvent,
AiToolCall as NativeAiToolCall,
CopilotToolRequestEvent as NativeAiToolRequestEvent,
CopilotAuthCancelledEvent as NativeCopilotAuthCancelledEvent,
CopilotAuthCompleteEvent as NativeCopilotAuthCompleteEvent,
CopilotAuthErrorEvent as NativeCopilotAuthErrorEvent,
CopilotAuthProgressEvent as NativeCopilotAuthProgressEvent,
CopilotDownloadCompleteEvent as NativeCopilotDownloadCompleteEvent,
CopilotDownloadErrorEvent as NativeCopilotDownloadErrorEvent,
CopilotDownloadProgressEvent as NativeCopilotDownloadProgressEvent,
CopilotStatus as NativeCopilotStatusDto,
DevProviderOverrideConfig as NativeDevProviderOverrideConfig,
DevProviderOverridesFile as NativeDevProviderOverridesFile,
MacroAiProvisioningStatus as NativeMacroAiProvisioningStatusDto
} from '../../types/generated/ipc';

/** ai IPC contracts and explicit frontend adaptations of generated native bindings. */

import type {
ChatCompletionReason,
ProviderTurnState,
ToolTrace,
} from "../../types";

export type MacroAiProvisioningStatusDto = NativeMacroAiProvisioningStatusDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DevProviderOverrideConfig = OmitFields<NativeDevProviderOverrideConfig,
  | "name"
  | "providerType"
  | "apiKey"
  | "baseUrl"
  | "isLocal"
> & {
  name?: string;
  providerType?: string;
  apiKey?: string;
  baseUrl?: string;
  isLocal?: boolean;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DevProviderOverridesFile = OmitFields<NativeDevProviderOverridesFile, "providers"> & {
  providers?: Record<string, DevProviderOverrideConfig>;
};

export type AiChatMessageImageUrl = NativeAiChatMessageImageUrl;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type AiChatMessagePart = OmitFields<NativeAiChatMessagePart, "text" | "image_url"> & {
  text?: string;
  image_url?: AiChatMessageImageUrl;
};

// Text follows the native union; image/text parts keep the frontend omission rules.
export type AiChatMessageContent = Extract<NativeAiChatMessageContent, string> | AiChatMessagePart[];

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type AiChatMessage = OmitFields<NativeAiChatMessage,
  | "content"
  | "tool_calls"
  | "tool_call_id"
  | "provider_input_items"
  | "provider_turn_state"
> & {
  content: AiChatMessageContent;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
  provider_input_items?: unknown[];
  provider_turn_state?: ProviderTurnState;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type AiToolCall = OmitFields<NativeAiToolCall, "type"> & {
  type: "function";
};

export type AiStreamChunkEvent = NativeAiStreamChunkEvent;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type AiStreamToolTraceEvent = OmitFields<NativeAiStreamToolTraceEvent, "tool_trace"> & {
  tool_trace: ToolTrace;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type AiToolRequestEvent = OmitFields<NativeAiToolRequestEvent, "args"> & {
  args: Record<string, unknown>;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type AiStreamDoneEvent = OmitFields<NativeAiStreamDoneEvent,
  | "tool_calls"
  | "response_id"
  | "output_items"
  | "provider_input_items"
  | "provider_turn_state"
  | "reasoning_summary"
  | "tool_traces"
  | "hidden_context"
  | "completion_reason"
> & {
  tool_calls: AiToolCall[];
  response_id?: string | null;
  output_items?: unknown[] | null;
  provider_input_items?: unknown[] | null;
  provider_turn_state?: ProviderTurnState | null;
  reasoning_summary?: string | null;
  tool_traces?: ToolTrace[] | null;
  hidden_context?: string | null;
  completion_reason?: ChatCompletionReason | null;
};

export type AiStreamErrorEvent = NativeAiStreamErrorEvent;

export type AiStreamTimelineEvent = NativeAiStreamTimelineEvent;

export type AiAuthStartedEvent = NativeAiAuthStartedEvent;

export type AiAuthSuccessEvent = NativeAiAuthSuccessEvent;

export type AiAuthCancelledEvent = NativeAiAuthCancelledEvent;

export type AiAuthErrorEvent = NativeAiAuthErrorEvent;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type CopilotStatusDto = OmitFields<NativeCopilotStatusDto, "runtime_source" | "runtime_status"> & {
  runtime_source: "managed" | "system" | "none";
  runtime_status:
    | "ready"
    | "missing"
    | "downloading"
    | "update_required"
    | "error";
};

export type CopilotDownloadProgressEvent = NativeCopilotDownloadProgressEvent;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type CopilotDownloadCompleteEvent = OmitFields<NativeCopilotDownloadCompleteEvent, "runtime_source" | "status"> & {
  runtime_source: "managed" | "system" | "none";
  status?: CopilotStatusDto;
};

export type CopilotDownloadErrorEvent = NativeCopilotDownloadErrorEvent;

export type CopilotAuthProgressEvent = NativeCopilotAuthProgressEvent;

export type CopilotAuthCompleteEvent = NativeCopilotAuthCompleteEvent;

export type CopilotAuthCancelledEvent = NativeCopilotAuthCancelledEvent;

export type CopilotAuthErrorEvent = NativeCopilotAuthErrorEvent;
