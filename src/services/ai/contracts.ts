import type { AppMode, ChatCompletionReason, MCPTool, ProjectMount, ProviderTurnState, ReasoningEffort, ReasoningTransportMode, ToolTrace } from '../../types';
import type { InternalAgentProfile } from '../internalAgentProfile';
import type { ImageContextMetadata } from '../contextTokenEstimation';
import type { WebSearchOptions } from '../webSearch';

export type ToolErrorKind = 'validation' | 'execution' | 'permission' | 'aborted';

export interface StreamMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: StreamMessageContent;
  image_metadata?: ImageContextMetadata[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  provider_input_items?: unknown[];
  provider_turn_state?: ProviderTurnState;
}

export type StreamMessageContent =
  | string
  | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  blocks?: import('../../shared/toolResultContent').ToolResultBlock[];
  tool_call_id: string;
  content: string;
  tool_name?: string;
  is_error: boolean;
  error_kind?: ToolErrorKind;
}

export interface StreamCompletionResult {
  visibleContent: string;
  toolTraces: ToolTrace[];
  hiddenContext?: string;
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
  completionReason?: StreamCompletionReason;
}

export interface LiveStreamContextSnapshot {
  version: number;
  visibleContent: string;
  visibleContentLength: number;
  toolTraces: ToolTrace[];
  hiddenContext?: string;
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
}

export type StreamCompletionReason = ChatCompletionReason;

export type StreamTimelinePhase =
  | 'send_requested'
  | 'messages_ready'
  | 'compaction_done'
  | 'provider_stream_start_requested'
  | 'backend_task_started'
  | 'provider_request_sent'
  | 'auth_ready'
  | 'auth_refreshed'
  | 'first_provider_event'
  | 'first_token'
  | 'done'
  | 'error';

export interface StreamTimelineEvent {
  request_id: string;
  provider_id: string;
  provider_type: string;
  phase: StreamTimelinePhase | string;
  elapsed_ms: number;
}

export interface ToolResultResolution {
  blocks?: import('../../shared/toolResultContent').ToolResultBlock[];
  kind: 'result';
  result: string;
  isError?: boolean;
  errorKind?: ToolResult['error_kind'];
  toString?: () => string;
}

export interface ToolInterruptResolution {
  kind: 'interrupt';
  result: string;
  visibleContent: string;
  hiddenContext?: string;
}

export type ToolCallResolution = ToolResultResolution | ToolInterruptResolution;

export type StreamingFollowUpCompactionReason = 'tool_results';

export interface StreamingFollowUpCompactionRequest {
  reason: StreamingFollowUpCompactionReason;
  messages: StreamMessage[];
  turnCount: number;
  toolResultCount: number;
}

export interface StreamingFollowUpCompactionResult {
  messages: StreamMessage[];
  compacted?: boolean;
}

export interface StreamingChatOptions {
  sessionId?: string;
  conversationId?: string;
  mode?: AppMode;
  internalAgentProfile?: InternalAgentProfile | null;
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  reasoningTransportMode?: ReasoningTransportMode;
  messages: StreamMessage[];
  onToken: (token: string) => void;
  onComplete: (result: StreamCompletionResult) => void;
  onError: (error: Error) => void;
  onTimeline?: (event: StreamTimelineEvent) => void;
  onToolTracesUpdate?: (toolTraces: ToolTrace[]) => void;
  onLiveContextUpdate?: (snapshot: LiveStreamContextSnapshot) => void;
  signal?: AbortSignal;
  // Tool calling options
  enableWebSearch?: boolean;
  enableWebFetch?: boolean;
  webSearchOptions?: WebSearchOptions;
  mcpTools?: MCPTool[];
  onToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ) =>
    | Promise<ToolCallResolution | string | void>
    | ToolCallResolution
    | string
    | void;
  onToolResult?: (toolName: string, result: string) => void;
  onBeforeFollowUpRequest?: (
    request: StreamingFollowUpCompactionRequest,
  ) =>
    | Promise<StreamingFollowUpCompactionResult | StreamMessage[] | void>
    | StreamingFollowUpCompactionResult
    | StreamMessage[]
    | void;
  consumePendingSteers?: () => StreamMessage[];
  fileToolContext?: Array<{
    title: string;
    source: string;
    path?: string;
    snippet?: string;
    content?: string;
  }>;
  allowedToolIds?: string[];
  skillToolIds?: string[];
  runnableSkillToolIds?: string[];
  copilotSendTimeoutMs?: number | null;
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  showToolTraces?: boolean;
  guidedToolRetry?: {
    requiredToolNames: string[];
    retrySystemPrompt: string;
    maxRetries?: number;
  };
  maxTurns?: number | null;
}

export interface StreamingTurnResult {
  content: string;
  toolCalls: ToolCall[];
  completionReason?: StreamCompletionReason;
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
  reasoningSummary?: string;
  toolTraces?: ToolTrace[];
  hiddenContext?: string;
}
