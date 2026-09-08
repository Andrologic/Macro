import {
  validateMessage as checkMessage,
  validateExchange as checkExchange,
  validatePageContinuation as checkPageContinuation,
  type ContentValidation,
} from './contentValidators.generated';
import type { ContentMessage, ContentRequest } from './contentTypes.generated';

export type * from './contentTypes.generated';
export type { ContentValidation } from './contentValidators.generated';

// Inputs may come from an untrusted transport. Malformed non-JSON values fail closed.
const checked = (validate: () => ContentValidation): ContentValidation => {
  try { return validate(); } catch { return { valid: false, errors: ['invalid content envelope'] }; }
};

/** Shape, UTF-8 bounds and within-envelope relationships, without network authority. */
export const validateMessage = (value: unknown): ContentValidation => checked(() => checkMessage(value));
/** Correlates a terminal response to its original request. Retain requests until completion. */
export const validateExchange = (request: unknown, response: unknown): ContentValidation => checked(() => checkExchange(request, response));
export const validateContentMessage = (value: unknown): value is ContentMessage => validateMessage(value).valid;
export const validateContentResponse = (request: unknown, response: unknown): boolean => validateExchange(request, response).valid;

export type ContentPageContinuationContext = {
  /** The outstanding request must use the cursor returned by the previous page. */
  request: ContentRequest;
  /** Identities retained from every earlier page of this capture. */
  seenIdentities?: ReadonlySet<string>;
};

type PageResult = { page: { snapshot_id: string; next_cursor: string | null }; items: Array<{
  message_id?: string; file_id?: string; session_id?: string; project_id?: string;
  ref?: { conversation_id: string };
}> };
const identity = (item: PageResult['items'][number]): string =>
  (item.message_id ?? item.file_id ?? item.session_id ?? item.project_id ?? item.ref?.conversation_id)!;

/** Adjacent pages plus optional cursor ownership and identities from the full capture. */
export function validatePageContinuation(previous: unknown, next: unknown, context?: ContentPageContinuationContext): ContentValidation {
  return checked(() => {
    const result = checkPageContinuation(previous, next);
    if (!result.valid || !context) return result;
    const before = (previous as { result: PageResult }).result;
    const after = (next as { result: PageResult }).result;
    const body = context.request.body as { continuation?: { snapshot_id: string; cursor: string } };
    if (!checkExchange(context.request, next).valid) result.errors.push('page request mismatch');
    if (body.continuation?.snapshot_id !== before.page.snapshot_id || body.continuation?.cursor !== before.page.next_cursor) {
      result.errors.push('outstanding cursor mismatch');
    }
    if (context.seenIdentities && after.items.some(item => context.seenIdentities!.has(identity(item)))) {
      result.errors.push('repeated earlier page identity');
    }
    return { valid: result.errors.length === 0, errors: result.errors };
  });
}
export const validateContentPageContinuation = (previous: unknown, next: unknown, context?: ContentPageContinuationContext): boolean =>
  validatePageContinuation(previous, next, context).valid;
