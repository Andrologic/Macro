export const DEFAULT_SUBAGENT_CONCURRENCY_PER_PARENT = 2;
export const MAX_SUBAGENT_DEPTH = 1;

export type SubagentRunState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type SubagentTerminalState = Exclude<
  SubagentRunState,
  "queued" | "running"
>;

export interface SubagentMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
  cost?: number;
  [key: string]: number | undefined;
}

export interface SubagentProgressEvent {
  kind: string;
  message?: string;
  data?: unknown;
  metrics?: SubagentMetrics;
}

export interface NormalizedSubagentError {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

export interface ChildTurnExecutionOutput<TStructuredOutput = unknown> {
  text?: string;
  structured?: TStructuredOutput;
  metrics?: SubagentMetrics;
}

export interface ChildTurnExecutionRequest<
  TInput = unknown,
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  childRunId: string;
  parentConversationId: string;
  depth: 1;
  input: TInput;
  signal: AbortSignal;
  onProgress?: (event: TProgress) => void;
}

/**
 * Provider adapter for one foreground child turn.
 *
 * Implementations must stop their work and settle the returned promise after
 * `signal` aborts. The runtime waits for that settlement before releasing the
 * parent's concurrency slot.
 */
export interface ChildTurnExecutor<
  TInput = unknown,
  TStructuredOutput = unknown,
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  execute(
    request: ChildTurnExecutionRequest<TInput, TProgress>,
  ): Promise<ChildTurnExecutionOutput<TStructuredOutput>>;
}

export interface SubagentRunRequest<TInput = unknown> {
  /** Optional caller-owned id, useful when a durable recorder needs metadata before queuing. */
  runId?: string;
  parentConversationId: string;
  parentDepth: number;
  input: TInput;
  parentSignal?: AbortSignal;
  timeoutMs?: number;
}

interface SubagentResultBase {
  runId: string;
  parentConversationId: string;
  queuedAt: number;
  startedAt?: number;
  endedAt: number;
  durationMs?: number;
}

export interface CompletedSubagentResult<TStructuredOutput = unknown>
  extends SubagentResultBase {
  status: "completed";
  output?: {
    text?: string;
    structured?: TStructuredOutput;
  };
  metrics?: SubagentMetrics;
}

export interface FailedSubagentResult extends SubagentResultBase {
  status: "failed";
  error: NormalizedSubagentError;
}

export interface CancelledSubagentResult extends SubagentResultBase {
  status: "cancelled";
  reason: "parent_cancelled" | "child_cancelled" | "runtime_disposed";
}

export interface TimedOutSubagentResult extends SubagentResultBase {
  status: "timed_out";
  timeoutMs: number;
}

export type SubagentRunResult<TStructuredOutput = unknown> =
  | CompletedSubagentResult<TStructuredOutput>
  | FailedSubagentResult
  | CancelledSubagentResult
  | TimedOutSubagentResult;

export interface SubagentRunSnapshot<
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  runId: string;
  parentConversationId: string;
  depth: 1;
  state: SubagentRunState;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  timeoutMs?: number;
  progress?: TProgress;
  error?: NormalizedSubagentError;
  metrics?: SubagentMetrics;
}

export interface SubagentTransition<
  TStructuredOutput = unknown,
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  runId: string;
  parentConversationId: string;
  sequence: number;
  previousState: SubagentRunState | null;
  state: SubagentRunState;
  occurredAt: number;
  snapshot: SubagentRunSnapshot<TProgress>;
  result?: SubagentRunResult<TStructuredOutput>;
}

export interface SubagentTransitionRecorder<
  TStructuredOutput = unknown,
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  recordTransition(
    transition: SubagentTransition<TStructuredOutput, TProgress>,
  ): void | Promise<void>;
}

export interface SubagentRuntimePolicy<TInput = unknown> {
  maxConcurrencyForParentConversation(parentConversationId: string): number;
  timeoutMsForRun?(request: SubagentRunRequest<TInput>): number | undefined;
}

export interface SubagentRuntimeClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SubagentRuntimeOptions<
  TInput = unknown,
  TStructuredOutput = unknown,
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  executor: ChildTurnExecutor<TInput, TStructuredOutput, TProgress>;
  policy?: SubagentRuntimePolicy<TInput>;
  transitionRecorder?: SubagentTransitionRecorder<TStructuredOutput, TProgress>;
  idFactory?: () => string;
  clock?: SubagentRuntimeClock;
  onTransitionError?: (
    error: unknown,
    transition: SubagentTransition<TStructuredOutput, TProgress>,
  ) => void | Promise<void>;
}

export interface SubagentRunHandle<TStructuredOutput = unknown> {
  runId: string;
  result: Promise<SubagentRunResult<TStructuredOutput>>;
  cancel(): boolean;
}

export type SubagentRuntimeListener<
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> = (snapshot: SubagentRunSnapshot<TProgress>) => void | Promise<void>;
