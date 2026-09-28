import { isProtectedToolTraceStatus, mergeToolTraceStatus } from '../toolTraceState';
import {
  cloneProviderInputItems,
} from './jsonValues';
import {
  type StreamCompletionResult,
  type LiveStreamContextSnapshot,
  type StreamingChatOptions,
} from './contracts';
import {
  buildToolContextBlock,
} from './toolPresentation';
import type { ProviderTurnState, ToolTrace } from '../../types';

export { emptyStreamCompletionResult } from './streamCompletionResult';

export const createStreamAccumulator = (
  options: Pick<StreamingChatOptions, 'onToken' | 'onToolTracesUpdate' | 'onLiveContextUpdate'>
) => {
  let visibleContent = '';
  const toolTraces = new Map<string, ToolTrace>();
  const toolTraceOrder: string[] = [];
  const hiddenContextBlocks: string[] = [];
  const liveOnlyHiddenContextBlocks = new Map<string, string>();
  let providerInputItems: unknown[] | undefined;
  let providerTurnState: ProviderTurnState | undefined;
  let liveContextVersion = 0;

  const snapshotToolTraces = (): ToolTrace[] =>
    // Preserve first-seen insertion order; the UI treats the serialized tool_traces
    // array as the canonical display order for grouped tool rendering.
    toolTraceOrder
      .map((toolCallId) => toolTraces.get(toolCallId))
      .filter((trace): trace is ToolTrace => Boolean(trace))
      .map((trace) => ({ ...trace }));

  const buildHiddenContext = (includeLiveOnly: boolean): string | undefined => {
    const blocks = includeLiveOnly
      ? [...hiddenContextBlocks, ...liveOnlyHiddenContextBlocks.values()]
      : hiddenContextBlocks;
    const hiddenContext = blocks.join('\n\n').trim();
    return hiddenContext || undefined;
  };

  const snapshotLiveContext = (): LiveStreamContextSnapshot => ({
    version: liveContextVersion,
    visibleContent,
    visibleContentLength: visibleContent.length,
    toolTraces: snapshotToolTraces(),
    hiddenContext: buildHiddenContext(true),
    providerInputItems: cloneProviderInputItems(providerInputItems),
    providerTurnState,
  });

  const publishLiveContext = () => {
    if (!options.onLiveContextUpdate) return;
    liveContextVersion += 1;
    options.onLiveContextUpdate(snapshotLiveContext());
  };

  const publishToolTraces = () => {
    options.onToolTracesUpdate?.(snapshotToolTraces());
    publishLiveContext();
  };

  const upsertToolTrace = (trace: ToolTrace) => {
    const existingTrace = toolTraces.get(trace.tool_call_id);
    const status = mergeToolTraceStatus(existingTrace?.status, trace.status);
    const completedAtMs =
      status === 'done'
        ? trace.completed_at_ms ?? existingTrace?.completed_at_ms ?? Date.now()
        : trace.completed_at_ms ?? existingTrace?.completed_at_ms;
    const nextTrace: ToolTrace = {
      tool_call_id: trace.tool_call_id,
      tool_name: trace.tool_name || existingTrace?.tool_name || trace.tool_call_id,
      detail: trace.detail ?? existingTrace?.detail,
      status,
      recovery_state: status === 'done' || status === 'denied'
        ? 'completed'
        : trace.recovery_state ?? existingTrace?.recovery_state,
      visible_offset:
        existingTrace?.visible_offset ?? trace.visible_offset ?? visibleContent.length,
      execution_mode: trace.execution_mode ?? existingTrace?.execution_mode,
      batch_id: trace.batch_id ?? existingTrace?.batch_id,
      order: trace.order ?? existingTrace?.order,
      started_at_ms: existingTrace?.started_at_ms ?? trace.started_at_ms,
      completed_at_ms: completedAtMs,
    };
    if (!toolTraces.has(trace.tool_call_id)) {
      toolTraceOrder.push(trace.tool_call_id);
    }
    toolTraces.set(trace.tool_call_id, nextTrace);
    publishToolTraces();
  };

  const settleRunningToolTracesUnknown = () => {
    let changed = false;
    for (const toolCallId of toolTraceOrder) {
      const trace = toolTraces.get(toolCallId);
      if (!trace || trace.status !== 'running' || trace.recovery_state === 'unknown') continue;
      toolTraces.set(toolCallId, {
        ...trace,
        recovery_state: 'unknown',
      });
      changed = true;
    }
    if (changed) {
      publishToolTraces();
    }
  };

  const appendVisibleChunk = (chunk: string, settleTools = true) => {
    if (!chunk) return;
    if (settleTools) {
      settleRunningToolTracesUnknown();
    }
    visibleContent += chunk;
    options.onToken(chunk);
    publishLiveContext();
  };

  return {
    appendProviderDelta(chunk: string) {
      appendVisibleChunk(chunk, false);
    },
    flushProviderDelta() {
      // Provider deltas are appended directly.
    },
    appendSystemChunk(chunk: string, markToolsDone = false) {
      appendVisibleChunk(chunk, markToolsDone);
    },
    settleRunningToolTracesUnknown,
    upsertToolTrace,
    upsertToolTraceFromProvider(trace: ToolTrace) {
      upsertToolTrace(trace);
    },
    beginToolTrace(
      toolCallId: string,
      toolName: string,
      detail?: string,
      metadata?: Pick<ToolTrace, 'execution_mode' | 'batch_id' | 'order'>
    ) {
      const existingTrace = toolTraces.get(toolCallId);
      upsertToolTrace({
        tool_call_id: toolCallId,
        tool_name: toolName,
        detail: detail ?? existingTrace?.detail,
        status: 'running',
        visible_offset: existingTrace?.visible_offset ?? visibleContent.length,
        execution_mode: metadata?.execution_mode ?? existingTrace?.execution_mode,
        batch_id: metadata?.batch_id ?? existingTrace?.batch_id,
        order: metadata?.order ?? existingTrace?.order,
        started_at_ms: existingTrace?.started_at_ms ?? Date.now(),
      });
    },
    completeToolTrace(toolCallId: string) {
      const existingTrace = toolTraces.get(toolCallId);
      if (!existingTrace || isProtectedToolTraceStatus(existingTrace.status)) return;
      upsertToolTrace({
        ...existingTrace,
        status: 'done',
        completed_at_ms: Date.now(),
      });
    },
    upsertRunningToolTrace(toolCallId: string, toolName: string, detail?: string) {
      const existingTrace = toolTraces.get(toolCallId);
      upsertToolTrace({
        tool_call_id: toolCallId,
        tool_name: toolName,
        detail: detail ?? existingTrace?.detail,
        status: 'running',
        visible_offset: existingTrace?.visible_offset ?? visibleContent.length,
        execution_mode: existingTrace?.execution_mode,
        batch_id: existingTrace?.batch_id,
        order: existingTrace?.order,
        started_at_ms: existingTrace?.started_at_ms ?? Date.now(),
      });
    },
    addHiddenToolContext(toolCallId: string, toolName: string, detail: string | undefined, result: string) {
      const block = buildToolContextBlock(toolCallId, toolName, detail, result);
      if (block) {
        hiddenContextBlocks.push(block);
        publishLiveContext();
      }
    },
    addLiveOnlyHiddenToolContext(toolCallId: string, toolName: string, detail: string | undefined, result: string) {
      const block = buildToolContextBlock(toolCallId, toolName, detail, result);
      if (block) {
        liveOnlyHiddenContextBlocks.set(toolCallId, block);
      } else {
        liveOnlyHiddenContextBlocks.delete(toolCallId);
      }
      publishLiveContext();
    },
    addHiddenContextBlock(block: string | undefined) {
      const normalized = block?.trim();
      if (normalized) {
        hiddenContextBlocks.push(normalized);
        publishLiveContext();
      }
    },
    setProviderContext(context: {
      providerInputItems?: unknown[] | null;
      providerTurnState?: ProviderTurnState;
    }) {
      providerInputItems = cloneProviderInputItems(context.providerInputItems);
      providerTurnState = context.providerTurnState;
      publishLiveContext();
    },
    replaceVisibleContent(content: string) {
      visibleContent = content;
      publishLiveContext();
    },
    publishLiveContext,
    snapshotLiveContext,
    getFinalHiddenContext() {
      return buildHiddenContext(false);
    },
    buildResult(): StreamCompletionResult {
      settleRunningToolTracesUnknown();
      return {
        visibleContent,
        toolTraces: snapshotToolTraces(),
        hiddenContext: buildHiddenContext(false),
      };
    },
  };
};
