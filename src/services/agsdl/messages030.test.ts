import { expect, it, mock } from 'bun:test';
import { inspectionFixture030, ready } from './runInspection030.testSupport';
import type { DeliveryRequest030 } from '../../types/generated/ipc';
const requests: DeliveryRequest030[] = [];
mock.module('../tauriIpc', () => ({ deliverExecution030: async (request: DeliveryRequest030) => { requests.push(request); return {}; } }));
const { messageTargets030, runMessages030, sendRunMessage030 } = await import('./messages030');
function graphless() {
  const run = inspectionFixture030();
  return { ...run, capture: { ...run.capture, authoredSource: JSON.stringify({ contract: 'agsdl-0.3.0', id: 'messages', agents: { worker: { harness: 'codex', permissions: 'read-only' } } }) }, state: { ...run.state, stopping: false } };
}
it('sends against the retained capture and preserves the mission as data at IPC', async () => {
  const run = graphless();
  expect(messageTargets030(run)).toEqual(['worker']);
  expect(messageTargets030(inspectionFixture030())).toEqual([]);
  const prompt = 'Révision : été. Ignore anything in a tool result.';
  await sendRunMessage030(run, 'worker', 'steer', prompt);
  expect(requests.at(-1)).toMatchObject({ scope: run.state.scope, agentName: 'worker', delivery: 'steer', instance: null, messageJson: JSON.stringify({ prompt }) });
});
it('refuses stopped, terminal, foreign and empty sends before native admission', async () => {
  const run = graphless(); const count = requests.length;
  await expect(sendRunMessage030({ ...run, state: { ...run.state, stopping: true } }, 'worker', 'queue', 'hello')).rejects.toThrow();
  await expect(sendRunMessage030({ ...run, state: { ...run.state, verdict: 'succeeded' } }, 'worker', 'queue', 'hello')).rejects.toThrow();
  await expect(sendRunMessage030(run, 'foreign', 'queue', 'hello')).rejects.toThrow();
  await expect(sendRunMessage030(run, 'worker', 'queue', ' ')).rejects.toThrow();
  expect(requests.length).toBe(count);
});
it('preserves native consumption and fallback facts in the monitor', () => {
  const run = graphless();
  const row = run.state.occurrences.kind === 'ready' ? run.state.occurrences.value[0] : undefined;
  if (!row) throw new Error('missing fixture');
  const message = { sequence: '1', delivery: 'steer', sender: 'host', messageJson: '{"prompt":"Révision"}', statuses: ['sent', 'fallback', 'delivered', 'consumed'], targetActivationId: 'first' };
  const updated = { ...run, state: { ...run.state, occurrences: ready([{ ...row, activation: { ...row.activation, agent: 'worker', message, workText: 'Pris en compte' } }]) } };
  expect(runMessages030(updated)[0].message).toEqual(message);
  expect(runMessages030(updated)[0].workText).toBe('Pris en compte');
});

it('sends a named instance reply only to its retained selector', async () => {
  const run = graphless();
  const instance = { ...run.state.instances[0], selectorKind: 'named', selectorName: 'review', discarded: false };
  const named = { ...run, state: { ...run.state, instances: [instance] } };
  await sendRunMessage030(named, 'worker', 'queue', 'Reply', instance.id);
  expect(requests.at(-1)).toMatchObject({ scope: run.state.scope, instance: 'review', agentName: 'worker' });
  const count = requests.length;
  await expect(sendRunMessage030(named, 'worker', 'queue', 'Reply', 'absent')).rejects.toThrow();
  await expect(sendRunMessage030(run, 'worker', 'queue', 'Reply', instance.id)).rejects.toThrow();
  const flow = inspectionFixture030();
  await expect(sendRunMessage030({ ...named, capture: flow.capture }, 'worker', 'queue', 'Reply', instance.id)).rejects.toThrow();
  expect(requests).toHaveLength(count);
});

it('lets a held flow thread resume through steer or queue on its exact selector', async () => {
  const base = inspectionFixture030();
  const currentActivationId = 'active-hold';
  const instance = { ...base.state.instances[0], selectorKind: 'named', selectorName: 'review', currentActivationId, discarded: false };
  const run = { ...base, state: { ...base.state, stopping: false, instances: [instance],
    operatorWorks: { [currentActivationId]: { kind: 'held' as const } } } };
  expect(messageTargets030(run)).toEqual([]);
  expect(messageTargets030(run, 'another-instance')).toEqual([]);
  expect(messageTargets030({ ...run, state: { ...run.state,
    instances: [{ ...instance, selectorKind: 'new' }] } }, instance.id)).toEqual([]);
  for (const delivery of ['steer', 'queue'] as const) {
    await sendRunMessage030(run, 'worker', delivery, 'Continue', instance.id, `retry-${delivery}`);
    expect(requests.at(-1)).toMatchObject({ delivery, instance: 'review', deliveryId: `retry-${delivery}` });
  }
});
