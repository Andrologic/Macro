import { expect, test } from 'bun:test';
import { evaluateRoutes030, type RoutesRequest030 } from './routes-oracle030';
const scopes = [{ steps: [{ address: ['work'] as [string], declarationJson: '{"type":"agent"}' as never }] }];
const source = { kind: 'entry' as const, terminalId: '', producerStep: null, outputJson: '{"prompt":"Host"}' as never, provenance: { instructions: [] } };
test('oracle preserves exact message text and does not promote output to authority', () => {
  expect(evaluateRoutes030({ op: 'message', scopes, route: '"work"', document: '{}', source, item: { kind: 'absent' } })).toEqual({
    status: 'ok', json: '{"messageJson":"{\\"prompt\\":\\"Host\\"}","promptProvenance":{"kind":"host"}}', callsJson: '[]',
  });
  expect(evaluateRoutes030({ op: 'authority', source: { ...source, kind: 'agent', producerAgent: 'lead' }, path: '["instructions"]' })).toMatchObject({ status: 'ok', json: 'null' });
});
test('oracle keeps native callback order and exact failure triples', () => {
  const request: RoutesRequest030 = { op: 'message', scopes, route: '{"step":"work","message":{"prompt":[{"uri":"a"},{"uri":"b"}]}}', document: '{}', source, item: { kind: 'absent' }, content: { entries: [{ sourceJson: '{"uri":"a"}', capturedJson: '{"value":"A"}' }] } };
  expect(evaluateRoutes030(request)).toEqual({ status: 'failure', code: 'CONTENT_UNAVAILABLE', pointer: '/message/prompt/1', message: 'No matching captured source.', callsJson: '[["{\\"uri\\":\\"a\\"}",{"usage":"prompt","pointer":"/message/prompt/0"}],["{\\"uri\\":\\"b\\"}",{"usage":"prompt","pointer":"/message/prompt/1"}]]' });
});
test('oracle reconstructs scope identity for cyclic outer continuations', () => {
  expect(evaluateRoutes030({ op: 'expect', agent: '{}', route: '{"output":"done"}', scopes: [{ steps: [], outputs: ['done'], outputRoutes: [['done', { routeJson: '{"output":"done"}' as never, scope: 0 }]] }] })).toMatchObject({ status: 'failure', code: 'ROUTES', message: 'Composition output continuations contain a cycle.' });
});
