import { describe, expect, it } from 'bun:test';
import { EMPTY_HUMAN_CLOCK_JOURNAL030, evaluateHostHumanClock030, type HumanClockEventBody030, type HumanClockReceipt030 } from './hostHumanClock030';

const owner = { systemStartId: 'run', ownerEpoch: 'epoch' };
const options = { maxSliceMs: 1000 };
function makeHarness() {
  let state = EMPTY_HUMAN_CLOCK_JOURNAL030, revision = 0, nextId = 0;
  const send = (nowMs: string, event: HumanClockEventBody030, id = `e${++nextId}`) => {
    const raw = JSON.stringify({ owner, eventId: id, nowMs, event });
    const result = evaluateHostHumanClock030(owner, id, String(revision), state, raw, options);
    if (result.stateJson !== state) revision++;
    state = result.stateJson;
    return { ...result, value: JSON.parse(result.receiptJson) as HumanClockReceipt030, raw, id };
  };
  const replay = (raw: string, id: string) => evaluateHostHumanClock030(owner, id, String(revision), state, raw, options);
  return { send, replay, state: () => state, revision: () => revision };
}
const admit = (workId: string, timeoutMs: string | null = null, answerTimeoutMs: string | null = null): HumanClockEventBody030 => ({ kind: 'admit', workId, timeoutMs, answerTimeoutMs });
const open = (requestId: string, workIds: string[], requestKind: 'ask' | 'plan' | 'question' = 'ask', reviewer: 'person' | 'model' = 'person'): HumanClockEventBody030 => ({ kind: 'open', requestId, requestKind, reviewer, workIds });
const answer = (requestId: string, nativeReceiptId: string, decision: 'yes' | 'no' | null): HumanClockEventBody030 => ({ kind: 'answer', requestId, nativeReceiptId, answer: decision === null ? null : { decision } });

describe('native human clock journal', () => {
  it('replays exact receipts, deduplicates events, and rejects conflicting ids, owners and revisions', () => {
    const h = makeHarness();
    const first = h.send('0', admit('w', '1e999999999999999999999'), 'first');
    h.send('3', { kind: 'tick' });
    expect(h.replay(first.raw, first.id)).toEqual({ stateJson: h.state(), receiptJson: first.receiptJson });
    const altered = JSON.stringify({ owner, eventId: 'first', nowMs: '0', event: admit('other') });
    expect(() => h.replay(altered, 'first')).toThrow('conflicting');
    expect(() => evaluateHostHumanClock030({ ...owner, ownerEpoch: 'other' }, 'first', String(h.revision()), h.state(), first.raw, options)).toThrow('journal capture');
    expect(() => evaluateHostHumanClock030(owner, 'first', '0', h.state(), first.raw, options)).toThrow('revision');
    const tampered = JSON.parse(h.state()); tampered.entries[0].receiptJson = '{}';
    expect(() => evaluateHostHumanClock030(owner, 'first', String(h.revision()), JSON.stringify(tampered), first.raw, options)).toThrow('cannot be reproduced');
    expect(first.value.nextWakeMs).toBe(1000);
  });
  it('uses union of waits, keeps minimum human deadline and applies late expiration at its true time', () => {
    const h = makeHarness();
    h.send('0', admit('a', '60000', '100'));
    h.send('0', admit('b', null, '50'));
    h.send('30000', open('shared', ['a', 'b'], 'plan'));
    h.send('30020', open('other', ['a']));
    const result = h.send('30100', { kind: 'tick' }).value;
    expect(result.pendingResolutions).toHaveLength(1);
    expect(result.pendingResolutions[0]).toMatchObject({ requestId: 'shared', expired: true, resolvedAtMs: '30050', answer: { kind: 'decision', decision: 'no' } });
    expect(result.pendingResolutions[0].workActions).toEqual([{ workId: 'a', action: 'PLAN_REJECTED' }, { workId: 'b', action: 'PLAN_REJECTED' }]);
    expect(result.clocks.find(clock => clock.workId === 'a')?.snapshot).toMatchObject({ elapsedMachineMs: '30000', openHumanRequests: ['other'] });
    expect(result.clocks.find(clock => clock.workId === 'b')?.snapshot.elapsedMachineMs).toBe('30050');
  });
  it('preserves question receipt references without reducing free-form answers to yes/no', () => {
    const h = makeHarness(); h.send('0', admit('w')); h.send('10', open('q', ['w'], 'question'));
    const result = h.send('20', answer('q', 'native-json-receipt-42', null)).value;
    expect(result.pendingResolutions[0].answer).toEqual({ kind: 'native', nativeReceiptId: 'native-json-receipt-42' });
    expect(result.nativeAnswers).toEqual([{ requestId: 'q', nativeReceiptId: 'native-json-receipt-42', accepted: true }]);
    expect(JSON.stringify(result.pendingResolutions)).not.toContain('"decision"');
    expect(() => h.send('20', answer('q', 'bad', 'yes'))).toThrow('projection');
  });
  it('makes the human deadline win over an answer at the deadline or after it', () => {
    for (const at of ['10', '20']) {
      const h = makeHarness(); h.send('0', admit('w', null, '10')); h.send('0', open('q', ['w'], 'question'));
      const result = h.send(at, answer('q', 'late-receipt', null)).value;
      expect(result.pendingResolutions[0]).toMatchObject({ expired: true, resolvedAtMs: '10', answer: { kind: 'expired' } });
      expect(result.nativeAnswers[0]).toEqual({ requestId: 'q', nativeReceiptId: 'late-receipt', accepted: false });
    }
  });
  it('reassociates, retires work and updates the shortest remaining human deadline', () => {
    const h = makeHarness(); h.send('0', admit('a', '10', '5')); h.send('0', admit('b', '1000', '100'));
    h.send('0', open('shared', ['a', 'b']));
    const retired = h.send('2', { kind: 'retire', workId: 'a' }).value;
    expect(retired.clocks.map(clock => clock.workId)).toEqual(['b']);
    expect(retired.nextWakeMs).toBe(98);
    h.send('3', { kind: 'associate', requestId: 'shared', workIds: [] });
    const tick = h.send('20', { kind: 'tick' }).value;
    expect(tick.clocks[0].snapshot.elapsedMachineMs).toBe('17');
    expect(tick.pendingResolutions).toEqual([]);
    const attached = h.send('20', { kind: 'associate', requestId: 'shared', workIds: ['b'] }).value;
    expect(attached.nextWakeMs).toBe(80);
  });
  it('retains pending decisions until ack, including a lost ack retry', () => {
    const h = makeHarness(); h.send('0', admit('w', null, '10')); h.send('0', open('ask', ['w']));
    const at = h.send('10', { kind: 'tick' });
    expect(at.value.pendingResolutions).toHaveLength(1);
    expect(h.send('11', { kind: 'tick' }).value.pendingResolutions).toHaveLength(1);
    const ack = h.send('12', { kind: 'ack', requestId: 'ask' }, 'ack-id');
    expect(ack.value.pendingResolutions).toEqual([]);
    expect(h.replay(ack.raw, ack.id)).toEqual({ stateJson: h.state(), receiptJson: ack.receiptJson });
    expect(h.send('13', { kind: 'ack', requestId: 'ask' }).value.pendingResolutions).toEqual([]);
  });
  it('counts model reviews as machine time and refuses time reversal and duplicate JSON keys', () => {
    const h = makeHarness(); h.send('0', admit('w', '10', '5')); h.send('0', open('model', ['w'], 'ask', 'model'));
    expect(h.send('10', { kind: 'tick' }).value.expiredWorkIds).toEqual(['w']);
    expect(() => h.send('9', { kind: 'tick' })).toThrow('backwards');
    const bad = '{"owner":{"systemStartId":"run","ownerEpoch":"epoch"},"eventId":"bad","nowMs":"11","event":{"kind":"tick","kind":"tick"}}';
    expect(() => h.replay(bad, 'bad')).toThrow();
  });
});

it('deduplicates admissions, requests, native receipts and retirements across distinct event ids', () => {
  const h = makeHarness();
  const admitted = h.send('0', admit('w'));
  expect(h.send('0', admit('w')).receiptJson).toBe(admitted.receiptJson);
  expect(() => h.send('0', admit('w', '10'))).toThrow('conflicting');
  const opened = h.send('1', open('q', ['w'], 'question'));
  expect(h.send('1', open('q', ['w'], 'question')).receiptJson).toBe(opened.receiptJson);
  const answered = h.send('2', answer('q', 'native', null));
  expect(h.send('2', answer('q', 'native', null)).receiptJson).toBe(answered.receiptJson);
  expect(() => h.send('2', answer('other', 'native', null))).toThrow('conflicting');
  const retired = h.send('3', { kind: 'retire', workId: 'w' });
  expect(h.send('3', { kind: 'retire', workId: 'w' }).receiptJson).toBe(retired.receiptJson);
});
it('keeps integer milliseconds exact well beyond the JS safe integer range', () => {
  const h = makeHarness();
  const start = '9007199254740993123456';
  h.send(start, admit('w', '100', '1e999999999999999999'));
  const running = h.send('9007199254740993123506', { kind: 'tick' }).value;
  expect(running.clocks[0].snapshot.elapsedMachineMs).toBe('50');
  expect(running.nextWakeMs).toBe(50);
  h.send('9007199254740993123506', open('q', ['w'], 'question'));
  const paused = h.send('9007199254740993999999', { kind: 'tick' }).value;
  expect(paused.clocks[0].snapshot.elapsedMachineMs).toBe('50');
  expect(paused.nextWakeMs).toBe(1000);
});
it('preserves the first accepted native answer and records later receipts without reopening', () => {
  const h = makeHarness(); h.send('0', admit('w')); h.send('0', open('q', ['w'], 'question'));
  h.send('1', answer('q', 'first-receipt', null));
  const late = h.send('2', answer('q', 'later-receipt', null)).value;
  expect(late.pendingResolutions[0].answer).toEqual({ kind: 'native', nativeReceiptId: 'first-receipt' });
  expect(late.nativeAnswers).toEqual([
    { requestId: 'q', nativeReceiptId: 'first-receipt', accepted: true },
    { requestId: 'q', nativeReceiptId: 'later-receipt', accepted: false },
  ]);
});
it('does not associate a foreign epoch or changed captured timer options', () => {
  const h = makeHarness(); const input = h.send('0', admit('w'));
  const foreign = JSON.stringify({ owner: { ...owner, ownerEpoch: 'other' }, eventId: 'foreign', nowMs: '1', event: { kind: 'tick' } });
  expect(() => h.replay(foreign, 'foreign')).toThrow('revoked owner');
  expect(() => evaluateHostHumanClock030(owner, input.id, String(h.revision()), h.state(), input.raw, { maxSliceMs: 999 })).toThrow('journal capture');
});

it('repeated admission cannot publish a stale expired-work projection', () => {
  const h = makeHarness();
  const admitted = h.send('0', admit('w', '100'), 'admit-original');
  const current = h.send('100', { kind: 'tick' }, 'expiry');
  expect(current.value.clocks[0].snapshot).toMatchObject({ elapsedMachineMs: '100', expired: true });
  expect(current.value.expiredWorkIds).toEqual(['w']);
  const stateBeforeDuplicate = h.state();
  const duplicate = h.send('0', admit('w', '100'), 'admit-new-id');
  // A no-op may replay its old receipt; a new CAS must describe current state.
  if (duplicate.stateJson === stateBeforeDuplicate) expect(duplicate.receiptJson).toBe(admitted.receiptJson);
  else expect(duplicate.value).toEqual(current.value);
});

it('repeated opening cannot publish a stale answered-question projection', () => {
  const h = makeHarness();
  h.send('0', admit('w', '1000'));
  const opened = h.send('10', open('q', ['w'], 'question'), 'open-original');
  h.send('20', answer('q', 'native-json-receipt-42', null), 'answer');
  const current = h.send('30', { kind: 'ack', requestId: 'q' }, 'ack');
  expect(current.value.pendingResolutions).toEqual([]);
  expect(current.value.clocks[0].snapshot).toMatchObject({ elapsedMachineMs: '20', openHumanRequests: [] });
  expect(current.value.nativeAnswers).toEqual([{ requestId: 'q', nativeReceiptId: 'native-json-receipt-42', accepted: true }]);
  const stateBeforeDuplicate = h.state();
  const duplicate = h.send('10', open('q', ['w'], 'question'), 'open-new-id');
  // The free-form native answer reference and clock state are separate facts.
  if (duplicate.stateJson === stateBeforeDuplicate) expect(duplicate.receiptJson).toBe(opened.receiptJson);
  else expect(duplicate.value).toEqual(current.value);
});

it('preserves the original receipt and journal on an exact event id replay after later work', () => {
  const h = makeHarness();
  const initial = h.send('0', admit('w', '100'), 'same-id');
  const current = h.send('100', { kind: 'tick' }, 'expiry');
  const beforeReplay = h.state();
  const replay = h.replay(initial.raw, initial.id);
  expect(replay.stateJson).toBe(beforeReplay);
  expect(replay.receiptJson).toBe(initial.receiptJson);
  expect(current.value.expiredWorkIds).toEqual(['w']);
});

it('replays successive business no-ops and advances the current clock on a later tick', () => {
  const h = makeHarness();
  h.send('0', admit('w', '100'), 'admission');
  const firstTick = h.send('30', { kind: 'tick' }, 'tick-30');
  const duplicateOne = h.send('0', admit('w', '100'), 'duplicate-one');
  const duplicateTwo = h.send('0', admit('w', '100'), 'duplicate-two');
  expect(duplicateOne.value).toEqual(firstTick.value);
  expect(duplicateTwo.value).toEqual(firstTick.value);
  expect(JSON.parse(duplicateTwo.stateJson).entries).toHaveLength(4);
  const expired = h.send('100', { kind: 'tick' }, 'tick-100');
  expect(expired.value.clocks[0].snapshot).toMatchObject({ elapsedMachineMs: '100', expired: true });
  expect(expired.value.expiredWorkIds).toEqual(['w']);
  expect(expired.value.nextWakeMs).toBe(0);
});

it('replays answered-question no-ops and retains the native receipt through a later tick', () => {
  const h = makeHarness();
  h.send('0', admit('w', '1000'), 'admission');
  h.send('10', open('q', ['w'], 'question'), 'open');
  h.send('20', answer('q', 'native-json-receipt-42', null), 'answer');
  const acknowledged = h.send('30', { kind: 'ack', requestId: 'q' }, 'ack');
  const duplicateOne = h.send('10', open('q', ['w'], 'question'), 'open-again-one');
  const duplicateTwo = h.send('10', open('q', ['w'], 'question'), 'open-again-two');
  expect(duplicateOne.value).toEqual(acknowledged.value);
  expect(duplicateTwo.value).toEqual(acknowledged.value);
  const later = h.send('50', { kind: 'tick' }, 'tick-50');
  expect(later.value.clocks[0].snapshot).toMatchObject({ elapsedMachineMs: '40', openHumanRequests: [], expired: false });
  expect(later.value.pendingResolutions).toEqual([]);
  expect(later.value.nativeAnswers).toEqual([{ requestId: 'q', nativeReceiptId: 'native-json-receipt-42', accepted: true }]);
  expect(later.value.nextWakeMs).toBe(960);
});

it('gives approval its own unsuspended deadline and preserves arbitrary choices and comments', () => {
  const h = makeHarness();
  h.send('0', admit('w', '60000'));
  h.send('0', open('ask', ['w']));
  h.send('0', { kind: 'approval', requestId: 'approval', workId: 'host-work', choices: ['publish', 'revise'], timeoutMs: '86400000' });
  const waiting = h.send('3600000', { kind: 'tick' }).value;
  expect(waiting.expiredWorkIds).toEqual([]);
  expect(waiting.clocks[0].snapshot.elapsedMachineMs).toBe('0');
  const answered = h.send('3600000', { kind: 'approvalAnswer', requestId: 'approval', nativeReceiptId: 'human', choice: 'revise', comment: 'Corriger le titre.' }).value;
  expect(answered.pendingResolutions[0].answer).toEqual({ kind: 'approval', choice: 'revise', comment: 'Corriger le titre.' });
  expect(() => h.send('3600000', { kind: 'approvalAnswer', requestId: 'approval', nativeReceiptId: 'bad', choice: 'yes', comment: '' })).toThrow('choice');
});
it('expires approval exactly, rejects late replies and replays without another effect', () => {
  const h = makeHarness();
  h.send('0', { kind: 'approval', requestId: 'approval', workId: 'host-work', choices: ['publish', 'revise'], timeoutMs: '86400000' });
  const result = h.send('86400001', { kind: 'approvalAnswer', requestId: 'approval', nativeReceiptId: 'late', choice: 'publish', comment: '' });
  expect(result.value.pendingResolutions[0]).toMatchObject({ expired: true, resolvedAtMs: '86400000', failure: 'APPROVAL_TIMEOUT' });
  expect(result.value.nativeAnswers[0].accepted).toBe(false);
  expect(h.replay(result.raw, result.id).receiptJson).toBe(result.receiptJson);
});
it('resumes after an hour and expires at the remaining budget, with the union of waits', () => {
  const h = makeHarness();
  h.send('0', admit('w', '60000'));
  h.send('30000', open('a', ['w']));
  h.send('30000', open('b', ['w']));
  h.send('3630000', answer('a', 'first', 'yes'));
  expect(h.send('3630000', { kind: 'tick' }).value.clocks[0].snapshot).toMatchObject({ elapsedMachineMs: '30000', openHumanRequests: ['b'], expired: false });
  h.send('3630000', answer('b', 'second', 'yes'));
  expect(h.send('3659999', { kind: 'tick' }).value.expiredWorkIds).toEqual([]);
  expect(h.send('3660000', { kind: 'tick' }).value.expiredWorkIds).toEqual(['w']);
});

it('retains the final consumed budget when a terminal clock is retired', () => {
  const h = makeHarness(); h.send('0', admit('w', '100'));
  const retired = h.send('40', { kind: 'retire', workId: 'w' }).value;
  expect(retired.clocks).toEqual([]);
  expect(retired.retiredClocks).toEqual([{ workId: 'w', snapshot: { elapsedMachineMs: '40', openHumanRequests: [], expired: false } }]);
});

it('charges a delayed broker admission from the delivered native Start', () => {
  const h = makeHarness();
  const admitted = h.send('5000', { kind: 'admit', workId: 'w', timeoutMs: '60000', answerTimeoutMs: null, startedAtMs: '0' }).value;
  expect(admitted.clocks[0].snapshot.elapsedMachineMs).toBe('5000');
  expect(h.send('59999', { kind: 'tick' }).value.expiredWorkIds).toEqual([]);
  expect(h.send('60000', { kind: 'tick' }).value.expiredWorkIds).toEqual(['w']);
});
it('does not extend a delayed approval deadline beyond its native Start', () => {
  const h = makeHarness();
  const admitted = h.send('5000', { kind: 'approval', requestId: 'late-admission', workId: 'w', choices: ['publish'], timeoutMs: '1000', startedAtMs: '0' }).value;
  expect(admitted.pendingResolutions[0]).toMatchObject({ failure: 'APPROVAL_TIMEOUT', resolvedAtMs: '1000' });
});
