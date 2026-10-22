import { StreamStopUnconfirmedError } from '../ai/streamCancellation';
import { expect, it } from 'bun:test';
import type { HostToolInvocation, HostToolReceipt } from '../../types/generated/ipc';
import { contextFixture } from './conformanceFixtures';
import { awaitNativeTool, type NativeInvocationPorts } from './nativeToolDispatch';

function request(): HostToolInvocation {
  const context = contextFixture();
  return { context: { ...context, work: { ...context.work, step: ['work'] } }, toolInvocationId: 'invocation', providerAttemptId: 'attempt',
    bindingJson: '{}', argumentsJson: '{"n":9007199254740993}', callScopeJson: null };
}
it('keeps the same invocation and exact bytes while the native approval or executor is pending', async () => {
  const input = request(), seen: HostToolInvocation[] = [];
  const receipts: HostToolReceipt[] = [{ kind: 'awaitingApproval', approval: { approvalId: 'approval', work: input.context.work, toolName: 'read', summary: 'Read', status: 'pending' } }, { kind: 'pending' }, { kind: 'ended', failed: false, resultJson: '"9007199254740993"' }];
  let waits = 0;
  const ports: NativeInvocationPorts = { invoke: async value => { seen.push(value); return receipts.shift()!; }, wait: async () => { waits++; }, identity: () => { throw new Error('must not allocate a replacement identity'); } };
  expect(await awaitNativeTool(input, ports)).toEqual({ resultJson: '"9007199254740993"', failed: false });
  expect(waits).toBe(2);
  expect(seen).toHaveLength(3);
  expect(seen.every(value => value === input)).toBe(true);
});
it('does not retry an unknown effect or turn denial into a successful tool result', async () => {
  for (const receipt of [{ kind: 'uncertain' }, { kind: 'rejected', code: 'PERMISSION' }] as const) {
    let calls = 0;
    const ports: NativeInvocationPorts = { invoke: async () => { calls++; return receipt; }, wait: async () => { throw new Error('unexpected retry'); }, identity: () => 'unused' };
    await expect(awaitNativeTool(request(), ports)).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

it('preserves native acknowledgement loss as unconfirmed termination so the Macro loop cannot continue effects', async () => {
  const ports: NativeInvocationPorts = { invoke: async () => { throw new Error('lost IPC reply'); }, wait: async () => {}, identity: () => 'unused' };
  await expect(awaitNativeTool(request(), ports)).rejects.toBeInstanceOf(StreamStopUnconfirmedError);
});

it('distinguishes native Stop cancellation from a denied approval', async () => {
  const ports: NativeInvocationPorts = { invoke: async () => ({ kind: 'rejected', code: 'STOP_CANCELLED' }), wait: async () => { throw new Error('unexpected retry'); }, identity: () => 'unused' };
  await expect(awaitNativeTool(request(), ports)).rejects.toMatchObject({ code: 'STOP_CANCELLED' });
});
