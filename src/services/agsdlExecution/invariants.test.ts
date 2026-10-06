import { describe, expect, it } from 'bun:test';
import type {
  AcceptedDelivery, ExactJsonText, ExactValuePort, FrozenAgentConfiguration,
  Identity, RuntimeOwner, Sequence, SourceRevision, TerminalOutcome, WorkIdentity,
} from './contracts';
import {
  assembleVisibleText, assertFrozenConfiguration, assertOldest, assertOwner,
  assertRetransmission, assertSourceRevision, assertTerminalDuplicate, compareSequence,
  holdsAgentLock, permissionWithinSnapshot, sameWork,
} from './invariants';
const id = <K extends string>(value: string) => value as Identity<K>;
const json = (value: string) => value as ExactJsonText;
const sequence = (value: string) => value as Sequence;
// Identity comparison is sufficient for these fixtures. Vendor equality is a separate port.
const exact: ExactValuePort = { equal: (left, right) => left === right };
const work: WorkIdentity = {
  systemStartId: id('system'), flowInvocationId: id('flow'), activationId: id('activation'),
  step: ['step'], agentInstanceId: id('instance'),
};
const owner: RuntimeOwner = { systemStartId: work.systemStartId, ownerEpoch: id('3') };
const delivery = (name = 'delivery', order = '1'): AcceptedDelivery => ({
  deliveryId: id(name), work, input: { origin: 'call', valueJson: json('{"data":9007199254740993}') },
  queueSequence: sequence(order),
});
const configuration: FrozenAgentConfiguration = {
  agentName: 'agent', configurationName: 'fixed', providerId: 'provider', modelId: 'model',
  configurationJson: json('{"engine":"binding"}'), settingsJson: json('{"n":9007199254740993}'),
  permissionsJson: json('["read"]'), scopeJson: json('{}'),
};

describe('AgSDL execution correlation contracts', () => {
  it('fences stale epochs and other system starts', () => {
    expect(() => assertOwner(owner, owner, work)).not.toThrow();
    expect(() => assertOwner(owner, { ...owner, ownerEpoch: id('2') }, work)).toThrow('epoch');
    expect(() => assertOwner(owner, owner, { ...work, systemStartId: id('other') })).toThrow('epoch');
  });
  it('distinguishes activations, flows, instances and unambiguous step addresses', () => {
    for (const changed of [
      { activationId: id<'activation'>('other') }, { flowInvocationId: id<'flowInvocation'>('other') },
      { agentInstanceId: id<'agentInstance'>('other') }, { step: null },
    ]) expect(sameWork(work, { ...work, ...changed })).toBe(false);
    expect(sameWork({ ...work, step: ['a/b', 'c'] }, { ...work, step: ['a', 'b/c'] })).toBe(false);
  });
  it('rejects changed source ownership even with equal bytes', () => {
    const source: SourceRevision = { owner: { projectId: 'p', planId: 'plan', branch: 'feature/example' }, revision: '7', sourceSha256: id('sha') };
    expect(() => assertSourceRevision(source, source)).not.toThrow();
    expect(() => assertSourceRevision(source, { ...source, owner: { ...source.owner, branch: 'develop' } })).toThrow();
    expect(() => assertSourceRevision(source, { ...source, revision: '8' })).toThrow();
    expect(() => assertSourceRevision(source, { ...source, sourceSha256: id('other') })).toThrow();
  });
  it('accepts retransmission without allocating another queue position', () => {
    const receipt = delivery();
    expect(() => assertRetransmission(receipt, { ...receipt }, exact)).not.toThrow();
    expect(receipt.queueSequence).toBe(sequence('1'));
  });
  it('rejects reused delivery ids with changed work, origin or exact number', () => {
    const receipt = delivery();
    for (const changed of [
      { ...receipt, work: { ...work, activationId: id<'activation'>('other') } },
      { ...receipt, input: { ...receipt.input, origin: 'prepare' as const } },
      { ...receipt, input: { ...receipt.input, valueJson: json('{"data":9007199254740992}') } },
    ]) expect(() => assertRetransmission(receipt, changed, exact)).toThrow('Conflicting');
  });
});
describe('retention and admission evidence', () => {
  it('retains every captured configuration field across Agent steps', () => {
    expect(() => assertFrozenConfiguration(configuration, { ...configuration })).not.toThrow();
    for (const field of Object.keys(configuration) as (keyof FrozenAgentConfiguration)[]) {
      expect(() => assertFrozenConfiguration(configuration, { ...configuration, [field]: 'changed' })).toThrow();
    }
  });
  it('intersects current permissions with the snapshot ceiling', () => {
    expect(permissionWithinSnapshot(['read'], ['read', 'write'], ['read'])).toBe(true);
    expect(permissionWithinSnapshot(['read'], ['read', 'write'], ['write'])).toBe(false);
    expect(permissionWithinSnapshot(['read'], [], ['read'])).toBe(false);
  });
  it('compares queue integers without float rounding or lexicographic mistakes', () => {
    expect(compareSequence(sequence('9'), sequence('10'))).toBe(-1);
    expect(compareSequence(sequence('9007199254740993'), sequence('9007199254740992'))).toBe(1);
    expect(compareSequence(sequence('0'), sequence('0'))).toBe(0);
    for (const invalid of ['01', '-1', '1.0', '1e2', '']) {
      expect(() => compareSequence(sequence(invalid), sequence('1'))).toThrow();
    }
  });
  it('requires the unique oldest queued occurrence across steps sharing an Agent', () => {
    const oldest = delivery('a', '9');
    const later = { ...delivery('b', '10'), work: { ...work, activationId: id<'activation'>('next'), step: ['other'] as const } };
    expect(() => assertOldest(oldest, [later, oldest])).not.toThrow();
    expect(() => assertOldest(later, [oldest, later])).toThrow();
    expect(() => assertOldest(oldest, [later])).toThrow();
    expect(() => assertOldest(oldest, [oldest, oldest])).toThrow();
    expect(() => assertOldest(oldest, [oldest, delivery('b', '9')])).toThrow();
    expect(() => assertOldest(oldest, [oldest, { ...later, work: { ...work, agentInstanceId: id('other') } }])).toThrow();
  });
  it('retains the lock for uncertain work irrespective of a stop request', () => {
    expect(holdsAgentLock('active')).toBe(true);
    expect(holdsAgentLock('uncertain')).toBe(true);
    expect(holdsAgentLock('terminal')).toBe(false);
    expect(holdsAgentLock('queued')).toBe(false);
  });
});
describe('terminal boundary', () => {
  it('accepts the same terminal result and rejects contradictions without dispatch', () => {
    const result: TerminalOutcome = { kind: 'completed', output: { origin: 'agent', valueJson: json('{"text":"done"}') } };
    expect(() => assertTerminalDuplicate(result, { ...result }, exact)).not.toThrow();
    expect(() => assertTerminalDuplicate(result, { kind: 'failed', code: 'AGENT_FAILED', errorJson: json('{}') }, exact)).toThrow('continuation remains resolved');
    expect(() => assertTerminalDuplicate(result, { kind: 'completed', output: { ...result.output, valueJson: json('{"text":"different"}') } }, exact)).toThrow();
  });
  it('keeps failure codes and confirmed-stop evidence in duplicate comparison', () => {
    const failure: TerminalOutcome = { kind: 'failed', code: 'AGENT_FAILED', errorJson: json('{}') };
    const stopped: TerminalOutcome = { kind: 'stopped', evidenceJson: json('{"ended":true}') };
    expect(() => assertTerminalDuplicate(failure, failure, exact)).not.toThrow();
    expect(() => assertTerminalDuplicate(failure, { ...failure, code: 'INTERRUPTED' }, exact)).toThrow();
    expect(() => assertTerminalDuplicate(stopped, stopped, exact)).not.toThrow();
    expect(() => assertTerminalDuplicate(stopped, { ...stopped, evidenceJson: json('{}') }, exact)).toThrow();
  });
  it('uses exact LF assembly and preserves whitespace and authored newlines', () => {
    expect(assembleVisibleText([['A', 'B'], [], ['\nC'], ['D\n']])).toBe('AB\n\nC\nD\n');
    expect(assembleVisibleText([[''], [' '], ['\r\n']])).toBe(' \n\r\n');
    expect(assembleVisibleText([])).toBe('');
  });
});
