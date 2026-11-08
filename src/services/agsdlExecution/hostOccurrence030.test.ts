import { expect, it } from 'bun:test';
import { validateDeliveryOccurrence030 } from './hostOccurrence030';

it('accepts positions in the authenticated preparation, including equal-valued elements', () => {
  // The two positions are distinct even if their payloads are identical.
  expect(() => validateDeliveryOccurrence030('receipt', 1, '0', 'receipt', [1, 2, 0])).not.toThrow();
  expect(() => validateDeliveryOccurrence030('receipt', 1, '1', 'receipt', [1, 2, 0])).not.toThrow();
  expect(() => validateDeliveryOccurrence030('receipt', 0, '0', 'receipt', [1, 2, 0])).not.toThrow();
});

it('rejects foreign receipts, invalid indices, empty batches and overflow', () => {
  for (const [receipt, target, item] of [
    ['other', 0, '0'], ['receipt', 0, '01'], ['receipt', 0, '-1'],
    ['receipt', 1, '0'], ['receipt', 0, '1'], ['receipt', 2, '0'],
    ['receipt', 0, '900719925474099312345'],
  ] as const) {
    expect(() => validateDeliveryOccurrence030(receipt, target, item, 'receipt', [1, 0])).toThrow();
  }
  expect(() => validateDeliveryOccurrence030('receipt', Number.MAX_SAFE_INTEGER + 1, '0', 'receipt', [1])).toThrow();
  expect(() => validateDeliveryOccurrence030('', 0, '0', '', [1])).toThrow();
  expect(() => validateDeliveryOccurrence030('receipt', 0, '0', 'receipt', [Number.MAX_SAFE_INTEGER + 1])).toThrow();
});
