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
      appendTokenChunk: (chunk) => {
        appended.push(chunk);
      },
      onComplete: (result, controls) => {
        controls.flushNow();
        completed.push(result.visibleContent);
      },
      onError: () => undefined,
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
      appendTokenChunk: () => undefined,
      onComplete: () => undefined,
      onError: (error) => {
        errors.push(error);
      },
      streamChatImpl: mock(async () => {
        throw "provider exploded";
      }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toBe("provider exploded");
  });
});
