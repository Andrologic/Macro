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

export const createChatStreamTokenBatcher = (
  appendChunk: (chunk: string) => void,
): ChatStreamTokenControls & { push: (token: string) => void } => {
  let buffer = "";
  let frameHandle: FrameHandle | null = null;

  const flush = () => {
    frameHandle = null;
    if (!buffer) {
      return;
    }
    const chunk = buffer;
    buffer = "";
    appendChunk(chunk);
  };

  return {
    push: (token: string) => {
      buffer += token;
      if (frameHandle !== null) {
        return;
      }
      frameHandle = requestFrame(flush);
    },
    flushNow: () => {
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

export interface RunAssistantStreamParams
  extends Omit<StreamingChatOptions, "onToken" | "onComplete" | "onError"> {
  appendTokenChunk: (chunk: string) => void;
  onComplete: (
    result: StreamCompletionResult,
    controls: ChatStreamTokenControls,
  ) => void;
  onError: (
    error: Error,
    controls: ChatStreamTokenControls,
  ) => void | Promise<void>;
  streamChatImpl?: ChatStreamTransport;
}

export const runAssistantStream = async ({
  appendTokenChunk,
  onComplete,
  onError,
  streamChatImpl = streamChat,
  ...streamOptions
}: RunAssistantStreamParams): Promise<void> => {
  const tokenBatcher = createChatStreamTokenBatcher(appendTokenChunk);
  const controls: ChatStreamTokenControls = {
    flushNow: tokenBatcher.flushNow,
    dispose: tokenBatcher.dispose,
  };

  try {
    await streamChatImpl({
      ...streamOptions,
      onToken: (token) => {
        tokenBatcher.push(token);
      },
      onComplete: (result) => {
        onComplete(result, controls);
      },
      onError: (error) => {
        void onError(error, controls);
      },
    });
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    await onError(normalized, controls);
  }
};
