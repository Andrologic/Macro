import { describe, expect, it, mock } from 'bun:test';
import type { StreamingChatOptions } from './contracts';
import { createStreamAccumulator } from './streamAccumulator';
import { runToolCallingLoop, type ToolCallingAdapter } from './toolCallingLoop';

function fixture(maxTurns: number | null | undefined, executionPolicy?: 'native-serial') {
  const dispatch = mock(async () => ({ kind: 'result' as const, result: 'Simulated read' }));
  const options: StreamingChatOptions = {
    providerId: 'fixture', providerType: 'openai', modelId: 'fixture', baseUrl: 'https://example.invalid',
    messages: [], allowedToolIds: ['read'], maxTurns, executionPolicy,
    onToken() {}, onComplete() {}, onError() {},
    ...(executionPolicy ? { onRawToolCall: dispatch } : { onToolCall: dispatch }),
  };
  const request = mock<ToolCallingAdapter['streamTurn']>(async ({ turnCount }) => ({
    result: {
      content: '',
      // End unrestricted runs without imposing a synthetic turn budget.
      toolCalls: turnCount < 52 ? [{ id: `read-${turnCount}`, type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path: `fixture-${turnCount}.txt` }) } }] : [],
    },
    projectAssistant: () => ({ items: [] }),
  }));
  const adapter: ToolCallingAdapter = {
    kind: executionPolicy ? 'native' : 'generic', streamTurn: request, projectTool: result => result.content, afterToolResults() {},
  };
  return { request, dispatch, run: () => runToolCallingLoop(options, adapter, createStreamAccumulator(options)) };
}

describe('tool calling turn budgets', () => {
  it.each([1, 2, 3, 51])('honors captured native-serial maxTurns=%i exactly', async maxTurns => {
    const h = fixture(maxTurns, 'native-serial');
    expect((await h.run()).completionReason).toBe('tool_turn_limit');
    expect(h.request).toHaveBeenCalledTimes(maxTurns);
    expect(h.dispatch).toHaveBeenCalledTimes(maxTurns);
  });

  it.each([[1, 3], [2, 3], [3, 3], [51, 50]])('keeps Chat normalization for maxTurns=%i', async (value, normalized) => {
    const h = fixture(value);
    expect((await h.run()).completionReason).toBe('tool_turn_limit');
    expect(h.request).toHaveBeenCalledTimes(normalized);
    expect(h.dispatch).toHaveBeenCalledTimes(normalized);
  });

  it.each([undefined, null])('keeps unlimited Chat maxTurns=%s', async value => {
    const h = fixture(value);
    expect((await h.run()).completionReason).not.toBe('tool_turn_limit');
    expect(h.request).toHaveBeenCalledTimes(53);
    expect(h.dispatch).toHaveBeenCalledTimes(52);
  });

  it('keeps an omitted native budget unlimited', async () => {
    const h = fixture(undefined, 'native-serial');
    expect((await h.run()).completionReason).not.toBe('tool_turn_limit');
    expect(h.request).toHaveBeenCalledTimes(53);
    expect(h.dispatch).toHaveBeenCalledTimes(52);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])('rejects invalid native maxTurns=%s before effects', async value => {
    const h = fixture(value, 'native-serial');
    await expect(h.run()).rejects.toThrow('positive integer turn limit');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
