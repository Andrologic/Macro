import { expect, it } from 'bun:test';
import { AgentInstances030 } from './agentInstances030';
import type { ExactJsonText } from './contracts';
const json = '{}' as ExactJsonText;
function fixtures() { let n = 0; return new AgentInstances030(() => `instance-${++n}`); }
const delivery = (id: string) => ({ deliveryId: id, workId: id, senderId: 'sender', messageJson: json });
it('lazily reuses shared and named instances and isolates definitions', () => {
  const instances = fixtures();
  const shared = instances.resolve('agent', 'digest', { kind: 'shared' });
  expect(instances.resolve('agent', 'digest', { kind: 'shared' })).toEqual(shared);
  const named = instances.resolve('agent', 'digest', { kind: 'named', name: 'pro' });
  expect(named.instanceId).not.toBe(shared.instanceId);
  expect(instances.resolve('other', 'digest', { kind: 'named', name: 'pro' }).instanceId).not.toBe(named.instanceId);
  expect(() => instances.resolve('agent', 'changed', { kind: 'shared' })).toThrow('configuration');
});
it('queues FIFO, absorbs steer only for active flow work, and deduplicates deliveries', () => {
  const instances = fixtures(), id = instances.resolve('agent', 'digest', { kind: 'shared' }).instanceId;
  expect(instances.deliver(id, delivery('first')).kind).toBe('start');
  expect(instances.deliver(id, delivery('second')).kind).toBe('queued');
  expect(instances.deliver(id, { ...delivery('steer'), delivery: 'steer' })).toMatchObject({ kind: 'steer', workId: 'first' });
  expect(instances.deliver(id, delivery('second')).kind).toBe('queued');
  expect(() => instances.deliver(id, { ...delivery('second'), senderId: 'changed' })).toThrow('conflicting');
  instances.setCountsForFlow(id, 'first', false);
  expect(instances.deliver(id, { ...delivery('third'), delivery: 'steer' }).kind).toBe('queued');
  expect(instances.finish(id, 'first')?.workId).toBe('second');
  expect(instances.finish(id, 'second')?.workId).toBe('third');
  expect(instances.finish(id, 'third')).toBeNull();
});
it('discards new instances and preserves memory only on the matching durable instance', () => {
  const instances = fixtures(), id = instances.resolve('agent', 'digest', { kind: 'new' }).instanceId;
  instances.deliver(id, delivery('one')); instances.finish(id, 'one');
  expect(() => instances.inspect(id)).toThrow('discarded');
  expect(() => instances.resolve('agent', 'digest', { kind: 'new' }, 'queue')).toThrow('delivery');
  const shared = instances.resolve('agent', 'digest', { kind: 'shared' }).instanceId;
  instances.deliver(shared, delivery('two'));
  const checkpoint = { agentInstanceId: shared, configurationDigest: 'digest', revision: '1', formatVersion: 'provider/1', stateJson: json };
  expect(() => instances.finish(shared, 'two', { ...checkpoint, agentInstanceId: 'foreign' })).toThrow('Foreign');
  instances.finish(shared, 'two', checkpoint);
  expect(instances.inspect(shared).memory).toEqual(checkpoint);
  instances.deliver(shared, delivery('three'));
  expect(() => instances.finish(shared, 'three', checkpoint)).toThrow('advance');
});
it('pins the configuration of a definition across all selectors and discarded fresh instances', () => {
  const instances = fixtures();
  const first = instances.resolve('a', 'd1', { kind: 'new' });
  instances.deliver(first.instanceId, delivery('only')); instances.finish(first.instanceId, 'only');
  for (const selector of [{ kind: 'shared' }, { kind: 'named', name: 'n' }, { kind: 'new' }] as const) {
    expect(() => instances.resolve('a', 'd2', selector)).toThrow('Definition configuration');
    expect(instances.resolve('a', 'd1', selector).configurationDigest).toBe('d1');
  }
});
