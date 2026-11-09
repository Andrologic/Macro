import { describe, expect, it } from 'bun:test';
import type { ExactJsonText } from './contracts';
import { decode, encode, NumberToken } from './exact';
import { createAgentWorkContract030, type ValueSchemaValidator030 } from './agentWorkContracts030';
import { validateAgentSubmission030 } from './agentSubmission030';
import { AgentWorkController030, type WorkEventBody030 } from './agentWorkController030';
import { compareIntegers030, timerDelay030 } from './workIntegers030';

const json = (value: string) => value as ExactJsonText;
const port: ValueSchemaValidator030 = (value, schema, pointer) => {
  // This suite tests the work protocol, not a second value-schema implementation.
  expect(schema).toEqual(decode('{"type":"integer"}'));
  return value instanceof NumberToken && value.raw === '9007199254740993' ? [] : [{ pointer, rule: 'VALUE_SCHEMA', message: 'Expected the exact fixture integer.' }];
};
const owner = { systemStartId: 'run', activationId: 'work', agentInstanceId: 'instance', ownerEpoch: '1' };
function harness(agent = '{}', route: Parameters<typeof createAgentWorkContract030>[0] = { agentJson: json('{}') }) {
  const contract = createAgentWorkContract030({ ...route, agentJson: json(agent) });
  const controller = new AgentWorkController030(owner, contract, port, { checkTimeoutMs: '1000', maxCheckOutputBytes: 5, enforcedPlanLock: true });
  let sequence = 0;
  const send = (event: WorkEventBody030, eventId = `event-${++sequence}`) => controller.dispatch({ owner, eventId, event });
  return { contract, controller, send };
}
describe('030 exact submission and work protocol', () => {
  it('corrects malformed Unicode submissions without silently publishing replacement text', () => {
    const { send, controller } = harness('{"results":{"textual":{"required":true,"mediaType":"text/plain"}}}');
    const refused = send({ kind: 'submit', callId: 'invalid-unicode', argumentsJson: `{"results":{"textual":"${String.fromCharCode(0xd800)}"}}` });
    expect(refused.decision.kind).toBe('correction');
    if (refused.decision.kind === 'correction' && refused.decision.category === 'submission') {
      expect(refused.decision.diagnostics[0].rule).toBe('JSON');
    }
    expect(controller.snapshot().accepted).toBeNull();
    expect(controller.snapshot().submissionCorrections).toBe('1');
    const valid = send({ kind: 'submit', callId: 'literal-replacement', argumentsJson: '{"results":{"textual":"�"}}' });
    expect(valid.decision.kind).toBe('accepted');
    if (valid.decision.kind === 'accepted') expect(decode(valid.decision.output.resultsJson)).toEqual({ textual: '�' });
  });
  it('keeps huge budgets exact without exponent expansion', () => {
    expect(compareIntegers030('1e999999999999999999999', '9007199254740993')).toBe(1);
    expect(compareIntegers030('1.00e2', '100')).toBe(0);
    expect(timerDelay030('1e999999999999999999999', 20n)).toBe(2147483647);
    expect(timerDelay030('1e2', 99n)).toBe(1);
  });
  it('validates direct JSON/text/file values and preserves exact tokens', () => {
    const { contract } = harness('{"results":{"n":{"required":true,"schema":{"type":"integer"}},"textual":{"mediaType":"text/plain"},"file":{"mediaType":"image/png"},"literal":{"mediaType":"application/geo+json"}}}');
    const good = validateAgentSubmission030(contract, '{"results":{"n":9007199254740993,"textual":"ok","file":"file:///workspace/a.png","literal":{"value":1}}}', port);
    expect(good.kind).toBe('candidate');
    if (good.kind === 'candidate') expect(good.candidate.resultsJson).toContain('9007199254740993');
    for (const raw of ['{}', '{"results":{"n":9007199254740992}}', '{"results":{"n":9007199254740993,"file":"../a"}}', '{"results":{"n":9007199254740993,"textual":{}}}', '{"results":{"n":9007199254740993,"unknown":1}}', '{"results":{},"results":{}}']) {
      expect(validateAgentSubmission030(contract, raw, port).kind).toBe('invalid');
    }
  });
  it('uses instructions of the selected route and refuses unauthorized missions', () => {
    const { contract } = harness('{"instructs":true}', { agentJson: json('{}'), choices: ['split', 'done'], instructionsByChoice: { split: 'list', done: 'string' } });
    expect(validateAgentSubmission030(contract, '{"choice":"split","instructions":[]}', port).kind).toBe('candidate');
    expect(validateAgentSubmission030(contract, '{"choice":"done","instructions":"ship"}', port).kind).toBe('candidate');
    expect(validateAgentSubmission030(contract, '{"choice":"done","instructions":[]}', port).kind).toBe('invalid');
    expect(validateAgentSubmission030(contract, '{"choice":"other"}', port).kind).toBe('invalid');
    expect(validateAgentSubmission030(harness().contract, '{"instructions":"injected"}', port).kind).toBe('invalid');
  });
  it('shares the default two corrections across refusals and omissions, idempotently', () => {
    const { controller, send } = harness('{"results":{"answer":{"required":true}}}');
    const event = { kind: 'submit', callId: 'call1', argumentsJson: '{}' } as const;
    const receipt = send(event, 'same');
    expect(send(event, 'same')).toEqual(receipt);
    expect(send(event, 'different-event')).toEqual(receipt);
    expect(() => send({ ...event, argumentsJson: '{ }' }, 'same')).toThrow('conflicting');
    expect(send({ kind: 'turnEnded', turnId: 't1' }).decision.kind).toBe('correction');
    expect(send({ kind: 'turnEnded', turnId: 't2' }).decision).toEqual({ kind: 'stopping', code: 'OUTPUT_INVALID' });
    expect(controller.snapshot().submissionCorrections).toBe('2');
    expect(send({ kind: 'physicalEnded', providerEnded: true, effectsEnded: false }).decision.kind).toBe('waiting');
    expect(send({ kind: 'physicalEnded', providerEnded: true, effectsEnded: true }).decision).toEqual({ kind: 'finished', outcome: 'failure', code: 'OUTPUT_INVALID' });
  });
  it('independently bounds checks, keeps rejected candidates out, and waits for physical end', () => {
    const { controller, send } = harness('{"maxCorrections":1,"completionCheck":{"command":"test","maxFailures":1}}');
    expect(send({ kind: 'submit', callId: 'bad', argumentsJson: '{"unknown":1}' }).decision.kind).toBe('correction');
    const candidate = () => send({ kind: 'submit', callId: `call-${controller.snapshot().checkFailures}`, argumentsJson: '{}' }).decision;
    const first = candidate();
    expect(first.kind).toBe('checkRequested');
    if (first.kind !== 'checkRequested') throw new Error('check required');
    const check = { kind: 'checkEnded', checkId: first.check.checkId, physicalState: 'ended', exitCode: 1, stdout: 'ééé', stderr: 'error' } as const;
    const correction = send(check);
    expect(correction.decision).toMatchObject({ kind: 'correction', category: 'check', stdout: 'éé', stderr: 'e', truncated: true });
    expect(send(check)).toEqual(correction);
    expect(controller.snapshot()).toMatchObject({ submissionCorrections: '1', checkFailures: '1', accepted: null });
    const next = candidate();
    if (next.kind !== 'checkRequested') throw new Error('second check required');
    expect(send({ ...check, checkId: next.check.checkId }).decision).toEqual({ kind: 'stopping', code: 'CHECK_FAILED' });
  });
  it('accepts only the checked candidate and closes effect admission before terminal', () => {
    const { controller, send } = harness('{"completionCheck":{"command":"test"}}');
    const check = send({ kind: 'submit', callId: 'call', argumentsJson: '{}' }).decision;
    if (check.kind !== 'checkRequested') throw new Error('check required');
    expect(send({ kind: 'checkEnded', checkId: check.check.checkId, physicalState: 'ended', exitCode: 0, stdout: '', stderr: '' }).decision.kind).toBe('accepted');
    expect(controller.allowsEffect('read')).toBe(false);
    expect(send({ kind: 'physicalEnded', providerEnded: false, effectsEnded: true }).decision.kind).toBe('waiting');
    expect(send({ kind: 'physicalEnded', providerEnded: true, effectsEnded: true }).decision).toMatchObject({ kind: 'finished', outcome: 'success' });
  });
  it('keeps check presence mandatory even for an excluded choice; handles zero budgets', () => {
    const { send } = harness('{"maxCorrections":0,"completionCheck":{"command":"test","choices":["done"]}}', { agentJson: json('{}'), choices: ['done', 'blocked'] });
    expect(send({ kind: 'submit', callId: 'blocked', argumentsJson: '{"choice":"blocked"}' }).decision.kind).toBe('accepted');
    expect(harness('{"maxCorrections":0,"results":{"x":{"required":true}}}').send({ kind: 'turnEnded', turnId: 't' }).decision).toEqual({ kind: 'stopping', code: 'OUTPUT_INVALID' });
    expect(harness('{"results":{"x":{}}}').send({ kind: 'turnEnded', turnId: 't' }).decision.kind).toBe('accepted');
    expect(harness('{"completionCheck":{"command":"test"}}').send({ kind: 'turnEnded', turnId: 't' }).decision.kind).toBe('correction');
  });
  it('never accepts late success after stop or uncertain physical check state', () => {
    const { send } = harness('{"completionCheck":{"command":"test"}}');
    const check = send({ kind: 'submit', callId: 'c', argumentsJson: '{}' }).decision;
    if (check.kind !== 'checkRequested') throw new Error('check required');
    expect(send({ kind: 'checkEnded', checkId: check.check.checkId, physicalState: 'uncertain', exitCode: 0, stdout: '', stderr: '' }).decision.kind).toBe('uncertain');
    expect(send({ kind: 'physicalEnded', providerEnded: true, effectsEnded: true }).decision.kind).toBe('waiting');
    send({ kind: 'stop', reason: 'TIMEOUT' });
    expect(send({ kind: 'submit', callId: 'late', argumentsJson: '{}' }).decision).toEqual({ kind: 'stopping', code: 'TIMEOUT' });
    expect(send({ kind: 'physicalEnded', providerEnded: true, effectsEnded: true }).decision).toMatchObject({ outcome: 'failure', code: 'TIMEOUT' });
  });
  it('enforces plan-first and distinguishes comment revision from terminal refusal', () => {
    const { controller, send } = harness('{"planFirst":"ask"}');
    expect(controller.allowsEffect('read')).toBe(true);
    expect(controller.allowsEffect('unknown')).toBe(false);
    expect(send({ kind: 'planPresented', planId: 'p1', text: 'Plan' }).decision.kind).toBe('planWaiting');
    expect(send({ kind: 'planResolved', planId: 'p1', decision: 'reject', comment: 'Revise' }).decision.kind).toBe('planRevision');
    send({ kind: 'planPresented', planId: 'p2', text: 'New plan' });
    expect(send({ kind: 'planResolved', planId: 'p2', decision: 'accept' }).decision.kind).toBe('planAccepted');
    expect(controller.allowsEffect('change')).toBe(true);
    const rejected = harness('{"planFirst":"ask"}');
    rejected.send({ kind: 'planPresented', planId: 'p', text: 'Plan' });
    expect(rejected.send({ kind: 'planResolved', planId: 'p', decision: 'reject' }).decision).toEqual({ kind: 'stopping', code: 'PLAN_REJECTED' });
    expect(() => new AgentWorkController030(owner, rejected.contract, port, { checkTimeoutMs: '1', maxCheckOutputBytes: 1, enforcedPlanLock: false })).toThrow('enforced native lock');
    const auto = harness('{"planFirst":"auto"}');
    expect(auto.send({ kind: 'planPresented', planId: 'p', text: 'Plan' }).decision.kind).toBe('planAccepted');
    expect(auto.controller.allowsEffect('change')).toBe(true);
  });
  it('isolates mutable returned receipts and contracts', () => {
    const { send } = harness();
    const first = send({ kind: 'submit', callId: 'c', argumentsJson: '{}' }, 'e');
    const signature = encode(first as never);
    (first as { revision: string }).revision = '999';
    expect(encode(send({ kind: 'submit', callId: 'c', argumentsJson: '{}' }, 'e') as never)).toBe(signature);
  });
});
it('retains visible text across corrections and the final provider boundary', () => {
  const { send } = harness('{"results":{"x":{"required":true}}}');
  send({ kind: 'visibleText', messageId: 'm1', textParts: ['First attempt'] });
  send({ kind: 'turnEnded', turnId: 't1' });
  send({ kind: 'visibleText', messageId: 'm2', textParts: ['Corrected'] });
  send({ kind: 'submit', callId: 'ok', argumentsJson: '{"results":{"x":1}}' });
  send({ kind: 'visibleText', messageId: 'm3', textParts: ['Done'] });
  expect(send({ kind: 'physicalEnded', providerEnded: true, effectsEnded: true }).decision).toMatchObject({ kind: 'finished', outcome: 'success', output: { text: 'First attempt\nCorrected\nDone', resultsJson: '{"x":1}' } });
});
it('preserves definition-wide check filters for disjoint steps and graphless work', () => {
  const agent = '{"completionCheck":{"command":"test","choices":["a","b"]}}';
  for (const choice of ['a', 'b']) {
    const { send, contract } = harness(agent, { agentJson: json(agent), choices: [choice] });
    expect(contract.completionCheck?.choices).toEqual(['a', 'b']);
    expect(send({ kind: 'submit', callId: 'c', argumentsJson: `{"choice":"${choice}"}` }).decision.kind).toBe('checkRequested');
  }
  const graphless = harness(agent);
  expect(graphless.send({ kind: 'turnEnded', turnId: 't' }).decision.kind).toBe('correction');
  expect(graphless.send({ kind: 'submit', callId: 'c', argumentsJson: '{}' }).decision.kind).toBe('accepted');
});
it('journals identical and conflicting calls after stop, including dominated successes', () => {
  const { send } = harness();
  const submitted = { kind: 'submit', callId: 'accepted', argumentsJson: '{}' } as const;
  send(submitted, 'accepted'); send({ kind: 'stop', reason: 'TIMEOUT' });
  const replacement = send(submitted, 'accepted');
  expect(send(submitted, 'other')).toEqual(replacement);
  const late = { kind: 'submit', callId: 'late', argumentsJson: '{}' } as const;
  const receipt = send(late, 'late');
  expect(send(late, 'late')).toEqual(receipt);
  expect(() => send({ ...late, argumentsJson: '{"unknown":1}' }, 'late')).toThrow('conflicting');
  expect(send({ kind: 'physicalEnded', providerEnded: true, effectsEnded: true }).decision).toMatchObject({ code: 'TIMEOUT', outcome: 'failure' });
});
it('validates concurrent submissions and gives valid competing calls a definitive receipt', () => {
  for (const exitCode of [0, 1]) {
    const { send } = harness('{"completionCheck":{"command":"test"}}');
    const first = send({ kind: 'submit', callId: 'first', argumentsJson: '{}' }).decision;
    if (first.kind !== 'checkRequested') throw new Error('check required');
    expect(send({ kind: 'submit', callId: 'invalid', argumentsJson: '{"unknown":1}' }).decision).toMatchObject({ kind: 'correction', category: 'submission' });
    const competing = { kind: 'submit', callId: 'competing', argumentsJson: '{}' } as const;
    const refusal = send(competing);
    expect(refusal.decision).toMatchObject({ kind: 'submissionNotAdmitted', checkId: first.check.checkId });
    send({ kind: 'checkEnded', checkId: first.check.checkId, physicalState: 'ended', exitCode, stdout: '', stderr: '' });
    expect(send(competing)).toEqual(refusal);
    expect(send({ ...competing, callId: 'new-call' }).decision.kind).toBe(exitCode === 0 ? 'waiting' : 'checkRequested');
  }
});
it('honors a zero check budget and preserves native failure codes', () => {
  const { send } = harness('{"completionCheck":{"command":"test","maxFailures":0}}');
  const first = send({ kind: 'submit', callId: 'first', argumentsJson: '{}' }).decision;
  if (first.kind !== 'checkRequested') throw new Error('check required');
  expect(send({ kind: 'checkEnded', checkId: first.check.checkId, physicalState: 'ended', exitCode: 1, stdout: '', stderr: '' }).decision).toEqual({ kind: 'stopping', code: 'CHECK_FAILED' });
  const native = harness(); native.send({ kind: 'stop', reason: 'AGENT_FAILED' });
  expect(native.send({ kind: 'physicalEnded', providerEnded: true, effectsEnded: true }).decision).toMatchObject({ code: 'AGENT_FAILED' });
});

it('cannot complete or submit while a plan lock is still awaiting acceptance', () => {
  const { send } = harness('{"planFirst":"ask"}');
  expect(send({ kind: 'turnEnded', turnId: 'before-plan' }).decision.kind).toBe('planRequired');
  expect(send({ kind: 'submit', callId: 'early', argumentsJson: '{}' }).decision.kind).toBe('planRequired');
});

it('uses ECMAScript comment emptiness for plan revision or terminal rejection', () => {
  for (const [comment, empty] of [
    ['\u0085', false], ['\uFEFF', true],
    ['\u00A0\u1680\u2003\u202F\u205F\u3000', true],
    ['\t\n\r\u000B\u000C\u2028\u2029', true],
    ['\uFEFF\u0085\uFEFF', false], ['\u200B', false], ['\u180E', false],
    ['\u2003Réviser.\uFEFF', false],
  ] as const) {
    const { send } = harness('{"planFirst":"ask"}');
    send({ kind: 'planPresented', planId: 'plan', text: 'A captured plan' });
    const result = send({ kind: 'planResolved', planId: 'plan', decision: 'reject', comment }).decision;
    expect(result).toEqual(empty ? { kind: 'stopping', code: 'PLAN_REJECTED' } : { kind: 'planRevision', planId: 'plan', comment });
  }
});

it('validates plan text using ECMAScript emptiness for BOM and NEL', () => {
  const bom = harness('{"planFirst":"ask"}');
  expect(() => bom.send({ kind: 'planPresented', planId: 'bom', text: '\uFEFF' })).toThrow('A presented plan must contain text');
  const nel = harness('{"planFirst":"ask"}');
  expect(nel.send({ kind: 'planPresented', planId: 'nel', text: '\u0085' }).decision).toEqual({ kind: 'planWaiting', planId: 'nel', text: '\u0085' });
});
