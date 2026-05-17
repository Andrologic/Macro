import {
  streamChat,
  type StreamCompletionResult,
  type StreamingChatOptions,
} from "./streamingChat";

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
}

export interface RunAssistantStreamParams
  extends Omit<StreamingChatOptions, "onToken" | "onComplete" | "onError"> {
  lifecycle: ChatStreamLifecycleCallbacks;
  streamChatImpl?: ChatStreamTransport;
}

export const runAssistantStream = async ({
  lifecycle,
  streamChatImpl = streamChat,
  ...streamOptions
}: RunAssistantStreamParams): Promise<void> => {
  const tokenBatcher = createChatStreamTokenBatcher(lifecycle.appendTokenChunk);
  const controls: ChatStreamTokenControls = {
    flushNow: tokenBatcher.flushNow,
    dispose: tokenBatcher.dispose,
  };
  let handledError = false;
  let handledComplete = false;
  let completionPromise: Promise<void> | null = null;
  const handleErrorOnce = async (error: Error): Promise<void> => {
    if (handledError) {
      return;
    }
    handledError = true;
    await lifecycle.onError(error, controls);
  };
  const handleCompleteOnce = async (
    result: StreamCompletionResult,
  ): Promise<void> => {
    if (handledError || handledComplete) {
      return;
    }
    handledComplete = true;
    try {
      await lifecycle.onComplete(result, controls);
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      await handleErrorOnce(normalized);
    }
  };

  try {
    await streamChatImpl({
      ...streamOptions,
      onToken: (token) => {
        tokenBatcher.push(token);
      },
      onComplete: (result) => {
        completionPromise = handleCompleteOnce(result);
      },
      onError: (error) => {
        void handleErrorOnce(error);
      },
    });
    if (completionPromise) {
      await completionPromise;
    }
  } catch (error) {
    if (completionPromise) {
      await completionPromise;
      return;
    }
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    await handleErrorOnce(normalized);
  }
};
