/** A Stop request lacks proof that its owned local executor has ended. */
export class StreamStopUnconfirmedError extends Error {
  readonly code = 'STREAM_STOP_UNCONFIRMED';
  /** Resolves only after a local executor receipt, never on a Stop request. */
  readonly whenStopped: Promise<void>;
  /** Failures in projections/cleanup must not replace the executor receipt. */
  readonly secondaryErrors: Error[] = [];
  private confirmed = false;
  get stopped(): boolean { return this.confirmed; }

  constructor(message: string, whenStopped?: Promise<void>) {
    super(message);
    this.name = 'StreamStopUnconfirmedError';
    this.whenStopped = (whenStopped ?? new Promise<void>(() => {})).then(() => { this.confirmed = true; });
    void this.whenStopped.catch(() => undefined);
  }
}

/** Keep every local owner when an error observer or cleanup also fails. */
export const preserveStreamStopError = (
  owner: StreamStopUnconfirmedError,
  secondary: unknown,
): StreamStopUnconfirmedError => {
  if (secondary === owner) return owner;
  const error = secondary instanceof Error ? secondary : new Error(String(secondary));
  if (error instanceof StreamStopUnconfirmedError) {
    const combined = new StreamStopUnconfirmedError(
      `${owner.message}; ${error.message}`,
      Promise.all([owner.whenStopped, error.whenStopped]).then(() => undefined),
    );
    combined.secondaryErrors.push(owner, error);
    return combined;
  }
  if (!owner.secondaryErrors.includes(error)) owner.secondaryErrors.push(error);
  return owner;
};

/** An observer may diagnose a failed stream, but cannot discharge its owner. */
export const reportStreamError = async (
  error: unknown,
  report: (error: Error) => void | Promise<void>,
): Promise<void> => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  try {
    await report(normalized);
  } catch (secondary) {
    throw combineStreamErrors(normalized, secondary);
  }
  if (normalized instanceof StreamStopUnconfirmedError) throw normalized;
};

/** Select a failure without losing an owner supplied by either operation. */
export const combineStreamErrors = (primary: unknown, secondary: unknown): unknown => {
  if (primary instanceof StreamStopUnconfirmedError) return preserveStreamStopError(primary, secondary);
  if (secondary instanceof StreamStopUnconfirmedError) return preserveStreamStopError(secondary, primary);
  return secondary;
};

/** Cleanup must run, but cannot replace the receipt from the work it closes. */
export const withStreamCleanup = async <T>(run: () => Promise<T>, cleanup: () => void | Promise<void>): Promise<T> => {
  let value!: T;
  let failed = false;
  let failure: unknown;
  try { value = await run(); }
  catch (error) { failed = true; failure = error; }
  try { await cleanup(); }
  catch (error) { failure = failed ? combineStreamErrors(failure, error) : error; failed = true; }
  if (failed) throw failure;
  return value;
};

/** JS reader closure is not proof when the underlying cancellation rejects. */
export const cancelStreamReader = async (reader: ReadableStreamDefaultReader<Uint8Array>, readFailure?: unknown): Promise<void> => {
  try { await reader.cancel(); }
  catch (error) {
    if (error instanceof StreamStopUnconfirmedError) throw error;
    // An errored JS stream rethrows its read error without invoking cancel.
    // Macro wraps lost IPC receipts before exposing them as a read failure.
    if (readFailure !== undefined && error === readFailure) return;
    throw preserveStreamStopError(new StreamStopUnconfirmedError('HTTP reader cleanup was not confirmed.'), error);
  }
};
