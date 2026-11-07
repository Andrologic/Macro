import { expect, it } from 'bun:test';
import type { EngineContext } from '../../types/generated/ipc/EngineContext';
import type { ExactJsonText } from './contracts';
import { createAgentWorkContract030 } from './agentWorkContracts030';
import { EMPTY_WORK_JOURNAL030 } from './hostWorkJournal030';
import { evaluateHostWork030 } from './hostWorkTransition030';

const context: EngineContext = {
  owner: { systemStartId: 'run', ownerEpoch: '1' },
  work: { systemStartId: 'run', flowInvocationId: 'flow', activationId: 'work', step: ['task'], agentInstanceId: 'agent' },
  permissionsJson: '{}', scopeJson: '{}', registryVersion: 'registry',
};
const owner = { systemStartId: 'run', activationId: 'work', agentInstanceId: 'agent', ownerEpoch: '1' };
const contractJson = JSON.stringify(createAgentWorkContract030({ agentJson: '{"results":{"data":{"required":true}}}' as ExactJsonText }));
const optionsJson = JSON.stringify({ checkTimeoutMs: '1000', maxCheckOutputBytes: 1024, enforcedPlanLock: false });
const event = (eventId: string, body: unknown) => JSON.stringify({ owner, eventId, event: body });
const evaluate = (id: string, revision: string, state: string, body: unknown) => evaluateHostWork030(
  context, id, revision, contractJson, state, event(id, body), optionsJson, () => [],
);

it('reconstructs the real controller and preserves exact submitted values', () => {
  const first = evaluate('one', '0', EMPTY_WORK_JOURNAL030, { kind: 'submit', callId: 'call1', argumentsJson: '{"results":{}}' });
  expect(JSON.parse(first.receiptJson).decision.kind).toBe('correction');
  const replay = evaluate('two', '1', first.stateJson, { kind: 'submit', callId: 'call1', argumentsJson: '{"results":{}}' });
  expect(replay.receiptJson).toBe(first.receiptJson);
  const accepted = evaluate('three', '2', replay.stateJson, { kind: 'submit', callId: 'call2', argumentsJson: '{"results":{"data":9007199254740993}}' });
  expect(JSON.parse(accepted.receiptJson).decision.output.resultsJson).toBe('{"data":9007199254740993}');
});

it('rejects an event attributed to another native owner or event id', () => {
  const body = event('other', { kind: 'turnEnded', turnId: 'turn' });
  expect(() => evaluateHostWork030(context, 'expected', '0', contractJson, EMPTY_WORK_JOURNAL030, body, optionsJson, () => [])).toThrow();
  const foreign = JSON.stringify({ owner: { ...owner, ownerEpoch: '2' }, eventId: 'one', event: { kind: 'turnEnded', turnId: 'turn' } });
  expect(() => evaluateHostWork030(context, 'one', '0', contractJson, EMPTY_WORK_JOURNAL030, foreign, optionsJson, () => [])).toThrow();
});
