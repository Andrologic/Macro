import { describe, expect, it } from 'bun:test';
import { compilePlan030 } from './compiler030';
import { sourceDigest } from './sourceDigest';
import { createHostRoutePort030 } from './hostRouteBroker030';
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
  it('isolates the same URI and pointer across destination caches and policies', async () => {
    const raw = `{"contract":"agsdl-0.3.0","id":"occurrence-targets",${definition},"content":{"guide":{"uri":"guide.txt","mediaType":"text/plain"}},"flow":{"entry":"plan","steps":{"plan":{"type":"agent","agent":"lead","next":[{"step":"alpha","message":{"prompt":[{"ref":"guide"}],"resources":{"n":{"from":["results","n"]}}}},{"step":"beta","message":{"prompt":[{"ref":"guide"}],"resources":{"n":{"from":["results","n"]}}}}]},"alpha":{"type":"agent","agent":"worker"},"beta":{"type":"agent","agent":"worker"}}}}`;
    const plan = await compile(raw);
    const input = fixture(plan, { source: ['plan'], kind: 'normal', key: null }, '{"text":"","results":{"n":9007199254740993}}', false);
    const seen: unknown[] = [];
    let globalCalls = 0;
    const result = prepareFlowRoute030({ ...input, content: { resolveSource: () => { globalCalls++; return j('{"value":"global"}'); } },
      contentForOccurrence: (ordinal, index, target) => {
        seen.push([ordinal, index, target]);
        return { resolveSource: (rawSource, context) => {
          expect(rawSource).toBe(j('{"uri":"guide.txt","mediaType":"text/plain"}'));
          expect(context).toEqual({ usage: 'prompt', pointer: '/message/prompt/0' });
          return j(ordinal === 0 ? '{"value":"Policy A"}' : '{"value":"Policy B"}');
        } };
      } });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('expected ready route');
    expect(result.batches.map(batch => batch.items[0].messageJson)).toEqual([
      j('{"prompt":[{"value":"Policy A"}],"resources":{"n":{"value":9007199254740993,"mediaType":"application/json"}}}'),
      j('{"prompt":[{"value":"Policy B"}],"resources":{"n":{"value":9007199254740993,"mediaType":"application/json"}}}'),
    ]);
    expect(seen.map(entry => { const [ordinal, index, target] = entry as [number, string, { address: string[] }]; return [ordinal, index, target.address]; })).toEqual([[0, '0', ['alpha']], [1, '0', ['beta']]]);
    expect(result.provenance.map(entry => [entry.occurrence.targetOrdinal, entry.occurrence.itemIndex, entry.prompt.kind])).toEqual([[0, '0', 'author'], [1, '0', 'author']]);
    expect(globalCalls).toBe(0);
  });
  it('uses occurrence indices for equal fan-out values, without reusing content', async () => {
    const raw = `{"contract":"agsdl-0.3.0","id":"occurrence-fanout",${definition},"content":{"guide":{"uri":"guide.txt"}},"flow":{"entry":"plan","steps":{"plan":{"type":"agent","agent":"lead","next":["run",{"step":"worker","each":["results","xs"],"message":{"prompt":[{"ref":"guide"}]}}]},"run":{"type":"call","command":"true"},"worker":{"type":"agent","agent":"worker"}}}}`;
    const parsed = record(decode(raw));
    record(record(record(parsed.agents).lead).results).xs = { schema: { type: 'array', items: { type: 'number' } } };
    const plan = await compile(encode(parsed));
    const input = fixture(plan, { source: ['plan'], kind: 'normal', key: null }, '{"text":"","results":{"xs":[9007199254740993,9007199254740993]}}', false);
    const seen: unknown[] = [];
    const result = prepareFlowRoute030({ ...input, contentForOccurrence: (ordinal, index, target) => {
      seen.push([ordinal, index, target.kind === 'step' ? target.address : null]);
      return { resolveSource: () => j(index === '0' ? '{"value":"First cache"}' : '{"value":"Second cache"}') };
    } });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('expected ready route');
    expect(seen).toEqual([[1, '0', ['worker']], [1, '1', ['worker']]]);
    expect(result.batches[0].items[0]).toMatchObject({ messageJson: null, itemJson: null, occurrence: { targetOrdinal: 0, itemIndex: '0' } });
    expect(result.batches[1].items.map(item => item.itemJson)).toEqual([j('9007199254740993'), j('9007199254740993')]);
    expect(result.batches[1].items.map(item => item.occurrence.itemIndex)).toEqual(['0', '1']);
    expect(result.batches[1].items[0].messageJson).toContain('First cache');
    expect(result.batches[1].items[1].messageJson).toContain('Second cache');
    expect(result.provenance.map(value => [value.occurrence.targetOrdinal, value.occurrence.itemIndex])).toEqual([[0, '0'], [1, '0'], [1, '1']]);
  });
  it('fails closed when an occurrence cache is undefined or empty even with a global cache', async () => {
    const raw = `{"contract":"agsdl-0.3.0","id":"occurrence-missing",${definition},"content":{"guide":{"uri":"guide.txt"}},"flow":{"entry":"plan","steps":{"plan":{"type":"agent","agent":"lead","next":[{"step":"alpha","message":{"prompt":[{"ref":"guide"}]}},{"step":"beta","message":{"prompt":[{"ref":"guide"}]}}]},"alpha":{"type":"agent","agent":"worker"},"beta":{"type":"agent","agent":"worker"}}}}`;
    const plan = await compile(raw);
    const input = fixture(plan, { source: ['plan'], kind: 'normal', key: null }, '{"text":"","results":{}}', false);
    for (const missing of [undefined, {}]) {
      let globalCalls = 0;
      const seen: number[] = [];
      const result = prepareFlowRoute030({ ...input,
        content: { resolveSource: () => { globalCalls++; return j('{"value":"Wrong global cache"}'); } },
        contentForOccurrence: ordinal => { seen.push(ordinal); return ordinal === 0 ? { resolveSource: () => j('{"value":"Allowed"}') } : missing; },
      });
      expect(result).toMatchObject({ kind: 'failed', targetOrdinal: 1, error: { code: 'CONTENT_UNAVAILABLE' } });
      expect('batches' in result).toBe(false);
      expect('provenance' in result).toBe(false);
      expect(seen).toEqual([0, 1]);
      expect(globalCalls).toBe(0);
    }
    const legacy = prepareFlowRoute030({ ...input, content: { resolveSource: () => j('{"value":"Legacy"}') } });
    expect(legacy.kind).toBe('ready');
    if (legacy.kind === 'ready') expect(legacy.batches.map(batch => batch.items[0].messageJson)).toEqual([j('{"prompt":[{"value":"Legacy"}]}'), j('{"prompt":[{"value":"Legacy"}]}')]);
  });
  it('never asks for a content cache for call or join targets', async () => {
    const raw = `{"contract":"agsdl-0.3.0","id":"occurrence-nonreceivers",${definition},"flow":{"entry":"fork","steps":{"fork":{"type":"call","command":"true","next":["run","gather"]},"run":{"type":"call","command":"true","next":"gather"},"gather":{"type":"join","next":"worker"},"worker":{"type":"agent","agent":"worker"}}}}`;
    const plan = await compile(raw);
    const outputJson = j('{"outcome":"passed","data":{"n":9007199254740993}}');
    const producer: NativeProducer030 = { activationId: 'call-terminal', step: ['fork'], kind: 'call', inputJson: j('{}'), messageJson: null, itemJson: null, outputJson };
    const source: RouteSource030 = { kind: 'call', terminalId: producer.activationId, producerStep: ['fork'], outputJson, provenance: { instructions: [] } };
    let calls = 0;
    const result = prepareFlowRoute030({ planJson: plan, producer, source, nativeReceiptId: 'receipt', reference: { route: { source: ['fork'], kind: 'normal', key: null } },
      contentForOccurrence: () => { calls++; throw new Error('No cache for call or join'); } });
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') expect(result.batches.map(batch => batch.items[0].messageJson)).toEqual([null, null]);
    expect(calls).toBe(0);
  });
  it('keeps the real body producer when the reducer selects a composition output route', async () => {
    const composed = `{"contract":"agsdl-0.3.0","id":"compose-test",${definition},"compositions":{"inner":{"parameters":["who"],"entry":"body","outputs":["done"],"steps":{"body":{"type":"agent","agent":{"parameter":"who"},"next":{"output":"done"}}}}},"flow":{"entry":"compose","steps":{"compose":{"type":"compose","composition":"inner","agents":{"who":"lead"},"next":{"done":"worker"}},"worker":{"type":"agent","agent":"worker","prompt":"Fallback"}}}}`;
    const plan = await compile(composed);
    const output = '{"text":"Info","results":{},"instructions":"from body"}';
    const result = prepareFlowRoute030(fixture(plan, { source: ['compose'], kind: 'normal', key: 'done' }, output, true, ['compose','body']));
    const failed = fixture(plan, { source: ['compose'], kind: 'normal', key: 'done' }, '{"error":{"code":"VISIT_LIMIT","message":"VISIT_LIMIT","details":[]}}', false, ['compose','body']);
    const errorExit = prepareFlowRoute030({ ...failed, source: { ...failed.source, kind: 'error' } });
    expect(errorExit).toMatchObject({ kind: 'ready' });
    if (errorExit.kind === 'ready') expect(errorExit.batches[0].items[0].messageJson).toContain('VISIT_LIMIT');

    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.batches[0].items[0].messageJson).toContain('from body');
      expect(result.provenance[0].source.producerStep).toEqual(['compose','body']);
    }
  });
  it('defers local prompt content to the effective nested entry agent and keeps the wrapper occurrence', async () => {
    const raw = `{"contract":"agsdl-0.3.0","id":"entry-content",${definition},"flow":{"entry":"plan","steps":{
      "plan":{"type":"agent","agent":"lead","next":{"step":"outer","message":{"prompt":[{"uri":"file:///workspace/mission.txt","mediaType":"text/plain"}]}}},
      "outer":{"type":"compose","composition":"outer","next":{"done":[]}}
    }},"compositions":{
      "outer":{"entry":"inner","outputs":["done"],"steps":{"inner":{"type":"compose","composition":"inner","next":{"done":{"output":"done"}}}}},
      "inner":{"entry":"work","outputs":["done"],"steps":{"work":{"type":"agent","agent":"worker","next":{"output":"done"}}}}
    }}`;
    const plan = await compile(raw);
    const input = { ...fixture(plan, { source: ['plan'], kind: 'normal', key: null }, '{"text":"","results":{}}', false), deferPromptUris: true };
    const result = prepareFlowRoute030(input);
    expect(result).toMatchObject({ kind: 'ready', batches: [{ target: { address: ['outer'] }, items: [{ occurrence: { nativeReceiptId: 'native-receipt', targetOrdinal: 0, itemIndex: '0' } }] }] });
    if (result.kind === 'ready') expect(result.batches[0].items[0].messageJson).toContain('file:///workspace/mission.txt');
    const wrong = record(decode(plan));
    const steps = wrong.steps as ReturnType<typeof record>[];
    steps.find(step => JSON.stringify(step.address) === '["outer","inner","work"]')!.type = 'approval';
    expect(prepareFlowRoute030({ ...input, planJson: encode(wrong) })).toMatchObject({ kind: 'failed', error: { code: 'CONTENT_UNAVAILABLE' } });
  });

  it('forwards approval replies and failures through nested outputs without mixing their message contracts', async () => {
    const raw = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'approval-output', agents: {},
      compositions: {
        inner: { entry: 'approve', outputs: ['done'], steps: { approve: { type: 'approval', timeoutMs: 1,
          next: { yes: { output: 'done' } }, onError: { output: 'done' } } } },
        outer: { entry: 'inner', outputs: ['done'], steps: { inner: { type: 'compose', composition: 'inner',
          next: { done: { output: 'done' } } } } },
      },
      flow: { entry: 'outer', steps: {
        outer: { type: 'compose', composition: 'outer', next: { done: 'after' } },
        after: { type: 'approval', next: { yes: [] } },
      } },
    });
    const planJson = await compile(raw);
    const messageJson = j('{"prompt":"Synthetic approval"}');
    const cases = [
      { errorCode: null, messageJson },
      { errorCode: 'APPROVAL_TIMEOUT', messageJson },
      { errorCode: 'VISIT_LIMIT', messageJson: null },
    ];
    for (const { errorCode, messageJson: received } of cases) {
      const outputJson = j(JSON.stringify(errorCode
        ? { error: { code: errorCode, message: errorCode, details: [] } }
        : { choice: 'yes', comment: 'Approved', message: JSON.parse(messageJson) }));
      const producer: NativeProducer030 = { activationId: 'approval-terminal', step: ['outer', 'inner', 'approve'],
        kind: 'approval', inputJson: j('{}'), messageJson: received, itemJson: null, outputJson };
      const source: RouteSource030 = { kind: errorCode ? 'error' : 'approval', terminalId: producer.activationId,
        producerStep: producer.step, outputJson, provenance: { instructions: [], ...(!errorCode ? { prompt: { kind: 'host' as const } } : {}) } };
      const input = { planJson, producer, source, nativeReceiptId: 'receipt',
        reference: { route: { source: ['outer'] as [string], kind: 'normal' as const, key: 'done' } } };
      const prepared = prepareFlowRoute030(input);
      expect(prepared.kind).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('expected prepared composition output');
      const message = JSON.parse(prepared.batches[0].items[0].messageJson!);
      if (errorCode) expect(message.resources.error.value.code).toBe(errorCode);
      else {
        expect(message.prompt).toBe('Synthetic approval');
        expect(() => prepareFlowRoute030({ ...input, producer: { ...producer, messageJson: j('{"prompt":"Other"}') } })).toThrow('received message');
      }
      const output = await createHostRoutePort030('generation').evaluate({ ticket: 'ticket', generation: 'generation', inputDigest: 'digest',
        inputJson: JSON.stringify({ ...input, contentReceipts: { format: 'macro-agsdl-route-content/1', occurrences: [] } }) });
      expect(output.kind).toBe('ready');
      if (output.kind !== 'ready') throw new Error('expected prepared resident route');
      expect(JSON.parse(output.resultJson)).toEqual(prepared);
    }
  });
});
