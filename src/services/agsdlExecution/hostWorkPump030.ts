/** The native mailbox owns ticket identity and cancellation. This pump only
 * evaluates issued work-protocol jobs; it neither commits nor routes them. */
export interface HostWorkPumpPort030<Job, Output> {
  next(): Promise<Job>;
  evaluate(job: Job): Promise<Output>;
  complete(job: Job, output: Output): Promise<void>;
  /** Revoke the resident host, which also wakes any pending next(). */
  fail(error: unknown): Promise<void>;
}

/** Run independently of the scheduler and compiler so one waiting work cannot
 * prevent unrelated pure transitions from being evaluated. Native SQL still
 * serializes and commits each work's transitions. Host retirement ends next(). */
export async function runHostWorkPump030<Job, Output>(port: HostWorkPumpPort030<Job, Output>): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  let failed = false;
  const revoke = async (error: unknown): Promise<void> => {
    if (failed) return;
    failed = true;
    await port.fail(error);
  };
  try {
    while (!failed) {
      const job = await port.next();
      if (failed) break;
      const operation = Promise.resolve().then(() => port.evaluate(job))
        .then(output => port.complete(job, output))
        .catch(revoke);
      inFlight.add(operation);
      void operation.then(() => inFlight.delete(operation), () => inFlight.delete(operation));
    }
  } catch (error) {
    await revoke(error);
  } finally {
    await Promise.allSettled(inFlight);
  }
}
