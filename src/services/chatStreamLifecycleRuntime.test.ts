import { describe, expect, mock, test } from "bun:test";
import type { AppMode, ChatMessage } from "../types";
import type { ChatStreamTokenControls } from "./chatStreamOrchestrator";
import {
  applyAssistantStreamCompletion,
  createChatStreamLifecycleRuntime,
  type ChatStreamLifecycleRuntimeAdapters,
} from "./chatStreamLifecycleRuntime";

const makeMessage = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "assistant-1",
  conversation_id: "conversation-1",
  task_id: "task-1",
  role: "assistant",
  content: "",
  timestamp: "2026-05-16T10:00:00.000Z",
  tool_traces: [],
  ...patch,
});

const makeControls = () => ({
  flushNow: mock(() => undefined),
  dispose: mock(() => undefined),
}) satisfies ChatStreamTokenControls;

const makeRuntime = (params?: {
  message?: ChatMessage;
  modeAtSend?: AppMode;
  resolvedTaskId?: string | null;
  overrides?: Partial<ChatStreamLifecycleRuntimeAdapters>;
}) => {
  let message = params?.message ?? makeMessage();
  const events: string[] = [];
  const adapters: ChatStreamLifecycleRuntimeAdapters = {
    shouldAcceptStreamUpdate: () => true,
    isAbortSignalAborted: () => false,
    appendTokenChunk: (_messageId, chunk) => {
      events.push(`append:${chunk}`);
      message = { ...message, content: `${message.content}${chunk}` };
    },
    getAssistantMessage: (messageId) =>
      message.id === messageId ? message : undefined,
    updateMessageFields: (_messageId, fields) => {
      message = { ...message, ...fields };
      events.push("fields");
    },
    updateMessageContent: (_messageId, content) => {
      message = { ...message, content };
      events.push(`content:${content}`);
    },
    markProviderReachable: () => {
      events.push("provider");
    },
    getTaskStatus: () => "InProgress",
    markTaskAwaitingResponse: mock(() => {
      events.push("awaiting");
    }),
    assistantTurnRequiresUserReply: () => true,
    updateConversationAfterCompletion: (_conversationId, visibleContent) => {
      events.push(`conversation:${visibleContent}`);
    },
    clearLiveStreamContextEstimate: () => {
      events.push("clear-live");
    },
    refreshConversationContextDiagnostics: () => {
      events.push("refresh");
    },
    persistAssistantStreamResult: mock(async () => {
      events.push("persist-final");
    }),
    persistAssistantPartialStreamResult: mock(async () => {
      events.push("persist-partial");
    }),
    consolidatePendingToolBoundaryCompactionAfterPersistence: mock(async () => {
      events.push("consolidate");
    }),
    syncMacroMetadataAfterStream: () => {
      events.push("metadata");
    },
    setCompletionPersistenceError: ({ message: errorMessage }) => {
      events.push(`persistence-error:${errorMessage}`);
    },
    clearCompletionPersistenceOwnership: () => {
      events.push("clear-persistence-ownership");
    },
    maybeMarkImplementTaskFailedAfterStreamError: async () => {
      events.push("task-failed");
    },
    tryRecoverFromOverflow: mock(async () => false),
    removeEmptyAssistantPlaceholder: () => {
      events.push("remove-placeholder");
      message = { ...message, content: "" };
    },
    deleteEmptyAssistantMessageFromDb: async () => {
      events.push("delete-db");
    },
    setStreamErrorState: ({ presentation, assistantMessageId }) => {
      events.push(
        `stream-error:${presentation.displayTarget}:${assistantMessageId ?? "none"}`,
      );
    },
    warn: (warning) => {
      events.push(`warn:${warning}`);
    },
    info: (info) => {
      events.push(`info:${info}`);
    },
    ...params?.overrides,
  };
  const runtime = createChatStreamLifecycleRuntime({
    stream: {
      conversationId: "conversation-1",
      sessionId: "session-1",
      turnId: "turn-1",
      assistantMessageId: "assistant-1",
      modeAtSend: params?.modeAtSend ?? "Implement",
      resolvedTaskId: params?.resolvedTaskId ?? "task-1",
      providerContext: {
        providerId: "provider-1",
        providerType: "openai",
        modelId: "model-1",
        baseUrl: "https://example.test",
      },
    },
    adapters,
  });

  return {
    runtime,
    adapters,
    events,
    getMessage: () => message,
  };
};

describe("applyAssistantStreamCompletion", () => {
  test("merges final content, metadata, and existing denied tool traces", () => {
    const message = makeMessage({
      tool_traces: [
        {
          tool_call_id: "call-1",
          tool_name: "git_commit",
          status: "denied",
          detail: "challenge",
        },
      ],
    });
    const fields: Partial<ChatMessage>[] = [];
    let content = "";

    applyAssistantStreamCompletion({
      assistantMessageId: "assistant-1",
      result: {
        visibleContent: "Done",
        hiddenContext: "hidden",
        providerInputItems: [{ id: "input" }],
        completionReason: "completed",
        toolTraces: [
          {
            tool_call_id: "call-1",
            tool_name: "git_commit",
            status: "done",
            detail: "done",
          },
        ],
      },
      adapters: {
        getAssistantMessage: () => message,
        updateMessageFields: (_messageId, nextFields) => {
          fields.push(nextFields);
        },
        updateMessageContent: (_messageId, nextContent) => {
          content = nextContent;
        },
      },
    });

    expect(content).toBe("Done");
    expect(fields[0]?.hidden_context).toBe("hidden");
    expect(fields[0]?.provider_input_items).toEqual([{ id: "input" }]);
    expect(fields[0]?.completion_reason).toBe("completed");
    expect(fields[0]?.tool_traces?.[0]?.status).toBe("denied");
  });
});

describe("createChatStreamLifecycleRuntime", () => {
  test("completion updates local state and schedules persistence, diagnostics, and metadata", async () => {
    const controls = makeControls();
    const { runtime, events } = makeRuntime();

    await runtime.onComplete(
      {
        visibleContent: "Final",
        toolTraces: [],
      },
      controls,
    );
    await Promise.resolve();

    expect(controls.flushNow).toHaveBeenCalledTimes(1);
    expect(controls.dispose).toHaveBeenCalledTimes(1);
    expect(events).toContain("content:Final");
    expect(events).toContain("provider");
    expect(events).toContain("awaiting");
    expect(events).toContain("conversation:Final");
    expect(events).toContain("clear-live");
    expect(events).toContain("refresh");
    expect(events).toContain("persist-final");
    expect(events).toContain("consolidate");
    expect(events).toContain("metadata");
  });

  test("completion does not mark completed tasks as awaiting response", async () => {
    const controls = makeControls();
    const { runtime, events } = makeRuntime({
      overrides: {
        getTaskStatus: () => "Completed",
      },
    });

    await runtime.onComplete(
      {
        visibleContent: "Final",
        toolTraces: [],
      },
      controls,
    );
    await Promise.resolve();

    expect(events).not.toContain("awaiting");
    expect(events).toContain("content:Final");
  });

  test("keeps completion ownership until tool-boundary consolidation finishes", async () => {
    const controls = makeControls();
    const releaseConsolidationRef: { current: (() => void) | null } = {
      current: null,
    };
    const { runtime, events } = makeRuntime({
      overrides: {
        consolidatePendingToolBoundaryCompactionAfterPersistence: mock(async () => {
          events.push("consolidate-start");
          await new Promise<void>((resolve) => {
            releaseConsolidationRef.current = resolve;
          });
          events.push("consolidate-end");
        }),
      },
    });

    await runtime.onComplete(
      {
        visibleContent: "Final",
        toolTraces: [],
      },
      controls,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContain("consolidate-start");
    expect(events).not.toContain("clear-persistence-ownership");

    releaseConsolidationRef.current?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(events.indexOf("consolidate-end")).toBeLessThan(
      events.indexOf("clear-persistence-ownership"),
    );
  });

  test("an exhausted length recovery persists the partial response and ends in error", async () => {
    const controls = makeControls();
    const { runtime, events, getMessage } = makeRuntime();

    await runtime.onComplete(
      {
        visibleContent: "Réponse encore coupée",
        toolTraces: [],
        completionReason: "length",
      },
      controls,
    );

    expect(getMessage().completion_reason).toBe("length");
    expect(events).toContain("persist-final");
    expect(events).toContain("stream-error:transcript:assistant-1");
    expect(events).toContain("conversation:Réponse encore coupée");
    expect(events).not.toContain("awaiting");
    expect(controls.dispose).toHaveBeenCalledTimes(1);
  });

  test("an incomplete response keeps a persistence failure instead of replacing it with a provider error", async () => {
    const controls = makeControls();
    const persistenceErrors: string[] = [];
    const { runtime, events } = makeRuntime({
      overrides: {
        persistAssistantStreamResult: mock(async () => {
          throw new Error("SQLite unavailable");
        }),
        setCompletionPersistenceError: ({ message }) => {
          persistenceErrors.push(message);
        },
      },
    });

    await runtime.onComplete(
      {
        visibleContent: "Réponse coupée non persistée",
        toolTraces: [],
        completionReason: "length",
      },
      controls,
    );

    expect(events).toContain("conversation:Réponse coupée non persistée");
    expect(persistenceErrors).toEqual(["SQLite unavailable"]);
    expect(events).not.toContain("stream-error:transcript:assistant-1");
    expect(controls.dispose).toHaveBeenCalledTimes(1);
  });

  test("provider error before any token removes the empty placeholder", async () => {
    const controls = makeControls();
    const { runtime, events } = makeRuntime();

    await runtime.onError(new Error("macro failed"), controls);

    expect(controls.flushNow).toHaveBeenCalledTimes(1);
    expect(controls.dispose).toHaveBeenCalledTimes(1);
    expect(events).toContain("task-failed");
    expect(events).toContain("remove-placeholder");
    expect(events).toContain("delete-db");
    expect(events).toContain("stream-error:composer:none");
  });

  test("provider error after progress keeps partial content and renders transcript error", async () => {
    const controls = makeControls();
    const { runtime, events, getMessage } = makeRuntime({
      message: makeMessage({ content: "partial" }),
    });

    const providerError = Object.assign(new Error("provider exploded"), {
      providerError: true,
      kind: "network",
      retryable: true,
    });
    await runtime.onError(providerError, controls);

    expect(events).toContain("task-failed");
    expect(events).toContain("persist-partial");
    expect(events).toContain("stream-error:transcript:assistant-1");
    expect(events).not.toContain("remove-placeholder");
    expect(getMessage().content).toContain("partial");
    expect(getMessage().content).toContain("Erreur du provider");
  });

  test("macro error after progress preserves the partial assistant message", async () => {
    const controls = makeControls();
    const { runtime, events } = makeRuntime({
      message: makeMessage({ content: "partial" }),
    });

    await runtime.onError(new Error("macro failed"), controls);

    expect(events).toContain("persist-partial");
    expect(events).toContain("stream-error:composer:assistant-1");
    expect(events).not.toContain("remove-placeholder");
  });

  test("abort flushes and persists already received assistant progress", async () => {
    const controls = makeControls();
    const { runtime, events } = makeRuntime({
      message: makeMessage({ content: "partial" }),
    });

    await runtime.onAbort?.(controls);

    expect(controls.flushNow).toHaveBeenCalledTimes(1);
    expect(controls.dispose).toHaveBeenCalledTimes(1);
    expect(events).toContain("persist-partial");
    expect(events).not.toContain("remove-placeholder");
  });

  test("abort removes an assistant placeholder that never received a token", async () => {
    const controls = makeControls();
    const { runtime, events } = makeRuntime();

    await runtime.onAbort(controls);

    expect(controls.flushNow).toHaveBeenCalledTimes(1);
    expect(controls.dispose).toHaveBeenCalledTimes(1);
    expect(events).toContain("remove-placeholder");
    expect(events).toContain("delete-db");
    expect(events).not.toContain("persist-partial");
  });

  test("completion persistence failure marks a Macro runtime error", async () => {
    const controls = makeControls();
    const { runtime, events } = makeRuntime({
      overrides: {
        persistAssistantStreamResult: mock(async () => {
          throw new Error("db unavailable");
        }),
      },
    });

    await runtime.onComplete(
      {
        visibleContent: "Final",
        toolTraces: [],
      },
      controls,
    );
    await Promise.resolve();

    expect(events).toContain("persistence-error:db unavailable");
  });

  test("tool-boundary consolidation failure is non-blocking after completion", async () => {
    const controls = makeControls();
    const { runtime, events } = makeRuntime({
      overrides: {
        consolidatePendingToolBoundaryCompactionAfterPersistence: mock(
          async () => {
            throw new Error("consolidation failed");
          },
        ),
      },
    });

    await runtime.onComplete(
      {
        visibleContent: "Final",
        toolTraces: [],
      },
      controls,
    );
    await Promise.resolve();

    expect(events).toContain("persist-final");
    expect(
      events.some((event) =>
        event.includes("Tool-boundary compaction consolidation failed"),
      ),
    ).toBe(true);
  });
});
