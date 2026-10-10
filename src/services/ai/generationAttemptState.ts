import type { GenerationAttempt } from './contracts';

export const mergeGenerationAttempts = (
  previous: GenerationAttempt[] | undefined,
  current: GenerationAttempt[] | undefined,
): GenerationAttempt[] | undefined => {
  if (!previous?.length && !current?.length) return undefined;
  const byId = new Map<string, GenerationAttempt>();
  for (const attempt of previous ?? []) byId.set(attempt.id, attempt);
  for (const attempt of current ?? []) byId.set(attempt.id, attempt);
  return [...byId.values()];
};
