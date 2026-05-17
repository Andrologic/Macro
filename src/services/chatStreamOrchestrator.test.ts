import { describe, expect, mock, test } from "bun:test";
import {
  createChatStreamTokenBatcher,
  runAssistantStream,
} from "./chatStreamOrchestrator";
import type { StreamingChatOptions } from "./streamingChat";

const minimalStreamOptions = {
  providerId: "provider",
  providerType: "openai",
  baseUrl: "https://example.test",
  modelId: "model",
  messages: [],
};

describe("createChatStreamTokenBatcher", () => {
  test("flushes buffered tokens as a single chunk", () => {
    const append = mock(() => undefined);
    const batcher = createChatStreamTokenBatcher(append);

    batcher.push("hel");
    batcher.push("lo");
    batcher.flushNow();

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith("hello");
  });

  test("dispose clears buffered tokens", () => {
    const append = mock(() => undefined);
    const batcher = createChatStreamTokenBatcher(append);

    batcher.push("unused");
    batcher.dispose();
    batcher.flushNow();

    expect(append).not.toHaveBeenCalled();
  });
});

describe("runAssistantStream", () => {
  test("wires token batching and completion callbacks", async () => {
    const appended: string[] = [];
    const completed: string[] = [];
    const streamChatImpl = mock(
      async (options: StreamingChatOptions) => {
        options.onToken("a");
        options.onToken("b");
        options.onComplete({
          visibleContent: "ab",
          hiddenContext: undefined,
          providerInputItems: undefined,
          providerTurnState: undefined,
          toolTraces: [],
        });
      },
    );

    await runAssistantStream({
      ...minimalStreamOptions,
      lifecycle: {
        appendTokenChunk: (chunk) => {
          appended.push(chunk);
        },
        onComplete: (result, controls) => {
          controls.flushNow();
          completed.push(result.visibleContent);
        },
        onError: () => undefined,
      },
      streamChatImpl,
    });

    expect(streamChatImpl).toHaveBeenCalledTimes(1);
    expect(appended).toEqual(["ab"]);
    expect(completed).toEqual(["ab"]);
  });

  test("normalizes thrown stream errors", async () => {
    const errors: Error[] = [];

    await runAssistantStream({
      ...minimalStreamOptions,
      lifecycle: {
        appendTokenChunk: () => undefined,
        onComplete: () => undefined,
        onError: (error) => {
          errors.push(error);
        },
      },
      streamChatImpl: mock(async () => {
        throw "provider exploded";
      }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toBe("provider exploded");
  });

  test("ignores tokens after dispose", () => {
    const append = mock(() => undefined);
    const batcher = createChatStreamTokenBatcher(append);

    batcher.dispose();
    batcher.push("ignored");
    batcher.flushNow();

    expect(append).not.toHaveBeenCalled();
  });

  test("handles provider onError plus rejection once", async () => {
    const errors: string[] = [];

    await runAssistantStream({
      ...minimalStreamOptions,
      lifecycle: {
        appendTokenChunk: () => undefined,
        onComplete: () => undefined,
        onError: (error) => {
          errors.push(error.message);
        },
      },
      streamChatImpl: mock(async (options: StreamingChatOptions) => {
        options.onError(new Error("callback error"));
        throw new Error("rejected error");
      }),
    });

    expect(errors).toEqual(["callback error"]);
  });

  test("lets completion flush before store-side persistence", async () => {
    const events: string[] = [];

    await runAssistantStream({
      ...minimalStreamOptions,
      lifecycle: {
        appendTokenChunk: (chunk) => {
          events.push(`append:${chunk}`);
        },
        onComplete: (_result, controls) => {
          controls.flushNow();
          events.push("persist");
        },
        onError: () => undefined,
      },
      streamChatImpl: mock(async (options: StreamingChatOptions) => {
        options.onToken("done");
        options.onComplete({
          visibleContent: "done",
          toolTraces: [],
        });
      }),
    });

    expect(events).toEqual(["append:done", "persist"]);
  });

  test("waits for async completion callbacks", async () => {
    const events: string[] = [];

    await runAssistantStream({
      ...minimalStreamOptions,
      lifecycle: {
        appendTokenChunk: () => undefined,
        onComplete: async () => {
          await Promise.resolve();
          events.push("completed");
        },
        onError: () => {
          events.push("error");
        },
      },
      streamChatImpl: mock(async (options: StreamingChatOptions) => {
        options.onComplete({
          visibleContent: "done",
          toolTraces: [],
        });
      }),
    });

    expect(events).toEqual(["completed"]);
  });

  test("routes completion callback errors through onError once", async () => {
    const errors: string[] = [];

    await runAssistantStream({
      ...minimalStreamOptions,
      lifecycle: {
        appendTokenChunk: () => undefined,
        onComplete: async () => {
          throw new Error("completion failed");
        },
        onError: (error) => {
          errors.push(error.message);
        },
      },
      streamChatImpl: mock(async (options: StreamingChatOptions) => {
        options.onComplete({
          visibleContent: "done",
          toolTraces: [],
        });
      }),
    });

    expect(errors).toEqual(["completion failed"]);
  });

  test("ignores completion callbacks after an error was already handled", async () => {
    const events: string[] = [];

    await runAssistantStream({
      ...minimalStreamOptions,
      lifecycle: {
        appendTokenChunk: () => undefined,
        onComplete: () => {
          events.push("complete");
        },
        onError: (error) => {
          events.push(`error:${error.message}`);
        },
      },
      streamChatImpl: mock(async (options: StreamingChatOptions) => {
        options.onError(new Error("provider failed"));
        options.onComplete({
          visibleContent: "late",
          toolTraces: [],
        });
      }),
    });

    expect(events).toEqual(["error:provider failed"]);
  });
});
