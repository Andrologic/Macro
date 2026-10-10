import { SERVICE_ERROR_CODES } from './contracts/errors';
import { presentServiceError, type DegradedErrorPresentation } from './degradedErrorPresentation';

/** The queue recovery contract retains only the message, including legacy errors. */
export function presentQueuedRecoveryError(message: string): DegradedErrorPresentation | null {
  // Match the revalidator's exact refusal only. Unknown diagnostics stay verbatim.
  if (message !== 'Conflict repository changed. Open a new assistant from the Git dialog.') return null;
  return presentServiceError({
    code: SERVICE_ERROR_CODES.CONFLICT_ASSISTANT_CONTEXT_CHANGED,
    message,
    details: message,
  });
}
