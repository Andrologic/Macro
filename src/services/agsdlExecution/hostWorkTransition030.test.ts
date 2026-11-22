import { expect, it } from 'bun:test';
import type { EngineContext } from './hostWorkTransition030';
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

it('uses the shipped 030 value schema reader for a real work submission', async () => {
  const { NumberToken, parse } = await import('../../vendor/agsdl/v0.4/json.mjs');
  const { validate } = await import('../../vendor/agsdl/v0.4/valueschema.mjs');
  const { connectValueSchemaValidator030 } = await import('./valueSchemaPort030');
  const validator = connectValueSchemaValidator030({ NumberToken, parse, validate });
  const contract = JSON.stringify(createAgentWorkContract030({ agentJson: '{"results":{"data":{"required":true,"schema":{"type":"integer"}}}}' as ExactJsonText }));
  const send = (id: string, revision: string, state: string, argumentsJson: string) => evaluateHostWork030(
    context, id, revision, contract, state, event(id, { kind: 'submit', callId: id, argumentsJson }), optionsJson, validator,
  );
  const invalid = send('invalid', '0', EMPTY_WORK_JOURNAL030, '{"results":{"data":"not an integer"}}');
  expect(JSON.parse(invalid.receiptJson).decision.kind).toBe('correction');
  const valid = send('valid', '1', invalid.stateJson, '{"results":{"data":9007199254740993}}');
  expect(JSON.parse(valid.receiptJson).decision.output.resultsJson).toBe('{"data":9007199254740993}');
});
