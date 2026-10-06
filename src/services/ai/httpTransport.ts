import { StreamStopUnconfirmedError, combineStreamErrors, preserveStreamStopError, withStreamCleanup } from "./streamCancellation";
import {
  ProviderRuntimeError,
} from './providerErrors';
import { tauriFetch } from '../tauriHttp';

export const GENERIC_RETRY_MAX_ATTEMPTS = 2;
export const GENERIC_RETRY_MAX_DELAY_MS = 5_000;
export const GENERIC_RETRY_BASE_DELAY_MS = 250;
export const GENERIC_STREAM_IDLE_TIMEOUT_MS = 45_000;
export const GENERIC_REQUEST_TIMEOUT_MS = 120_000;
export const getRetryDelayMs = (attempt: number, retryAfterMs?: number): number => {
  const exponential = GENERIC_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const delay = retryAfterMs ?? exponential;
  return Math.min(GENERIC_RETRY_MAX_DELAY_MS, Math.max(0, delay));
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abortHandler = () => {
      globalThis.clearTimeout(timeoutId);
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', abortHandler);
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
};

export const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal
): Promise<Response> => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  return withStreamCleanup(async () => {
    try {
      if (outerSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      abortHandler = () => controller.abort(outerSignal?.reason);
      outerSignal?.addEventListener('abort', abortHandler, { once: true });
      timeoutId = globalThis.setTimeout(() => {
        controller.abort(new Error('Provider request timed out'));
      }, timeoutMs);

      return await tauriFetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof StreamStopUnconfirmedError) throw error;
      if (outerSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (controller.signal.aborted) {
        throw new ProviderRuntimeError('Provider request timed out', {
          kind: 'network',
          retryable: true,
          cause: error,
        });
      }
      throw new ProviderRuntimeError(error instanceof Error ? error.message : String(error), {
        kind: 'network',
        retryable: true,
        cause: error,
      });
    }
  }, () => {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
    if (abortHandler) {
      outerSignal?.removeEventListener('abort', abortHandler);
    }
  });
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

export const readStreamChunkWithIdleTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> => {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let cancellation: Promise<never> | undefined;
  return withStreamCleanup(async () => {
    let interrupt!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
    const cancel = (reason: Error) => {
      if (cancellation) return;
      cancellation = (async () => { await cancelStreamReader(reader); throw reason; })();
      void cancellation.catch(interrupt);
    };
    timeoutId = globalThis.setTimeout(() => cancel(new ProviderRuntimeError('Provider stream stalled before sending more data', {
      kind: 'stream_idle_timeout', retryable: true,
    })), timeoutMs);
    abortHandler = () => cancel(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
    try {
      const result = await Promise.race([reader.read(), interrupted]);
      // cancel() may resolve the JS read before its physical cleanup finishes.
      if (cancellation) await cancellation;
      return result;
    } catch (error) {
      if (cancellation) {
        try { await cancellation; }
        catch (secondary) { throw combineStreamErrors(error, secondary); }
      }
      throw error;
    }
  }, () => {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  });
};
