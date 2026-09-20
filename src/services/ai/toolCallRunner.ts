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

export async function runToolBatch(params: {
  calls: ToolCall[];
  messages: StreamMessage[];
  options: StreamingChatOptions;
  allowedTools: ReadonlySet<string>;
  schemas: ReadonlyMap<string, JsonSchema>;
  accumulator: ToolBatchAccumulator;
  batchId: string;
  usedToolNames: Set<string>;
}): Promise<{ toolResults: ToolResult[]; interruptResolution: ToolInterruptResolution | null }> {
  const { calls, messages, options, allowedTools, schemas, accumulator, batchId, usedToolNames } = params;
  const toolResults: ToolResult[] = [];
  let interruptResolution: ToolInterruptResolution | null = null;
  const questionCount = calls.filter(call => call.function.name === 'question').length;
  for (const [order, call] of calls.entries()) {
    throwIfToolAborted(options.signal);
    const name = call.function.name;
    usedToolNames.add(name);
    let detail: string | undefined;
    const metadata = { execution_mode: 'sequential' as const, batch_id: batchId, order };
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
      accumulator.addHiddenContextBlock(resolution.hiddenContext);
    }
    if (notifyResult) options.onToolResult?.(name, resolution.result);
    accumulator.addHiddenToolContext(call.id, name, detail, resolution.result);
    accumulator.completeToolTrace(call.id);
    const errorKind = resolution.kind === 'result' && resolution.isError ? resolution.errorKind ?? 'execution' : undefined;
    toolResults.push({ tool_call_id: call.id, tool_name: name, content: resolution.result, is_error: Boolean(errorKind), ...(errorKind ? { error_kind: errorKind } : {}) });
    if (interruptResolution) break;
  }
  return { toolResults, interruptResolution };
}
