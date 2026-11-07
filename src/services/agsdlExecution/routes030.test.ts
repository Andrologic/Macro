import { describe, expect, it } from 'bun:test';
import type { ExactJsonText } from './contracts';
import { ConformanceError, decode, encode } from './exact';
import { instructionsExpectation030, normalizeRoute030, preflightExpansion030, type RouteSource030, type Scope030 } from './routes030';

const j = (raw: string) => raw as ExactJsonText;
const scope: Scope030 = { steps: [
  { address: ['worker'], declarationJson: j('{"type":"agent"}') },
  { address: ['review'], declarationJson: j('{"type":"approval"}') },
  { address: ['body'], declarationJson: j('{"type":"compose"}') },
  { address: ['run'], declarationJson: j('{"type":"call"}') },
  { address: ['gather'], declarationJson: j('{"type":"join"}') },
] };
const source = (outputJson: string, instructs = false): RouteSource030 => ({ terminalId: 't', producerStep: ['plan'], producerAgent: 'lead', kind: 'agent', outputJson: j(outputJson),
  provenance: { instructions: instructs ? [{ pathJson: j('["instructions"]'), producerAgent: 'lead', terminalId: 't' }] : [] } });
function code(action: () => unknown, expected: string) {
  try { action(); throw new Error('Expected failure'); } catch (error) { expect(error).toBeInstanceOf(ConformanceError); expect((error as ConformanceError).code).toBe(expected); }
}
describe('AgSDL 0.3 descriptive routes', () => {
  it('normalizes single/list/empty routes and keeps exact target declarations', () => {
    expect(normalizeRoute030(j('[]'), scope)).toEqual([]);
    const targets = normalizeRoute030(j('["worker",{"step":"review","message":{},"each":["results","xs"],"concurrency":9007199254740993,"max":1e999999}]'), scope);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ kind: 'step', address: ['worker'], declarationJson: '"worker"' });
    expect(targets[1]).toMatchObject({ concurrencyJson: '9007199254740993', maxJson: '1e999999', messageJson: '{}' });
    expect(Object.isFrozen(targets)).toBe(true);
  });
  it('resolves lexical scope and composition outputs without global lookup', () => {
    const nested: Scope030 = { prefix: ['body'], outputs: ['done'], steps: [{ address: ['body', 'worker'], declarationJson: j('{"type":"agent"}') }] };
    expect(normalizeRoute030(j('"worker"'), nested)[0]).toMatchObject({ address: ['body', 'worker'] });
    expect(normalizeRoute030(j('{"output":"done"}'), nested)).toEqual([{ kind: 'output', name: 'done' }]);
    code(() => normalizeRoute030(j('{"output":"done"}'), scope), 'ROUTES');
    code(() => normalizeRoute030(j('{"output":"done","message":{}}'), nested), 'ROUTES');
    code(() => normalizeRoute030(j('"missing"'), scope), 'REFERENCE');
  });
  it('rejects duplicate targets across spellings and invalid message/fan-out targets', () => {
    code(() => normalizeRoute030(j('["worker",{"step":"worker","message":{}}]'), scope), 'DUPLICATE');
    for (const target of ['{"step":"run","message":{}}', '{"step":"gather","each":[]}', '{"step":"worker","max":1}', '{"step":"worker","each":[],"concurrency":0}', '{"step":"worker","each":[],"max":1.1}']) code(() => normalizeRoute030(j(target), scope), 'ROUTES');
    for (const each of ['[true]', '[-1]', '[0.5]', '["item"]']) code(() => normalizeRoute030(j(`{"step":"worker","each":${each}}`), scope), 'MESSAGE_PATH');
  });
  it('returns no batches on a later expansion error, including after a fixed target', () => {
    const targets = normalizeRoute030(j('["review",{"step":"worker","each":["results","xs"]},{"step":"body","each":["missing"]}]'), scope);
    const result = preflightExpansion030(targets, source('{"results":{"xs":[1,2]}}'));
    expect(result).toMatchObject({ kind: 'failed', targetIndex: 2, code: 'OPERAND' });
    expect('batches' in result).toBe(false);
    if (result.kind === 'failed') expect(decode(result.errorJson)).toMatchObject({ error: { code: 'OPERAND' } });
  });
  it('keeps duplicates, order, empty lists, exact caps and immutable descriptors', () => {
    for (const max of ['2', '2.0', '2e0', '9007199254740993', '1e999999999999999999']) {
      const targets = normalizeRoute030(j(`{"step":"worker","each":["results","xs"],"max":${max},"concurrency":1}`), scope);
      const result = preflightExpansion030(targets, source('{"results":{"xs":[9007199254740993,9007199254740993]}}'));
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') continue;
      expect(result.batches[0]).toMatchObject({ kind: 'fanout', length: '2', listJson: '[9007199254740993,9007199254740993]', maxJson: max, concurrencyJson: '1' });
      expect(Object.isFrozen(result.batches)).toBe(true);
      expect(Object.isFrozen(result.batches[0])).toBe(true);
    }
    const targets = normalizeRoute030(j('{"step":"worker","each":["results","xs"],"max":1}'), scope);
    expect(preflightExpansion030(targets, source('{"results":{"xs":[1,2]}}'))).toMatchObject({ kind: 'failed', code: 'FANOUT_LIMIT' });
    expect(preflightExpansion030(targets, source('{"results":{"xs":[]}}'))).toMatchObject({ kind: 'ready', batches: [{ kind: 'fanout', length: '0', listJson: '[]' }] });
    for (const value of ['null', '{}', '"x"']) expect(preflightExpansion030(targets, source(`{"results":{"xs":${value}}}`))).toMatchObject({ kind: 'failed', code: 'OPERAND' });
  });
  it('requires accepted provenance for instruction missions and never parses text as routing', () => {
    const targets = normalizeRoute030(j('{"step":"worker","each":["instructions"]}'), scope);
    expect(preflightExpansion030(targets, source('{"instructions":["A","B"]}', true))).toMatchObject({ kind: 'ready', batches: [{ mission: true, instructionAuthority: { producerAgent: 'lead' } }] });
    for (const input of [source('{"instructions":["A"]}'), source('{"instructions":[1]}', true)]) expect(preflightExpansion030(targets, input)).toMatchObject({ kind: 'failed', code: 'OPERAND' });
    expect(normalizeRoute030(j('"review"'), scope)[0]).toMatchObject({ address: ['review'] });
  });
});
describe('instructions required by the selected route only', () => {
  const yes = j('{"instructs":true}'), no = j('{}');
  it('distinguishes terminal, scalar and list expectations', () => {
    expect(instructionsExpectation030(yes, j('[]'), scope)).toBe('none');
    expect(instructionsExpectation030(no, j('"worker"'), scope)).toBe('none');
    expect(instructionsExpectation030(yes, j('"worker"'), scope)).toBe('string');
    expect(instructionsExpectation030(yes, j('{"step":"worker","message":{}}'), scope)).toBe('none');
    expect(instructionsExpectation030(yes, j('{"step":"worker","message":{"prompt":{"from":["instructions"]}}}'), scope)).toBe('string');
    expect(instructionsExpectation030(yes, j('{"step":"worker","each":["instructions"],"message":{"prompt":{"from":["item"]}}}'), scope)).toBe('list');
  });
  it('requires destination context and excludes calls and joins in both target forms', () => {
    // @ts-expect-error A captured scope is required, including at the public API boundary.
    code(() => instructionsExpectation030(yes, j('"run"')), 'ROUTES');
    for (const target of ['"run"', '{"step":"run"}', '"gather"', '{"step":"gather"}']) {
      expect(instructionsExpectation030(yes, j(target), scope)).toBe('none');
      expect(instructionsExpectation030(yes, j(`["worker",${target}]`), scope)).toBe('string');
      expect(instructionsExpectation030(yes, j(`[{"step":"worker","each":["instructions"]},${target}]`), scope)).toBe('list');
    }
  });
  it('follows selected composition outputs into the effective outer route', () => {
    const body = (outerRoute: string): Scope030 => ({
      prefix: ['compose'], steps: [], outputs: ['done'],
      outputRoutes: { done: { routeJson: j(outerRoute), scope } },
    });
    const output = j('{"output":"done"}');
    for (const [route, expected] of [
      ['[]', 'none'], ['"run"', 'none'],
      ['"worker"', 'string'],
      ['{"step":"worker","message":{}}', 'none'],
      ['{"step":"worker","message":{"prompt":{"from":["instructions"]}}}', 'string'],
      ['[{"step":"worker","each":["instructions"]},"run"]', 'list'],
    ] as const) expect(instructionsExpectation030(yes, output, body(route))).toBe(expected);
    code(() => instructionsExpectation030(yes, output, { prefix: ['compose'], steps: [], outputs: ['done'] }), 'ROUTES');
    expect(instructionsExpectation030(no, output, body('"worker"'))).toBe('none');
  });
  it('follows nested outputs and combines their effective targets with sibling targets', () => {
    const middle: Scope030 = {
      prefix: ['outer'], steps: [{ address: ['outer', 'review'], declarationJson: j('{"type":"approval"}') }], outputs: ['out'],
      outputRoutes: { out: { routeJson: j('{"step":"worker","each":["instructions"]}'), scope } },
    };
    const inner: Scope030 = {
      prefix: ['outer', 'inner'], steps: [], outputs: ['done'],
      outputRoutes: { done: { routeJson: j('{"output":"out"}'), scope: middle } },
    };
    expect(instructionsExpectation030(yes, j('{"output":"done"}'), inner)).toBe('list');
    const middleWithSibling: Scope030 = { ...middle, outputRoutes: middle.outputRoutes };
    const conflict: Scope030 = { ...inner, outputRoutes: { done: { routeJson: j('[{"output":"out"},"review"]'), scope: middleWithSibling } } };
    code(() => instructionsExpectation030(yes, j('{"output":"done"}'), conflict), 'MESSAGE_PATH');
    const loop: { steps: Scope030['steps']; outputs: string[]; outputRoutes: Record<string, { routeJson: ExactJsonText; scope: Scope030 }> } = { steps: [], outputs: ['again'], outputRoutes: {} };
    loop.outputRoutes.again = { routeJson: j('{"output":"again"}'), scope: loop };
    code(() => instructionsExpectation030(yes, j('{"output":"again"}'), loop), 'ROUTES');
    for (const agent of [j('{}'), j('{"instructs":false}')]) {
      code(() => instructionsExpectation030(agent, j('{"output":"done"}'), { steps: [], outputs: ['done'] }), 'ROUTES');
      code(() => instructionsExpectation030(agent, j('{"output":"again"}'), loop), 'ROUTES');
      expect(instructionsExpectation030(agent, j('{"output":"done"}'), inner)).toBe('none');
    }
  });
  it('refuses a list of missions also used as a single default or explicit prompt', () => {
    for (const other of ['"review"', '{"step":"review","message":{"prompt":{"from":["instructions"]}}}']) code(() => instructionsExpectation030(yes, j(`[{"step":"worker","each":["instructions"]},${other}]`), scope), 'MESSAGE_PATH');
    expect(instructionsExpectation030(yes, j('[{"step":"worker","each":["instructions"]},{"step":"review","message":{"resources":{"missions":{"from":["instructions"]}}}}]'), scope)).toBe('list');
    expect(encode(decode(j('9007199254740993')))).toBe(j('9007199254740993'));
  });
});
