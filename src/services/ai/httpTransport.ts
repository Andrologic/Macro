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
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
    if (abortHandler) {
      outerSignal?.removeEventListener('abort', abortHandler);
    }
  }
};

export const readStreamChunkWithIdleTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> => {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const idleTimeout = new Promise<never>((_, reject) => {
      timeoutId = globalThis.setTimeout(() => {
        const error = new ProviderRuntimeError('Provider stream stalled before sending more data', {
          kind: 'stream_idle_timeout',
          retryable: true,
        });
        reject(error);
        void reader.cancel().catch(() => {
          // Ignore cancellation errors while closing an idle stream.
        });
      }, timeoutMs);
    });
    const abort = new Promise<never>((_, reject) => {
      abortHandler = () => {
        void reader.cancel().catch(() => {
          // Ignore cancellation errors while aborting a stream.
        });
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abortHandler, { once: true });
    });
    return await Promise.race([reader.read(), idleTimeout, abort]);
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
    if (abortHandler) {
      signal?.removeEventListener('abort', abortHandler);
    }
  }
};
