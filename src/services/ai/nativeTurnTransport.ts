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
import { isParallelSafeReadTool, MAX_PARALLEL_READS } from './toolExecutionEffects';
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
import { devLogger } from '../../utils/devLogger';

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

  return new Promise<StreamingTurnResult>((resolve, reject) => {
    let settled = false;
    const nativeUnlisteners: UnlistenFn[] = [];
    let questionToolRequestCount = 0;
    let nativeToolRequestOrder = 0;
    type NativeOutcome = {
      result: string;
      blocks?: ToolResultBlock[];
      hiddenContext?: string;
      visibleContent?: string;
      interrupt?: boolean;
      isError?: boolean;
      errorKind?: ToolResult['error_kind'];
    };
    type NativeSubmission = { id: string; result: string; items: unknown[]; hiddenContext?: string };
    type NativeRequest = {
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
      detail?: string;
      order: number;
      safeRead: boolean;
      started: boolean;
      outcome?: NativeOutcome;
      submissions: NativeSubmission[];
    };
    const requests: NativeRequest[] = [];
    const pendingToolSubmissions = new Set<string>();
    let nextToStart = 0;
    let nextToPublish = 0;
    let executing = 0;
    let exclusiveActive = false;
    let publishing = false;
    let interruptObserved = false;
    let submissionChannelFailed = false;
    let deferredDonePayload: tauriIpc.AiStreamDoneEvent | undefined;
    let deferredDoneTimer: ReturnType<typeof setTimeout> | undefined;

    const stopped = () => settled || params.signal?.aborted === true;
    const emitToolTrace = (trace: ToolTrace) => {
      try { params.onToolTrace?.(trace); }
      catch (error) { devLogger.warn('Native tool trace observer failed', formatToolExecutionError(error)); }
    };
    const submitResult = async (request: NativeRequest, outcome: NativeOutcome) => {
      const submission: NativeSubmission = {
        id: createStreamingRequestId(), result: outcome.result,
        hiddenContext: outcome.hiddenContext,
        items: [
          { type: 'function_call', call_id: request.toolCallId, name: request.toolName, arguments: JSON.stringify(request.args) },
          buildFunctionCallOutputProviderInputItem(request.toolCallId, outcome.result, outcome.blocks, outcome.isError),
        ],
      };
      request.submissions.push(submission);
      pendingToolSubmissions.add(submission.id);
      try {
        await tauriIpc.aiSubmitToolResult({
          requestId, toolCallId: request.toolCallId, submissionId: submission.id,
          result: outcome.result, ...(outcome.blocks ? { blocks: outcome.blocks } : {}),
          hiddenContext: outcome.hiddenContext, visibleContent: outcome.visibleContent,
          interrupt: outcome.interrupt, isError: outcome.isError, errorKind: outcome.errorKind,
        });
      } finally {
        pendingToolSubmissions.delete(submission.id);
      }
    };

    const publishReady = () => {
      if (publishing || stopped() || deferredDonePayload || submissionChannelFailed) return;
      const request = requests[nextToPublish];
      if (!request?.outcome) return;
      publishing = true;
      void (async () => {
        try {
          await submitResult(request, request.outcome!);
        } catch (error) {
          if (stopped() || deferredDonePayload) return;
          // The tool has already run. Submit an error once, without running it again;
          // only the bridge receipt can decide which submission was accepted.
          try {
            await submitResult(request, {
              result: `Error executing tool ${request.toolName}: ${formatToolExecutionError(error)}`,
              isError: true,
              errorKind: 'execution',
            });
          } catch (fallbackError) {
            if (stopped()) return;
            submissionChannelFailed = true;
            devLogger.warn('Native tool result fallback submission failed', formatToolExecutionError(fallbackError));
          }
        } finally {
          if (!settled) {
            emitToolTrace({
              tool_call_id: request.toolCallId, tool_name: request.toolName,
              detail: request.detail, status: 'running', recovery_state: 'unknown',
              execution_mode: request.safeRead ? 'parallel' : 'sequential',
              batch_id: requestId, order: request.order,
            });
            nextToPublish += 1;
            if (!request.safeRead) exclusiveActive = false;
            publishing = false;
            if (deferredDonePayload) flushDeferredDone();
            else { publishReady(); startReady(); }
          }
        }
      })();
    };

    const executeRequest = async (request: NativeRequest) => {
      const { toolName, toolCallId, args } = request;
      const outcome: NativeOutcome = { result: '' };
      try {
        const invalid = validateToolInvocation({
          toolName, args, schema: toolSchemas.get(toolName), allowedTools,
          questionErrorKind: questionToolRequestCount > 0 ? 'execution' : undefined,
        });
        if (invalid) {
          outcome.result = invalid.result;
          outcome.isError = true;
          outcome.errorKind = invalid.errorKind;
        } else if (!params.onToolCall) {
          outcome.result = `Tool ${toolName} is unavailable in this provider context.`;
          outcome.isError = true;
          outcome.errorKind = 'permission';
        } else {
          if (toolName === 'question') questionToolRequestCount += 1;
          const resolution = await invokeToolHandler(params.onToolCall, toolName, args, toolCallId, params.signal);
          if (stopped()) return;
          if (isToolInterruptResolution(resolution)) {
            outcome.result = resolution.result;
            outcome.hiddenContext = resolution.hiddenContext;
            outcome.visibleContent = resolution.visibleContent;
            outcome.interrupt = true;
            interruptObserved = true;
          } else if (resolution?.kind === 'result') {
            outcome.result = resolution.result;
            outcome.blocks = resolution.blocks;
            outcome.isError = resolution.isError === true;
            outcome.errorKind = resolution.errorKind;
          }
        }
      } catch (error) {
        if (stopped()) return;
        outcome.result = `Error executing tool ${toolName}: ${formatToolExecutionError(error)}`;
        outcome.isError = true;
        outcome.errorKind = 'execution';
      } finally {
        if (!stopped()) {
          request.outcome = outcome;
          executing -= 1;
          publishReady();
          startReady();
        }
      }
    };

    const startReady = () => {
      if (stopped() || exclusiveActive || interruptObserved || deferredDonePayload || submissionChannelFailed) return;
      while (nextToStart < requests.length) {
        const request = requests[nextToStart];
        if (request.safeRead) {
          if (executing >= MAX_PARALLEL_READS) return;
        } else if (executing > 0 || publishing || nextToPublish !== nextToStart) return;
        nextToStart += 1;
        executing += 1;
        request.started = true;
        if (!request.safeRead) exclusiveActive = true;
        emitToolTrace({
          tool_call_id: request.toolCallId, tool_name: request.toolName,
          detail: request.detail, status: 'running',
          execution_mode: request.safeRead ? 'parallel' : 'sequential',
          batch_id: requestId, order: request.order, started_at_ms: Date.now(),
        });
        if (stopped()) return;
        void executeRequest(request);
        if (!request.safeRead) return;
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
      if (stopped()) return;
      const acceptedIds = new Set(payload.accepted_submission_ids ?? []);
      const nativeToolItems: unknown[] = [];
      const acceptedHiddenContext: string[] = [];
      for (const request of requests) {
        if (stopped()) return;
        if (!request.started) continue;
        const submission = request.submissions.find(item => acceptedIds.has(item.id));
        if (!submission) {
          emitToolTrace({
            tool_call_id: request.toolCallId, tool_name: request.toolName,
            detail: request.detail, status: 'running', recovery_state: 'unknown',
            execution_mode: request.safeRead ? 'parallel' : 'sequential',
            batch_id: requestId, order: request.order,
          });
          continue;
        }
        nativeToolItems.push(...submission.items);
        if (submission.hiddenContext?.trim()) acceptedHiddenContext.push(submission.hiddenContext.trim());
        try {
          params.onLiveToolResult?.({
            toolName: request.toolName, args: request.args, toolCallId: request.toolCallId,
            result: submission.result, hiddenContext: submission.hiddenContext,
            providerInputItems: [...nativeToolItems],
          });
        } catch (error) {
          devLogger.warn('Native live result observer failed', formatToolExecutionError(error));
        }
        if (stopped()) return;
        try { params.onToolResult?.(request.toolName, submission.result); }
        catch (error) { devLogger.warn('Native tool result observer failed', formatToolExecutionError(error)); }
        if (stopped()) return;
        emitToolTrace({
          tool_call_id: request.toolCallId, tool_name: request.toolName,
          detail: request.detail, status: 'done', recovery_state: 'completed',
          execution_mode: request.safeRead ? 'parallel' : 'sequential',
          batch_id: requestId, order: request.order, completed_at_ms: Date.now(),
        });
      }
      const providerInputItems = nativeToolItems.length ? [
        ...nativeToolItems, ...(payload.provider_input_items ?? buildAssistantProviderInputItemsFromTurn(payload.output_text || fullContent, payload.tool_calls || [])),
      ] : payload.provider_input_items ?? undefined;
      const providerTurnState = payload.provider_turn_state ??
        (params.providerType === 'chatgpt'
          ? buildChatGptProviderTurnState(payload.response_id, payload.output_items)
          : undefined);
      const derivedOutputText = extractVisibleTextFromProviderInputItems(providerInputItems) ||
        extractVisibleTextFromProviderInputItems(payload.output_items ?? undefined);
      const localCallIds = new Set(requests.map(request => request.toolCallId));
      // Copilot builds hidden_context from accepted relay results and built-in tool results.
      const confirmedHiddenContext = params.providerType === 'copilot' && payload.accepted_submission_ids
        ? payload.hidden_context ?? (acceptedHiddenContext.join('\n\n') || undefined)
        : requests.length ? acceptedHiddenContext.join('\n\n') || undefined : payload.hidden_context ?? undefined;
      finish(() => resolve({
        content: payload.output_text || fullContent || derivedOutputText,
        toolCalls: payload.tool_calls || [], providerInputItems, providerTurnState,
        reasoningSummary: payload.reasoning_summary ?? undefined,
        toolTraces: payload.tool_traces?.filter(trace => !localCallIds.has(trace.tool_call_id)) ?? undefined,
        hiddenContext: confirmedHiddenContext,
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
            if (event.payload.tool_trace.status === 'done' &&
              requests.some(request => request.toolCallId === event.payload.tool_trace.tool_call_id)) return;
            emitToolTrace(event.payload.tool_trace);
          }),
          ownListener<tauriIpc.AiToolRequestEvent>('ai:tool-request', (event) => {
            if (settled || event.payload.request_id !== requestId) return;
            const toolName = event.payload.tool_name;
            const args = event.payload.args && typeof event.payload.args === 'object'
              ? event.payload.args : {};
            requests.push({
              toolName, toolCallId: event.payload.tool_call_id ?? '', args,
              detail: formatToolTraceDetail(toolName, args),
              order: nativeToolRequestOrder++, safeRead: isParallelSafeReadTool(toolName),
              started: false, submissions: [],
            });
            startReady();
          }),
          ownListener<tauriIpc.AiStreamDoneEvent>('ai:done', (event) => {
            if (settled || event.payload.request_id !== requestId) return;
            // Completion may arrive before IPC settles the submitted result.
            deferredDonePayload = event.payload;
            if (pendingToolSubmissions.size === 0) flushDeferredDone();
            else if (!deferredDoneTimer) deferredDoneTimer = setTimeout(() => {
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
