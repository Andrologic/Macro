import { describe, expect, it } from 'bun:test';
import { BridgeControlError, decodeToolResultMessage } from './protocol';

const resultMessage = {
  type: 'tool_result',
  request_id: ' request:opaque ',
  tool_call_id: ' call/opaque ',
  result: '',
  hidden_context: null,
  visible_content: '',
  interrupt: false,
  is_error: false,
  error_kind: null,
} as const;

describe('Copilot control decoder', () => {
  it('accepts the Rust payload without trimming IDs or losing empty/null fields', () => {
    expect(decodeToolResultMessage(resultMessage)).toEqual(resultMessage);
    expect(decodeToolResultMessage({ ...resultMessage, error_kind: 'future_kind' })?.error_kind)
      .toBe('future_kind');
  });

  it.each([
    ['request_id', undefined], ['request_id', ''], ['request_id', 12],
    ['tool_call_id', null], ['tool_call_id', '   '],
    ['result', null], ['result', {}], ['hidden_context', []],
    ['visible_content', false], ['interrupt', 'true'], ['is_error', 1],
    ['error_kind', {}], ['error', 1],
  ])('rejects malformed %s=%j instead of coercing it', (field, value) => {
    expect(() => decodeToolResultMessage({ ...resultMessage, [field]: value }))
      .toThrow(BridgeControlError);
  });

  it('ignores unrelated message kinds', () => {
    for (const value of [null, [], 42, {}, { type: 'future_control' }]) {
      expect(decodeToolResultMessage(value)).toBeNull();
    }
  });
});
