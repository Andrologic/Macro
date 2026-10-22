import { describe, expect, mock, test } from "bun:test";
import {
  createChatStreamTokenBatcher,
  runAssistantStream,
} from "./chatStreamOrchestrator";
import { StreamStopUnconfirmedError } from "./ai/streamCancellation";
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

  test("flushes buffered tokens before invoking the abort lifecycle", async () => {
    const events: string[] = [];
    const controller = new AbortController();

    const running = runAssistantStream({
      ...minimalStreamOptions,
      signal: controller.signal,
      lifecycle: {
        appendTokenChunk: (chunk) => {
          events.push(`append:${chunk}`);
        },
        onComplete: () => undefined,
        onError: () => undefined,
        onAbort: () => {
          events.push("persist-partial");
        },
      },
      streamChatImpl: mock(async (options: StreamingChatOptions) => {
        options.onToken("partial");
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }),
    });

    controller.abort();
    await running;

    expect(events).toEqual(["append:partial", "persist-partial"]);
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

test("duplicate terminal callbacks cannot replace the pending persistence promise", async () => {
  let save!: () => void;
  const persistence = new Promise<void>(resolve => { save = resolve; });
  let returned = false;
  const complete = mock(async () => { await persistence; });
  const error = mock(() => {});
  const running = runAssistantStream({
    ...minimalStreamOptions,
    lifecycle: { appendTokenChunk: () => {}, onComplete: complete, onError: error },
    streamChatImpl: async options => {
      options.onComplete({ visibleContent: "answer", toolTraces: [] });
      options.onComplete({ visibleContent: "duplicate", toolTraces: [] });
      options.onError(new Error("late transport error"));
    },
  }).then(() => { returned = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(returned).toBe(false);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  save();
  await running;
  expect(returned).toBe(true);
});

for (const phase of ["error", "completion", "abort"] as const) {
  test(`retains the same receipt after ${phase} recovery/persistence rejects and joins the callback`, async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const saving = new Promise<void>(resolve => { finish = resolve; });
    let confirm!: () => void;
    const receipt = new StreamStopUnconfirmedError("Local owner pending", new Promise<void>(resolve => { confirm = resolve; }));
    const secondary = new Error(`${phase} projection failed`);
    let returned = false;
    let observed: unknown;
    const callback = async () => { await saving; throw secondary; };
    const running = runAssistantStream({
      ...minimalStreamOptions, signal: controller.signal,
      lifecycle: {
        appendTokenChunk: () => {},
        onComplete: phase === "completion" ? callback : () => {},
        onError: phase === "completion" ? async () => { throw secondary; } : callback,
        onAbort: callback,
      },
      streamChatImpl: async options => {
        if (phase === "completion") options.onComplete({ visibleContent: "answer", toolTraces: [] });
        else if (phase === "abort") controller.abort();
        else options.onError(receipt);
        throw receipt;
      },
    }).catch(error => { returned = true; observed = error; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false);
    finish();
    await running;
    expect(observed).toBe(receipt);
    expect(receipt.secondaryErrors).toContain(secondary);
    expect(receipt.stopped).toBe(false);
    confirm();
    await receipt.whenStopped;
    expect(receipt.stopped).toBe(true);
  });
}

test("a synchronous abort flush failure cannot escape the receipt or skip pending abort persistence", async () => {
  const controller = new AbortController();
  const projection = new Error("Token projection failed");
  const receipt = new StreamStopUnconfirmedError("Terminal still owned");
  const persist = mock(async () => { throw new Error("Partial persistence failed"); });
  const running = runAssistantStream({
    ...minimalStreamOptions, signal: controller.signal,
    lifecycle: { appendTokenChunk: () => { throw projection; }, onComplete: () => {}, onError: () => {}, onAbort: persist },
    streamChatImpl: async options => { options.onToken("partial"); controller.abort(); throw receipt; },
  });
  await expect(running).rejects.toBe(receipt);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(receipt.secondaryErrors.map(error => error.message)).toEqual(["Token projection failed", "Partial persistence failed"]);
});

test("combines distinct lifecycle and transport owners instead of releasing either receipt", async () => {
  let confirmTransport!: () => void;
  let confirmPersistence!: () => void;
  const transport = new StreamStopUnconfirmedError("Transport pending", new Promise<void>(resolve => { confirmTransport = resolve; }));
  const persistence = new StreamStopUnconfirmedError("Persistence owner pending", new Promise<void>(resolve => { confirmPersistence = resolve; }));
  const running = runAssistantStream({
    ...minimalStreamOptions,
    lifecycle: { appendTokenChunk: () => {}, onComplete: async () => { throw persistence; }, onError: async () => { throw new Error("Recovery failed"); } },
    streamChatImpl: async options => { options.onComplete({ visibleContent: "answer", toolTraces: [] }); throw transport; },
  });
  const outcome = await running.catch(error => error as StreamStopUnconfirmedError);
  expect(outcome).toBeInstanceOf(StreamStopUnconfirmedError);
  if (!(outcome instanceof StreamStopUnconfirmedError)) throw new Error("Missing owner receipt");
  expect(outcome.secondaryErrors.map(error => error.message)).toContain("Recovery failed");
  confirmTransport();
  await transport.whenStopped;
  expect(outcome.stopped).toBe(false);
  confirmPersistence();
  await outcome.whenStopped;
  expect(outcome.stopped).toBe(true);
});

test("a finite error observer failure is an ordinary error without a fabricated owner", async () => {
  const secondary = new Error("Recovery failed after local completion");
  await expect(runAssistantStream({
    ...minimalStreamOptions,
    lifecycle: { appendTokenChunk: () => {}, onComplete: () => {}, onError: async () => { throw secondary; } },
    streamChatImpl: async options => { options.onError(new Error("Provider rejected")); },
  })).rejects.toBe(secondary);
});
