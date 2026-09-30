import type { PilotPublicState } from './nativeClient';
import { connectionIntervention, connectionScope } from './connectionPresentation';

export const CONNECT_ATTENTION_KEY = 'macro-connect-intervention';

/** One notification per incident, including cancellation after an explicit retry. */
export function createConnectionAttentionObserver() {
  let scope: string | null = null;
  let notified = false;
  return (state: PilotPublicState & { busy?: boolean }, emit: (reason: NonNullable<ReturnType<typeof connectionIntervention>>) => void, dismiss: () => void) => {
    const nextScope = connectionScope(state);
    if (scope !== nextScope) {
      if (notified) dismiss();
      scope = nextScope;
      notified = false;
    }
    const reason = connectionIntervention(state);
    if (!reason) {
      // Suspension and in-flight recovery still belong to the same incident.
      if (!state.busy && (!state.vaultStatus || state.vaultStatus === 'ready')) {
        if (notified) dismiss();
        notified = false;
      }
      return;
    }
    if (notified) return;
    notified = true;
    emit(reason);
  };
}
