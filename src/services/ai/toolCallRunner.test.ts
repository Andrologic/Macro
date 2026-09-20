import { describe, expect, it, mock } from 'bun:test';
import type { StreamingChatOptions, ToolCall } from './contracts';
import { runToolBatch, validateToolInvocation, type ToolBatchAccumulator } from './toolCallRunner';

const call = (name: string, id = name): ToolCall => ({ id, type: 'function', function: { name, arguments: '{}' } });
const accumulator = (): ToolBatchAccumulator => ({
  beginToolTrace: mock(() => undefined), completeToolTrace: mock(() => undefined),
  addHiddenToolContext: mock(() => undefined), addHiddenContextBlock: mock(() => undefined),
  appendSystemChunk: mock(() => undefined),
});
const options = (onToolCall: StreamingChatOptions['onToolCall']): StreamingChatOptions => ({
  providerId: 'fixture', providerType: 'openai', baseUrl: 'https://example.invalid', modelId: 'fixture', messages: [],
  onToken: () => undefined, onComplete: () => undefined, onError: () => undefined, onToolCall,
});
const run = (calls: ToolCall[], opts: StreamingChatOptions, acc = accumulator()) => runToolBatch({
  calls, messages: [], options: opts, accumulator: acc, allowedTools: new Set(calls.map(item => item.function.name)),
  schemas: new Map(), batchId: 'fixture', usedToolNames: new Set(),
});

describe('shared tool batch', () => {
  it('preserves an explicit empty result without invoking a fallback', async () => {
    const handler = mock(() => ({ kind: 'result' as const, result: '' }));
    const result = await run([call('web_fetch')], options(handler));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.toolResults).toEqual([{ tool_call_id: 'web_fetch', tool_name: 'web_fetch', content: '', is_error: false }]);
  });

  it('keeps batch and live question quotas distinct before calling the handler', async () => {
    const handler = mock(() => 'unused');
    const result = await run([call('question', 'q1'), call('question', 'q2')], options(handler));
    expect(handler).not.toHaveBeenCalled();
    expect(result.toolResults.map(item => [item.tool_call_id, item.error_kind])).toEqual([['q1', 'validation'], ['q2', 'validation']]);
    const input = { toolName: 'question', args: {}, allowedTools: new Set(['question']) };
    expect(validateToolInvocation(input)).toBeUndefined();
    expect(validateToolInvocation({ ...input, questionErrorKind: 'execution' })?.errorKind).toBe('execution');
  });

  it('returns a structured workspace read denial with the original call id', async () => {
    const handler = mock((name: string, _args: Record<string, unknown>, _id?: string) => name === 'read' ? { kind: 'result' as const, result: 'Denied', isError: true, errorKind: 'permission' as const } : undefined);
    const read = call('read_file', 'original');
    read.function.arguments = '{"file":"README.md"}';
    const result = await runToolBatch({ calls: [read], messages: [], options: options(handler), accumulator: accumulator(),
      allowedTools: new Set(['read_file', 'read']), schemas: new Map(), batchId: 'fixture', usedToolNames: new Set() });
    expect(handler.mock.calls[1]).toEqual(['read', { path: 'README.md', start_line: undefined, end_line: undefined, max_lines: undefined, cursor: undefined }, 'original']);
    expect(result.toolResults[0]).toEqual({ tool_call_id: 'original', tool_name: 'read_file', content: 'Denied', is_error: true, error_kind: 'permission' });
  });

  it('does not execute the next tool or publish late output after an awaited handler is cancelled', async () => {
    const controller = new AbortController();
    const handler = mock(async () => { controller.abort(); await Promise.resolve(); return 'late'; });
    const acc = accumulator();
    await expect(run([call('read'), call('write')], { ...options(handler), signal: controller.signal }, acc)).rejects.toMatchObject({ name: 'AbortError' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(acc.addHiddenToolContext).not.toHaveBeenCalled();
  });

  it('rejects malformed invocation envelopes without imposing the Macro schema dialect on MCP', () => {
    const input = { toolName: 'mcp__fixture__tool', allowedTools: new Set(['mcp__fixture__tool']) };
    expect(validateToolInvocation({ ...input, args: [] })?.errorKind).toBe('validation');
    expect(validateToolInvocation({ ...input, args: { vendor: { extension: true } } })).toBeUndefined();
  });
});
