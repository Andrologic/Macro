import { describe, expect, mock, test } from "bun:test";
import type { ConversationRuntimeState } from "../types";
import { EMPTY_CONVERSATION_RUNTIME } from "../domains/chat/runtimeState";
import { createChatTurnRuntime, type ChatTurnIdentity } from "./chatTurnRuntime";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const states = new Map<string, ConversationRuntimeState>();
  const deleted = new Set<string>();
  const cancelTransport = mock((_sessionId: string) => undefined);
  const settled = mock((_conversationId: string) => undefined);
  const runtime = createChatTurnRuntime({
    state: {
      read: (id) => states.get(id) ?? EMPTY_CONVERSATION_RUNTIME,
      project: (id, state) => {
        if (state) states.set(id, state);
        else states.delete(id);
      },
      isDeleted: (id) => deleted.has(id),
    },
    cancelTransport,
    settled,
  });
  function begin(conversationId: string, sessionId = `${conversationId}-session`) {
    const identity: ChatTurnIdentity = {
      conversationId, sessionId,
      turnId: `${sessionId}-turn`, assistantMessageId: `${sessionId}-assistant`,
    };
    const controller = new AbortController();
    runtime.rememberSession(conversationId, sessionId);
    runtime.set(conversationId, {
      ...identity, phase: "streaming", abortController: controller, lastError: null,
    });
    return { identity, controller };
  }
  return { runtime, begin, deleted, cancelTransport, settled };
}

describe("chatTurnRuntime ownership", () => {
  test("stopping one conversation preserves the other session and its steers", () => {
    const h = setup();
    const a = h.begin("a");
    const b = h.begin("b");
    h.runtime.enqueueSteer("a", { role: "user", content: "A steer" });
    const steerB = { role: "user" as const, content: "B steer" };
    h.runtime.enqueueSteer("b", steerB);

    h.runtime.stop("a");

    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(false);
    expect(h.cancelTransport.mock.calls).toEqual([[a.identity.sessionId]]);
    expect(h.runtime.read("a").phase).toBe("idle");
    expect(h.runtime.matches(b.identity, "streaming")).toBe(true);
    expect(h.runtime.consumeSteers(a.identity)).toEqual([]);
    expect(h.runtime.consumeSteers(b.identity)).toEqual([steerB]);
    expect(h.runtime.consumeSteers(b.identity)).toEqual([]);
  });

  test("stale completion cannot release or fail its successor", () => {
    const h = setup();
    const old = h.begin("a", "old").identity;
    expect(h.runtime.beginCompletion(old)).toBe(true);
    const next = h.begin("a", "next").identity;
    expect(h.runtime.beginCompletion(next)).toBe(true);
    const fail = mock(() => undefined);

    h.runtime.releaseCompletion(old);
    h.runtime.failCompletion(old, fail);
    expect(h.runtime.beginCompletion(old)).toBe(false);
    expect(h.runtime.update("a", "old", () => null)).toBe(false);
    expect(fail).not.toHaveBeenCalled();
    expect(h.runtime.ownsCompletion(next)).toBe(true);
    expect(h.runtime.matches(next, "persisting")).toBe(true);

    h.runtime.releaseCompletion(next);
    expect(h.runtime.read("a").phase).toBe("idle");
    expect(h.runtime.ownsCompletion(next)).toBe(false);
  });

  test("stop keeps persistence ownership until explicit release", () => {
    const h = setup();
    const { identity, controller } = h.begin("a");
    expect(h.runtime.beginCompletion(identity)).toBe(true);

    h.runtime.stop("a");

    expect(h.runtime.matches(identity, "persisting")).toBe(true);
    expect(h.runtime.ownsCompletion(identity)).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(h.cancelTransport).not.toHaveBeenCalled();
    h.runtime.releaseCompletion(identity);
    expect(h.runtime.read("a").phase).toBe("idle");
  });

  test("a synchronous abort listener may install a successor without stop clearing it", () => {
    const h = setup();
    const old = h.begin("a", "old");
    let next: ChatTurnIdentity | undefined;
    old.controller.signal.addEventListener("abort", () => {
      next = h.begin("a", "next").identity;
    });

    h.runtime.stop("a");

    expect(h.runtime.read("a")).toMatchObject({ ...next, phase: "streaming" });
    expect(h.cancelTransport.mock.calls).toEqual([["old"]]);
  });

  test("drain follows a replacement stream and old settlement keeps pending steers", async () => {
    const h = setup();
    const { identity } = h.begin("a");
    const old = deferred();
    const next = deferred();
    h.runtime.track("a", old.promise);
    let drained = false;
    const drain = h.runtime.drain("a").then(() => { drained = true; });
    h.runtime.track("a", next.promise);
    const steer = { role: "user" as const, content: "Keep this steer" };
    h.runtime.enqueueSteer("a", steer);

    old.resolve();
    await checkpoint();
    expect(drained).toBe(false);
    expect(h.settled).not.toHaveBeenCalled();
    expect(h.runtime.consumeSteers(identity)).toEqual([steer]);

    next.resolve();
    await drain;
    await checkpoint();
    expect(drained).toBe(true);
    expect(h.settled.mock.calls).toEqual([["a"]]);
  });

  test("completion failure is delivered once and a new turn can own completion", () => {
    const h = setup();
    const old = h.begin("a", "old").identity;
    h.runtime.beginCompletion(old);
    const fail = mock(() => {
      h.runtime.set("a", {
        ...old, phase: "error", abortController: null, lastError: "disk unavailable",
      });
    });
    h.runtime.failCompletion(old, fail);
    h.runtime.failCompletion(old, fail);
    h.runtime.releaseCompletion(old);

    expect(fail).toHaveBeenCalledTimes(1);
    expect(h.runtime.read("a")).toMatchObject({ phase: "error", lastError: "disk unavailable" });
    expect(h.runtime.ownsCompletion(old)).toBe(false);

    const next = h.begin("a", "retry").identity;
    expect(h.runtime.beginCompletion(next)).toBe(true);
    h.runtime.releaseCompletion(old);
    expect(h.runtime.matches(next, "persisting")).toBe(true);
  });

  test("deleted conversations reject completion and steer callbacks", () => {
    const h = setup();
    const { identity } = h.begin("a");
    h.runtime.enqueueSteer("a", { role: "user", content: "Pending" });
    h.runtime.beginCompletion(identity);
    h.deleted.add("a");
    const fail = mock(() => undefined);

    expect(h.runtime.matches(identity)).toBe(false);
    expect(h.runtime.ownsCompletion(identity)).toBe(false);
    expect(h.runtime.beginCompletion(identity)).toBe(false);
    expect(h.runtime.consumeSteers(identity)).toEqual([]);
    h.runtime.failCompletion(identity, fail);
    expect(fail).not.toHaveBeenCalled();
  });
});
