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

  it.each([
    ['empty string', '', '', false],
    ['whitespace string', ' \n', ' \n', false],
    ['structured empty result', { kind: 'result' as const, result: '' }, '', false],
    ['absent result', undefined, 'Error executing tool read_file: workspace read returned no content.', true],
    ['legacy error', 'File not found: empty.txt', 'Error executing tool read_file: File not found: empty.txt', true],
  ] as const)('preserves workspace read semantics for %s', async (_label, response, content, isError) => {
    const handler = mock((name: string, _args: Record<string, unknown>, _id?: string) => name === 'read' ? response : undefined);
    const read = call('read_file', 'original');
    read.function.arguments = '{"file":"empty.txt"}';
    const acc = accumulator();
    const result = await runToolBatch({ calls: [read], messages: [], options: options(handler), accumulator: acc,
      allowedTools: new Set(['read_file', 'read']), schemas: new Map(), batchId: 'fixture', usedToolNames: new Set() });
    expect(handler.mock.calls.map(([name, , id]) => [name, id])).toEqual([['read_file', 'original'], ['read', 'original']]);
    expect(result.toolResults).toEqual([{
      tool_call_id: 'original', tool_name: 'read_file', content, is_error: isError,
      ...(isError ? { error_kind: 'execution' } : {}),
    }]);
    expect(acc.addHiddenToolContext).toHaveBeenCalledWith('original', 'read_file', expect.any(String), content);
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

  it('runs independent built-in reads concurrently but publishes results in call order', async () => {
    let releaseFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const published: string[] = [];
    const providerOrder: string[] = [];
    const handler = mock((name: string, _args: Record<string, unknown>, id?: string) => {
      started.push(id ?? '');
      return name === 'read' && id === 'one' ? first : id ?? '';
    });
    const acc = accumulator();
    const pending = runToolBatch({
      calls: [call('read', 'one'), call('grep', 'two')], messages: [],
      options: { ...options(handler), onToolResult: (_name, result) => published.push(result) },
      accumulator: acc, allowedTools: new Set(['read', 'grep']), schemas: new Map(),
      batchId: 'fixture', usedToolNames: new Set(),
      onCompletedResult: (result) => providerOrder.push(result.tool_call_id),
    });
    await Promise.resolve();
    expect(started).toEqual(['one', 'two']);
    expect(published).toEqual([]);
    releaseFirst('one');
    const result = await pending;
    expect(result.toolResults.map((item) => item.tool_call_id)).toEqual(['one', 'two']);
    expect(published).toEqual(['one', 'two']);
    expect(providerOrder).toEqual(['one', 'two']);
    expect(acc.beginToolTrace).toHaveBeenCalledWith('one', 'read', undefined, {
      execution_mode: 'parallel', batch_id: 'fixture', order: 0,
    });
  });

  it('treats a mutation as a barrier between parallel read groups', async () => {
    let releaseFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const handler = mock((_name: string, _args: Record<string, unknown>, id?: string) => {
      started.push(id ?? '');
      return id === 'one' ? first : id ?? '';
    });
    const pending = run([
      call('read', 'one'), call('grep', 'two'), call('write', 'three'), call('list', 'four'),
    ], options(handler));
    await Promise.resolve();
    expect(started).toEqual(['one', 'two']);
    releaseFirst('one');
    const result = await pending;
    expect(started).toEqual(['one', 'two', 'three', 'four']);
    expect(result.toolResults.map((item) => item.tool_call_id)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('keeps unknown MCP tools sequential even when their names suggest reads', async () => {
    let releaseFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const handler = mock((_name: string, _args: Record<string, unknown>, id?: string) => {
      started.push(id ?? '');
      return id === 'one' ? first : id ?? '';
    });
    const pending = run([call('mcp__fixture__read', 'one'), call('mcp__fixture__read', 'two')], options(handler));
    await Promise.resolve();
    expect(started).toEqual(['one']);
    releaseFirst('one');
    await pending;
    expect(started).toEqual(['one', 'two']);
  });

  it('does not publish concurrent sibling results after cancellation', async () => {
    const controller = new AbortController();
    const acc = accumulator();
    const published = mock(() => undefined);
    const handler = mock(async (_name: string, _args: Record<string, unknown>, id?: string) => {
      if (id === 'one') controller.abort();
      await Promise.resolve();
      return id ?? '';
    });
    await expect(run([call('read', 'one'), call('grep', 'two')], {
      ...options(handler), signal: controller.signal, onToolResult: published,
    }, acc)).rejects.toMatchObject({ name: 'AbortError' });
    expect(published).not.toHaveBeenCalled();
    expect(acc.addHiddenToolContext).not.toHaveBeenCalled();
  });

  it('caps concurrent reads at three and responds to abort while a handler is pending', async () => {
    const releases: Array<(value: string) => void> = [];
    const started: string[] = [];
    const handler = mock((_name: string, _args: Record<string, unknown>, id?: string) => {
      started.push(id ?? '');
      return new Promise<string>((resolve) => releases.push(resolve));
    });
    const controller = new AbortController();
    const acc = accumulator();
    const pending = run([
      call('read', 'one'), call('grep', 'two'), call('glob', 'three'), call('list', 'four'),
    ], { ...options(handler), signal: controller.signal }, acc);
    await Promise.resolve();
    expect(started).toEqual(['one', 'two', 'three']);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).not.toContain('four');
    for (const [index, release] of releases.entries()) release(String(index));
    await Promise.resolve();
    expect(acc.addHiddenToolContext).not.toHaveBeenCalled();
  });

  it('stops publishing concurrent siblings when a result callback cancels the batch', async () => {
    const controller = new AbortController();
    const published: string[] = [];
    const handler = mock((_name: string, _args: Record<string, unknown>, id?: string) => id ?? '');
    await expect(runToolBatch({
      calls: [call('read', 'one'), call('grep', 'two')], messages: [],
      options: { ...options(handler), signal: controller.signal, onToolResult: (_name, result) => {
        published.push(result);
        controller.abort();
      } },
      accumulator: accumulator(), allowedTools: new Set(['read', 'grep']),
      schemas: new Map(), batchId: 'fixture', usedToolNames: new Set(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(published).toEqual(['one']);
  });

  it('keeps a completed read in provider history when a later concurrent read is cancelled', async () => {
    const controller = new AbortController();
    let releaseSecond!: (value: string) => void;
    const second = new Promise<string>((resolve) => { releaseSecond = resolve; });
    let publishedFirst!: () => void;
    const firstPublished = new Promise<void>((resolve) => { publishedFirst = resolve; });
    const providerOrder: string[] = [];
    const acc = accumulator();
    const pending = runToolBatch({
      calls: [call('read', 'one'), call('grep', 'two')], messages: [],
      options: { ...options((_name, _args, id) => id === 'two' ? second : 'first'), signal: controller.signal },
      accumulator: acc, allowedTools: new Set(['read', 'grep']), schemas: new Map(),
      batchId: 'fixture', usedToolNames: new Set(),
      onCompletedResult: (result) => {
        providerOrder.push(result.tool_call_id);
        if (result.tool_call_id === 'one') publishedFirst();
      },
    });
    await firstPublished;
    expect(providerOrder).toEqual(['one']);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    releaseSecond('late');
    await Promise.resolve();
    expect(providerOrder).toEqual(['one']);
    expect(acc.addHiddenToolContext).toHaveBeenCalledWith('one', 'read', undefined, 'first');
    expect(acc.addHiddenToolContext).not.toHaveBeenCalledWith('two', 'grep', expect.anything(), 'late');
  });

  it('stops replaying a read after its completion callback cancels the turn', async () => {
    const controller = new AbortController();
    const acc = accumulator();
    const notified = mock(() => undefined);
    const committed: string[] = [];
    await expect(runToolBatch({
      calls: [call('read', 'one'), call('grep', 'two')], messages: [],
      options: { ...options((_name, _args, id) => id ?? ''), signal: controller.signal, onToolResult: notified },
      accumulator: acc, allowedTools: new Set(['read', 'grep']), schemas: new Map(),
      batchId: 'fixture', usedToolNames: new Set(),
      onCompletedResult: (result) => {
        committed.push(result.tool_call_id);
        controller.abort();
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(committed).toEqual(['one']);
    expect(acc.addHiddenToolContext).not.toHaveBeenCalled();
    expect(notified).not.toHaveBeenCalled();
  });
});
