import {
  DEFAULT_SUBAGENT_CONCURRENCY_PER_PARENT,
  type ChildTurnExecutionOutput,
  type CancelledSubagentResult,
  type NormalizedSubagentError,
  type SubagentProgressEvent,
  type SubagentRunHandle,
  type SubagentRunRequest,
  type SubagentRunResult,
  type SubagentRunSnapshot,
  type SubagentRuntimeClock,
  type SubagentRuntimeListener,
  type SubagentRuntimeOptions,
  type SubagentRunState,
  type SubagentTransition,
  type TimedOutSubagentResult,
} from "./types";

type CancellationReason = CancelledSubagentResult["reason"] | "timed_out";

interface ParentPool<TInput, TStructuredOutput, TProgress extends SubagentProgressEvent> {
  activeCount: number;
  maximumConcurrency: number;
  queue: Array<RunRecord<TInput, TStructuredOutput, TProgress>>;
}

interface RunRecord<TInput, TStructuredOutput, TProgress extends SubagentProgressEvent> {
  request: SubagentRunRequest<TInput>;
  snapshot: SubagentRunSnapshot<TProgress>;
  controller: AbortController;
  cancellationReason?: CancellationReason;
  timeoutHandle?: unknown;
  removeParentAbortListener?: () => void;
  transitionSequence: number;
  transitionWrites: Promise<void>;
  settled: boolean;
  resolveResult: (result: SubagentRunResult<TStructuredOutput>) => void;
  result: Promise<SubagentRunResult<TStructuredOutput>>;
}

const systemClock: SubagentRuntimeClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

let fallbackIdSequence = 0;

const defaultIdFactory = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackIdSequence += 1;
  return `subagent-${Date.now()}-${fallbackIdSequence}`;
};

const defaultPolicy = {
  maxConcurrencyForParentConversation: () => DEFAULT_SUBAGENT_CONCURRENCY_PER_PARENT,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const normalizeSubagentError = (
  error: unknown,
): NormalizedSubagentError => {
  if (typeof error === "string") {
    return { code: "CHILD_EXECUTION_FAILED", message: error };
  }

  if (isRecord(error)) {
    const code =
      typeof error.code === "string" && error.code.trim()
        ? error.code
        : "CHILD_EXECUTION_FAILED";
    const message =
      typeof error.message === "string" && error.message.trim()
        ? error.message
        : "Child execution failed";
    return {
      code,
      message,
      details: error,
      ...(typeof error.retryable === "boolean"
        ? { retryable: error.retryable }
        : {}),
    };
  }

  return {
    code: "CHILD_EXECUTION_FAILED",
    message: "Child execution failed",
    details: error,
  };
};

const cloneSnapshot = <TProgress extends SubagentProgressEvent>(
  snapshot: SubagentRunSnapshot<TProgress>,
): SubagentRunSnapshot<TProgress> => ({
  ...snapshot,
  ...(snapshot.progress ? { progress: { ...snapshot.progress } } : {}),
  ...(snapshot.metrics ? { metrics: { ...snapshot.metrics } } : {}),
  ...(snapshot.error ? { error: { ...snapshot.error } } : {}),
});

const validatePositiveInteger = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
};

export class SubagentRuntime<
  TInput = unknown,
  TStructuredOutput = unknown,
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  readonly #options: SubagentRuntimeOptions<
    TInput,
    TStructuredOutput,
    TProgress
  >;
  readonly #clock: SubagentRuntimeClock;
  readonly #runs = new Map<
    string,
    RunRecord<TInput, TStructuredOutput, TProgress>
  >();
  readonly #pools = new Map<
    string,
    ParentPool<TInput, TStructuredOutput, TProgress>
  >();
  readonly #listeners = new Set<SubagentRuntimeListener<TProgress>>();
  #disposed = false;

  constructor(
    options: SubagentRuntimeOptions<TInput, TStructuredOutput, TProgress>,
  ) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  run(request: SubagentRunRequest<TInput>): SubagentRunHandle<TStructuredOutput> {
    const runId = request.runId ?? (this.#options.idFactory ?? defaultIdFactory)();
    if (!runId.trim() || this.#runs.has(runId)) {
      throw new Error(`Subagent run id must be unique and non-empty: ${runId}`);
    }

    const timeoutMs =
      request.timeoutMs ??
      this.#options.policy?.timeoutMsForRun?.(request);
    if (timeoutMs !== undefined) {
      validatePositiveInteger(timeoutMs, "timeoutMs");
    }

    let resolveResult!: (
      result: SubagentRunResult<TStructuredOutput>,
    ) => void;
    const result = new Promise<SubagentRunResult<TStructuredOutput>>(
      (resolve) => {
        resolveResult = resolve;
      },
    );
    const record: RunRecord<TInput, TStructuredOutput, TProgress> = {
      request,
      snapshot: {
        runId,
        parentConversationId: request.parentConversationId,
        depth: 1,
        state: "queued",
        queuedAt: this.#clock.now(),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
      controller: new AbortController(),
      transitionSequence: 0,
      transitionWrites: Promise.resolve(),
      settled: false,
      resolveResult,
      result,
    };
    this.#runs.set(runId, record);
    this.#publishTransition(record, null);

    const handle: SubagentRunHandle<TStructuredOutput> = {
      runId,
      result,
      cancel: () => this.cancelChild(runId),
    };

    if (this.#disposed) {
      this.#finishCancelled(record, "runtime_disposed");
      return handle;
    }

    if (request.parentDepth !== 0) {
      this.#finishFailed(record, {
        code: "SUBAGENT_DEPTH_LIMIT_EXCEEDED",
        message: "Subagent runtime only accepts top-level parents",
        details: {
          parentDepth: request.parentDepth,
          maximumChildDepth: 1,
        },
      });
      return handle;
    }

    if (!request.parentConversationId.trim()) {
      this.#finishFailed(record, {
        code: "INVALID_PARENT_ID",
        message: "Subagent parent id must be non-empty",
      });
      return handle;
    }

    this.#attachParentSignal(record);
    if (record.snapshot.state !== "queued") {
      return handle;
    }

    let maximumConcurrency: number;
    try {
      maximumConcurrency = validatePositiveInteger(
        (
          this.#options.policy ?? defaultPolicy
        ).maxConcurrencyForParentConversation(request.parentConversationId),
        "maxConcurrencyForParentConversation",
      );
    } catch (error) {
      this.#finishFailed(record, {
        ...normalizeSubagentError(error),
        code: "INVALID_SUBAGENT_POLICY",
      });
      return handle;
    }

    const pool = this.#getPool(
      request.parentConversationId,
      maximumConcurrency,
    );
    pool.queue.push(record);
    this.#pump(request.parentConversationId);
    return handle;
  }

  cancelChild(runId: string): boolean {
    const record = this.#runs.get(runId);
    if (!record || this.#isTerminal(record.snapshot.state)) {
      return false;
    }
    this.#requestCancellation(record, "child_cancelled");
    return true;
  }

  cancelParentConversation(parentConversationId: string): number {
    let cancelledCount = 0;
    for (const record of this.#runs.values()) {
      if (
        record.snapshot.parentConversationId === parentConversationId &&
        !this.#isTerminal(record.snapshot.state)
      ) {
        cancelledCount += 1;
        this.#requestCancellation(record, "parent_cancelled");
      }
    }
    return cancelledCount;
  }

  getSnapshot(runId: string): SubagentRunSnapshot<TProgress> | undefined {
    const snapshot = this.#runs.get(runId)?.snapshot;
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  listSnapshots(parentConversationId?: string): Array<SubagentRunSnapshot<TProgress>> {
    return [...this.#runs.values()]
      .filter((record) =>
        parentConversationId === undefined ? true : record.snapshot.parentConversationId === parentConversationId,
      )
      .map((record) => cloneSnapshot(record.snapshot));
  }

  subscribe(listener: SubagentRuntimeListener<TProgress>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async whenIdle(parentConversationId?: string): Promise<void> {
    const pending = [...this.#runs.values()]
      .filter(
        (record) =>
          !record.settled &&
          (parentConversationId === undefined || record.snapshot.parentConversationId === parentConversationId),
      )
      .map((record) => record.result);
    await Promise.all(pending);
  }

  async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      for (const record of this.#runs.values()) {
        if (!this.#isTerminal(record.snapshot.state)) {
          this.#requestCancellation(record, "runtime_disposed");
        }
      }
    }
    await Promise.all([...this.#runs.values()].map((record) => record.result));
    this.#listeners.clear();
  }

  #getPool(
    parentConversationId: string,
    maximumConcurrency: number,
  ): ParentPool<TInput, TStructuredOutput, TProgress> {
    const existing = this.#pools.get(parentConversationId);
    if (existing) {
      existing.maximumConcurrency = maximumConcurrency;
      return existing;
    }
    const created: ParentPool<TInput, TStructuredOutput, TProgress> = {
      activeCount: 0,
      maximumConcurrency,
      queue: [],
    };
    this.#pools.set(parentConversationId, created);
    return created;
  }

  #pump(parentConversationId: string): void {
    const pool = this.#pools.get(parentConversationId);
    if (!pool) return;
    while (pool.activeCount < pool.maximumConcurrency) {
      const record = pool.queue.shift();
      if (!record) break;
      if (record.snapshot.state !== "queued") continue;
      pool.activeCount += 1;
      this.#startExecution(record);
    }

    if (pool.activeCount === 0 && pool.queue.length === 0) {
      this.#pools.delete(parentConversationId);
    }
  }

  #startExecution(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): void {
    const previousState = record.snapshot.state;
    record.snapshot = {
      ...record.snapshot,
      state: "running",
      startedAt: this.#clock.now(),
    };
    this.#publishTransition(record, previousState);

    const timeoutMs = record.snapshot.timeoutMs;
    if (timeoutMs !== undefined) {
      record.timeoutHandle = this.#clock.setTimeout(() => {
        this.#requestCancellation(record, "timed_out");
      }, timeoutMs);
    }

    void this.#execute(record);
  }

  async #execute(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): Promise<void> {
    let output: ChildTurnExecutionOutput<TStructuredOutput> | undefined;
    let failure: unknown;
    try {
      output = await this.#options.executor.execute({
        childRunId: record.snapshot.runId,
        parentConversationId: record.snapshot.parentConversationId,
        depth: 1,
        input: record.request.input,
        signal: record.controller.signal,
        onProgress: (event) => this.#handleProgress(record, event),
      });
    } catch (error) {
      failure = error;
    }

    if (record.cancellationReason === "timed_out") {
      this.#finishTimedOut(record);
    } else if (record.cancellationReason) {
      this.#finishCancelled(record, record.cancellationReason);
    } else if (failure !== undefined) {
      this.#finishFailed(record, normalizeSubagentError(failure));
    } else {
      this.#finishCompleted(record, output ?? {});
    }

    const pool = this.#pools.get(record.snapshot.parentConversationId);
    if (pool) {
      pool.activeCount -= 1;
      this.#pump(record.snapshot.parentConversationId);
    }
  }

  #handleProgress(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    event: TProgress,
  ): void {
    if (record.snapshot.state !== "running" || record.controller.signal.aborted) {
      return;
    }
    record.snapshot = {
      ...record.snapshot,
      progress: { ...event },
      ...(event.metrics ? { metrics: { ...event.metrics } } : {}),
    };
    this.#emit(record.snapshot);
  }

  #attachParentSignal(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): void {
    const signal = record.request.parentSignal;
    if (!signal) return;
    if (signal.aborted) {
      this.#requestCancellation(record, "parent_cancelled");
      return;
    }
    const onAbort = () =>
      this.#requestCancellation(record, "parent_cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    record.removeParentAbortListener = () =>
      signal.removeEventListener("abort", onAbort);
  }

  #requestCancellation(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    reason: CancellationReason,
  ): void {
    if (this.#isTerminal(record.snapshot.state) || record.cancellationReason) {
      return;
    }
    record.cancellationReason = reason;
    if (record.snapshot.state === "queued") {
      if (reason === "timed_out") {
        this.#finishTimedOut(record);
      } else {
        this.#finishCancelled(record, reason);
      }
      this.#removeQueuedRecord(record);
      return;
    }
    record.controller.abort(reason);
  }

  #removeQueuedRecord(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): void {
    const pool = this.#pools.get(record.snapshot.parentConversationId);
    if (!pool) return;
    const index = pool.queue.indexOf(record);
    if (index >= 0) pool.queue.splice(index, 1);
    this.#pump(record.snapshot.parentConversationId);
  }

  #finishCompleted(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    output: ChildTurnExecutionOutput<TStructuredOutput>,
  ): void {
    const endedAt = this.#clock.now();
    this.#finish(record, {
      runId: record.snapshot.runId,
      parentConversationId: record.snapshot.parentConversationId,
      status: "completed",
      queuedAt: record.snapshot.queuedAt,
      ...(record.snapshot.startedAt === undefined
        ? {}
        : {
            startedAt: record.snapshot.startedAt,
            durationMs: endedAt - record.snapshot.startedAt,
          }),
      endedAt,
      ...(output.text === undefined && output.structured === undefined
        ? {}
        : {
            output: {
              ...(output.text === undefined ? {} : { text: output.text }),
              ...(output.structured === undefined
                ? {}
                : { structured: output.structured }),
            },
          }),
      ...(output.metrics ? { metrics: { ...output.metrics } } : {}),
    });
  }

  #finishFailed(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    error: NormalizedSubagentError,
  ): void {
    const endedAt = this.#clock.now();
    this.#finish(record, {
      runId: record.snapshot.runId,
      parentConversationId: record.snapshot.parentConversationId,
      status: "failed",
      queuedAt: record.snapshot.queuedAt,
      ...(record.snapshot.startedAt === undefined
        ? {}
        : {
            startedAt: record.snapshot.startedAt,
            durationMs: endedAt - record.snapshot.startedAt,
          }),
      endedAt,
      error,
    });
  }

  #finishCancelled(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    reason: Exclude<CancellationReason, "timed_out">,
  ): void {
    const endedAt = this.#clock.now();
    this.#finish(record, {
      runId: record.snapshot.runId,
      parentConversationId: record.snapshot.parentConversationId,
      status: "cancelled",
      reason,
      queuedAt: record.snapshot.queuedAt,
      ...(record.snapshot.startedAt === undefined
        ? {}
        : {
            startedAt: record.snapshot.startedAt,
            durationMs: endedAt - record.snapshot.startedAt,
          }),
      endedAt,
    });
  }

  #finishTimedOut(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): void {
    const endedAt = this.#clock.now();
    const result: TimedOutSubagentResult = {
      runId: record.snapshot.runId,
      parentConversationId: record.snapshot.parentConversationId,
      status: "timed_out",
      timeoutMs: record.snapshot.timeoutMs ?? 0,
      queuedAt: record.snapshot.queuedAt,
      ...(record.snapshot.startedAt === undefined
        ? {}
        : {
            startedAt: record.snapshot.startedAt,
            durationMs: endedAt - record.snapshot.startedAt,
          }),
      endedAt,
    };
    this.#finish(record, result);
  }

  #finish(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    result: SubagentRunResult<TStructuredOutput>,
  ): void {
    if (this.#isTerminal(record.snapshot.state)) return;
    const previousState = record.snapshot.state;
    this.#clearRunResources(record);
    record.snapshot = {
      ...record.snapshot,
      state: result.status,
      endedAt: result.endedAt,
      ...(result.status === "failed" ? { error: result.error } : {}),
      ...(result.status === "completed" && result.metrics
        ? { metrics: { ...result.metrics } }
        : {}),
    };
    this.#publishTransition(record, previousState, result);
    void record.transitionWrites.then(() => {
      record.settled = true;
      record.resolveResult(result);
    });
  }

  #clearRunResources(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): void {
    if (record.timeoutHandle !== undefined) {
      this.#clock.clearTimeout(record.timeoutHandle);
      record.timeoutHandle = undefined;
    }
    record.removeParentAbortListener?.();
    record.removeParentAbortListener = undefined;
  }

  #publishTransition(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    previousState: SubagentRunState | null,
    result?: SubagentRunResult<TStructuredOutput>,
  ): void {
    const transition: SubagentTransition<TStructuredOutput, TProgress> = {
      runId: record.snapshot.runId,
      parentConversationId: record.snapshot.parentConversationId,
      sequence: record.transitionSequence,
      previousState,
      state: record.snapshot.state,
      occurredAt: this.#clock.now(),
      snapshot: cloneSnapshot(record.snapshot),
      ...(result ? { result } : {}),
    };
    record.transitionSequence += 1;
    this.#emit(record.snapshot);

    const recorder = this.#options.transitionRecorder;
    if (!recorder) return;
    record.transitionWrites = record.transitionWrites.then(async () => {
      try {
        await recorder.recordTransition(transition);
      } catch (error) {
        try {
          await this.#options.onTransitionError?.(error, transition);
        } catch {
          // Observability failures must not alter the child result.
        }
      }
    });
  }

  #emit(snapshot: SubagentRunSnapshot<TProgress>): void {
    for (const listener of this.#listeners) {
      try {
        const observation = listener(cloneSnapshot(snapshot));
        if (observation) {
          void Promise.resolve(observation).catch(() => undefined);
        }
      } catch {
        // One observer cannot break the runtime lifecycle.
      }
    }
  }

  #isTerminal(state: SubagentRunState): boolean {
    return state !== "queued" && state !== "running";
  }
}
