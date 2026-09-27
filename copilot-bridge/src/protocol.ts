import { normalizeToolResultBlocks, type ToolResultBlock } from '../../src/shared/toolResultContent';
import type { BridgeToolResultMessage as NativeBridgeToolResultMessage } from '../../src/types/generated/ipc/BridgeToolResultMessage';

export type JsonRecord = Record<string, unknown>;

export interface BridgeProjectMount {
  project_id: string;
  mount_name: string;
  workspace_path: string | null;
  display_name?: string;
}

export interface BridgeChatMessageImageUrl {
  url: string;
}

export interface BridgeChatMessagePart {
  type: string;
  text?: string;
  image_url?: BridgeChatMessageImageUrl;
}

export interface BridgeToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface BridgeChatMessage {
  role: string;
  content: string | BridgeChatMessagePart[];
  tool_calls?: BridgeToolCall[];
  tool_call_id?: string;
}

export interface BridgeSendRequest {
  request_id?: string;
  model_id: string;
  reasoning_effort?: string | null;
  messages: BridgeChatMessage[];
  allowed_tool_ids?: string[];
  tools?: unknown[];
  workspace_path?: string | null;
  default_workspace_path?: string | null;
  project_mounts?: BridgeProjectMount[];
  virtual_root_enabled?: boolean;
  focused_project_id?: string | null;
  copilot_send_timeout_ms?: number | null;
}

export interface ToolTraceSnapshot {
  tool_call_id: string;
  tool_name: string;
  detail?: string;
  status: 'running' | 'done';
}

export type BridgeToolRequestMessage = {
  type: 'tool_request';
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  args: JsonRecord;
};

// Older senders may omit payload fields or send a channel error. Keep that
// compatibility at the decoder boundary while deriving field types from Rust.
type HistoricalToolResultField =
  | 'blocks'
  | 'result'
  | 'hidden_context'
  | 'visible_content'
  | 'interrupt'
  | 'is_error'
  | 'error_kind';

export type BridgeToolResultMessage =
  Omit<NativeBridgeToolResultMessage, HistoricalToolResultField>
  & Partial<Pick<NativeBridgeToolResultMessage, HistoricalToolResultField>>
  & { error?: string };

export interface RelayToolResult {
  blocks?: ToolResultBlock[];
  result: string;
  isError?: boolean;
  errorKind?: string | null;
  hiddenContext?: string;
  visibleContent?: string;
  interrupt?: boolean;
}

export class BridgeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Channel failures reject the SDK handler; business errors resolve as tool results.
export class BridgeControlError extends BridgeError {}

export const validateControlId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BridgeControlError('invalid_control_message', `Invalid Copilot ${field}.`);
  }
  return value;
};

/** Decode only control messages. Unknown message kinds remain forward compatible. */
export const decodeToolResultMessage = (value: unknown): BridgeToolResultMessage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  if (record.type !== 'tool_result') return null;

  const requestId = validateControlId(record.request_id, 'request_id');
  const toolCallId = validateControlId(record.tool_call_id, 'tool_call_id');
  for (const field of ['result', 'error'] as const) {
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      throw new BridgeControlError('invalid_control_message', `Invalid Copilot ${field}.`);
    }
  }
  for (const field of ['hidden_context', 'visible_content', 'error_kind'] as const) {
    if (record[field] != null && typeof record[field] !== 'string') {
      throw new BridgeControlError('invalid_control_message', `Invalid Copilot ${field}.`);
    }
  }
  for (const field of ['interrupt', 'is_error'] as const) {
    if (record[field] !== undefined && typeof record[field] !== 'boolean') {
      throw new BridgeControlError('invalid_control_message', `Invalid Copilot ${field}.`);
    }
  }

  return {
    type: 'tool_result',
    request_id: requestId,
    tool_call_id: toolCallId,
    result: record.result as string | undefined,
    ...(record.blocks !== undefined ? { blocks: normalizeToolResultBlocks(record.blocks) } : {}),
    hidden_context: record.hidden_context as string | null | undefined,
    visible_content: record.visible_content as string | null | undefined,
    interrupt: record.interrupt as boolean | undefined,
    is_error: record.is_error as boolean | undefined,
    error_kind: record.error_kind as string | null | undefined,
    error: record.error as string | undefined,
  };
};
