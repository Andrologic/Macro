import { expect, it } from 'bun:test';
import type { ExactJsonText } from './contracts';
import { createAgentWorkContract030 } from './agentWorkContracts030';
import { EMPTY_WORK_JOURNAL030 } from './hostWorkJournal030';

const { createHostWorkPort030 } = await import('./hostWorkPort030');
const owner = { systemStartId: 'run', activationId: 'work', agentInstanceId: 'agent', ownerEpoch: '1' };
const job = {
  ticket: 'ticket', generation: 'generation', inputDigest: 'digest',
  input: {
    context: { owner: { systemStartId: 'run', ownerEpoch: '1' }, work: { systemStartId: 'run', flowInvocationId: 'flow', activationId: 'work', step: ['task'], agentInstanceId: 'agent' }, permissionsJson: '{}', scopeJson: '{}', registryVersion: 'registry' },
    eventId: 'event', expectedRevision: '0', stateJson: EMPTY_WORK_JOURNAL030,
    contractJson: JSON.stringify(createAgentWorkContract030({ agentJson: '{"results":{"n":{"required":true}}}' as ExactJsonText })),
    eventJson: JSON.stringify({ owner, eventId: 'event', event: { kind: 'submit', callId: 'call', argumentsJson: '{"results":{"n":9007199254740993}}' } }),
    optionsJson: '{"checkTimeoutMs":"1000","maxCheckOutputBytes":1024,"enforcedPlanLock":false}',
  },
};

it('evaluates captured work and preserves exact output bytes', async () => {
  const port = createHostWorkPort030('generation', () => []);
  const incoming = job;
  const output = await port.evaluate(incoming);
  expect(JSON.parse(output.receiptJson).decision.output.resultsJson).toBe('{"n":9007199254740993}');
});

it('refuses a job from another incarnation before evaluating it', async () => {
  const port = createHostWorkPort030('other', () => []);
  await expect(port.evaluate(job)).rejects.toThrow('generation');
});
