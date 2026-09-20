import type { ToolCallResolution, ToolInterruptResolution } from './contracts';

export const formatToolExecutionError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const maybeMessage = 'message' in error ? (error as { message?: unknown }).message : undefined;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }
    const maybeError = 'error' in error ? (error as { error?: unknown }).error : undefined;
    if (typeof maybeError === 'string' && maybeError.trim()) {
      return maybeError;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
};

export const isToolInterruptResolution = (value: ToolCallResolution | undefined): value is ToolInterruptResolution => value?.kind === 'interrupt';

export const normalizeToolCallResolution = (value: ToolCallResolution | string | void): ToolCallResolution | undefined => typeof value === 'string' ? { kind: 'result', result: value } : value || undefined;

export function throwIfToolAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Tool execution aborted', 'AbortError');
}
