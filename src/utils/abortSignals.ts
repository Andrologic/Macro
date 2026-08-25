export interface CombinedAbortSignalHandle {
  signal: AbortSignal;
  dispose: () => void;
}

export const createCombinedAbortSignal = (
  signals: Array<AbortSignal | undefined>
): CombinedAbortSignalHandle => {
  const controller = new AbortController();
  const activeSignals = signals.filter(Boolean) as AbortSignal[];
  let disposed = false;

  const cleanups: Array<() => void> = [];

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    cleanups.splice(0).forEach((cleanup) => cleanup());
  };

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
    dispose();
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal.reason);
      break;
    }

    const handleAbort = () => abort(signal.reason);
    signal.addEventListener('abort', handleAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', handleAbort));
  }

  return {
    signal: controller.signal,
    dispose,
  };
};
