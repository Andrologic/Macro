import type { StreamCompletionResult } from './contracts';

export const emptyStreamCompletionResult = (visibleContent = ''): StreamCompletionResult => ({
  visibleContent,
  toolTraces: [],
});
