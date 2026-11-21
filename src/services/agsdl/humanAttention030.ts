import type { RunHumanRequest030 } from '../../types/agsdlRunUi030';
import { humanRequestKey030 } from './humanRequests030';

/** Stable request identity excludes refresh revisions and component lifetime. */
export const notifiedHumanRequests030 = new Set<string>();
export function claimHumanAttention030(request: RunHumanRequest030): boolean {
  const key = humanRequestKey030(request);
  if (notifiedHumanRequests030.has(key)) return false;
  notifiedHumanRequests030.add(key);
  return true;
}
