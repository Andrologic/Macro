import { expect, it } from 'bun:test';
import { buildWorkCorpus030, WORK_MINIMUMS030 } from './work-corpus030';
import { evaluateWork030 } from './work-oracle030';

it('keeps native UTF-16 parsing distinct from exact authored submissions', () => {
    const parse = JSON.parse(evaluateWork030({ op: 'parse', json: JSON.stringify({ raw: '"\ud800"' }) }));
    expect(parse).toEqual({ status: 'ok', json: '"\\ud800"' });
    const syntax = JSON.parse(evaluateWork030({ op: 'parse', json: JSON.stringify({ raw: '\ud800' }) }));
    expect(syntax).toEqual({ status: 'exception', name: 'SyntaxError', message: "JSON Parse error: Unrecognized token '\ud800'" });
    const exact = JSON.parse(evaluateWork030({ op: 'submission', json: JSON.stringify({ agent: '{}', raw: '{"results":{"x":"\ud800"}}' }) }));
    expect(JSON.parse(exact.json)).toEqual({ kind: 'invalid', diagnostics: [{ pointer: '', rule: 'JSON', message: 'Result tool arguments must be exact JSON without duplicate keys.' }] });
});

it('requires every deterministic corpus family, including generated sequences and altered journals', () => {
    const corpus = buildWorkCorpus030();
    const counts: Record<string, number> = {};
    for (const entry of corpus) counts[entry.family] = (counts[entry.family] ?? 0) + 1;
    for (const [family, minimum] of Object.entries(WORK_MINIMUMS030)) expect(counts[family], family).toBeGreaterThanOrEqual(minimum);
    expect(buildWorkCorpus030()).toEqual(corpus);
});
