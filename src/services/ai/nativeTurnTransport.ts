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
import { MCP_DISCOVERY_DEFINITIONS } from '../mcp/toolDiscovery';
import type { ProjectMount, ReasoningEffort, ToolTrace } from '../../types';

const DONE_SUBMISSION_GRACE_MS = 5_000;

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
  for (const entry of MCP_DISCOVERY_DEFINITIONS) {
    if (allowedTools.has(entry.id)) toolSchemas.set(entry.id, entry.parameters);
  }

  let fullContent = '';
  const nativeToolItems: unknown[] = [];
  const nativeToolCalls = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  const nativeToolSubmissions = new Map<string, Array<{ id: string; result: string; items: unknown[] }>>();

  return new Promise<StreamingTurnResult>((resolve, reject) => {
    let settled = false;
    const nativeUnlisteners: UnlistenFn[] = [];
    let questionToolRequestCount = 0;
    let nativeToolRequestOrder = 0;
    const pendingToolSubmissions = new Map<string, { toolName: string; args: Record<string, unknown> }>();
    let deferredDonePayload: tauriIpc.AiStreamDoneEvent | undefined;
    let deferredDoneTimer: ReturnType<typeof setTimeout> | undefined;

    const removeNativeToolItems = (toolCallId: string) => {
      const index = nativeToolItems.findIndex((item) => item && typeof item === 'object' &&
        'type' in item && item.type === 'function_call' &&
        'call_id' in item && item.call_id === toolCallId);
      if (index !== -1) nativeToolItems.splice(index, 2);
    };
    const proposeNativeToolResult = (
      toolCallId: string, toolName: string, args: Record<string, unknown>,
      result: string, blocks: ToolResultBlock[] | undefined, isError: boolean,
    ) => {
      const id = createStreamingRequestId();
      const items = [
        { type: 'function_call', call_id: toolCallId, name: toolName, arguments: JSON.stringify(args) },
        buildFunctionCallOutputProviderInputItem(toolCallId, result, blocks, isError),
      ];
      nativeToolSubmissions.set(toolCallId, [
        ...(nativeToolSubmissions.get(toolCallId) ?? []), { id, result, items },
      ]);
      nativeToolItems.push(...items);
      return id;
    };
    const discardNativeToolResult = (toolCallId: string) => {
      removeNativeToolItems(toolCallId);
      const call = nativeToolCalls.get(toolCallId);
      if (!call) return;
      try {
        params.onLiveToolResult?.({
          ...call, toolCallId, result: '', providerInputItems: [...nativeToolItems],
        });
      } catch {
        // A stale live preview must not prevent completion or error submission.
      }
    };

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
      if (deferredDoneTimer) clearTimeout(deferredDoneTimer);
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
      if (params.providerType === 'copilot') {
        const accepted = new Set(payload.accepted_submission_ids ?? []);
        const acceptedByCall = new Map([...nativeToolCalls.keys()].map(toolCallId => [
          toolCallId,
          nativeToolSubmissions.get(toolCallId)?.find(submission => accepted.has(submission.id)),
        ]));
        nativeToolItems.splice(0, nativeToolItems.length);
        for (const submission of acceptedByCall.values()) {
          if (submission) nativeToolItems.push(...submission.items);
        }
        for (const [toolCallId, { toolName, args }] of nativeToolCalls) {
          const submission = acceptedByCall.get(toolCallId);
          try {
            params.onLiveToolResult?.({
              toolName, args, toolCallId, result: submission?.result ?? '',
              providerInputItems: [...nativeToolItems],
            });
          } catch {
            // A live preview failure must not hold the completed turn open.
          }
          if (submission) {
            try {
              params.onToolResult?.(toolName, submission.result);
            } catch {
              // A result observer must not hold the completed turn open.
            }
            try {
              params.onToolTrace?.({
                tool_call_id: toolCallId, tool_name: toolName,
                detail: formatToolTraceDetail(toolName, args), status: 'done',
                recovery_state: 'completed', completed_at_ms: Date.now(),
              });
            } catch {
              // The final result still carries its provider context.
            }
          }
        }
      }
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
        toolTraces: payload.tool_traces?.filter(trace =>
          params.providerType !== 'copilot' || !nativeToolCalls.has(trace.tool_call_id)) ?? undefined,
        hiddenContext: payload.hidden_context ?? undefined,
        completionReason: payload.completion_reason ?? undefined,
      }));
    };

    const flushDeferredDone = () => {
      if (pendingToolSubmissions.size !== 0 || !deferredDonePayload) return;
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
            if (params.providerType === 'copilot' && event.payload.tool_trace.status === 'done' &&
              nativeToolCalls.has(event.payload.tool_trace.tool_call_id)) return;
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
              nativeToolCalls.set(toolCallId, { toolName, args });
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
                pendingToolSubmissions.set(toolCallId, { toolName, args });
                submissionPending = true;
                const submissionId = proposeNativeToolResult(toolCallId, toolName, args, toolResult, blocks, isError);
                proposedResultAdded = true;
                params.onLiveToolResult?.({
                  toolName, args, toolCallId, result: toolResult,
                  providerInputItems: [...nativeToolItems],
                });
                await tauriIpc.aiSubmitToolResult({
                  requestId,
                  toolCallId,
                  submissionId,
                  result: toolResult,
                  ...(blocks ? { blocks } : {}),
                  hiddenContext,
                  visibleContent,
                  interrupt,
                  isError,
                  errorKind,
                });
                resultSubmitted = true;
                if (settled || params.signal?.aborted) return;
                if (params.providerType !== 'copilot') params.onToolResult?.(toolName, toolResult);
              } catch (error) {
                if (settled || params.signal?.aborted || resultSubmitted) {
                  return;
                }
                if (proposedResultAdded) {
                  discardNativeToolResult(toolCallId);
                }
                const toolResult = `Error executing tool ${toolName}: ${formatToolExecutionError(error)}`;
                if (settled || params.signal?.aborted) return;
                const submissionId = proposeNativeToolResult(toolCallId, toolName, args, toolResult, undefined, true);
                try {
                  params.onLiveToolResult?.({
                    toolName, args, toolCallId, result: toolResult,
                    providerInputItems: [...nativeToolItems],
                  });
                } catch {
                  // A live preview failure must not prevent error submission.
                }
                try {
                  await tauriIpc.aiSubmitToolResult({
                    requestId,
                    toolCallId,
                    submissionId,
                    result: toolResult,
                    isError: true,
                    errorKind: 'execution',
                  });
                  resultSubmitted = true;
                } catch {
                  discardNativeToolResult(toolCallId);
                  return;
                }
                if (settled || params.signal?.aborted) return;
                if (params.providerType !== 'copilot') params.onToolResult?.(toolName, toolResult);
              } finally {
                try {
                  if (!settled && !params.signal?.aborted) params.onToolTrace?.({
                    tool_call_id: toolCallId,
                    tool_name: toolName,
                    detail,
                    status: resultSubmitted && params.providerType !== 'copilot' ? 'done' : 'running',
                    recovery_state: resultSubmitted && params.providerType !== 'copilot' ? 'completed' : 'unknown',
                    execution_mode: 'parallel',
                    batch_id: requestId,
                    order,
                    ...(resultSubmitted && params.providerType !== 'copilot' ? { completed_at_ms: Date.now() } : {}),
                  });
                } finally {
                  if (submissionPending) {
                    pendingToolSubmissions.delete(toolCallId);
                    flushDeferredDone();
                  }
                }
              }
            })();
          }),
          ownListener<tauriIpc.AiStreamDoneEvent>('ai:done', (event) => {
            if (settled || event.payload.request_id !== requestId) return;
            // Completion may arrive before IPC confirms or rejects the proposed tool result.
            if (pendingToolSubmissions.size === 0) {
              completeDone(event.payload);
              return;
            }
            deferredDonePayload = event.payload;
            if (!deferredDoneTimer) deferredDoneTimer = setTimeout(() => {
              if (deferredDonePayload) completeDone(deferredDonePayload);
            }, DONE_SUBMISSION_GRACE_MS);
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
