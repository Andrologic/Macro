import type { ToolResultBlock } from '../../shared/toolResultContent';
import { projectCopilotMessageContent } from './copilotPromptCodec';
import {
  buildAssistantProviderInputItemsFromTurn,
  buildFunctionCallOutputProviderInputItem,
  buildChatGptProviderTurnState,
  extractVisibleTextFromProviderInputItems,
} from './responsesCodec';
import {
  normalizeNativeProviderTools,
} from './toolDefinitions';
import {
  type ActiveStreamResources,
  getStreamSessionId,
  createActiveStreamResources,
  pruneActiveStreamResources,
  createStreamingRequestId,
} from './streamResources';
import {
  type StreamMessage,
  type ToolResult,
  type StreamingChatOptions,
  type StreamingTurnResult,
} from './contracts';
import {
  classifyProviderError,
} from './providerErrors';
import {
  validateToolInvocation,
  invokeToolHandler,
} from './toolCallRunner';
import {
  formatToolExecutionError,
  isToolInterruptResolution,
} from './toolCallResolution';
import {
  formatToolTraceDetail,
} from './toolPresentation';
import { listen, type UnlistenFn } from '../tauriRuntimeBridge';
import * as tauriIpc from '../tauriIpc';
import { getMacroToolRegistryEntry, type JsonSchema } from '../../shared/macroToolRegistry';
import type { ProjectMount, ReasoningEffort, ToolTrace } from '../../types';

export const streamNativeTurnViaTauri = async (params: {
  sessionId?: string;
  providerId: string;
  providerType: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  conversationId?: string | null;
  messages: StreamMessage[];
  tools: unknown[];
  allowedToolIds?: string[];
  copilotSendTimeoutMs?: number | null;
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onTimeline?: StreamingChatOptions['onTimeline'];
  onToolTrace?: (toolTrace: ToolTrace) => void;
  onToolCall?: StreamingChatOptions['onToolCall'];
  onToolResult?: StreamingChatOptions['onToolResult'];
  onLiveToolResult?: (toolResult: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
    result: string;
    hiddenContext?: string;
    providerInputItems?: unknown[];
  }) => void;
  onConfirmedToolContext?: (hiddenContext: string) => void;
}, invocationResources?: ActiveStreamResources): Promise<StreamingTurnResult> => {
  if (!tauriIpc.isTauriAvailable()) {
    throw new Error(`${params.providerType} provider requires the desktop backend.`);
  }

  const sessionId = getStreamSessionId(params.sessionId);
  const resources = invocationResources ?? createActiveStreamResources(sessionId);
  const requestId = createStreamingRequestId();
  resources.tauriRequestId = requestId;
  const allowedTools = new Set(params.allowedToolIds ?? []);
  const toolSchemas = new Map<string, JsonSchema>();
  for (const toolName of allowedTools) {
    const entry = getMacroToolRegistryEntry(toolName);
    if (entry) toolSchemas.set(toolName, entry.parameters);
  }

  let fullContent = '';
  const nativeToolItems: unknown[] = [];

  return new Promise<StreamingTurnResult>((resolve, reject) => {
    let settled = false;
    const nativeUnlisteners: UnlistenFn[] = [];
    let questionToolRequestCount = 0;
    let nativeToolRequestOrder = 0;
    let pendingToolSubmissions = 0;
    let deferredDonePayload: tauriIpc.AiStreamDoneEvent | undefined;

    const disposeListener = (unlisten: UnlistenFn) => {
      try {
        unlisten();
      } catch {
        // Completion can race listener setup and cleanup.
      }
    };
    const ownListener: typeof listen = async (event, handler) => {
      const unlisten = await listen(event, handler);
      // Promise.all can reject before the other registrations resolve.
      if (settled) disposeListener(unlisten);
      else nativeUnlisteners.push(unlisten);
      return unlisten;
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      params.signal?.removeEventListener('abort', signalHandler);
      nativeUnlisteners.splice(0).forEach(disposeListener);
      if (resources.tauriRequestId === requestId) {
        resources.tauriRequestId = null;
        if (!invocationResources) pruneActiveStreamResources(sessionId, resources);
      }
      fn();
    };

    const completeDone = (payload: tauriIpc.AiStreamDoneEvent) => {
      if (settled) return;
      const providerInputItems = nativeToolItems.length ? [
        ...nativeToolItems, ...(payload.provider_input_items ?? buildAssistantProviderInputItemsFromTurn(payload.output_text || fullContent, payload.tool_calls || [])),
      ] : payload.provider_input_items ?? undefined;
      const providerTurnState =
        payload.provider_turn_state ??
        (params.providerType === 'chatgpt'
          ? buildChatGptProviderTurnState(payload.response_id, payload.output_items)
          : undefined);
      const derivedOutputText =
        extractVisibleTextFromProviderInputItems(providerInputItems) ||
        extractVisibleTextFromProviderInputItems(payload.output_items ?? undefined);
      finish(() => resolve({
        content: payload.output_text || fullContent || derivedOutputText,
        toolCalls: payload.tool_calls || [],
        providerInputItems,
        providerTurnState,
        reasoningSummary: payload.reasoning_summary ?? undefined,
        toolTraces: payload.tool_traces ?? undefined,
        hiddenContext: payload.hidden_context ?? undefined,
        completionReason: payload.completion_reason ?? undefined,
      }));
    };

    const flushDeferredDone = () => {
      if (pendingToolSubmissions !== 0 || !deferredDonePayload) return;
      const payload = deferredDonePayload;
      deferredDonePayload = undefined;
      completeDone(payload);
    };

    const signalHandler = () => {
      void tauriIpc.aiCancelStream(requestId).catch(() => {
        // Ignore backend cancel failures
      });
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
    };

    if (!invocationResources) resources.cancel = signalHandler;

    if (params.signal?.aborted) {
      signalHandler();
      return;
    }

    if (params.signal) {
      params.signal.addEventListener('abort', signalHandler, { once: true });
    }

    void (async () => {
      try {
        await Promise.all([
          ownListener<tauriIpc.AiStreamTimelineEvent>('ai:timeline', (event) => {
            if (settled || event.payload.request_id !== requestId) return;
            params.onTimeline?.({
              request_id: event.payload.request_id,
              provider_id: event.payload.provider_id,
              provider_type: event.payload.provider_type,
              phase: event.payload.phase,
              elapsed_ms: event.payload.elapsed_ms,
            });
          }),
          ownListener<tauriIpc.AiStreamChunkEvent>('ai:stream', (event) => {
            if (settled || event.payload.request_id !== requestId) return;
            fullContent += event.payload.delta;
            params.onDelta(event.payload.delta);
          }),
          ownListener<tauriIpc.AiStreamToolTraceEvent>('ai:tool-trace', (event) => {
            if (settled || event.payload.request_id !== requestId) return;
            params.onToolTrace?.(event.payload.tool_trace);
          }),
          ownListener<tauriIpc.AiToolRequestEvent>('ai:tool-request', (event) => {
            if (settled || event.payload.request_id !== requestId) return;

            void (async () => {
              const toolName = event.payload.tool_name;
              const toolCallId = event.payload.tool_call_id;
              const args =
                event.payload.args && typeof event.payload.args === 'object'
                  ? event.payload.args
                  : {};
              const detail = formatToolTraceDetail(toolName, args);
              const order = nativeToolRequestOrder;
              nativeToolRequestOrder += 1;

              params.onToolTrace?.({
                tool_call_id: toolCallId,
                tool_name: toolName,
                detail,
                status: 'running',
                execution_mode: 'parallel',
                batch_id: requestId,
                order,
                started_at_ms: Date.now(),
              });

              let resultSubmitted = false;
              let proposedResultAdded = false;
              let submissionPending = false;
              try {
                let toolResult = '';
                let blocks: ToolResultBlock[] | undefined;
                let hiddenContext: string | undefined;
                let visibleContent: string | undefined;
                let interrupt = false;
                let isError = false;
                let errorKind: ToolResult['error_kind'] | undefined;

                const invalid = validateToolInvocation({
                  toolName, args, schema: toolSchemas.get(toolName), allowedTools,
                  questionErrorKind: questionToolRequestCount > 0 ? 'execution' : undefined,
                });
                if (invalid) {
                  toolResult = invalid.result;
                  isError = true;
                  errorKind = invalid.errorKind;
                } else if (!params.onToolCall) {
                  toolResult = `Tool ${toolName} is unavailable in this provider context.`;
                  isError = true;
                  errorKind = 'permission';
                } else {
                  if (toolName === 'question') questionToolRequestCount += 1;
                  const resolution = await invokeToolHandler(
                    params.onToolCall, toolName, args, toolCallId, params.signal,
                  );

                  // A stopped generation must never submit a late tool result
                  // back to the native provider loop.
                  if (settled || params.signal?.aborted) {
                    return;
                  }

                  if (isToolInterruptResolution(resolution)) {
                    toolResult = resolution.result;
                    hiddenContext = resolution.hiddenContext;
                    visibleContent = resolution.visibleContent;
                    interrupt = true;
                  } else if (resolution?.kind === 'result') {
                    toolResult = resolution.result;
                    blocks = resolution.blocks;
                    isError = resolution.isError === true;
                    errorKind = resolution.errorKind;
                  }
                }

                if (settled || params.signal?.aborted) return;
                pendingToolSubmissions += 1;
                submissionPending = true;
                nativeToolItems.push(
                  { type: 'function_call', call_id: toolCallId, name: toolName, arguments: JSON.stringify(args) },
                  buildFunctionCallOutputProviderInputItem(toolCallId, toolResult, blocks, isError),
                );
                proposedResultAdded = true;
                params.onLiveToolResult?.({
                  toolName, args, toolCallId, result: toolResult,
                  providerInputItems: [...nativeToolItems],
                });
                await tauriIpc.aiSubmitToolResult({
                  requestId,
                  toolCallId,
                  result: toolResult,
                  ...(blocks ? { blocks } : {}),
                  hiddenContext,
                  visibleContent,
                  interrupt,
                  isError,
                  errorKind,
                });
                resultSubmitted = true;
                if (!settled && !params.signal?.aborted && hiddenContext) {
                  params.onConfirmedToolContext?.(hiddenContext);
                }
                if (settled || params.signal?.aborted) return;
                params.onToolResult?.(toolName, toolResult);
              } catch (error) {
                if (settled || params.signal?.aborted || resultSubmitted) {
                  return;
                }
                if (proposedResultAdded) {
                  const index = nativeToolItems.findIndex((item) => item && typeof item === 'object' &&
                    'type' in item && item.type === 'function_call' &&
                    'call_id' in item && item.call_id === toolCallId);
                  if (index !== -1) nativeToolItems.splice(index, 2);
                  try {
                    params.onLiveToolResult?.({
                      toolName, args, toolCallId, result: '',
                      providerInputItems: [...nativeToolItems],
                    });
                  } catch {
                    // A live-context callback must not prevent error submission.
                  }
                }
                const toolResult = `Error executing tool ${toolName}: ${formatToolExecutionError(error)}`;
                if (settled || params.signal?.aborted) return;
                try {
                  await tauriIpc.aiSubmitToolResult({
                    requestId,
                    toolCallId,
                    result: toolResult,
                    isError: true,
                    errorKind: 'execution',
                  });
                  resultSubmitted = true;
                } catch {
                  return;
                }
                if (settled || params.signal?.aborted) return;
                nativeToolItems.push(
                  { type: 'function_call', call_id: toolCallId, name: toolName, arguments: JSON.stringify(args) },
                  buildFunctionCallOutputProviderInputItem(toolCallId, toolResult, undefined, true),
                );
                params.onLiveToolResult?.({
                  toolName,
                  args,
                  toolCallId,
                  result: toolResult,
                  providerInputItems: [...nativeToolItems],
                });
                params.onToolResult?.(toolName, toolResult);
              } finally {
                try {
                  if (!settled && !params.signal?.aborted) params.onToolTrace?.({
                    tool_call_id: toolCallId,
                    tool_name: toolName,
                    detail,
                    status: resultSubmitted ? 'done' : 'running',
                    recovery_state: resultSubmitted ? 'completed' : 'unknown',
                    execution_mode: 'parallel',
                    batch_id: requestId,
                    order,
                    ...(resultSubmitted ? { completed_at_ms: Date.now() } : {}),
                  });
                } finally {
                  if (submissionPending) {
                    pendingToolSubmissions -= 1;
                    flushDeferredDone();
                  }
                }
              }
            })();
          }),
          ownListener<tauriIpc.AiStreamDoneEvent>('ai:done', (event) => {
            if (settled || event.payload.request_id !== requestId) return;
            // Completion may arrive before IPC confirms or rejects the proposed tool result.
            if (pendingToolSubmissions > 0) deferredDonePayload = event.payload;
            else completeDone(event.payload);
          }),
          ownListener<tauriIpc.AiStreamErrorEvent>('ai:error', (event) => {
            if (settled || event.payload.request_id !== requestId) return;
            finish(() => reject(classifyProviderError(event.payload.message)));
          }),
        ]);

        if (settled) return;
        if (params.signal?.aborted) {
          signalHandler();
          return;
        }
        const tools = normalizeNativeProviderTools(params.tools, params.providerType);

        await tauriIpc.aiStreamChat({
          requestId,
          providerId: params.providerId,
          modelId: params.modelId,
          reasoningEffort: params.reasoningEffort ?? null,
          conversationId: params.conversationId ?? null,
          messages: params.messages.map((message) => ({
            role: message.role,
            content: params.providerType === 'copilot' ? projectCopilotMessageContent(message) : message.content,
            ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            ...(message.provider_input_items
              ? { provider_input_items: message.provider_input_items }
              : {}),
            ...(params.providerType === 'chatgpt' && message.provider_turn_state
              ? { provider_turn_state: message.provider_turn_state }
              : {}),
          })),
          tools,
          toolChoice: 'auto',
          parallelToolCalls: false,
          workspacePath: params.workspacePath,
          defaultWorkspacePath: params.defaultWorkspacePath,
          projectMounts: params.projectMounts,
          virtualRootEnabled: params.virtualRootEnabled,
          focusedProjectId: params.focusedProjectId,
          allowedToolIds: params.allowedToolIds,
          copilotSendTimeoutMs: params.copilotSendTimeoutMs,
        });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    })();
  });
};
