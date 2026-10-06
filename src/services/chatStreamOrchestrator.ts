import { StreamStopUnconfirmedError, preserveStreamStopError } from "./ai/streamCancellation";
import type {
  StreamCompletionResult,
  StreamingChatOptions,
} from "./ai/contracts";

type FrameHandle = number | ReturnType<typeof setTimeout>;

const requestFrame = (callback: () => void): FrameHandle => {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    return window.requestAnimationFrame(callback);
  }

  return setTimeout(callback, 16);
};

const cancelFrame = (handle: FrameHandle): void => {
  if (
    typeof window !== "undefined" &&
    typeof window.cancelAnimationFrame === "function" &&
    typeof handle === "number"
  ) {
    window.cancelAnimationFrame(handle);
    return;
  }

  clearTimeout(handle);
};

export interface ChatStreamTokenControls {
  flushNow: () => void;
  dispose: () => void;
}

interface ChatStreamTokenBatcher extends ChatStreamTokenControls {
  push: (token: string) => void;
}

export const createChatStreamTokenBatcher = (
  appendChunk: (chunk: string) => void,
): ChatStreamTokenBatcher => {
  let buffer = "";
  let frameHandle: FrameHandle | null = null;
  let disposed = false;

  const flush = () => {
    frameHandle = null;
    if (disposed || !buffer) {
      return;
    }
    const chunk = buffer;
    buffer = "";
    appendChunk(chunk);
  };

  return {
    push: (token: string) => {
      if (disposed) {
        return;
      }
      buffer += token;
      if (frameHandle !== null) {
        return;
      }
      frameHandle = requestFrame(flush);
    },
    flushNow: () => {
      if (disposed) {
        return;
      }
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      if (!buffer) {
        return;
      }
      const chunk = buffer;
      buffer = "";
      appendChunk(chunk);
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      buffer = "";
    },
  };
};

export type ChatStreamTransport = (
  options: StreamingChatOptions,
) => Promise<void>;

export interface ChatStreamLifecycleCallbacks {
  appendTokenChunk: (chunk: string) => void;
  /**
   * Owns Macro-side completion effects: message update, persistence,
   * conversation runtime transitions, diagnostics, and metadata sync.
   */
  onComplete: (
    result: StreamCompletionResult,
    controls: ChatStreamTokenControls,
  ) => void | Promise<void>;
  onError: (
    error: Error,
    controls: ChatStreamTokenControls,
  ) => void | Promise<void>;
  /**
   * Flushes and persists visible progress when the owning conversation stops.
   * This runs synchronously from AbortController.abort(), before the store
   * releases the runtime ownership fence.
   */
  onAbort?: (controls: ChatStreamTokenControls) => void | Promise<void>;
}

export interface RunAssistantStreamParams
  extends Omit<StreamingChatOptions, "onToken" | "onComplete" | "onError"> {
  lifecycle: ChatStreamLifecycleCallbacks;
  streamChatImpl: ChatStreamTransport;
}

export const runAssistantStream = async ({
  lifecycle,
  streamChatImpl,
  ...streamOptions
}: RunAssistantStreamParams): Promise<void> => {
  const tokenBatcher = createChatStreamTokenBatcher(lifecycle.appendTokenChunk);
  const controls: ChatStreamTokenControls = {
    flushNow: tokenBatcher.flushNow,
    dispose: tokenBatcher.dispose,
  };
  let handledError = false;
  let handledComplete = false;
  let handledAbort = false;
  let abortPromise: Promise<void> | null = null;
  let completionPromise: Promise<void> | null = null;
  let errorPromise: Promise<void> | null = null;
  let unconfirmedStop: StreamStopUnconfirmedError | undefined;
  const lifecycleFailures: unknown[] = [];
  const stopOwners = new Set<StreamStopUnconfirmedError>();
  const rememberStop = (error: unknown) => {
    if (error instanceof StreamStopUnconfirmedError && !stopOwners.has(error)) {
      stopOwners.add(error);
      unconfirmedStop = unconfirmedStop
        ? preserveStreamStopError(unconfirmedStop, error)
        : error;
    }
  };
  // Observe callbacks as soon as they start. Drain them even if another callback
  // fails, and select the owner error only after all finite lifecycle work ends.
  const observe = (pending: Promise<void>): Promise<void> => pending.catch(error => {
    rememberStop(error);
    lifecycleFailures.push(error);
  });
  const handleErrorOnce = async (error: Error, completionFailure = false): Promise<void> => {
    rememberStop(error);
    if (handledError || handledAbort || (handledComplete && !completionFailure)) {
      return;
    }
    handledError = true;
    await lifecycle.onError(error, controls);
  };
  const handleCompleteOnce = async (
    result: StreamCompletionResult,
  ): Promise<void> => {
    if (handledAbort || handledError || handledComplete) {
      return;
    }
    handledComplete = true;
    try {
      await lifecycle.onComplete(result, controls);
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      await handleErrorOnce(normalized, true);
    }
  };

  const handleAbort = () => {
    if (handledAbort || handledComplete || handledError) {
      return;
    }
    handledAbort = true;
    try {
      controls.flushNow();
    } catch (error) {
      rememberStop(error);
      lifecycleFailures.push(error);
    }
    try {
      abortPromise = observe(Promise.resolve(lifecycle.onAbort?.(controls)));
    } catch (error) {
      rememberStop(error);
      lifecycleFailures.push(error);
    }
  };
  streamOptions.signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    await streamChatImpl({
      ...streamOptions,
      onToken: (token) => {
        if (!handledComplete && !handledError && !handledAbort) tokenBatcher.push(token);
      },
      onGenerationAttemptsUpdate: async (attempts) => {
        tokenBatcher.flushNow();
        await streamOptions.onGenerationAttemptsUpdate?.(attempts);
      },
      onComplete: (result) => {
        if (handledComplete || handledError || handledAbort) return;
        completionPromise = observe(handleCompleteOnce(result));
      },
      onError: (error) => {
        rememberStop(error);
        if (handledComplete || handledError || handledAbort) return;
        errorPromise = observe(handleErrorOnce(error));
      },
    });
  } catch (error) {
    rememberStop(error);
    // Completion already owns its persistence/recovery; a late transport error
    // must still retain a receipt, without starting a second lifecycle callback.
    if (!completionPromise) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await observe(handleErrorOnce(normalized));
    }
  } finally {
    await completionPromise;
    await errorPromise;
    await abortPromise;
    for (const cleanup of [
      () => streamOptions.signal?.removeEventListener("abort", handleAbort),
      () => tokenBatcher.dispose(),
    ]) {
      try { cleanup(); }
      catch (error) { rememberStop(error); lifecycleFailures.push(error); }
    }
  }
  if (unconfirmedStop) {
    for (const error of lifecycleFailures) {
      // Typed failures were already combined by rememberStop.
      if (!(error instanceof StreamStopUnconfirmedError)) {
        unconfirmedStop = preserveStreamStopError(unconfirmedStop, error);
      }
    }
    throw unconfirmedStop;
  }
  if (lifecycleFailures.length) throw lifecycleFailures[0];
};
