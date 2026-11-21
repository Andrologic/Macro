/** Created only after a runtime error response has actually been received. */
export class RuntimeCommandError extends Error {
  constructor(readonly payload: unknown) {
    super(typeof payload === 'string' ? payload : 'Runtime command failed', { cause: payload });
    this.name = 'RuntimeCommandError';
  }
}
