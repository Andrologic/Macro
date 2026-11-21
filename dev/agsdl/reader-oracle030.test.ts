import { expect, test } from 'bun:test';
import { approvalChain030, evaluateReader030 } from './reader-oracle030';

const hex = (text: string) => Buffer.from(text).toString('hex');
const minimal = '{"contract":"agsdl-0.3.0","id":"order","agents":{"a":{"harness":"unknown","permissions":{"preset":"read-only","directories":{"2":"write","1":"write"}}}}}';

test('reports and spans cross as exact text in source order', () => {
  const result = evaluateReader030({ op: 'read', hex: hex(minimal), modules: { kind: 'map', entries: [] } }) as { status: string; output: { report: string; spans: [string, number, number][] } };
  expect(result.status).toBe('ok');
  expect(JSON.parse(result.output.report).diagnostics.map((d: { path: string }) => d.path)).toEqual([
    '/agents/a/permissions/directories/2', '/agents/a/permissions/directories/1', '/agents/a/harness',
  ]);
  expect(result.output.spans[0]).toEqual(['/contract', 12, 25]);
  expect(evaluateReader030({ op: 'read', hex: hex('{'), modules: { kind: 'pinned' } })).toEqual({
    status: 'ok', output: { report: '{"contract":"agsdl-0.3.0","valid":false,"diagnostics":[{"severity":"error","code":"PARSE","path":"","message":"Invalid JSON at byte 1"}],"joins":{}}', spans: [] },
  });
});

test('module failures, setup failures and registry keys stay distinct', () => {
  expect(evaluateReader030({ op: 'loadModule', hex: hex('{"2":0}') })).toMatchObject({ status: 'moduleError' });
  expect(evaluateReader030({ op: 'read', hex: hex(minimal), modules: { kind: 'map', entries: [{ name: 'x', json: '{', load: true }] } })).toEqual({
    status: 'setupError', message: 'Invalid JSON at byte 1',
  });
  // An overwritten entry is never seen by the reader, exactly like Map.set.
  expect(evaluateReader030({ op: 'read', hex: hex(minimal), modules: { kind: 'map', entries: [{ name: 'x', json: '{"bad":1}', load: false }, { name: 'x', json: '{"bad":2}', load: false }] } })).toMatchObject({
    status: 'moduleError',
  });
});

test('graph snapshots, schema roots and permissions call the vendored exports', () => {
  const graph = evaluateReader030({ op: 'graph', document: approvalChain030(3) }) as { status: string; output: { inDomain: boolean; snapshot: string } };
  expect(graph.output.inDomain).toBe(true);
  expect(graph.output.snapshot.startsWith('[[],[["scope:flow",["s",')).toBe(true);
  expect(evaluateReader030({ op: 'schema', root: 'hostMessage', value: '{"prompt":[{"uri":"x\\n"}]}' })).toMatchObject({ status: 'ok' });
  expect(evaluateReader030({ op: 'permissions', fn: 'glob', permissions: null, action: '', subject: 'a/b.ts', pattern: '**.ts', paths: true, command: false, rule: '{}' })).toEqual({
    status: 'ok', output: { result: true },
  });
});
