import type { JsonSchema } from '../../shared/macroToolRegistry';
import type { ToolTrace } from '../../types';
import { validateToolArguments, formatToolArgumentValidationError } from '../toolArgumentValidation';
import type { StreamMessage, StreamingChatOptions, ToolCall, ToolCallResolution, ToolInterruptResolution, ToolResult, ToolResultResolution } from './contracts';
import { formatToolExecutionError, normalizeToolCallResolution, throwIfToolAborted } from './toolCallResolution';
import { formatToolTraceDetail, formatToolUsageLabel } from './toolPresentation';
import { executeFallbackTool } from './fallbackTools';

export function validateToolInvocation(params: {
  toolName: string;
  args: unknown;
  schema?: JsonSchema;
  allowedTools: ReadonlySet<string>;
  questionErrorKind?: ToolResult['error_kind'];
}): ToolResultResolution | undefined {
  const { toolName, args, schema, allowedTools, questionErrorKind } = params;
  const issues = schema ? validateToolArguments(args, schema) : [];
  if (issues.length) {
    return { kind: 'result', result: formatToolArgumentValidationError(toolName, issues), isError: true, errorKind: 'validation' };
  }
  if (!allowedTools.has(toolName)) {
    return { kind: 'result', result: `Tool ${toolName} is disabled for the current mode.`, isError: true, errorKind: 'permission' };
  }
  // MCP schemas can exceed the restricted Macro schema dialect. Only check
  // the invocation envelope here; the MCP runtime owns its schema validation.
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { kind: 'result', result: formatToolArgumentValidationError(toolName, [{ path: '$', message: 'expected object' }]), isError: true, errorKind: 'validation' };
  }
  if (toolName === 'question' && questionErrorKind) {
    return { kind: 'result', result: 'Error executing tool question: only one question tool call is allowed per assistant turn.', isError: true, errorKind: questionErrorKind };
  }
}

/** The callback remains the owner of approval, execution and durable effects. */
export async function invokeToolHandler(
  handler: StreamingChatOptions['onToolCall'], name: string,
  args: Record<string, unknown>, callId: string, signal?: AbortSignal,
): Promise<ToolCallResolution | undefined> {
  throwIfToolAborted(signal);
  const result = normalizeToolCallResolution(await handler?.(name, args, callId));
  throwIfToolAborted(signal);
  return result;
}

export const getToolCallLoopKey = (call: ToolCall): string => {
  let args = call.function.arguments.trim();
  try { args = JSON.stringify(JSON.parse(args)); } catch { /* Keep malformed input as-is. */ }
  return `${call.function.name}\u0000${args}`;
};

export function isRepeatedToolCallLoop(messages: StreamMessage[], call: ToolCall): boolean {
  const recent = messages.flatMap(message => message.role === 'assistant'
    ? (message.tool_calls ?? []).filter(item => item.id && item.function.name).map(getToolCallLoopKey) : []).slice(-3);
  return recent.length === 3 && recent.every(key => key === getToolCallLoopKey(call));
}

export interface ToolBatchAccumulator {
  beginToolTrace(id: string, name: string, detail?: string, metadata?: Pick<ToolTrace, 'execution_mode' | 'batch_id' | 'order'>): void;
  completeToolTrace(id: string): void;
  addHiddenToolContext(id: string, name: string, detail: string | undefined, result: string): void;
  addHiddenContextBlock(block: string | undefined): void;
  appendSystemChunk(chunk: string, includeInHiddenContext?: boolean): void;
}

// Only built-in workspace/Git reads have an audited effect contract. Unknown,
// interactive, remote and MCP tools retain sequential execution.
const PARALLEL_READ_TOOL_IDS = new Set([
  'read', 'list', 'glob', 'grep', 'ast_grep',
  'git_status', 'git_log', 'git_diff', 'git_get_tree', 'git_branch_list',
]);
const MAX_PARALLEL_READS = 3;

interface ToolBatchParams {
  calls: ToolCall[];
  messages: StreamMessage[];
  options: StreamingChatOptions;
  allowedTools: ReadonlySet<string>;
  schemas: ReadonlyMap<string, JsonSchema>;
  accumulator: ToolBatchAccumulator;
  batchId: string;
  usedToolNames: Set<string>;
  onCompletedResult?: (result: ToolResult) => void;
}

type ToolBatchResult = { toolResults: ToolResult[]; interruptResolution: ToolInterruptResolution | null };

async function runSequentialToolBatch(params: ToolBatchParams & {
  orderOffset?: number;
  questionCount?: number;
  executionMode?: 'parallel' | 'sequential';
}): Promise<ToolBatchResult> {
  const { calls, messages, options, allowedTools, schemas, accumulator, batchId, usedToolNames } = params;
  const toolResults: ToolResult[] = [];
  let interruptResolution: ToolInterruptResolution | null = null;
  const questionCount = params.questionCount ?? calls.filter(call => call.function.name === 'question').length;
  for (const [order, call] of calls.entries()) {
    throwIfToolAborted(options.signal);
    const name = call.function.name;
    usedToolNames.add(name);
    let detail: string | undefined;
    const metadata = { execution_mode: params.executionMode ?? 'sequential', batch_id: batchId, order: (params.orderOffset ?? 0) + order };
    accumulator.beginToolTrace(call.id, name, detail, metadata);
    let resolution: ToolCallResolution;
    // Disabled tools historically publish hidden output, but no onToolResult.
    let notifyResult = true;
    try {
      if (isRepeatedToolCallLoop(messages, call)) {
        resolution = { kind: 'result', result: 'Tool execution aborted: repeated identical tool call.', isError: true, errorKind: 'aborted' };
      } else {
        const args: unknown = JSON.parse(call.function.arguments);
        const invalid = validateToolInvocation({ toolName: name, args, schema: schemas.get(name), allowedTools, questionErrorKind: questionCount > 1 ? 'validation' : undefined });
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          detail = formatToolTraceDetail(name, args as Record<string, unknown>);
          accumulator.beginToolTrace(call.id, name, detail, metadata);
        }
        if (invalid) {
          resolution = invalid;
          notifyResult = invalid.errorKind !== 'permission';
        } else {
          const parsedArgs = args as Record<string, unknown>;
          const custom = await invokeToolHandler(options.onToolCall, name, parsedArgs, call.id, options.signal);
          if (options.showToolTraces) accumulator.appendSystemChunk(formatToolUsageLabel(name, parsedArgs), false);
          resolution = custom ?? await executeFallbackTool({ name, args: parsedArgs, callId: call.id, options, allowedTools,
            appendSystemChunk: chunk => accumulator.appendSystemChunk(chunk, false) });
          throwIfToolAborted(options.signal);
        }
      }
    } catch (error) {
      throwIfToolAborted(options.signal);
      if (error instanceof Error && error.name === 'AbortError') throw error;
      resolution = { kind: 'result', result: `Error executing tool ${name}: ${formatToolExecutionError(error)}`, isError: true, errorKind: 'execution' };
    } finally {
      // Completion never overwrites a locally protected approval/refusal trace.
      if (options.signal?.aborted) accumulator.completeToolTrace(call.id);
    }
    throwIfToolAborted(options.signal);
    if (resolution.kind === 'interrupt') {
      interruptResolution = resolution;
    }
    const errorKind = resolution.kind === 'result' && resolution.isError ? resolution.errorKind ?? 'execution' : undefined;
    const completed: ToolResult = { tool_call_id: call.id, tool_name: name, content: resolution.result, ...(resolution.kind === 'result' && resolution.blocks ? { blocks: resolution.blocks } : {}), is_error: Boolean(errorKind), ...(errorKind ? { error_kind: errorKind } : {}) };
    toolResults.push(completed);
    // Journal before notifications or the next handler can cancel/interrupt the batch.
    params.onCompletedResult?.(completed);
    if (resolution.kind === 'interrupt') accumulator.addHiddenContextBlock(resolution.hiddenContext);
    accumulator.addHiddenToolContext(call.id, name, detail, resolution.result);
    accumulator.completeToolTrace(call.id);
    if (notifyResult) options.onToolResult?.(name, resolution.result);
    if (interruptResolution) break;
  }
  return { toolResults, interruptResolution };
}

async function runParallelReadGroup(params: ToolBatchParams & { orderOffset: number; questionCount: number }): Promise<ToolBatchResult> {
  const { calls, accumulator, options } = params;
  const perCall = calls.map((call, index) => {
    const events: Array<() => void> = [];
    const bufferedAccumulator: ToolBatchAccumulator = {
      beginToolTrace: (...args) => events.push(() => accumulator.beginToolTrace(...args)),
      completeToolTrace: (...args) => events.push(() => accumulator.completeToolTrace(...args)),
      addHiddenToolContext: (...args) => events.push(() => accumulator.addHiddenToolContext(...args)),
      addHiddenContextBlock: (...args) => events.push(() => accumulator.addHiddenContextBlock(...args)),
      appendSystemChunk: (...args) => events.push(() => accumulator.appendSystemChunk(...args)),
    };
    // Show all in-flight reads immediately; their completion events are
    // published in call order to keep provider history deterministic.
    accumulator.beginToolTrace(call.id, call.function.name, undefined, {
      execution_mode: 'parallel', batch_id: params.batchId, order: params.orderOffset + index,
    });
    const run = runSequentialToolBatch({
      ...params,
      calls: [call],
      options: { ...options, onToolResult: (name, result) => events.push(() => options.onToolResult?.(name, result)) },
      accumulator: bufferedAccumulator,
      orderOffset: params.orderOffset + index,
      executionMode: 'parallel',
      onCompletedResult: (result) => events.push(() => params.onCompletedResult?.(result)),
    });
    return { call, events, run };
  });
  const toolResults: ToolResult[] = [];
  let interruptResolution: ToolInterruptResolution | null = null;
  let flushed = 0;
  try {
    const allSettled = Promise.allSettled(perCall.map((item) => item.run));
    let removeAbortListener: () => void = () => undefined;
    const settled = options.signal
      ? await Promise.race([
          allSettled,
          new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException('Tool execution aborted', 'AbortError'));
            options.signal!.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => options.signal!.removeEventListener('abort', onAbort);
            if (options.signal!.aborted) onAbort();
          }),
        ]).finally(() => removeAbortListener())
      : await allSettled;
    throwIfToolAborted(options.signal);
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') throw outcome.reason;
      for (const event of perCall[index].events) event();
      toolResults.push(...outcome.value.toolResults);
      flushed += 1;
      if (outcome.value.interruptResolution) {
        interruptResolution = outcome.value.interruptResolution;
        break;
      }
      throwIfToolAborted(options.signal);
    }
  } finally {
    // A cancelled or interrupted batch must not leave unread sibling traces
    // looking live after the child operations have settled.
    for (const item of perCall.slice(flushed)) accumulator.completeToolTrace(item.call.id);
  }
  return { toolResults, interruptResolution };
}

export async function runToolBatch(params: ToolBatchParams): Promise<ToolBatchResult> {
  const questionCount = params.calls.filter((call) => call.function.name === 'question').length;
  const toolResults: ToolResult[] = [];
  let interruptResolution: ToolInterruptResolution | null = null;
  for (let index = 0; index < params.calls.length;) {
    throwIfToolAborted(params.options.signal);
    let readCount = 0;
    while (readCount < MAX_PARALLEL_READS &&
      PARALLEL_READ_TOOL_IDS.has(params.calls[index + readCount]?.function.name ?? '')) readCount += 1;
    const count = readCount > 1 ? readCount : 1;
    const batch = { ...params, calls: params.calls.slice(index, index + count), orderOffset: index, questionCount };
    const result = count > 1
      ? await runParallelReadGroup(batch)
      : await runSequentialToolBatch(batch);
    toolResults.push(...result.toolResults);
    if (result.interruptResolution) {
      interruptResolution = result.interruptResolution;
      break;
    }
    index += count;
  }
  return { toolResults, interruptResolution };
}
