import {
  type ToolCall,
  type StreamCompletionReason,
  type StreamingChatOptions,
} from './contracts';

export const INCOMPLETE_RECOVERY_PROMPT =
  'The previous assistant output ended before completion. ' +
  'Continue exactly where it stopped. Return only the missing continuation. ' +
  'Do not repeat text and do not call tools.';

export const isIncompleteCompletionReason = (
  reason: StreamCompletionReason | undefined,
): reason is 'length' | 'incomplete' => reason === 'length' || reason === 'incomplete';

export const stripContinuationOverlap = (existing: string, continuation: string): string => {
  if (!existing || !continuation) return continuation;
  const prefixLengths = new Uint32Array(continuation.length);
  for (let index = 1, matched = 0; index < continuation.length; index += 1) {
    while (matched > 0 && continuation[index] !== continuation[matched]) {
      matched = prefixLengths[matched - 1] ?? 0;
    }
    if (continuation[index] === continuation[matched]) {
      matched += 1;
    }
    prefixLengths[index] = matched;
  }

  let overlap = 0;
  for (let index = 0; index < existing.length; index += 1) {
    while (overlap > 0 && existing[index] !== continuation[overlap]) {
      overlap = prefixLengths[overlap - 1] ?? 0;
    }
    if (existing[index] === continuation[overlap]) {
      overlap += 1;
    }
    if (overlap === continuation.length && index < existing.length - 1) {
      overlap = prefixLengths[overlap - 1] ?? 0;
    }
  }
  const overlapStartsAtWordBoundary =
    overlap === existing.length || /[^\p{L}\p{N}_]/u.test(existing[existing.length - overlap - 1] ?? '');
  const overlapEndsAtWordBoundary =
    overlap === continuation.length || /[^\p{L}\p{N}_]/u.test(continuation[overlap] ?? '');
  if (
    overlap < 3 ||
    (overlap < 8 && (!overlapStartsAtWordBoundary || !overlapEndsAtWordBoundary))
  ) {
    return continuation;
  }
  return continuation.slice(overlap);
};

export const recoveredCompletionReason = (
  cause: 'length' | 'incomplete',
): StreamCompletionReason =>
  cause === 'length' ? 'length_recovered' : 'incomplete_recovered';

export function shouldRetryMissingRequiredTool(
  policy: StreamingChatOptions['guidedToolRetry'],
  toolCalls: ToolCall[],
  retryCount: number
): boolean {
  if (!policy || retryCount >= (policy.maxRetries ?? 1)) {
    return false;
  }

  const requiredToolNames = new Set(policy.requiredToolNames);
  if (requiredToolNames.size === 0) {
    return false;
  }

  return !toolCalls.some((toolCall) => requiredToolNames.has(toolCall.function.name));
}
