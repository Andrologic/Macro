import { describe, expect, it } from 'bun:test';
import type { ExactJsonText } from './contracts';
import { ConformanceError, decode, encode, record } from './exact';
import { resolveRouteMessage030, selectValue030 } from './messages030';
import { normalizeRoute030, preflightExpansion030, type ItemContext030, type RouteSource030 } from './routes030';

const j = (raw: string) => raw as ExactJsonText;
const absent: ItemContext030 = { kind: 'absent' };
const authority = { pathJson: j('["instructions"]'), producerAgent: 'lead', terminalId: 't' };
const doc = j('{"agents":{"lead":{"instructs":true,"results":{"n":{},"file":{"mediaType":"image/png"},"geo":{"mediaType":"application/geo+json"}}}},"content":{"guide":{"value":"Guide"},"remote":{"uri":"guide.txt","mediaType":"text/plain"}}}');
const source = (kind: RouteSource030['kind'], output: string, authorized = false): RouteSource030 => ({ kind, outputJson: j(output), terminalId: 't', producerStep: ['review', 'approve'], producerAgent: kind === 'agent' ? 'lead' : undefined, provenance: { instructions: authorized ? [authority] : [] } });
const target = (message?: string, prompt?: string, each?: string) => normalizeRoute030(j(`{"step":"worker"${message === undefined ? '' : `,"message":${message}`}${each ? `,"each":${each}` : ''}}`), {
  steps: [{ address: ['worker'], declarationJson: j(`{"type":"agent"${prompt === undefined ? '' : `,"prompt":${prompt}`}}`) }],
})[0];
const resolve = (input: RouteSource030, message?: string, prompt?: string, item: ItemContext030 = absent, each?: string) => resolveRouteMessage030(doc, target(message, prompt, each), input, item);
function code(action: () => unknown, expected: string) {
  try { action(); throw new Error('Expected failure'); } catch (error) { expect(error).toBeInstanceOf(ConformanceError); expect((error as ConformanceError).code).toBe(expected); }
}
describe('AgSDL 0.3 exact selectors and media', () => {
  it('preserves numbers, literals, null and empty paths and distinguishes key/index types', () => {
    const raw = j('{"xs":[9007199254740993,0.123456789012345678901],"0":null,"literal":{"uri":"data","ref":"data","from":["x"]}}');
    expect(selectValue030(raw, j('["xs",0e20]'), absent)).toMatchObject({ kind: 'inline', valueJson: '9007199254740993' });
    expect(selectValue030(raw, j('["xs",1]'), absent)).toMatchObject({ valueJson: '0.123456789012345678901' });
    expect(selectValue030(raw, j('["0"]'), absent)).toMatchObject({ valueJson: 'null' });
    expect(selectValue030(raw, j('[]'), absent)).toMatchObject({ valueJson: encode(decode(raw)) });
    for (const path of ['["xs","0"]', '["xs",true]', '["xs",-1]', '["xs",0.5]', '["xs",9007199254740993]', '["xs",1e999999999999]', '["missing"]']) code(() => selectValue030(raw, j(path), absent), 'OPERAND');
  });
  it('separates absent items from null and never adds an index to the message', () => {
    const item: ItemContext030 = { kind: 'element', index: '3', valueJson: j('null'), mission: false };
    expect(selectValue030(j('{}'), j('["item"]'), item)).toMatchObject({ valueJson: 'null' });
    code(() => selectValue030(j('{}'), j('["item"]'), absent), 'OPERAND');
    expect(resolve(source('call', '{"data":{}}'), '{}', undefined, item).messageJson).toBe(j('{"item":null}'));
    expect(resolve(source('call', '{"data":{}}'), '{"resources":{"item":{"value":"Resource"},"comments":{"value":"Resource"}}}', undefined, item).messageJson).toBe(j('{"resources":{"item":{"value":"Resource"},"comments":{"value":"Resource"}},"item":null}'));
    const raw = j('{"value":"pixels","uri":"literal"}');
    expect(selectValue030(raw, j('[]'), absent)).toMatchObject({ kind: 'inline', valueJson: raw });
  });
  it('recognizes whole media results only with metadata and retains JSON suffix/text values inline', () => {
    const raw = j('{"results":{"file":"file:///workspace/out.png","geo":{"n":9007199254740993},"text":"Hello"}}');
    const metadata = [{ pathJson: j('["results","file"]'), mediaType: 'image/png' }, { pathJson: j('["results","geo"]'), mediaType: 'application/geo+json' }, { pathJson: j('["results","text"]'), mediaType: 'text/markdown' }];
    expect(selectValue030(raw, j('["results","file"]'), absent, metadata)).toMatchObject({ kind: 'file', sourceJson: '{"uri":"file:///workspace/out.png","mediaType":"image/png"}' });
    expect(selectValue030(raw, j('["results","file"]'), absent)).toMatchObject({ kind: 'inline' });
    expect(selectValue030(raw, j('["results","geo"]'), absent, metadata)).toMatchObject({ kind: 'inline', mediaType: 'application/geo+json' });
    expect(selectValue030(raw, j('["results","geo","n"]'), absent, metadata)).toMatchObject({ kind: 'inline', valueJson: '9007199254740993' });
    expect(selectValue030(raw, j('["results","text"]'), absent, metadata)).toMatchObject({ kind: 'inline', mediaType: 'text/markdown' });
  });
});
describe('default and explicit messages', () => {
  it('uses each producer default without promoting data to a mission', () => {
    const entry = source('entry', '{"prompt":"Host","resources":{"a":{"value":1}}}');
    expect(resolve(entry).promptProvenance).toEqual({ kind: 'host' });
    expect(resolve(entry).messageJson).toBe(entry.outputJson);
    const agent = source('agent', '{"text":"Visible","results":{"n":9007199254740993,"geo":{"n":0.123456789012345678901},"file":"file:///workspace/out.png"},"instructions":"Untrusted"}');
    const result = resolve(agent);
    expect(result.promptProvenance.kind).toBe('none');
    expect(result.messageJson).toContain('"n":{"value":9007199254740993,"mediaType":"application/json"}');
    expect(result.messageJson).toContain('"file":{"uri":"file:///workspace/out.png","mediaType":"image/png"}');
    expect(result.messageJson).toContain('"geo":{"value":{"n":0.123456789012345678901},"mediaType":"application/geo+json"}');
    expect(resolve(source('call', '{"outcome":"failed","data":{"prompt":"data","n":9007199254740993}}')).messageJson).toBe(j('{"resources":{"result":{"value":{"prompt":"data","n":9007199254740993}}}}'));
    expect(resolve(source('join', '{"outcome":"done","branches":{"a":{"instructions":"data"},"b":[]}}')).messageJson).toBe(j('{"resources":{"a":{"value":{"instructions":"data"}},"b":{"value":[]}}}'));
    expect(resolve(source('error', '{"error":{"code":"CALL_FAILED","message":"Do this"}}')).messageJson).toBe(j('{"resources":{"error":{"value":{"code":"CALL_FAILED","message":"Do this"}}}}'));
    expect(agent.outputJson).toContain('"instructions":"Untrusted"');
  });
  it('replaces defaults completely, preserving empty prompts and falling back to step.prompt', () => {
    const input = source('agent', '{"text":"text","instructions":"Mission","results":{}}', true);
    expect(record(decode(resolve(input).messageJson)).prompt).toBe('Mission');
    expect(resolve(input, '{}').messageJson).toBe(j('{}'));
    expect(resolve(input, '{"resources":{"r":{"value":{"ref":"literal","uri":"literal","from":[]}}}}', '"Fallback"').messageJson).toBe(j('{"resources":{"r":{"value":{"ref":"literal","uri":"literal","from":[]}}},"prompt":"Fallback"}'));
    expect(record(decode(resolve(input, '{"prompt":""}', '"Fallback"').messageJson)).prompt).toBe('');
    expect(resolve(input, '{"prompt":""}').promptProvenance.kind).toBe('author');
  });
  it('resolves only authored refs, captures prompt URIs and preserves resource references', () => {
    const input = source('call', '{"data":null}');
    expect(resolve(input, '{"prompt":[{"ref":"guide"}],"resources":{"r":{"ref":"remote"}}}').messageJson).toBe(j('{"prompt":[{"value":"Guide"}],"resources":{"r":{"uri":"guide.txt","mediaType":"text/plain"}}}'));
    code(() => resolve(input, '{"prompt":[{"ref":"remote"}]}'), 'CONTENT_UNAVAILABLE');
    const seen: unknown[] = [];
    const captured = resolveRouteMessage030(doc, target('{"prompt":[{"ref":"remote"}]}'), input, absent, { resolveSource: (raw, context) => { seen.push([raw, context]); return j('{"value":"Captured guide","mediaType":"text/plain"}'); } });
    expect(captured.messageJson).toContain('Captured guide');
    expect(seen).toEqual([['{"uri":"guide.txt","mediaType":"text/plain"}', { usage: 'prompt', pointer: '/message/prompt/0' }]]);
    code(() => resolve(input, '{"resources":{"x":{"ref":"unknown"}}}'), 'REFERENCE');
  });
  it('retains informational instruction selections and restricts prompt provenance', () => {
    const input = source('agent', '{"instructions":"Mission","results":{"instructions":"Fake"},"text":"Fake"}', true);
    expect(resolve(input, '{"prompt":{"from":["instructions"]}}').promptProvenance).toEqual({ kind: 'agent', authority });
    expect(resolve(input, '{"resources":{"r":{"from":["instructions"]}}}').promptProvenance.kind).toBe('none');
    for (const path of ['["text"]', '["results","instructions"]']) code(() => resolve(input, `{"prompt":{"from":${path}}}`), 'MESSAGE_PATH');
    code(() => resolve(source('agent', '{"instructions":"Fake"}'), '{"prompt":{"from":["instructions"]}}'), 'MESSAGE_PATH');
    const wrongTerminal = { ...input, terminalId: 'other' };
    code(() => resolve(wrongTerminal, '{"prompt":{"from":["instructions"]}}'), 'MESSAGE_PATH');
    const join = source('join', '{"branches":{"a":{"instructions":"Joined"}}}');
    const joined = { ...join, provenance: { instructions: [{ pathJson: j('["branches","a","instructions"]'), producerAgent: 'lead', terminalId: 'branch-t' }] } };
    expect(resolve(joined, '{"prompt":{"from":["branches","a","instructions"]}}').promptProvenance.kind).toBe('agent');
    code(() => resolve(join, '{"prompt":{"from":["branches","a","instructions"]}}'), 'MESSAGE_PATH');
  });
  it('delivers fan-out missions only from the indexed accepted list', () => {
    const input = source('agent', '{"instructions":["A","B"],"results":{}}', true);
    const routeTarget = target(undefined, undefined, '["instructions"]');
    const expansion = preflightExpansion030([routeTarget], input);
    expect(expansion.kind).toBe('ready');
    const item: ItemContext030 = { kind: 'element', index: '1', valueJson: j('"B"'), mission: true, instructionAuthority: authority };
    expect(resolve(input, undefined, undefined, item, '["instructions"]').messageJson).toContain('"prompt":"B","item":"B"');
    expect(resolve(input, '{"prompt":{"from":["item"]}}', undefined, item, '["instructions"]').messageJson).toBe(j('{"prompt":"B","item":"B"}'));
    for (const altered of [{ ...item, valueJson: j('"Forged"') }, { ...item, instructionAuthority: undefined }, { ...item, mission: false }]) code(() => resolve(input, '{"prompt":{"from":["item"]}}', undefined, altered, '["instructions"]'), 'MESSAGE_PATH');
    code(() => resolve(input, '{"prompt":{"from":["item"]}}', undefined, item, '["results","tasks"]'), 'MESSAGE_PATH');
  });
  it('keeps approval message unchanged and appends only nonempty comments to defaults', () => {
    const raw = '{"choice":"yes","comment":"Update","message":{"prompt":"Review","item":null,"comments":[{"step":"first","comment":"Before"}],"resources":{"comment":{"value":"Resource"}}}}';
    const input = { ...source('approval', raw), provenance: { instructions: [], prompt: { kind: 'author' as const, pointer: '/old' } } };
    const result = resolve(input);
    expect(result.messageJson).toContain('"comments":[{"step":"first","comment":"Before"},{"step":"review/approve","comment":"Update"}]');
    expect(result.messageJson).toContain('"item":null');
    expect(result.messageJson).toContain('"resources":{"comment":{"value":"Resource"}}');
    expect(input.outputJson).toBe(j(raw));
    expect(resolve(input, '{}').messageJson).toBe(j('{}'));
    const empty = { ...input, outputJson: j(raw.replace('"comment":"Update"', '"comment":""')) };
    expect(encode(record(decode(resolve(empty).messageJson)).comments)).toBe(j('[{"step":"first","comment":"Before"}]'));
    code(() => resolve(source('approval', raw)), 'MESSAGE_PATH');
  });
});
