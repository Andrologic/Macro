import {
  buildChatGptProviderTurnState,
  extractVisibleTextFromProviderInputItems,
} from './responsesCodec';
import {
  normalizeNativeProviderTools,
} from './toolDefinitions';
import {
  activeStreamResourcesBySessionId,
  getStreamSessionId,
  getOrCreateActiveStreamResources,
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
  }) => void;
}): Promise<StreamingTurnResult> => {
  if (!tauriIpc.isTauriAvailable()) {
    throw new Error(`${params.providerType} provider requires the desktop backend.`);
  }

  const sessionId = getStreamSessionId(params.sessionId);
  const resources = getOrCreateActiveStreamResources(sessionId);
  const requestId = createStreamingRequestId();
  resources.tauriRequestId = requestId;
  const allowedTools = new Set(params.allowedToolIds ?? []);
  const toolSchemas = new Map<string, JsonSchema>();
  for (const toolName of allowedTools) {
    const entry = getMacroToolRegistryEntry(toolName);
    if (entry) toolSchemas.set(toolName, entry.parameters);
  }

  let fullContent = '';

  return new Promise<StreamingTurnResult>((resolve, reject) => {
    let settled = false;
    let nativeUnlisteners: UnlistenFn[] = [];
    let questionToolRequestCount = 0;
    let nativeToolRequestOrder = 0;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      nativeUnlisteners.forEach((unlisten) => {
        try {
          unlisten();
        } catch {
          // Completion can race listener setup and cleanup.
        }
      });
      nativeUnlisteners = [];
      const activeResources = activeStreamResourcesBySessionId.get(sessionId);
      if (activeResources && activeResources.tauriRequestId === requestId) {
        activeResources.tauriRequestId = null;
        pruneActiveStreamResources(sessionId);
      }
      fn();
    };

    const signalHandler = () => {
      void tauriIpc.aiCancelStream(requestId).catch(() => {
        // Ignore backend cancel failures
      });
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
    };

    if (params.signal?.aborted) {
      signalHandler();
      return;
    }

    if (params.signal) {
      params.signal.addEventListener('abort', signalHandler, { once: true });
    }

    void (async () => {
      try {
        const unlisteners = await Promise.all([
          listen<tauriIpc.AiStreamTimelineEvent>('ai:timeline', (event) => {
            if (event.payload.request_id !== requestId) return;
            params.onTimeline?.({
              request_id: event.payload.request_id,
              provider_id: event.payload.provider_id,
              provider_type: event.payload.provider_type,
              phase: event.payload.phase,
              elapsed_ms: event.payload.elapsed_ms,
            });
          }),
          listen<tauriIpc.AiStreamChunkEvent>('ai:stream', (event) => {
            if (event.payload.request_id !== requestId) return;
            fullContent += event.payload.delta;
            params.onDelta(event.payload.delta);
          }),
          listen<tauriIpc.AiStreamToolTraceEvent>('ai:tool-trace', (event) => {
            if (event.payload.request_id !== requestId) return;
            params.onToolTrace?.(event.payload.tool_trace);
          }),
          listen<tauriIpc.AiToolRequestEvent>('ai:tool-request', (event) => {
            if (event.payload.request_id !== requestId) return;

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

              try {
                let toolResult = '';
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
                  if (params.signal?.aborted) {
                    return;
                  }

                  if (isToolInterruptResolution(resolution)) {
                    toolResult = resolution.result;
                    hiddenContext = resolution.hiddenContext;
                    visibleContent = resolution.visibleContent;
                    interrupt = true;
                  } else if (resolution?.kind === 'result') {
                    toolResult = resolution.result;
                    isError = resolution.isError === true;
                    errorKind = resolution.errorKind;
                  }
                }

                await tauriIpc.aiSubmitToolResult({
                  requestId,
                  toolCallId,
                  result: toolResult,
                  hiddenContext,
                  visibleContent,
                  interrupt,
                  isError,
                  errorKind,
                });
                params.onLiveToolResult?.({
                  toolName,
                  args,
                  toolCallId,
                  result: toolResult,
                  hiddenContext,
                });
                params.onToolResult?.(toolName, toolResult);
              } catch (error) {
                if (params.signal?.aborted) {
                  return;
                }
                const toolResult = `Error executing tool ${toolName}: ${formatToolExecutionError(error)}`;
                await tauriIpc.aiSubmitToolResult({
                  requestId,
                  toolCallId,
                  result: toolResult,
                  isError: true,
                  errorKind: 'execution',
                }).catch(() => undefined);
                params.onLiveToolResult?.({
                  toolName,
                  args,
                  toolCallId,
                  result: toolResult,
                });
                params.onToolResult?.(toolName, toolResult);
              } finally {
                params.onToolTrace?.({
                  tool_call_id: toolCallId,
                  tool_name: toolName,
                  detail,
                  status: 'done',
                  execution_mode: 'parallel',
                  batch_id: requestId,
                  order,
                  completed_at_ms: Date.now(),
                });
              }
            })();
          }),
          listen<tauriIpc.AiStreamDoneEvent>('ai:done', (event) => {
            if (event.payload.request_id !== requestId) return;
            if (params.signal) {
              params.signal.removeEventListener('abort', signalHandler);
            }
            const providerInputItems = event.payload.provider_input_items ?? undefined;
            const providerTurnState =
              event.payload.provider_turn_state ??
              (params.providerType === 'chatgpt'
                ? buildChatGptProviderTurnState(
                  event.payload.response_id,
                  event.payload.output_items,
                )
                : undefined);
            const derivedOutputText =
              extractVisibleTextFromProviderInputItems(providerInputItems) ||
              extractVisibleTextFromProviderInputItems(event.payload.output_items ?? undefined);
            finish(() =>
              resolve({
                content: event.payload.output_text || fullContent || derivedOutputText,
                toolCalls: event.payload.tool_calls || [],
                providerInputItems,
                providerTurnState,
                reasoningSummary: event.payload.reasoning_summary ?? undefined,
                toolTraces: event.payload.tool_traces ?? undefined,
                hiddenContext: event.payload.hidden_context ?? undefined,
                completionReason: event.payload.completion_reason ?? undefined,
              })
            );
          }),
          listen<tauriIpc.AiStreamErrorEvent>('ai:error', (event) => {
            if (event.payload.request_id !== requestId) return;
            if (params.signal) {
              params.signal.removeEventListener('abort', signalHandler);
            }
            finish(() => reject(classifyProviderError(event.payload.message)));
          }),
        ]);

        // These listeners belong to this request. Two requests may briefly share
        // a session identifier while the previous conversation is stopping.
        nativeUnlisteners = unlisteners;
        if (settled || params.signal?.aborted) {
          unlisteners.forEach((unlisten) => {
            try {
              unlisten();
            } catch {
              // Ignore listener cleanup errors during an abort race.
            }
          });
          nativeUnlisteners = [];
          if (!settled) {
            signalHandler();
          }
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
            content: message.content,
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
        if (params.signal) {
          params.signal.removeEventListener('abort', signalHandler);
        }
        const activeResources = activeStreamResourcesBySessionId.get(sessionId);
        if (activeResources && activeResources.tauriRequestId === requestId) {
          activeResources.tauriRequestId = null;
        }
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    })();
  });
};
