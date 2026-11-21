import type { RunHumanRequest030 } from '../../types/agsdlRunUi030';
import { humanRequestKey030, sameHumanScope030 } from './humanRequests030';
import type { RunInspectionAccess030 } from './runtimeProjection030';

/** Stable request identity excludes refresh revisions and component lifetime. */
export const notifiedHumanRequests030 = new Set<string>();
export function claimHumanAttention030(request: RunHumanRequest030): boolean {
  if (request.state.kind !== 'open' || request.content.kind === 'unclassified' ||
      (request.content.kind === 'question' && request.content.answerContract.kind !== 'available')) {
    return false;
  }
  const key = humanRequestKey030(request);
  if (notifiedHumanRequests030.has(key)) return false;
  notifiedHumanRequests030.add(key);
  return true;
}

export function subscribeRunHumanRequests030(
  registrations: readonly {
    scope: { owner: RunHumanRequest030['scope']['source']['owner']; conversationId?: string };
    access: Pick<RunInspectionAccess030, 'getSnapshot' | 'subscribe'>;
  }[],
  onRequest: (request: RunHumanRequest030, conversationId?: string) => void,
): () => void {
  const subscriptions = registrations.map(({ access, scope }) => {
    const check = () => {
      const snapshot = access.getSnapshot();
      if (snapshot.history.kind !== 'ready') return;
      for (const read of Object.values(snapshot.runs)) {
        if (read.kind !== 'ready') continue;
        const { capture, state } = read.value;
        if (state.humans.kind !== 'ready') continue;
        const { owner } = capture.source;
        if (owner.projectId !== scope.owner.projectId || owner.planId !== scope.owner.planId ||
            owner.branch !== scope.owner.branch) continue;
        for (const request of state.humans.value) {
          if (sameHumanScope030(request.scope, capture)) onRequest(request, scope.conversationId);
        }
      }
    };
    const unsubscribe = access.subscribe(check);
    check();
    return unsubscribe;
  });
  return () => subscriptions.forEach(unsubscribe => unsubscribe());
}
