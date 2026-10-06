import { describe, expect, mock, test } from "bun:test";
import type { ConversationRuntimeState } from "../types";
import { EMPTY_CONVERSATION_RUNTIME } from "../domains/chat/runtimeState";
import { StreamStopUnconfirmedError } from "./ai/streamCancellation";
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
  const cancelTransport = mock<(_sessionId: string) => void | Promise<void>>(() => undefined);
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

  test("a successor cannot consume a direction owned by the previous turn", () => {
    const h = setup();
    const first = h.begin('a', 'first');
    expect(h.runtime.enqueueSteer('a', { role: 'user', content: 'First only' }, first.identity)).toBe(true);
    const successor = h.begin('a', 'successor');
    expect(h.runtime.enqueueSteer('a', { role: 'user', content: 'Late first' }, first.identity)).toBe(false);
    expect(h.runtime.consumeSteers(successor.identity)).toEqual([]);
    expect(h.runtime.enqueueSteer('a', { role: 'user', content: 'Successor only' }, successor.identity)).toBe(true);
    expect(h.runtime.consumeSteers(successor.identity)).toEqual([{ role: 'user', content: 'Successor only' }]);
    expect(h.runtime.consumeSteers(successor.identity)).toEqual([]);
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


test('Stop retains admission until an executor ignoring its signal finishes', async () => {
  const h = setup();
  const { controller } = h.begin('a');
  const work = deferred();
  h.runtime.track('a', work.promise);
  const stopped = h.runtime.stop('a');
  expect(h.runtime.stop('a')).toBe(stopped);
  expect(controller.signal.aborted).toBe(true);
  expect(() => h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false })).toThrow('already running');
  let drained = false;
  void stopped.then(() => { drained = true; });
  await checkpoint();
  expect(drained).toBe(false);
  work.resolve();
  await stopped;
  expect(h.runtime.read('a').phase).toBe('idle');
  h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false });
});

test('an unconfirmed transport cancellation keeps the owner reserved', async () => {
  const h = setup();
  h.begin('a');
  h.cancelTransport.mockImplementation(async () => { throw new Error('Native cancellation failed'); });
  await expect(h.runtime.stop('a')).rejects.toThrow('Native cancellation failed');
  expect(h.runtime.read('a')).toMatchObject({ phase: 'error', lastError: expect.stringContaining('not confirmed') });
  expect(() => h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false })).toThrow('already running');
  expect(h.settled).not.toHaveBeenCalled();
});

test('a stream rejection reporting uncertain Stop also keeps admission closed', async () => {
  const h = setup();
  h.begin('a');
  const failure = new StreamStopUnconfirmedError('No stop receipt');
  h.runtime.track('a', Promise.reject(failure));
  await expect(h.runtime.stop('a')).rejects.toBe(failure);
  expect(() => h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false })).toThrow('already running');
});


test('a spontaneous uncertain stream failure retains admission until its receipt', async () => {
  const h = setup();
  h.begin('a');
  const receipt = deferred();
  const failure = new StreamStopUnconfirmedError('Unconfirmed executor end', receipt.promise);
  const run = Promise.reject(failure);
  h.runtime.track('a', run);
  await checkpoint();
  expect(h.runtime.read('a').phase).toBe('error');
  expect(() => h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false })).toThrow('already running');
  expect(h.settled).not.toHaveBeenCalled();
  receipt.resolve();
  await checkpoint();
  expect(h.runtime.read('a').phase).toBe('idle');
  h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false });
  expect(h.settled).toHaveBeenCalledTimes(1);
});


test('Stop without a transport receipt cannot clear a spontaneous uncertain owner', async () => {
  const h = setup();
  h.begin('a');
  const failure = new StreamStopUnconfirmedError('No executor receipt');
  h.runtime.track('a', Promise.reject(failure));
  await checkpoint();
  await expect(h.runtime.stop('a')).rejects.toBe(failure);
  expect(h.runtime.read('a').phase).toBe('error');
  expect(() => h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false })).toThrow('already running');
});


test('drain retains a rejected Stop owner until its receipt, including cleared projections', async () => {
  const h = setup();
  h.begin('a');
  const proof = deferred();
  const failure = new StreamStopUnconfirmedError('Missing stop receipt', proof.promise);
  h.cancelTransport.mockImplementation(async () => { throw failure; });
  await expect(h.runtime.stop('a')).rejects.toBe(failure);
  h.runtime.set('a', null);
  h.cancelTransport.mockClear();
  await expect(h.runtime.stop('a')).rejects.toBe(failure);
  expect(h.cancelTransport).toHaveBeenCalledWith('a-session');
  let ended = false;
  const drained = h.runtime.drain('a').then(() => { ended = true; });
  await checkpoint();
  expect(ended).toBe(false);
  proof.resolve();
  await drained;
  h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false });
});


test('a successful local transport retry cannot release an outstanding tool receipt', async () => {
  const h = setup();
  h.begin('a');
  const toolReceipt = deferred();
  const failure = new StreamStopUnconfirmedError('Tool executor end unknown', toolReceipt.promise);
  h.runtime.track('a', Promise.reject(failure));
  await checkpoint();
  h.cancelTransport.mockImplementation(async () => undefined);
  await expect(h.runtime.stop('a')).rejects.toBe(failure);
  expect(() => h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false })).toThrow('already running');
  expect(h.settled).not.toHaveBeenCalled();
  toolReceipt.resolve();
  await h.runtime.drain('a');
  await checkpoint();
  h.runtime.assertCanSend('a', { available: true, hasUnsavedResponse: false });
});
