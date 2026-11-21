/** A native send that ended with a relay decision the user must be told about. */
export type TransferOutcome = 'aborted' | 'pending';
export class TransferOutcomeError extends Error {
  constructor(readonly outcome: TransferOutcome) { super(outcome); }
}
// `aborted`: the relay recorded the cancellation and the source is open again.
// `pending`: the relay committed; the source stays frozen until the target activates.
const outcomes: Record<string, TransferOutcome> = { transfer_aborted: 'aborted', target_activation_pending: 'pending' };
export function transferOutcome(error: unknown): TransferOutcome | null {
  const message = error !== null && typeof error === 'object' ? (error as { message?: unknown }).message : error;
  return typeof message === 'string' ? outcomes[message] ?? null : null;
}
