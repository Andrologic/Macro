import { expect, test } from 'bun:test';
import { evaluateValues030 } from './values-oracle030';

test('oracle distinguishes lexical transport, mathematical equality and parser failures', () => {
  expect(evaluateValues030({ op: 'values', left: '1.0', right: '1e0' })).toMatchObject({
    status: 'ok', output: { equal: true, left: '1.0', right: '1e0', decimal: ['', '1', '0'] },
  });
  const hex = Buffer.from('{"é":0,"é":1}').toString('hex');
  expect(evaluateValues030({ op: 'parse', mode: 'v030', hex })).toEqual({
    status: 'parseError', byte: 8, message: 'Invalid JSON at byte 8', tree: null, spans: [], bytesHex: hex,
  });
  expect(evaluateValues030({ op: 'values', left: '01', right: '0' })).toEqual({
    status: 'failure', code: 'PARSE', pointer: '', message: 'Invalid or unsupported exact JSON.',
  });
});

test('oracle preserves different scanner orders and span map order', () => {
  const hex = Buffer.from('{"2":0,"1":1}').toString('hex');
  expect(evaluateValues030({ op: 'parse', mode: 'shared', hex })).toMatchObject({
    status: 'ok', output: { encoded: '{"1":1,"2":0}', spans: [['/2', { start: 5, end: 6 }], ['/1', { start: 11, end: 12 }], ['', { start: 0, end: 13 }]] },
  });
  expect(evaluateValues030({ op: 'parse', mode: 'v030', hex })).toMatchObject({
    status: 'ok', output: { encoded: '{"2":0,"1":1}', cloned: '{"1":1,"2":0}' },
  });
  // Its own token class is serialized by its own API, without feeding that
  // class into the shared helpers, which deliberately use instanceof.
  expect(evaluateValues030({ op: 'parse', mode: 'experimental', hex: '30' })).toMatchObject({
    status: 'ok', output: { encoded: '0', cloned: null },
  });
});

test('shape-valid inconsistent schemas remain in the semantic differential', () => {
  expect(evaluateValues030({ op: 'schema', schema: '{"type":"array","minItems":2,"maxItems":1}', value: '[]', path: [], pointer: '/a~1b' })).toMatchObject({
    status: 'ok', output: { inDomain: true, consistency: [['/minItems', 'minItems exceeds maxItems']],
      port: [{ pointer: '/a~1b', rule: 'VALUE_SCHEMA', message: 'expected at least 2 items' }] },
  });
  expect(evaluateValues030({ op: 'schema', schema: '{"type":"unknown"}', value: 'null', path: [], pointer: '' })).toEqual({ status: 'ok', output: { inDomain: false } });
});
