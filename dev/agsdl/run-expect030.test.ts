import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compareRun030 } from './run-expect030';

const base = { run: 'succeeded', starts: {}, messages: [], joins: [], failures: [], cancelled: [], answers: [] };
const compare = (expected: unknown, observed: unknown = base) => compareRun030(JSON.stringify(expected), JSON.stringify(observed));
const codes = (expected: unknown, observed: unknown = base) => compare(expected, observed).map((d) => d.code);
const withObserved = (patch: object) => ({ ...base, ...patch });

describe('run expectation comparison', () => {
  test('checks partial objects, absent fields, null and ordered exact-length arrays', () => {
    const observed = withObserved({ messages: [{ to: 'a', prompt: null, resources: { x: { n: 1, extra: true }, list: [1, 2] }, comments: [{ step: 's', comment: 'ok', extra: 1 }] }] });
    expect(compare({ run: 'succeeded', messages: [{ to: 'a', prompt: null, resources: { x: { n: 1 }, list: [1, 2] }, comments: [{ step: 's', comment: 'ok' }] }] }, observed)).toEqual([]);
    expect(codes({ run: 'succeeded', messages: [{ to: 'a', element: null }] }, observed)).toContain('MISSING');
    expect(codes({ run: 'succeeded', messages: [{ to: 'a', resources: { list: [2, 1] } }] }, observed)).toContain('MISMATCH');
    expect(codes({ run: 'succeeded', messages: [{ to: 'a', resources: { list: [1] } }] }, observed)).toContain('MISMATCH');
    expect(compare({ run: 'succeeded' }, observed)).toEqual([]);
  });

  test('selects deliveries including steer, and fan-out indexes separately from elements', () => {
    const observed = withObserved({ messages: [{ to: 'a', item: 0, element: 'first', prompt: 'start' }, { to: 'b' }, { to: 'a', item: 1, element: 'second', prompt: 'steer' }] });
    expect(compare({ run: 'succeeded', messages: [{ to: 'a', nth: 2, prompt: 'steer' }, { to: 'a', item: 1, element: 'second' }] }, observed)).toEqual([]);
    expect(codes({ run: 'succeeded', messages: [{ to: 'a' }] }, observed)).toEqual(['AMBIGUOUS']);
    expect(codes({ run: 'succeeded', messages: [{ to: 'a', item: 3 }] }, observed)).toEqual(['MISSING']);
    expect(codes({ run: 'succeeded', messages: [{ to: 'a', nth: 3 }] }, observed)).toEqual(['MISSING']);
    expect(codes({ run: 'succeeded', messages: [{ to: 'a', nth: 1, item: 0 }] }, observed)).toEqual(['UNSUPPORTED_SELECTION']);
  });

  test('checks exact starts and ordered joins with partial branches', () => {
    const observed = withObserved({ starts: { a: 1, extra: 1 }, joins: [{ join: 'j', outcome: 'done', branches: { a: { value: 3, extra: true }, b: null } }, { join: 'k', outcome: 'missed' }] });
    expect(codes({ run: 'succeeded', starts: { a: 1 } }, observed)).toEqual(['MISMATCH']);
    expect(compare({ run: 'succeeded', joins: [{ join: 'j', outcome: 'done', branches: { a: { value: 3 } } }, { join: 'k', outcome: 'missed' }] }, observed)).toEqual([]);
    expect(codes({ run: 'succeeded', joins: [{ join: 'k', outcome: 'missed' }, { join: 'j', outcome: 'done' }] }, observed)).toContain('MISMATCH');
    expect(codes({ run: 'succeeded', joins: [{ join: 'j', nth: 1, outcome: 'done' }] }, withObserved({ joins: [observed.joins[0]] }))).toEqual(['UNSUPPORTED_SELECTION']);
    expect(codes({ run: 'succeeded', joins: [] }, observed)).toContain('MISMATCH');
  });

  test('matches unordered multisets globally, including duplicates and overlapping patterns', () => {
    const observed = withObserved({ failures: [{ step: 'x', code: 'ERR', item: 0 }, { step: 'x', code: 'ERR', item: 1 }, { step: 'x', code: 'ERR', item: 1 }], cancelled: [{ step: 'b' }, { step: 'a' }], answers: [{ work: 'b', answer: 'no' }, { work: 'a', answer: 'no' }] });
    const expected = { run: 'succeeded', failures: [{ step: 'x', code: 'ERR' }, { step: 'x', code: 'ERR', item: 0 }, { step: 'x', code: 'ERR', item: 1 }], cancelled: [{ step: 'a' }, { step: 'b' }], answers: [{ work: 'a', answer: 'no' }, { work: 'b', answer: 'no' }] };
    expect(compare(expected, observed)).toEqual([]);
    expect(codes({ ...expected, failures: [...expected.failures, expected.failures[1]] }, observed)).toContain('MISSING');
    expect(codes({ ...expected, cancelled: [] }, observed)).toContain('MISMATCH');
  });

  test('preserves numeric lexemes without float coercion', () => {
    const observed = '{"run":"succeeded","starts":{},"messages":[{"to":"a","resources":{"n":9007199254740993,"x":1.0}}],"joins":[],"failures":[],"cancelled":[],"answers":[]}';
    expect(compareRun030('{"run":"succeeded","messages":[{"to":"a","resources":{"n":9007199254740993,"x":1.0}}]}', observed)).toEqual([]);
    const errors = compareRun030('{"run":"succeeded","messages":[{"to":"a","resources":{"n":9007199254740992,"x":1}}]}', observed);
    expect(errors.map((d) => d.path)).toEqual(['/messages/0/resources/n', '/messages/0/resources/x']);
    expect(errors.map((d) => d.observed)).toEqual(['9007199254740993', '1.0']);
  });

  test('reports invalid JSON and malformed inputs instead of passing', () => {
    expect(compareRun030('{', '{}').map((d) => d.code)).toEqual(['INVALID_JSON', 'INVALID_OBSERVED']);
    expect(codes({ run: 'succeeded', messages: [{ to: 'a', nth: 0 }] })).toEqual(['INVALID_EXPECTED']);
    expect(codes({ run: 'succeeded', typo: [] })).toEqual(['INVALID_EXPECTED']);
    expect(codes({ run: 'succeeded' }, { ...base, messages: [{ to: 'a', resources: null }] })).toEqual(['INVALID_OBSERVED']);
    expect(codes({ run: 'succeeded' }, { ...base, answers: null })).toEqual(['INVALID_OBSERVED']);
  });

  test('checks a published delivery-steer expectation against a normalized observation', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/v0.3/conformance/runs/delivery-steer.json', import.meta.url), 'utf8'));
    const observed = withObserved({ starts: { start: 1, work: 1, ping: 1 }, messages: [{ to: 'nudge', prompt: 'Also update the changelog.' }] });
    expect(compare(fixture.expect, observed)).toEqual([]);
    expect(codes(fixture.expect, { ...observed, starts: { ...observed.starts, nudge: 1 } })).toContain('MISMATCH');
  });
});
