/** Check coordinates against one already-authenticated preparation. This does
 * not authenticate the receipt, grant permission, select a route, or claim an
 * effect. The native commit and admission guards remain authoritative. */
export function validateDeliveryOccurrence030(
  receiptId: string,
  targetOrdinal: number,
  itemIndex: string,
  capturedReceiptId: string,
  capturedBatchLengths: readonly number[],
): void {
  if (!receiptId || receiptId !== capturedReceiptId
    || !Number.isSafeInteger(targetOrdinal) || targetOrdinal < 0 || targetOrdinal >= capturedBatchLengths.length
    || !/^(0|[1-9][0-9]*)$/.test(itemIndex)) {
    throw new Error('Invalid prepared delivery occurrence.');
  }
  const length = capturedBatchLengths[targetOrdinal];
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('Invalid captured batch length.');
  }
  const bound = String(length);
  if (itemIndex.length > bound.length || (itemIndex.length === bound.length && itemIndex >= bound)) {
    throw new Error('Prepared delivery occurrence is outside its captured batch.');
  }
}
