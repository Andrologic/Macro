import {
  DEFAULT_SUBAGENT_CONCURRENCY_PER_PARENT,
  type ChildTurnExecutionOutput,
  type CancelledSubagentResult,
  type NormalizedSubagentError,
  type SubagentMetrics,
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

interface ParentPool<
  TInput,
  TStructuredOutput,
  TProgress extends SubagentProgressEvent,
> {
  activeCount: number;
  maximumConcurrency: number;
  queue: Array<RunRecord<TInput, TStructuredOutput, TProgress>>;
}

interface RunRecord<
  TInput,
  TStructuredOutput,
  TProgress extends SubagentProgressEvent,
> {
  request: SubagentRunRequest<TInput>;
  snapshot: SubagentRunSnapshot<TProgress>;
  claimState: "pending" | "claimed";
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
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  fallbackIdSequence += 1;
  return `subagent-${Date.now()}-${fallbackIdSequence}`;
};

const defaultPolicy = {
  maxConcurrencyForParentConversation: () =>
    DEFAULT_SUBAGENT_CONCURRENCY_PER_PARENT,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const getMetrics = (value: unknown): SubagentMetrics | undefined => {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.metrics) ? value.metrics : value;
  const entries = Object.entries(candidate);
  if (
    entries.length === 0 ||
    entries.some(
      ([, metric]) => metric !== undefined && typeof metric !== "number",
    )
  ) {
    return undefined;
  }
  return { ...candidate } as SubagentMetrics;
};

const cancellationReasonFromSignal = (
  signal: AbortSignal,
): CancellationReason => {
  switch (signal.reason) {
    case "timed_out":
    case "runtime_disposed":
    case "child_cancelled":
    case "parent_cancelled":
      return signal.reason;
    default:
      return "parent_cancelled";
  }
};

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

  run(
    request: SubagentRunRequest<TInput>,
  ): SubagentRunHandle<TStructuredOutput> {
    const runId =
      request.runId ?? (this.#options.idFactory ?? defaultIdFactory)();
    if (typeof runId !== "string" || !runId.trim() || this.#runs.has(runId)) {
      throw new Error(`Subagent run id must be unique and non-empty: ${runId}`);
    }

    const queuedAt = this.#clock.now();
    if (this.#disposed) {
      return this.#rejectBeforeClaim(runId, request, queuedAt, {
        status: "cancelled",
        reason: "runtime_disposed",
      });
    }
    if (request.parentDepth !== 0) {
      return this.#rejectBeforeClaim(runId, request, queuedAt, {
        status: "failed",
        error: {
          code: "SUBAGENT_DEPTH_LIMIT_EXCEEDED",
          message: "Subagent runtime only accepts top-level parents",
          details: { parentDepth: request.parentDepth, maximumChildDepth: 1 },
        },
      });
    }
    if (!request.parentConversationId.trim()) {
      return this.#rejectBeforeClaim(runId, request, queuedAt, {
        status: "failed",
        error: {
          code: "INVALID_PARENT_ID",
          message: "Subagent parent id must be non-empty",
        },
      });
    }

    let timeoutMs: number | undefined;
    let maximumConcurrency: number;
    try {
      timeoutMs =
        request.timeoutMs ?? this.#options.policy?.timeoutMsForRun?.(request);
      if (timeoutMs !== undefined) {
        validatePositiveInteger(timeoutMs, "timeoutMs");
      }
      maximumConcurrency = validatePositiveInteger(
        (
          this.#options.policy ?? defaultPolicy
        ).maxConcurrencyForParentConversation(request.parentConversationId),
        "maxConcurrencyForParentConversation",
      );
    } catch (error) {
      return this.#rejectBeforeClaim(runId, request, queuedAt, {
        status: "failed",
        error: {
          ...normalizeSubagentError(error),
          code: "INVALID_SUBAGENT_POLICY",
        },
      });
    }

    let resolveResult!: (result: SubagentRunResult<TStructuredOutput>) => void;
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
        queuedAt,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
      claimState: "pending",
      controller: new AbortController(),
      transitionSequence: 0,
      transitionWrites: Promise.resolve(),
      settled: false,
      resolveResult,
      result,
    };
    this.#runs.set(runId, record);
    const pool = this.#getPool(
      request.parentConversationId,
      maximumConcurrency,
    );
    pool.queue.push(record);

    const handle: SubagentRunHandle<TStructuredOutput> = {
      runId,
      result,
      cancel: () => this.cancelChild(runId),
    };

    if (!this.#options.transitionRecorder) {
      record.claimState = "claimed";
      record.transitionSequence = 1;
      this.#emit(record.snapshot);
      this.#scheduleClaimed(record);
    } else {
      void this.#claimAndSchedule(record);
    }
    return handle;
  }

  #rejectBeforeClaim(
    runId: string,
    request: SubagentRunRequest<TInput>,
    queuedAt: number,
    terminal:
      | { status: "failed"; error: NormalizedSubagentError }
      | { status: "cancelled"; reason: "runtime_disposed" },
  ): SubagentRunHandle<TStructuredOutput> {
    const endedAt = this.#clock.now();
    const result: SubagentRunResult<TStructuredOutput> = {
      runId,
      parentConversationId: request.parentConversationId,
      queuedAt,
      endedAt,
      ...terminal,
    };
    const snapshot: SubagentRunSnapshot<TProgress> = {
      runId,
      parentConversationId: request.parentConversationId,
      depth: 1,
      state: terminal.status,
      queuedAt,
      endedAt,
      ...(terminal.status === "failed" ? { error: terminal.error } : {}),
    };
    let resolveResult!: (value: SubagentRunResult<TStructuredOutput>) => void;
    const resultPromise = new Promise<SubagentRunResult<TStructuredOutput>>(
      (resolve) => {
        resolveResult = resolve;
      },
    );
    const record: RunRecord<TInput, TStructuredOutput, TProgress> = {
      request,
      snapshot,
      claimState: "pending",
      controller: new AbortController(),
      transitionSequence: 0,
      transitionWrites: Promise.resolve(),
      settled: true,
      resolveResult,
      result: resultPromise,
    };
    this.#runs.set(runId, record);
    resolveResult(result);
    this.#emit(snapshot);
    return {
      runId,
      result: resultPromise,
      cancel: () => false,
    };
  }

  async #claimAndSchedule(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): Promise<void> {
    const claimed = await this.#claimRun(record);
    if (!claimed) return;

    record.claimState = "claimed";
    record.transitionSequence = 1;
    this.#scheduleClaimed(record);
  }

  #scheduleClaimed(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): void {
    if (this.#disposed && !record.cancellationReason) {
      this.#requestCancellation(record, "runtime_disposed");
    }
    this.#attachParentSignal(record);
    if (record.cancellationReason) {
      this.#requestQueuedCancellation(record);
      return;
    }

    this.#pump(record.snapshot.parentConversationId);
  }

  async #claimRun(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): Promise<boolean> {
    const transition: SubagentTransition<TStructuredOutput, TProgress> & {
      sequence: 0;
      previousState: null;
      state: "queued";
    } = {
      runId: record.snapshot.runId,
      parentConversationId: record.snapshot.parentConversationId,
      sequence: 0,
      previousState: null,
      state: "queued",
      occurredAt: this.#clock.now(),
      snapshot: cloneSnapshot(record.snapshot),
    };
    this.#emit(record.snapshot);
    const recorder = this.#options.transitionRecorder;
    if (!recorder) return false;
    try {
      if (recorder.claimRun) {
        await recorder.claimRun(transition);
      } else {
        await recorder.recordTransition(transition);
      }
      return true;
    } catch (error) {
      try {
        await this.#options.onTransitionError?.(error, transition);
      } catch {
        // The claim failure remains authoritative even if reporting it fails.
      }
      this.#finishUnclaimed(record, {
        code: "SUBAGENT_CLAIM_FAILED",
        message: "Subagent run could not be claimed",
        details: error,
        retryable: true,
      });
      this.#removeQueuedRecord(record);
      return false;
    }
  }

  #finishUnclaimed(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    error: NormalizedSubagentError,
  ): void {
    const endedAt = this.#clock.now();
    const result: SubagentRunResult<TStructuredOutput> = {
      runId: record.snapshot.runId,
      parentConversationId: record.snapshot.parentConversationId,
      status: "failed",
      queuedAt: record.snapshot.queuedAt,
      endedAt,
      error,
    };
    record.snapshot = {
      ...record.snapshot,
      state: "failed",
      endedAt,
      error,
    };
    record.settled = true;
    this.#emit(record.snapshot);
    record.resolveResult(result);
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

  listSnapshots(
    parentConversationId?: string,
  ): Array<SubagentRunSnapshot<TProgress>> {
    return [...this.#runs.values()]
      .filter((record) =>
        parentConversationId === undefined
          ? true
          : record.snapshot.parentConversationId === parentConversationId,
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
          (parentConversationId === undefined ||
            record.snapshot.parentConversationId === parentConversationId),
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
      const record = pool.queue[0];
      if (!record) break;
      if (record.claimState === "pending") break;
      pool.queue.shift();
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
      this.#finishTimedOut(record, output?.metrics ?? getMetrics(failure));
    } else if (record.cancellationReason) {
      this.#finishCancelled(
        record,
        record.cancellationReason,
        output?.metrics ?? getMetrics(failure),
      );
    } else if (failure !== undefined) {
      this.#finishFailed(
        record,
        normalizeSubagentError(failure),
        getMetrics(failure),
      );
    } else {
      const completedOutput = output ?? {};
      if (
        completedOutput.text !== undefined &&
        completedOutput.structured !== undefined
      ) {
        this.#finishFailed(
          record,
          {
            code: "AMBIGUOUS_CHILD_OUTPUT",
            message: "Child execution returned both text and structured output",
          },
          completedOutput.metrics,
        );
      } else {
        this.#finishCompleted(record, completedOutput);
      }
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
    if (
      record.snapshot.state !== "running" ||
      record.controller.signal.aborted
    ) {
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
      this.#requestCancellation(record, cancellationReasonFromSignal(signal));
      return;
    }
    const onAbort = () =>
      this.#requestCancellation(record, cancellationReasonFromSignal(signal));
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
      if (record.transitionSequence > 0) {
        this.#requestQueuedCancellation(record);
      }
      return;
    }
    record.controller.abort(reason);
  }

  #requestQueuedCancellation(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
  ): void {
    const reason = record.cancellationReason;
    if (!reason || record.snapshot.state !== "queued") return;
    if (reason === "timed_out") {
      this.#finishTimedOut(record);
    } else {
      this.#finishCancelled(record, reason);
    }
    this.#removeQueuedRecord(record);
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
    const resultBase = {
      runId: record.snapshot.runId,
      parentConversationId: record.snapshot.parentConversationId,
      status: "completed" as const,
      queuedAt: record.snapshot.queuedAt,
      ...(record.snapshot.startedAt === undefined
        ? {}
        : {
            startedAt: record.snapshot.startedAt,
            durationMs: endedAt - record.snapshot.startedAt,
          }),
      endedAt,
      ...(output.metrics ? { metrics: { ...output.metrics } } : {}),
    };
    if (output.text !== undefined) {
      this.#finish(record, { ...resultBase, output: { text: output.text } });
    } else if (output.structured !== undefined) {
      this.#finish(record, {
        ...resultBase,
        output: { structured: output.structured },
      });
    } else {
      this.#finish(record, resultBase);
    }
  }

  #finishFailed(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    error: NormalizedSubagentError,
    metrics?: SubagentMetrics,
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
      ...(metrics ? { metrics: { ...metrics } } : {}),
    });
  }

  #finishCancelled(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    reason: Exclude<CancellationReason, "timed_out">,
    metrics?: SubagentMetrics,
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
      ...(metrics ? { metrics: { ...metrics } } : {}),
    });
  }

  #finishTimedOut(
    record: RunRecord<TInput, TStructuredOutput, TProgress>,
    metrics?: SubagentMetrics,
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
      ...(metrics ? { metrics: { ...metrics } } : {}),
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
      ...(result.metrics ? { metrics: { ...result.metrics } } : {}),
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
