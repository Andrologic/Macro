import { PilotClientError } from './clientError';

/** Admission counts, not a process heap budget. Composition must choose every value. */
export interface ConsumerLimits {
  targets: number;
  subscribers: number;
  activeReads: number;
  directoryPages: number;
  directoryItems: number;
  directoryBytes: number;
  pageItems: number;
  pageBytes: number;
  identities: number;
  cursors: number;
}
export interface ConsumerRetryPolicy {
  /** One delay per permitted retry, shared by a target until manual retry. */
  delaysMs: readonly number[];
  maxDelayMs: number;
  deadlineMs: number;
  jitterRatio: number;
  pollIntervalMs: number;
}
export function consumerTimer(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
}
export interface ConsumerClock {
  timer?(callback: () => void, ms: number): () => void;
  now(): number;
  random(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export function consumerLimits(value: ConsumerLimits): Readonly<ConsumerLimits> {
  const keys: (keyof ConsumerLimits)[] = ['targets', 'subscribers', 'activeReads', 'directoryPages', 'directoryItems',
    'directoryBytes', 'pageItems', 'pageBytes', 'identities', 'cursors'];
  if (!value || keys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 1) ||
    Object.keys(value).some(key => !keys.includes(key as keyof ConsumerLimits)) || value.pageItems > 200 ||
    value.pageBytes > 1_048_576 || value.pageBytes > value.directoryBytes || value.activeReads > value.targets) {
    throw new PilotClientError('invalid_configuration');
  }
  return Object.freeze({ ...value });
}
export function consumerRetryPolicy(value: ConsumerRetryPolicy): Readonly<ConsumerRetryPolicy> {
  if (!value || !Array.isArray(value.delaysMs) || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 1 || value.deadlineMs > 60_000 ||
    !Number.isSafeInteger(value.maxDelayMs) || value.maxDelayMs < 1 || value.maxDelayMs > value.deadlineMs ||
    !Number.isSafeInteger(value.pollIntervalMs) || value.pollIntervalMs < 1 || value.pollIntervalMs > value.maxDelayMs ||
    !Number.isFinite(value.jitterRatio) || value.jitterRatio < 0 || value.jitterRatio > 1 ||
    Array.from(value.delaysMs).some(delay => !Number.isSafeInteger(delay) || delay < 1 || delay > value.maxDelayMs) || Object.keys(value).some(key => !['delaysMs', 'maxDelayMs', 'deadlineMs', 'jitterRatio', 'pollIntervalMs'].includes(key))) {
    throw new PilotClientError('invalid_configuration');
  }
  return Object.freeze({ ...value, delaysMs: Object.freeze([...value.delaysMs]) });
}
export function consumerRetryable(error: unknown): error is PilotClientError {
  return error instanceof PilotClientError && (error.code === 'offline' || error.retryable && error.code === 'unavailable');
}
export const consumerClock: ConsumerClock = {
  now: () => performance.now(), random: () => Math.random(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new PilotClientError('context_changed')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  }),
};

/** Abandon an uncooperative injected port without accepting its late value. */
export function consumerAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new PilotClientError('context_changed')); };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(new PilotClientError('context_changed')); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
