import type { PilotPermission, PilotPublicState } from './nativeClient';
import type { PilotRuntimeStatus } from './runtime';

export const vaultRecoveryMessages = {
  intervention_required: 'Macro needs your permission to read the saved credentials. Restore the connection to continue using Macro Pilot. Your local projects and conversations remain available.',
  cancelled: 'Permission was cancelled. Restore the connection when you are ready. Your local projects and conversations remain available.',
  suspended: 'The connection is paused. If it does not resume after you unlock your session, restore it here. Your local projects and conversations remain available.',
  vault_unavailable: 'Saved credentials are inaccessible. Check that your system credential storage is unlocked, then restore the connection. Your local projects and conversations remain available.',
} as const;

const COMPUTER_PERMISSIONS: PilotPermission[] = ['supervise', 'respond', 'approve_tools', 'review'];

const vaultErrors = {
  vault_intervention_required: 'intervention_required',
  vault_cancelled: 'cancelled',
  vault_suspended: 'suspended',
  vault_unavailable: 'vault_unavailable',
} as const;

export function getVaultRecoveryStatus(state: PilotPublicState) {
  if (state.vaultStatus && state.vaultStatus !== 'ready') return state.vaultStatus;
  return vaultErrors[state.lastError as keyof typeof vaultErrors];
}

/** A ready credential store still needs the fresh session check that fences the producer. */
export function sessionVerificationStatus(state: PilotPublicState) {
  if (state.vaultStatus !== 'ready' || state.deviceSession?.state !== 'active') return null;
  return state.sessionVerification === 'failed' ? 'retry' : state.sessionVerification === 'pending' ? 'verifying' : null;
}

export function accountConnectionStatus(state: PilotPublicState) {
  if (state.sessionEndReason) return state.sessionEndReason === 'unauthorized' ? 'expired' : 'revoked';
  if (state.lastError === 'unauthorized' || state.deviceSession?.state === 'expired') return 'expired';
  if (state.lastError === 'session_revoked' || state.deviceSession?.state === 'revoked') return 'revoked';
  if (state.account && state.deviceSession?.state === 'active') return 'connected';
  return state.status;
}

export const computerAvailabilityMessages = {
  online: 'Online',
  paused: 'Connection paused',
  intervention_required: 'Permission required',
  cancelled: 'Permission cancelled',
  vault_unavailable: 'Saved credentials inaccessible',
  unavailable: 'Unavailable',
  offline: 'Offline',
  resuming: 'Connecting…',
  access_required: 'Access needs restoring',
} as const;

export function computerAvailability(state: PilotPublicState, runtime: PilotRuntimeStatus) {
  const vault = getVaultRecoveryStatus(state);
  if (vault) return vault === 'suspended' ? 'paused' : vault;
  const verification = sessionVerificationStatus(state);
  if (verification) return verification === 'verifying' ? 'resuming' : 'offline';
  const account = accountConnectionStatus(state);
  if (account === 'expired' || account === 'revoked' || state.status !== 'connected' || state.deviceSession?.state !== 'active') return 'offline';
  if (state.instance && (state.instanceAccess?.state !== 'granted' ||
    !COMPUTER_PERMISSIONS.every(permission => state.instanceAccess?.permissions.includes(permission)))) return 'access_required';
  if (runtime === 'unavailable') return 'unavailable';
  if (runtime === 'running' && state.instance?.connection_state === 'reachable') return 'online';
  return 'resuming';
}

export function connectionIntervention(state: PilotPublicState) {
  const account = accountConnectionStatus(state);
  if (account === 'expired' || account === 'revoked') return account;
  const vault = getVaultRecoveryStatus(state);
  return vault && vault !== 'suspended' ? vault : null;
}

export function connectionScope(state: PilotPublicState) {
  return JSON.stringify([state.configurationId, state.relayOrigin, state.account?.account_id, state.deviceSession?.ref.session_id]);
}
