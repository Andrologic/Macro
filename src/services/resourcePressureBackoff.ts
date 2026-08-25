import { isResourcePressureError } from './contracts/errors';

const TOO_MANY_OPEN_FILES_BACKOFF_MS = 30_000;

let tooManyOpenFilesBackoffUntil = 0;

export const isTooManyOpenFilesMessage = (value: unknown): boolean => {
  if (isResourcePressureError(value)) {
    return true;
  }

  const message =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? value.message
        : value && typeof value === 'object' && 'message' in value
          ? String((value as { message?: unknown }).message ?? '')
          : '';
  const lower = message.toLowerCase();
  return lower.includes('too many open files') || lower.includes('os error 24') || lower.includes('emfile');
};

export const noteTooManyOpenFilesBackoff = (now: number = Date.now()): number => {
  tooManyOpenFilesBackoffUntil = Math.max(
    tooManyOpenFilesBackoffUntil,
    now + TOO_MANY_OPEN_FILES_BACKOFF_MS
  );
  return tooManyOpenFilesBackoffUntil;
};

export const isTooManyOpenFilesBackoffActive = (now: number = Date.now()): boolean =>
  now < tooManyOpenFilesBackoffUntil;

export const getTooManyOpenFilesNotificationKey = (): string =>
  'implement-task-error:too-many-open-files';

export const __testables = {
  reset: () => {
    tooManyOpenFilesBackoffUntil = 0;
  },
  backoffMs: TOO_MANY_OPEN_FILES_BACKOFF_MS,
};
