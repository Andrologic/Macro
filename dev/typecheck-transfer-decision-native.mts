import type { DecisionFrozen } from '../contracts/macro-pilot/v2/transfer-decision.js';
import type { ConversationContentToken } from '../src/types/generated/ipc/ConversationContentToken.js';

// Desktop-only composition check; never part of the vendor contract import.
// Native C1 DTO fields project without UUID conversion or numeric coercion.
export function frozenFromCurrentNativeToken(token: ConversationContentToken, rest: Omit<DecisionFrozen, 'content_incarnation' | 'content_revision'>): DecisionFrozen {
  return { ...rest, content_incarnation: token.incarnation, content_revision: token.revision };
}
