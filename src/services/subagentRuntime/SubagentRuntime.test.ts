import { describe, expect, it } from "bun:test";

import {
  DEFAULT_SUBAGENT_CONCURRENCY_PER_PARENT,
  SubagentRuntime,
  type ChildTurnExecutionOutput,
  type ChildTurnExecutionRequest,
  type ChildTurnExecutor,
  type SubagentProgressEvent,
  type SubagentRuntimeClock,
  type SubagentTransition,
} from "./index";

interface TestInput {
  name: string;
}

interface TestOutput {
  value: number;
}

interface PendingExecution {
  request: ChildTurnExecutionRequest<TestInput>;
  resolve: (output: ChildTurnExecutionOutput<TestOutput>) => void;
  reject: (error: unknown) => void;
}

class ControlledExecutor
  implements ChildTurnExecutor<TestInput, TestOutput>
{
  readonly started: string[] = [];
  readonly pending = new Map<string, PendingExecution>();
  activeCount = 0;
  maximumActiveCount = 0;

  execute(
    request: ChildTurnExecutionRequest<TestInput>,
  ): Promise<ChildTurnExecutionOutput<TestOutput>> {
    this.started.push(request.input.name);
    this.activeCount += 1;
    this.maximumActiveCount = Math.max(
      this.maximumActiveCount,
      this.activeCount,
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        callback: () => void,
      ) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener("abort", onAbort);
        this.pending.delete(request.input.name);
        this.activeCount -= 1;
        callback();
      };
      const onAbort = () =>
        finish(() => reject(new Error("execution aborted")));
      request.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.input.name, {
        request,
        resolve: (output) => finish(() => resolve(output)),
        reject: (error) => finish(() => reject(error)),
      });
    });
  }

  complete(name: string, output: ChildTurnExecutionOutput<TestOutput> = {}): void {
    const pending = this.pending.get(name);
    if (!pending) throw new Error(`Missing pending execution: ${name}`);
    pending.resolve(output);
  }

  fail(name: string, error: unknown): void {
    const pending = this.pending.get(name);
    if (!pending) throw new Error(`Missing pending execution: ${name}`);
    pending.reject(error);
  }

  progress(name: string, event: SubagentProgressEvent): void {
    this.pending.get(name)?.request.onProgress?.(event);
  }
}

class FakeClock implements SubagentRuntimeClock {
  #now = 1_000;
  #sequence = 0;
  readonly timers = new Map<
    number,
    { deadline: number; callback: () => void }
  >();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    this.#sequence += 1;
    this.timers.set(this.#sequence, {
      deadline: this.#now + delayMs,
      callback,
    });
    return this.#sequence;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(durationMs: number): void {
    this.#now += durationMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.deadline <= this.#now)
      .sort(([left], [right]) => left - right);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

const createIdFactory = () => {
  let sequence = 0;
  return () => `child-${++sequence}`;
};

const makeRuntime = (options?: {
  executor?: ControlledExecutor;
  clock?: FakeClock;
  concurrency?: (parentConversationId: string) => number;
  transitions?: Array<SubagentTransition<TestOutput>>;
}) => {
  const executor = options?.executor ?? new ControlledExecutor();
  const runtime = new SubagentRuntime<TestInput, TestOutput>({
    executor,
    idFactory: createIdFactory(),
    clock: options?.clock,
    policy: {
      maxConcurrencyForParentConversation:
        options?.concurrency ??
        (() => DEFAULT_SUBAGENT_CONCURRENCY_PER_PARENT),
    },
    transitionRecorder: options?.transitions
      ? {
          recordTransition: async (transition) => {
            await Promise.resolve();
            options.transitions?.push(transition);
          },
        }
      : undefined,
  });
  return { executor, runtime };
};

describe("SubagentRuntime", () => {
  it("returns a stable id, structured output, metrics, and observable progress", async () => {
    const { executor, runtime } = makeRuntime();
    const observedKinds: string[] = [];
    runtime.subscribe((snapshot) => {
      if (snapshot.state === "running" && snapshot.progress) {
        observedKinds.push(snapshot.progress.kind);
      }
    });

    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "success" },
    });
    executor.progress("success", { kind: "tokens", metrics: { totalTokens: 8 } });
    executor.complete("success", {
      text: "done",
      structured: { value: 42 },
      metrics: { totalTokens: 12, requests: 1 },
    });

    const result = await handle.result;
    expect(handle.runId).toBe("child-1");
    expect(result).toMatchObject({
      runId: "child-1",
      status: "completed",
      output: { text: "done", structured: { value: 42 } },
      metrics: { totalTokens: 12, requests: 1 },
    });
    expect(runtime.getSnapshot(handle.runId)).toMatchObject({
      state: "completed",
      progress: { kind: "tokens" },
      metrics: { totalTokens: 12 },
    });
    expect(observedKinds).toEqual(["tokens"]);
  });

  it("normalizes executor failures and records ordered transitions", async () => {
    const transitions: Array<SubagentTransition<TestOutput>> = [];
    const { executor, runtime } = makeRuntime({ transitions });
    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "failure" },
    });

    executor.fail("failure", {
      code: "PROVIDER_DOWN",
      message: "Provider unavailable",
      retryable: true,
    });

    expect(await handle.result).toMatchObject({
      status: "failed",
      error: {
        code: "PROVIDER_DOWN",
        message: "Provider unavailable",
        retryable: true,
      },
    });
    expect(transitions.map(({ state }) => state)).toEqual([
      "queued",
      "running",
      "failed",
    ]);
    expect(transitions.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    expect(transitions.at(-1)?.result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_DOWN" },
    });
  });

  it("times out a running child and waits for cooperative abort cleanup", async () => {
    const clock = new FakeClock();
    const { executor, runtime } = makeRuntime({ clock });
    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "slow" },
      timeoutMs: 50,
    });

    clock.advanceBy(50);

    expect(await handle.result).toMatchObject({
      status: "timed_out",
      timeoutMs: 50,
      durationMs: 50,
    });
    expect(executor.activeCount).toBe(0);
    expect(clock.timers.size).toBe(0);
  });

  it("propagates parent cancellation to running and queued children", async () => {
    const executor = new ControlledExecutor();
    const { runtime } = makeRuntime({ executor, concurrency: () => 1 });
    const parentController = new AbortController();
    const running = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "running" },
      parentSignal: parentController.signal,
    });
    const queued = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "queued" },
      parentSignal: parentController.signal,
    });

    parentController.abort("parent stopped");

    expect(await running.result).toMatchObject({
      status: "cancelled",
      reason: "parent_cancelled",
    });
    expect(await queued.result).toMatchObject({
      status: "cancelled",
      reason: "parent_cancelled",
    });
    expect(executor.started).toEqual(["running"]);
  });

  it("cancels one child explicitly without affecting its sibling", async () => {
    const { executor, runtime } = makeRuntime();
    const cancelled = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "cancelled" },
    });
    const sibling = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "sibling" },
    });

    expect(cancelled.cancel()).toBe(true);
    executor.complete("sibling", { structured: { value: 7 } });

    expect(await cancelled.result).toMatchObject({
      status: "cancelled",
      reason: "child_cancelled",
    });
    expect(await sibling.result).toMatchObject({ status: "completed" });
    expect(cancelled.cancel()).toBe(false);
  });

  it("uses a deterministic FIFO queue and bounds concurrency per parent", async () => {
    const { executor, runtime } = makeRuntime({ concurrency: () => 2 });
    const handles = ["first", "second", "third", "fourth"].map((name) =>
      runtime.run({
        parentConversationId: "parent-1",
        parentDepth: 0,
        input: { name },
      }),
    );

    expect(executor.started).toEqual(["first", "second"]);
    executor.complete("second");
    await handles[1].result;
    expect(executor.started).toEqual(["first", "second", "third"]);
    executor.complete("first");
    await handles[0].result;
    expect(executor.started).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
    executor.complete("third");
    executor.complete("fourth");
    await Promise.all(handles.map(({ result }) => result));

    expect(executor.maximumActiveCount).toBe(2);
  });

  it("applies concurrency independently for each parent", async () => {
    const { executor, runtime } = makeRuntime({ concurrency: () => 1 });
    const first = runtime.run({
      parentConversationId: "parent-a",
      parentDepth: 0,
      input: { name: "a" },
    });
    const second = runtime.run({
      parentConversationId: "parent-b",
      parentDepth: 0,
      input: { name: "b" },
    });

    expect(executor.started).toEqual(["a", "b"]);
    expect(executor.activeCount).toBe(2);
    executor.complete("a");
    executor.complete("b");
    await Promise.all([first.result, second.result]);
  });

  it("rejects recursion in the engine without invoking the executor", async () => {
    const { executor, runtime } = makeRuntime();
    const handle = runtime.run({
      parentConversationId: "child-parent",
      parentDepth: 1,
      input: { name: "recursive" },
    });

    expect(await handle.result).toMatchObject({
      status: "failed",
      error: { code: "SUBAGENT_DEPTH_LIMIT_EXCEEDED" },
    });
    expect(executor.started).toEqual([]);
  });

  it("disposes all work, waits for transition hooks, and leaves no active execution", async () => {
    const executor = new ControlledExecutor();
    const clock = new FakeClock();
    const recordedStates: string[] = [];
    let releaseTerminalWrite!: () => void;
    const terminalWrite = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    const runtime = new SubagentRuntime<TestInput, TestOutput>({
      executor,
      clock,
      idFactory: createIdFactory(),
      policy: { maxConcurrencyForParentConversation: () => 1 },
      transitionRecorder: {
        recordTransition: async (transition) => {
          recordedStates.push(transition.state);
          if (transition.state === "cancelled") await terminalWrite;
        },
      },
    });
    runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "active" },
      timeoutMs: 100,
    });
    runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "queued" },
    });

    let disposed = false;
    const disposal = runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    releaseTerminalWrite();
    await disposal;

    expect(executor.activeCount).toBe(0);
    expect(clock.timers.size).toBe(0);
    expect(recordedStates).toContain("cancelled");
    expect(runtime.listSnapshots().map(({ state }) => state)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });
});
