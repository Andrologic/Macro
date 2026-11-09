import { expect, it, mock } from 'bun:test';
import type { HostRouteJob030 } from '../../types/generated/ipc';
import type { ExactJsonText, SourceRevision } from './contracts';
import { compilePlan030 } from './compiler030';
import { sourceDigest } from './compiler';
import { decode, encode, record } from './exact';
import type { CapturedRegistry030 } from './contracts030';

const invoke = mock(async () => undefined);
mock.module('../tauriRuntimeBridge', () => ({ invoke }));
const { capturedContentForOccurrence030, createHostRoutePort030 } = await import('./hostRouteBroker030');

it('keeps native content caches distinct for equal fan-out items and rejects duplicates', () => {
  const identity = { captureId: 'capture', sourceDigest: 'source', agent: 'worker', policyDigest: 'policy' };
  const receipt = (text: string) => ({ sourceJson: '{"uri":"guide.txt"}' as ExactJsonText,
    payload: { kind: 'text' as const, text }, provenance: { ...identity, usage: 'prompt' as const,
      pointer: '/message/prompt/0', requestedUri: 'guide.txt', mediaType: 'text/plain', sha256: 'a'.repeat(64) } });
  const first = { targetOrdinal: 1, itemIndex: '0', contextId: 'first', identity, receipts: [receipt('A')] };
  const second = { targetOrdinal: 1, itemIndex: '1', contextId: 'second', identity, receipts: [receipt('B')] };
  const factory = capturedContentForOccurrence030({ format: 'macro-agsdl-route-content/1', occurrences: [first, second] });
  const target = {} as Parameters<typeof factory>[2];
  const source = '{"uri":"guide.txt"}' as ExactJsonText;
  const use = { usage: 'prompt' as const, pointer: '/message/prompt/0' };
  expect(factory(1, '0', target)?.resolveSource?.(source, use)).toContain('"A"');
  expect(factory(1, '1', target)?.resolveSource?.(source, use)).toContain('"B"');
  expect(factory(1, '2', target)).toEqual({});
  expect(() => capturedContentForOccurrence030({ format: 'macro-agsdl-route-content/1', occurrences: [first, first] })).toThrow();
  for (const itemIndex of [0, ['0']]) {
    const invalid = { ...first, itemIndex } as unknown as typeof first;
    expect(() => capturedContentForOccurrence030({ format: 'macro-agsdl-route-content/1', occurrences: [invalid] })).toThrow();
  }
  expect(() => capturedContentForOccurrence030({ identity, receipts: [receipt('A')] })).toThrow();
  expect(capturedContentForOccurrence030({ identity, receipts: [] })(1, '0', target)).toEqual({});
});

it('prepares two real destinations with their own captured content and never borrows the other cache', async () => {
  const raw = '{"contract":"agsdl-0.3.0","id":"broker","agents":{"lead":{"harness":"synthetic","permissions":"read-only"},"worker":{"harness":"synthetic","permissions":"read-only"}},"content":{"guide":{"uri":"guide.txt","mediaType":"text/plain"}},"flow":{"entry":"plan","steps":{"plan":{"type":"agent","agent":"lead","next":[{"step":"alpha","message":{"prompt":[{"ref":"guide"}]}},{"step":"beta","message":{"prompt":[{"ref":"guide"}]}}]},"alpha":{"type":"agent","agent":"worker"},"beta":{"type":"agent","agent":"worker"}}}}';
  const document = record(decode(raw));
  const evidence = '{"native":"synthetic"}' as ExactJsonText;
  const registry: CapturedRegistry030 = { format: 'macro-agsdl-registry/030', version: 'test', modules: [],
    harnesses: [{ harness: 'synthetic', version: '1.0.0', installation: 'available', adapterId: 'synthetic', qualified: true,
      defaultModel: 'test/model', models: [{ name: 'test/model', efforts: [], defaultEffort: null }],
      capabilities: ['result-submission','agent-continuity','continuity','permission-enforcement','contained-stop','response-attribution','completion-check','resources','model.name','model.effort','skills','mcpServers','plan','planFirst.auto','planFirst.ask','reviewer.person','reviewer.model','directories','instance.new','delivery.steer','delivery.queue','instructions','answer-timeout','harness-settings'].map(name => ({ name, support: 'native', evidenceJson: evidence })) }],
    agents: Object.entries(record(document.agents)).map(([agentName, value]) => ({ agentName, agentDeclarationJson: encode(value), settingsJson: '{}' as ExactJsonText, permissionsJson: '{"preset":"read-only"}' as ExactJsonText, scopeJson: '{"workspace":"/synthetic"}' as ExactJsonText, evidenceJson: evidence, provenanceJson: '{"entries":[]}' as ExactJsonText })) };
  const revision: SourceRevision = { owner: { projectId: 'test', planId: 'test', branch: 'feature/test' }, revision: '1', sourceSha256: await sourceDigest(raw) as SourceRevision['sourceSha256'] };
  const compiled = await compilePlan030(raw, revision, registry);
  expect(compiled.compiledPlanJson).not.toBeNull();
  const outputJson = '{"text":"","results":{}}';
  const producer = { activationId: 'terminal', step: ['plan'], kind: 'agent', inputJson: '{}', messageJson: null, itemJson: null, outputJson };
  const source = { kind: 'agent', terminalId: 'terminal', producerStep: ['plan'], producerAgent: 'lead', outputJson, provenance: { instructions: [] } };
  const identity = { captureId: 'capture', sourceDigest: 'source', agent: 'worker', policyDigest: 'policy' };
  const occurrence = (targetOrdinal: number, text: string) => ({ targetOrdinal, itemIndex: '0', contextId: `context-${targetOrdinal}`, identity,
    receipts: [{ sourceJson: '{"uri":"guide.txt","mediaType":"text/plain"}', payload: { kind: 'text', text }, provenance: { ...identity, usage: 'prompt', pointer: '/message/prompt/0', requestedUri: 'guide.txt', mediaType: 'text/plain', sha256: 'a'.repeat(64) } }] });
  const input = { planJson: compiled.compiledPlanJson, reference: { route: { source: ['plan'], kind: 'normal', key: null } }, producer, source, nativeReceiptId: 'receipt',
    contentReceipts: { format: 'macro-agsdl-route-content/1', occurrences: [occurrence(0, 'A'), occurrence(1, 'B')] } };
  const job: HostRouteJob030 = { ticket: 'ticket', generation: 'generation', inputDigest: 'digest', inputJson: JSON.stringify(input) };
  const port = createHostRoutePort030('generation');
  const output = await port.evaluate(job);
  expect(output.kind).toBe('ready');
  if (output.kind !== 'ready') throw new Error('expected route');
  const result = JSON.parse(output.resultJson);
  expect(result.batches[0].items[0].messageJson).toContain('"A"');
  expect(result.batches[1].items[0].messageJson).toContain('"B"');
  input.contentReceipts.occurrences.pop();
  const missing = await port.evaluate({ ...job, inputJson: JSON.stringify(input) });
  expect(missing.kind).toBe('ready');
  if (missing.kind !== 'ready') throw new Error('expected correlated preparation failure');
  expect(JSON.parse(missing.resultJson)).toMatchObject({ kind: 'failed', targetOrdinal: 1, error: { code: 'CONTENT_UNAVAILABLE' } });
});

it('prepares the selected captured route and transports exact values without inventing authority', async () => {
  const planJson = await Bun.file('src-tauri/tests/fixtures/agsdl030_compiled_plan.json').text();
  const outputJson = '{"outcome":"success","data":9007199254740993}';
  const producer = { activationId: 'terminal', step: ['fork'], kind: 'call', inputJson: '{}', messageJson: null, itemJson: null, outputJson };
  const source = { kind: 'call', terminalId: 'terminal', producerStep: ['fork'], outputJson, provenance: { instructions: [] } };
  const input = { planJson, reference: { route: { source: ['fork'], kind: 'normal', key: null } },
    producer, source, nativeReceiptId: 'native-receipt', contentReceipts: { identity: {
      captureId: 'capture', sourceDigest: 'digest', agent: 'worker', policyDigest: 'policy',
    }, receipts: [] } };
  const job: HostRouteJob030 = { ticket: 'ticket', generation: 'generation', inputDigest: 'digest', inputJson: JSON.stringify(input) };
  const port = createHostRoutePort030('generation');
  const output = await port.evaluate(job);
  expect(output.kind).toBe('ready');
  if (output.kind !== 'ready') throw new Error('expected preparation');
  expect(output.resultJson).toContain('9007199254740993');
  const prepared = JSON.parse(output.resultJson);
  expect(prepared.kind).toBe('ready');
  expect(prepared.batches[0].items[0].occurrence.nativeReceiptId).toBe('native-receipt');
  await port.complete(job, output);
  expect(invoke).toHaveBeenLastCalledWith('execution_host_complete_route030', { completion: {
    ticket: job.ticket, generation: job.generation, inputDigest: job.inputDigest, output,
  } });
  const wrong = { ...input, source: { ...source, terminalId: 'other' } };
  expect(await port.evaluate({ ...job, inputJson: JSON.stringify(wrong) })).toMatchObject({ kind: 'failed', code: 'CORRELATION' });
});

it('normalizes native command tickets before routes and keeps normal failed distinct from parsing failure', async () => {
  const port = createHostRoutePort030('generation');
  const job = (input: unknown): HostRouteJob030 => ({ ticket: 'call-ticket', generation: 'generation', inputDigest: 'digest', inputJson: JSON.stringify(input) });
  const source = { kind: 'entry', terminalId: 'call-visit', producerStep: ['tests'], outputJson: '{}', provenance: { instructions: [] } };
  const prepared = await port.evaluate(job({ operation: 'prepare', stepJson: '{"type":"call","command":"never execute","parse":"json"}', source }));
  if (prepared.kind !== 'ready') throw new Error('Call preparation failed');
  const input = { operation: 'normalize', prepared: JSON.parse(prepared.resultJson).prepared,
    receipt: { exitCodeJson: '1', stdout: '{"failed":9007199254740993}', stderr: 'stderr', output: '{"failed":9007199254740993}stderr', complete: true } };
  const normalized = await port.evaluate(job(input));
  if (normalized.kind !== 'ready') throw new Error('Call normalization failed');
  expect(JSON.parse(normalized.resultJson)).toEqual({ kind: 'completed', outputJson: '{"outcome":"failed","data":{"exitCode":1,"output":"{\\"failed\\":9007199254740993}stderr","value":{"failed":9007199254740993}}}' });
  const invalid = await port.evaluate(job({ ...input, receipt: { ...input.receipt, stdout: 'not json' } }));
  if (invalid.kind !== 'ready') throw new Error('Data failure escaped native ticket');
  expect(JSON.parse(invalid.resultJson)).toEqual({ kind: 'failed', code: 'OUTPUT_INVALID' });
  await expect(port.evaluate({ ...job(input), generation: 'retired' })).rejects.toThrow('generation changed');
});

it('transports human clock jobs through the authenticated native route mailbox', async () => {
  const owner = { systemStartId: 'system', ownerEpoch: 'epoch' };
  const input = { owner, eventId: 'admit', expectedRevision: '0', stateJson: '', optionsJson: '{"maxSliceMs":2147483647}',
    eventJson: JSON.stringify({ owner, eventId: 'admit', nowMs: '1700000000000', event: { kind: 'admit', workId: 'work', timeoutMs: '60000', answerTimeoutMs: '600000', startedAtMs: '1700000000000' } }) };
  const job: HostRouteJob030 = { ticket: 'human-ticket', generation: 'generation', inputDigest: 'digest', inputJson: JSON.stringify({ operation: 'humanClock', input }) };
  const port = createHostRoutePort030('generation');
  const output = await port.evaluate(job);
  if (output.kind !== 'ready') throw new Error('Human clock evaluation failed');
  const receipt = JSON.parse(JSON.parse(output.resultJson).receiptJson);
  expect(receipt.clocks).toHaveLength(1);
  expect(receipt.nextWakeMs).toBe(60000);
  await port.complete(job, output);
  expect(invoke).toHaveBeenLastCalledWith('execution_host_complete_route030', { completion: { ticket: job.ticket, generation: job.generation, inputDigest: job.inputDigest, output } });
  await expect(port.evaluate({ ...job, generation: 'retired' })).rejects.toThrow('generation changed');
});
