import { expect, it, mock } from 'bun:test';
import type { HostRouteJob030 } from '../../types/generated/ipc';

const invoke = mock(async () => undefined);
mock.module('../tauriRuntimeBridge', () => ({ invoke }));
const { createHostRoutePort030 } = await import('./hostRouteBroker030');

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
