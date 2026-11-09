import { expect, test } from 'bun:test';
import { evaluateHumanClockJob030, type HostClockJob030 } from './humanAnswer030';
const owner = { systemStartId: 'run', ownerEpoch: 'owner' };
const job: HostClockJob030 = {
  ticket: 'native-ticket', generation: 'generation', inputDigest: 'native-digest',
  input: { identity: { systemStartId: 'run', flowInvocationId: 'flow', snapshotId: 'snapshot', epoch: 'capture' }, owner,
    eventId: 'native-event', expectedRevision: '0', stateJson: '', optionsJson: '{"maxSliceMs":1000}',
    eventJson: JSON.stringify({ owner, eventId: 'native-event', nowMs: '0', event: { kind: 'tick' } }) },
};
test('evaluates a flow clock without an Agent instance', () => {
  expect(JSON.parse(evaluateHumanClockJob030(job).receiptJson).clocks).toEqual([]);
  expect(() => evaluateHumanClockJob030({ ...job, input: { ...job.input, identity: { ...job.input.identity, systemStartId: 'foreign' } } })).toThrow('CORRELATION');
});
