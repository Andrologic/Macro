import { describe, expect, it } from 'bun:test';
import { compilePlan030 } from './compiler030';
import { sourceDigest } from './compiler';
import type { ExactJsonText, SourceRevision } from './contracts';
import type { CapturedRegistry030 } from './contracts030';
import { ConformanceError, decode, encode, record } from './exact';
import { prepareFlowRoute030, type NativeProducer030, type NativeRouteRef030 } from './prepareFlowRoute030';
import type { RouteSource030 } from './routes030';

const j = (value: string) => value as ExactJsonText;
const evidence = j('{"native":"synthetic"}');
async function compile(raw: string) {
  const document = record(decode(raw));
  const registry: CapturedRegistry030 = { format: 'macro-agsdl-registry/030', version: 'test', modules: [],
    hostCapabilities: ['call.command', 'call.mcp', 'approval'].map(name => ({ name, support: 'native', evidenceJson: evidence })),
    harnesses: [{ harness: 'synthetic', version: '1.0.0', installation: 'available', adapterId: 'synthetic', qualified: true,
      defaultModel: 'test/model', models: [{ name: 'test/model', efforts: [], defaultEffort: null }],
      capabilities: ['result-submission','agent-continuity','continuity','permission-enforcement','contained-stop','response-attribution','completion-check','resources','model.name','model.effort','skills','mcpServers','plan','planFirst.auto','planFirst.ask','reviewer.person','reviewer.model','directories','instance.new','delivery.steer','delivery.queue','instructions','answer-timeout','harness-settings'].map(name => ({ name, support: 'native', evidenceJson: evidence })) }],
    agents: Object.entries(record(document.agents)).map(([agentName, value]) => ({ agentName, agentDeclarationJson: encode(value), settingsJson: j('{}'), permissionsJson: j('{"preset":"read-only"}'), scopeJson: j('{"workspace":"/synthetic/workspace"}'), evidenceJson: evidence, provenanceJson: j('{"entries":[]}' ) })) };
  const revision: SourceRevision = { owner: { projectId: 'test', planId: 'test', branch: 'feature/test' }, revision: '1', sourceSha256: await sourceDigest(raw) as SourceRevision['sourceSha256'] };
  const result = await compilePlan030(raw, revision, registry);
  expect({ static: result.static.diagnostics.filter(d => d.severity === 'error'), runtime: result.runtime.diagnostics.filter(d => d.severity === 'error') }).toEqual({ static: [], runtime: [] });
  expect(result.compiledPlanJson).not.toBeNull();
  return result.compiledPlanJson!;
}
const definition = '"agents":{"lead":{"harness":"synthetic","permissions":"read-only","instructs":true,"results":{"n":{},"file":{"mediaType":"image/png"}}},"worker":{"harness":"synthetic","permissions":"read-only"}}';
const document = `{"contract":"agsdl-0.3.0","id":"route-test",${definition},"content":{"guide":{"uri":"guide.txt","mediaType":"text/plain"}},"flow":{"entry":"plan","steps":{"plan":{"type":"agent","agent":"lead","next":{"split":{"step":"worker","each":["instructions"],"max":2},"done":"worker","guide":{"step":"worker","message":{"prompt":[{"ref":"guide"}]}}},"onError":"worker"},"worker":{"type":"agent","agent":"worker","prompt":"Fallback"}}}}`;
const authority = { pathJson: j('["instructions"]'), producerAgent: 'lead', terminalId: 'terminal' };
function fixture(planJson: ExactJsonText, route: NativeRouteRef030, output: string, authorized = true, producerStep: [string, ...string[]] = ['plan']) {
  const producer: NativeProducer030 = { activationId: 'terminal', step: producerStep, kind: 'agent', inputJson: j('{}'), messageJson: null, itemJson: null, outputJson: j(output) };
  const source: RouteSource030 = { kind: route.kind === 'error' ? 'error' : 'agent', terminalId: 'terminal', producerStep, producerAgent: 'lead', outputJson: producer.outputJson, provenance: { instructions: authorized ? [authority] : [] } };
  return { planJson, reference: { route }, producer, source, nativeReceiptId: 'native-receipt' };
}
describe('preparing a reducer-selected route from a compiled plan', () => {
  it('retains exact and duplicate fan-out items, occurrence identity and native provenance', async () => {
    const plan = await compile(document);
    const initial = fixture(plan, { source: ['plan'], kind: 'normal', key: 'split' }, '{"text":"Info","results":{"n":9007199254740993,"file":"file:///workspace/image.png"},"instructions":["same","same"],"choice":"split"}');
    const input = { ...initial, source: { ...initial.source, provenance: { ...initial.source.provenance, results: [{ pathJson: j('["results","file"]'), mediaType: 'image/png' }] } } };
    const result = prepareFlowRoute030(input);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('expected prepared route');
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].targetOrdinal).toBe(0);
    expect(result.batches[0].items.map(item => item.itemJson)).toEqual([j('"same"'), j('"same"')]);
    expect(result.batches[0].items.map(item => item.occurrence.itemIndex)).toEqual(['0', '1']);
    expect(result.batches[0].items[0].messageJson).toContain('9007199254740993');
    expect(result.batches[0].items[0].messageJson).toContain('file:///workspace/image.png');
    expect(result.provenance[0].source.provenance.results).toEqual([{ pathJson: j('["results","file"]'), mediaType: 'image/png' }]);
    expect(result.provenance.map(entry => entry.prompt.kind)).toEqual(['agent', 'agent']);
    expect(result.provenance[0].source.terminalId).toBe('terminal');
    expect(result.provenance[1].producer).toEqual(input.producer);
    (input.source.provenance.results[0] as { mediaType: string }).mediaType = 'text/plain';
    expect(result.provenance[0].source.provenance.results?.[0].mediaType).toBe('image/png');
    expect(result.provenance[1].source.provenance.results?.[0].mediaType).toBe('image/png');
    expect(Object.isFrozen(result.batches[0].items[0].occurrence)).toBe(true);
    const empty = prepareFlowRoute030(fixture(plan, input.reference.route, '{"text":"","results":{},"instructions":[],"choice":"split"}'));
    expect(empty).toMatchObject({ kind: 'ready', batches: [{ items: [] }], provenance: [] });
    const tooMany = prepareFlowRoute030(fixture(plan, input.reference.route, '{"text":"","results":{},"instructions":["a","b","c"],"choice":"split"}'));
    expect(tooMany).toMatchObject({ kind: 'failed', targetOrdinal: 0, error: { code: 'FANOUT_LIMIT' } });
    expect('batches' in tooMany).toBe(false);
  });
  it('handles the native selected choice or error route and rejects missing authority or mismatched capture', async () => {
    const plan = await compile(document);
    const route: NativeRouteRef030 = { source: ['plan'], kind: 'normal', key: 'done' };
    const output = '{"text":"Info","results":{},"instructions":"work","choice":"done"}';
    expect(() => prepareFlowRoute030(fixture(plan, route, output, false))).toThrow('no attested instruction provenance');
    expect(() => prepareFlowRoute030(fixture(plan, route, '{"text":"","results":{},"choice":"done"}', true))).toThrow();
    const fixed = prepareFlowRoute030(fixture(plan, route, output));
    expect(fixed).toMatchObject({ kind: 'ready', batches: [{ items: [{ itemJson: null, occurrence: { itemIndex: '0', targetOrdinal: 0, nativeReceiptId: 'native-receipt' } }] }] });
    const error = prepareFlowRoute030(fixture(plan, { source: ['plan'], kind: 'error', key: null }, '{"error":{"code":"TIMEOUT","message":"timeout","details":[]}}', false));
    expect(error.kind).toBe('ready');
    if (error.kind === 'ready') expect(error.batches[0].items[0].messageJson).toContain('TIMEOUT');
    expect(() => prepareFlowRoute030(fixture(plan, { source: ['plan'], kind: 'normal', key: 'wrong' }, output))).toThrow('missing or ambiguous');
    const inconsistent = fixture(plan, route, output);
    expect(() => prepareFlowRoute030({ ...inconsistent, source: { ...inconsistent.source, outputJson: j('{}') } })).toThrow('disagree');
    expect(() => prepareFlowRoute030(fixture(plan, route, '{"text":"","results":{},"instructions":"x","choice":"split"}'))).toThrow('route key');
  });
  it('returns an exact content failure and uses an already captured URI without IO', async () => {
    const plan = await compile(document);
    const input = fixture(plan, { source: ['plan'], kind: 'normal', key: 'guide' }, '{"text":"","results":{},"choice":"guide"}', false);
    expect(prepareFlowRoute030(input)).toMatchObject({ kind: 'failed', targetOrdinal: 0, error: { code: 'CONTENT_UNAVAILABLE' } });
    const seen: string[] = [];
    const result = prepareFlowRoute030({ ...input, content: { resolveSource: (raw, context) => { seen.push(`${raw}:${context.usage}:${context.pointer}`); return j('{"value":"Captured","mediaType":"text/plain"}'); } } });
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.batches[0].items[0].messageJson).toContain('Captured');
      expect(result.provenance[0].prompt.kind).toBe('author');
    }
    expect(seen).toEqual(['{"uri":"guide.txt","mediaType":"text/plain"}:prompt:/message/prompt/0']);
  });
  it('returns no partial batches when a later target exceeds max or needs unavailable content', async () => {
    const mixed = `{"contract":"agsdl-0.3.0","id":"mixed-test",${definition},"content":{"guide":{"uri":"guide.txt"}},"flow":{"entry":"plan","steps":{"plan":{"type":"agent","agent":"lead","next":["run",{"step":"worker","each":["results","xs"],"max":1,"message":{"prompt":[{"ref":"guide"}]}}]},"run":{"type":"call","command":"true"},"worker":{"type":"agent","agent":"worker"}}}}`;
    const parsed = record(decode(mixed));
    record(record(record(parsed.agents).lead).results).xs = { schema: { type: 'array', items: { type: 'number' } } };
    const plan = await compile(encode(parsed));
    const route: NativeRouteRef030 = { source: ['plan'], kind: 'normal', key: null };
    const input = fixture(plan, route, '{"text":"","results":{"xs":[1,2]}}', false);
    const limited = prepareFlowRoute030(input);
    expect(limited).toMatchObject({ kind: 'failed', targetOrdinal: 1, error: { code: 'FANOUT_LIMIT' } });
    expect('batches' in limited).toBe(false);
    const unavailable = prepareFlowRoute030(fixture(plan, route, '{"text":"","results":{"xs":[1]}}', false));
    expect(unavailable).toMatchObject({ kind: 'failed', targetOrdinal: 1, error: { code: 'CONTENT_UNAVAILABLE' } });
    expect('batches' in unavailable).toBe(false);
    const ready = prepareFlowRoute030({ ...fixture(plan, route, '{"text":"","results":{"xs":[1]}}', false), content: { resolveSource: () => j('{"value":"guide"}') } });
    expect(ready).toMatchObject({ kind: 'ready', batches: [{ targetOrdinal: 0, items: [{ messageJson: null, itemJson: null }] }, { targetOrdinal: 1, items: [{ itemJson: '1' }] }] });
  });
  it('rejects a captured target that no longer matches its route declaration', async () => {
    const plan = await compile(document);
    const input = fixture(plan, { source: ['plan'], kind: 'normal', key: 'done' }, '{"text":"","results":{},"instructions":"do","choice":"done"}');
    const altered = record(decode(plan));
    const routes = altered.routes as ReturnType<typeof record>[];
    const route = routes.find(value => value.key === 'done')!;
    (route.targets as ReturnType<typeof record>[])[0].address = ['plan'];
    expect(() => prepareFlowRoute030({ ...input, planJson: encode(altered) })).toThrow('contradict');
    const invalid = record(decode(plan));
    const invalidRoutes = invalid.routes as ReturnType<typeof record>[];
    invalidRoutes.find(value => value.key === 'done')!.declarationJson = '"missing"';
    try { prepareFlowRoute030({ ...input, planJson: encode(invalid) }); throw new Error('expected correlation failure'); }
    catch (error) { expect(error).toBeInstanceOf(ConformanceError); expect((error as ConformanceError).code).toBe('CORRELATION'); }
  });
  it('preserves an approval decision, received prompt and comments; rejects a different route key', async () => {
    const raw = `{"contract":"agsdl-0.3.0","id":"approval-test",${definition},"flow":{"entry":"review","steps":{"review":{"type":"approval","next":{"yes":"worker","no":[]}},"worker":{"type":"agent","agent":"worker"}}}}`;
    const planJson = await compile(raw);
    const messageJson = j('{"prompt":"Review","resources":{"comment":{"value":"information"}},"item":null}');
    const outputJson = j('{"choice":"yes","comment":"Approved","message":{"prompt":"Review","resources":{"comment":{"value":"information"}},"item":null}}');
    const producer: NativeProducer030 = { activationId: 'approval-terminal', step: ['review'], kind: 'approval', inputJson: j('{}'), messageJson, itemJson: j('null'), outputJson };
    const source: RouteSource030 = { kind: 'approval', terminalId: producer.activationId, producerStep: ['review'], outputJson, provenance: { instructions: [], prompt: { kind: 'author', pointer: '/message/prompt' } } };
    const input = { planJson, producer, source, nativeReceiptId: 'receipt', reference: { route: { source: ['review'] as [string], kind: 'normal' as const, key: 'yes' } } };
    const result = prepareFlowRoute030(input);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.batches[0].items[0].messageJson).toContain('"comments":[{"step":"review","comment":"Approved"}]');
      expect(result.batches[0].items[0].messageJson).toContain('"comment":{"value":"information"}');
      expect(result.provenance[0].prompt).toEqual({ kind: 'author', pointer: '/message/prompt' });
      expect(result.provenance[0].producer).toEqual(producer);
    }
    const contrary = j('{"choice":"no","comment":"Approved","message":{"prompt":"Review","resources":{"comment":{"value":"information"}},"item":null}}');
    expect(() => prepareFlowRoute030({ ...input, producer: { ...producer, outputJson: contrary }, source: { ...source, outputJson: contrary } })).toThrow('route key');
    expect(() => prepareFlowRoute030({ ...input, producer: { ...producer, messageJson: j('{"prompt":"Different"}') } })).toThrow('received message');
  });
  it('preserves join producer and branch instruction and media provenance', async () => {
    const raw = `{"contract":"agsdl-0.3.0","id":"join-test",${definition},"flow":{"entry":"fork","steps":{"fork":{"type":"call","command":"true","next":["left","right"]},"left":{"type":"agent","agent":"lead","next":"gather"},"right":{"type":"agent","agent":"lead","next":"gather"},"gather":{"type":"join","next":{"step":"worker","message":{"prompt":{"from":["branches","left","instructions"]},"resources":{"diagram":{"from":["branches","right","results","file"]}}}}},"worker":{"type":"agent","agent":"worker"}}}}`;
    const planJson = await compile(raw);
    const outputJson = j('{"outcome":"done","branches":{"left":{"text":"left","results":{},"instructions":"mission"},"right":{"text":"right","results":{"file":"file:///workspace/diagram.png","n":9007199254740993}}}}');
    const producer: NativeProducer030 = { activationId: 'join-terminal', step: ['gather'], kind: 'join', inputJson: j('{}'), messageJson: null, itemJson: null, outputJson };
    const branchAuthority = { pathJson: j('["branches","left","instructions"]'), producerAgent: 'lead', terminalId: 'left-terminal' };
    const file = { pathJson: j('["branches","right","results","file"]'), mediaType: 'image/png' };
    const source: RouteSource030 = { kind: 'join', terminalId: producer.activationId, producerStep: ['gather'], outputJson, provenance: { instructions: [branchAuthority], results: [file] } };
    const result = prepareFlowRoute030({ planJson, producer, source, nativeReceiptId: 'receipt', reference: { route: { source: ['gather'], kind: 'normal', key: null } } });
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.batches[0].items[0].messageJson).toBe(j('{"prompt":"mission","resources":{"diagram":{"uri":"file:///workspace/diagram.png","mediaType":"image/png"}}}'));
      expect(result.provenance[0].prompt).toEqual({ kind: 'agent', authority: branchAuthority });
      expect(result.provenance[0].source.provenance.results).toEqual([file]);
      expect(result.provenance[0].producer).toEqual(producer);
    }
  });
  it('keeps the real body producer when the reducer selects a composition output route', async () => {
    const composed = `{"contract":"agsdl-0.3.0","id":"compose-test",${definition},"compositions":{"inner":{"parameters":["who"],"entry":"body","outputs":["done"],"steps":{"body":{"type":"agent","agent":{"parameter":"who"},"next":{"output":"done"}}}}},"flow":{"entry":"compose","steps":{"compose":{"type":"compose","composition":"inner","agents":{"who":"lead"},"next":{"done":"worker"}},"worker":{"type":"agent","agent":"worker","prompt":"Fallback"}}}}`;
    const plan = await compile(composed);
    const output = '{"text":"Info","results":{},"instructions":"from body"}';
    const result = prepareFlowRoute030(fixture(plan, { source: ['compose'], kind: 'normal', key: 'done' }, output, true, ['compose','body']));
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.batches[0].items[0].messageJson).toContain('from body');
      expect(result.provenance[0].source.producerStep).toEqual(['compose','body']);
    }
  });
});
