/** The native mailbox owns ticket identity and cancellation. This pump only
 * evaluates issued work-protocol jobs; it neither commits nor routes them. */
export interface HostWorkPumpPort030<Job, Output> {
  next(): Promise<Job>;
  evaluate(job: Job): Promise<Output>;
  complete(job: Job, output: Output): Promise<void>;
  /** Revoke the resident host. Failure is surfaced to the caller; it is not
   * evidence that native ownership or physical effects have ended. */
  fail(error: unknown): Promise<void>;
}

/** Run independently of the scheduler and compiler so one waiting work cannot
 * prevent unrelated pure transitions from being evaluated. Native SQL still
 * serializes and commits each work's transitions. Host retirement ends next(). */
export async function runHostWorkPump030<Job, Output>(port: HostWorkPumpPort030<Job, Output>): Promise<void> {
  let failed = false;
  let wakeNext: (() => void) | null = null;
  let revocation: Promise<void> | null = null;
  const revoke = (error: unknown): void => {
    if (failed) return;
    failed = true;
    // Wake the loop even if native revocation rejects or next() never settles.
    wakeNext?.();
    revocation = Promise.resolve().then(() => port.fail(error));
  };
  while (!failed) {
    const outcome = await new Promise<{ kind: 'job'; job: Job } | { kind: 'error'; error: unknown } | { kind: 'failed' }>(resolve => {
      let settled = false;
      const finish = (value: { kind: 'job'; job: Job } | { kind: 'error'; error: unknown } | { kind: 'failed' }) => {
        if (settled) return;
        settled = true;
        wakeNext = null;
        resolve(value);
      };
      wakeNext = () => finish({ kind: 'failed' });
      void Promise.resolve().then(() => port.next()).then(
        job => finish({ kind: 'job', job }),
        error => finish({ kind: 'error', error }),
      );
    });
    if (failed || outcome.kind === 'failed') break;
    if (outcome.kind === 'error') {
      revoke(outcome.error);
      break;
    }
    // Evaluation is pure. Once revoked, detach it and refuse a late completion.
    // An already-started completion still requires native epoch/SQL fencing.
    void Promise.resolve().then(() => port.evaluate(outcome.job))
      .then(output => { if (!failed) return port.complete(outcome.job, output); })
      .catch(revoke);
  }
  // Do not join detached pure work: one promise may never settle. In particular,
  // this does not claim that any physical effect has stopped or been joined.
  if (revocation !== null) await revocation;
}
