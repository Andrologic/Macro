import { expect, it } from 'bun:test';
import { EMPTY_WORK_JOURNAL030, evaluateWorkJournal030 } from './hostWorkJournal030';

/** A deterministic controller stands in for 04 only in these journal tests. */
function controller() {
  let count = 0;
  return { dispatch(event: { raw: string }) { count++; return { revision: String(count), raw: event.raw }; } };
}

it('reconstructs prior transitions without effects and preserves opaque JSON bytes', () => {
  const firstEvent = JSON.stringify({ raw: '{"n":9007199254740993,"v":1e999}' });
  const first = evaluateWorkJournal030(EMPTY_WORK_JOURNAL030, '0', firstEvent, controller);
  const second = evaluateWorkJournal030(first.stateJson, '1', '{"raw":"second"}', controller);
  expect(JSON.parse(first.receiptJson).raw).toBe('{"n":9007199254740993,"v":1e999}');
  expect(JSON.parse(second.receiptJson)).toEqual({ revision: '2', raw: 'second' });
  const journal = JSON.parse(second.stateJson);
  expect(journal.events[0].eventJson).toBe(firstEvent);
  expect(journal.events[0].receiptJson).toBe(first.receiptJson);
});

it('refuses stale revisions, altered receipts and unknown journal fields', () => {
  const first = evaluateWorkJournal030(EMPTY_WORK_JOURNAL030, '0', '{"raw":"x"}', controller);
  expect(() => evaluateWorkJournal030(first.stateJson, '0', '{"raw":"y"}', controller)).toThrow();
  expect(() => evaluateWorkJournal030(first.stateJson, '01', '{"raw":"y"}', controller)).toThrow();
  const corrupt = JSON.parse(first.stateJson);
  corrupt.events[0].receiptJson = '{"revision":"1","raw":"changed"}';
  expect(() => evaluateWorkJournal030(JSON.stringify(corrupt), '1', '{"raw":"y"}', controller)).toThrow('cannot be reproduced');
  corrupt.unexpected = true;
  expect(() => evaluateWorkJournal030(JSON.stringify(corrupt), '1', '{"raw":"y"}', controller)).toThrow();
});

it('counts committed native entries independently of an idempotent controller receipt', () => {
  const factory = () => {
    let sequence = 0;
    const calls = new Map<string, { revision: string }>();
    return { dispatch(event: { callId: string }) {
      const prior = calls.get(event.callId);
      if (prior) return prior;
      const receipt = { revision: String(++sequence) };
      calls.set(event.callId, receipt);
      return receipt;
    } };
  };
  const first = evaluateWorkJournal030(EMPTY_WORK_JOURNAL030, '0', '{"callId":"a"}', factory);
  const repeated = evaluateWorkJournal030(first.stateJson, '1', '{"callId":"a"}', factory);
  expect(repeated.receiptJson).toBe(first.receiptJson);
  const next = evaluateWorkJournal030(repeated.stateJson, '2', '{"callId":"b"}', factory);
  expect(JSON.parse(next.receiptJson).revision).toBe('2');
  expect(JSON.parse(next.stateJson).events).toHaveLength(3);
});
