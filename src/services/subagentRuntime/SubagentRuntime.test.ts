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

class ControlledExecutor implements ChildTurnExecutor<TestInput, TestOutput> {
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
      const finish = (callback: () => void) => {
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

  complete(
    name: string,
    output: ChildTurnExecutionOutput<TestOutput> = {},
  ): void {
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

class MetricsOnAbortExecutor implements ChildTurnExecutor<
  TestInput,
  TestOutput
> {
  execute(
    request: ChildTurnExecutionRequest<TestInput>,
  ): Promise<ChildTurnExecutionOutput<TestOutput>> {
    return new Promise((resolve) => {
      request.signal.addEventListener(
        "abort",
        () => resolve({ metrics: { totalTokens: 23, requests: 1 } }),
        { once: true },
      );
    });
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

const waitForExecution = async (
  executor: ControlledExecutor,
  name: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (executor.pending.has(name)) return;
    await Promise.resolve();
  }
  throw new Error(`Execution did not start: ${name}`);
};

const createControlledClaims = () => {
  const pending = new Map<
    string,
    { resolve: () => void; reject: (error: unknown) => void }
  >();
  return {
    pending,
    recorder: {
      claimRun: (transition: SubagentTransition<TestOutput>) =>
        new Promise<void>((resolve, reject) => {
          pending.set(transition.runId, { resolve, reject });
        }),
      recordTransition: () => undefined,
    },
  };
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
        options?.concurrency ?? (() => DEFAULT_SUBAGENT_CONCURRENCY_PER_PARENT),
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
  it("accepts a caller-owned run id for durable metadata correlation", async () => {
    const { executor, runtime } = makeRuntime();
    const handle = runtime.run({
      runId: "durable-run-1",
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "durable" },
    });
    executor.complete("durable");

    expect(handle.runId).toBe("durable-run-1");
    expect(await handle.result).toMatchObject({
      runId: "durable-run-1",
      status: "completed",
    });
  });

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
    executor.progress("success", {
      kind: "tokens",
      metrics: { totalTokens: 8 },
    });
    executor.complete("success", {
      structured: { value: 42 },
      metrics: { totalTokens: 12, requests: 1 },
    });

    const result = await handle.result;
    expect(handle.runId).toBe("child-1");
    expect(result).toMatchObject({
      runId: "child-1",
      status: "completed",
      output: { structured: { value: 42 } },
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
    await waitForExecution(executor, "failure");

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

  it("preserves final executor metrics after timeout", async () => {
    const clock = new FakeClock();
    const runtime = new SubagentRuntime<TestInput, TestOutput>({
      executor: new MetricsOnAbortExecutor(),
      clock,
      idFactory: createIdFactory(),
    });
    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "metered-timeout" },
      timeoutMs: 50,
    });
    clock.advanceBy(50);

    expect(await handle.result).toMatchObject({
      status: "timed_out",
      metrics: { totalTokens: 23, requests: 1 },
    });
    expect(runtime.getSnapshot(handle.runId)).toMatchObject({
      state: "timed_out",
      metrics: { totalTokens: 23, requests: 1 },
    });
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

  it("maps known reasons from an already aborted parent signal", async () => {
    const cases = [
      {
        signalReason: "timed_out",
        expected: { status: "timed_out" },
      },
      {
        signalReason: "runtime_disposed",
        expected: { status: "cancelled", reason: "runtime_disposed" },
      },
      {
        signalReason: "child_cancelled",
        expected: { status: "cancelled", reason: "child_cancelled" },
      },
      {
        signalReason: "parent_cancelled",
        expected: { status: "cancelled", reason: "parent_cancelled" },
      },
      {
        signalReason: "unknown_reason",
        expected: { status: "cancelled", reason: "parent_cancelled" },
      },
    ] as const;

    for (const { signalReason, expected } of cases) {
      const parentController = new AbortController();
      parentController.abort(signalReason);
      const { executor, runtime } = makeRuntime();
      const handle = runtime.run({
        parentConversationId: "parent-1",
        parentDepth: 0,
        input: { name: signalReason },
        parentSignal: parentController.signal,
      });

      expect(await handle.result).toMatchObject(expected);
      expect(executor.started).toEqual([]);
    }
  });

  it("maps an in-flight timed_out parent abort to the terminal transition", async () => {
    const transitions: Array<SubagentTransition<TestOutput>> = [];
    const parentController = new AbortController();
    const { executor, runtime } = makeRuntime({ transitions });
    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "external-timeout" },
      parentSignal: parentController.signal,
    });
    await waitForExecution(executor, "external-timeout");
    parentController.abort("timed_out");

    expect(await handle.result).toMatchObject({ status: "timed_out" });
    expect(transitions.at(-1)).toMatchObject({
      state: "timed_out",
      result: { status: "timed_out" },
    });
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

  it("preserves final executor metrics after cancellation", async () => {
    const runtime = new SubagentRuntime<TestInput, TestOutput>({
      executor: new MetricsOnAbortExecutor(),
      idFactory: createIdFactory(),
    });
    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "metered-cancellation" },
    });
    handle.cancel();

    expect(await handle.result).toMatchObject({
      status: "cancelled",
      reason: "child_cancelled",
      metrics: { totalTokens: 23, requests: 1 },
    });
    expect(runtime.getSnapshot(handle.runId)).toMatchObject({
      state: "cancelled",
      metrics: { totalTokens: 23, requests: 1 },
    });
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
    expect(executor.started).toEqual(["first", "second", "third", "fourth"]);
    executor.complete("third");
    executor.complete("fourth");
    await Promise.all(handles.map(({ result }) => result));

    expect(executor.maximumActiveCount).toBe(2);
  });

  it("preserves submission FIFO when durable claims resolve out of order", async () => {
    const executor = new ControlledExecutor();
    const claims = createControlledClaims();
    const runtime = new SubagentRuntime<TestInput, TestOutput>({
      executor,
      idFactory: createIdFactory(),
      policy: { maxConcurrencyForParentConversation: () => 1 },
      transitionRecorder: claims.recorder,
    });
    const first = runtime.run({
      runId: "first-run",
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "first" },
    });
    const second = runtime.run({
      runId: "second-run",
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "second" },
    });

    claims.pending.get("second-run")?.resolve();
    await Promise.resolve();
    expect(executor.started).toEqual([]);

    claims.pending.get("first-run")?.resolve();
    await waitForExecution(executor, "first");
    expect(executor.started).toEqual(["first"]);
    executor.complete("first");
    await first.result;
    await waitForExecution(executor, "second");
    expect(executor.started).toEqual(["first", "second"]);
    executor.complete("second");
    await second.result;
  });

  it("releases the next FIFO run when the first durable claim fails", async () => {
    const executor = new ControlledExecutor();
    const claims = createControlledClaims();
    const runtime = new SubagentRuntime<TestInput, TestOutput>({
      executor,
      idFactory: createIdFactory(),
      policy: { maxConcurrencyForParentConversation: () => 1 },
      transitionRecorder: claims.recorder,
    });
    const first = runtime.run({
      runId: "first-run",
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "first" },
    });
    const second = runtime.run({
      runId: "second-run",
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "second" },
    });

    claims.pending.get("second-run")?.resolve();
    claims.pending.get("first-run")?.reject(new Error("first claim rejected"));

    expect(await first.result).toMatchObject({
      status: "failed",
      error: { code: "SUBAGENT_CLAIM_FAILED" },
    });
    await waitForExecution(executor, "second");
    expect(executor.started).toEqual(["second"]);
    executor.complete("second");
    await second.result;
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

  it("rejects invalid requests before recording a queued transition", async () => {
    const transitions: Array<SubagentTransition<TestOutput>> = [];
    const executor = new ControlledExecutor();
    const runtime = new SubagentRuntime<TestInput, TestOutput>({
      executor,
      idFactory: createIdFactory(),
      policy: { maxConcurrencyForParentConversation: () => 0 },
      transitionRecorder: {
        recordTransition: (transition) => {
          transitions.push(transition);
        },
      },
    });

    const invalidParent = runtime.run({
      parentConversationId: " ",
      parentDepth: 0,
      input: { name: "invalid-parent" },
    });
    const invalidDepth = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 1,
      input: { name: "invalid-depth" },
    });
    const invalidPolicy = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "invalid-policy" },
    });

    expect(await invalidParent.result).toMatchObject({
      status: "failed",
      error: { code: "INVALID_PARENT_ID" },
    });
    expect(await invalidPolicy.result).toMatchObject({
      status: "failed",
      error: { code: "INVALID_SUBAGENT_POLICY" },
    });
    expect(await invalidDepth.result).toMatchObject({
      status: "failed",
      error: { code: "SUBAGENT_DEPTH_LIMIT_EXCEEDED" },
    });
    expect(transitions).toEqual([]);
    expect(executor.started).toEqual([]);
  });

  it("fails closed when the durable queued claim is rejected", async () => {
    const executor = new ControlledExecutor();
    const transitionErrors: unknown[] = [];
    const recordedStates: string[] = [];
    const runtime = new SubagentRuntime<TestInput, TestOutput>({
      executor,
      idFactory: createIdFactory(),
      transitionRecorder: {
        claimRun: () => {
          throw new Error("run id already exists");
        },
        recordTransition: (transition) => {
          recordedStates.push(transition.state);
        },
      },
      onTransitionError: (error) => {
        transitionErrors.push(error);
      },
    });
    const handle = runtime.run({
      runId: "already-durable",
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "must-not-start" },
    });

    expect(await handle.result).toMatchObject({
      status: "failed",
      error: { code: "SUBAGENT_CLAIM_FAILED", retryable: true },
    });
    expect(runtime.getSnapshot(handle.runId)).toMatchObject({
      state: "failed",
    });
    expect(executor.started).toEqual([]);
    expect(recordedStates).toEqual([]);
    expect(transitionErrors).toHaveLength(1);
  });

  it("keeps post-claim recorder failures observational", async () => {
    const executor = new ControlledExecutor();
    const failedStates: string[] = [];
    const runtime = new SubagentRuntime<TestInput, TestOutput>({
      executor,
      idFactory: createIdFactory(),
      transitionRecorder: {
        claimRun: () => undefined,
        recordTransition: (transition) => {
          throw new Error(`cannot record ${transition.state}`);
        },
      },
      onTransitionError: (_error, transition) => {
        failedStates.push(transition.state);
      },
    });
    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "observable" },
    });
    await waitForExecution(executor, "observable");
    executor.complete("observable", { text: "done" });

    expect(await handle.result).toMatchObject({
      status: "completed",
      output: { text: "done" },
    });
    expect(failedStates).toEqual(["running", "completed"]);
  });

  it("normalizes ambiguous executor output as a failed run", async () => {
    const { executor, runtime } = makeRuntime();
    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "ambiguous" },
    });
    executor.complete("ambiguous", {
      text: "text",
      structured: { value: 1 },
      metrics: { totalTokens: 9 },
    } as unknown as ChildTurnExecutionOutput<TestOutput>);

    expect(await handle.result).toMatchObject({
      status: "failed",
      error: { code: "AMBIGUOUS_CHILD_OUTPUT" },
      metrics: { totalTokens: 9 },
    });
    expect(runtime.getSnapshot(handle.runId)).toMatchObject({
      state: "failed",
      metrics: { totalTokens: 9 },
    });
  });

  it("preserves final executor metrics after failure", async () => {
    const { executor, runtime } = makeRuntime();
    const handle = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "metered-failure" },
    });
    executor.fail("metered-failure", {
      code: "PROVIDER_DOWN",
      message: "Provider unavailable",
      metrics: { totalTokens: 17, requests: 1 },
    });

    expect(await handle.result).toMatchObject({
      status: "failed",
      metrics: { totalTokens: 17, requests: 1 },
    });
    expect(runtime.getSnapshot(handle.runId)).toMatchObject({
      state: "failed",
      metrics: { totalTokens: 17, requests: 1 },
    });
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
    const active = runtime.run({
      parentConversationId: "parent-1",
      parentDepth: 0,
      input: { name: "active" },
      timeoutMs: 100,
    });
    const queued = runtime.run({
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
    expect(await active.result).toMatchObject({
      status: "cancelled",
      reason: "runtime_disposed",
    });
    expect(await queued.result).toMatchObject({
      status: "cancelled",
      reason: "runtime_disposed",
    });
    expect(runtime.listSnapshots().map(({ state }) => state)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });
});
