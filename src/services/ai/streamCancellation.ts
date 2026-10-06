/** A Stop request lacks proof that its owned local executor has ended. */
export class StreamStopUnconfirmedError extends Error {
  readonly code = 'STREAM_STOP_UNCONFIRMED';
  /** Resolves only after a local executor receipt, never on a Stop request. */
  readonly whenStopped: Promise<void>;
  private confirmed = false;
  get stopped(): boolean { return this.confirmed; }

  constructor(message: string, whenStopped?: Promise<void>) {
    super(message);
    this.name = 'StreamStopUnconfirmedError';
    this.whenStopped = (whenStopped ?? new Promise<void>(() => {})).then(() => { this.confirmed = true; });
    void this.whenStopped.catch(() => undefined);
  }
}
