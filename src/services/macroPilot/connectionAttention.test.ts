import { describe, expect, it, mock } from 'bun:test';
import type { PilotPublicState } from './nativeClient';
import { createConnectionAttentionObserver } from './connectionAttention';
import { accountConnectionStatus, computerAvailability } from './connectionPresentation';

const state = (): PilotPublicState => ({
  status: 'connected', vaultStatus: 'ready', configurationId: 'config:one', relayOrigin: 'https://relay.example.com',
  account: { contract_version: '1.0', type: 'account', account_id: 'account:one', identity: { provider: 'github', subject: '1', login: 'example' }, revision: 1 },
  deviceSession: { contract_version: '1.0', type: 'device_session', ref: { type: 'session', account_id: 'account:one', session_id: 'session:one' }, device_id: 'device:one', state: 'active', issued_at: '2026-09-01T00:00:00Z', revision: 1 },
  instance: null, instanceAccess: null, attempt: null, lastError: null, logoutRevocationConfirmed: null,
});

describe('Macro Connect attention', () => {
  it('stays quiet during suspension and emits once through repeated updates and cancellation', () => {
    const observe = createConnectionAttentionObserver(); const emit = mock(() => undefined); const dismiss = mock(() => undefined);
    const current = state(); current.status = 'vault_unavailable'; current.vaultStatus = 'suspended';
    observe(current, emit, dismiss); expect(emit).not.toHaveBeenCalled();
    current.vaultStatus = 'intervention_required';
    observe(current, emit, dismiss); observe(current, emit, dismiss);
    current.vaultStatus = 'cancelled'; observe(current, emit, dismiss);
    current.vaultStatus = 'suspended'; observe(current, emit, dismiss);
    current.vaultStatus = 'intervention_required'; observe(current, emit, dismiss);
    expect(emit).toHaveBeenCalledTimes(1); expect(dismiss).not.toHaveBeenCalled();
    current.vaultStatus = 'ready'; current.status = 'connected'; observe(current, emit, dismiss);
    expect(dismiss).toHaveBeenCalledTimes(1);
    current.vaultStatus = 'intervention_required'; observe(current, emit, dismiss);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('clears obsolete attention when the account changes or signs out', () => {
    const observe = createConnectionAttentionObserver(); const emit = mock(() => undefined); const dismiss = mock(() => undefined);
    const current = state(); current.vaultStatus = 'vault_unavailable'; observe(current, emit, dismiss);
    current.deviceSession = { ...current.deviceSession!, ref: { ...current.deviceSession!.ref, session_id: 'session:two' } };
    observe(current, emit, dismiss); expect(emit).toHaveBeenCalledTimes(2); expect(dismiss).toHaveBeenCalledTimes(1);
    current.deviceSession = null; current.account = null; current.status = 'signed_out'; current.vaultStatus = 'ready'; observe(current, emit, dismiss);
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  it.each(['unauthorized', 'session_revoked'] as const)('requires attention for %s without a credential prompt', error => {
    const observe = createConnectionAttentionObserver(); const emit = mock(() => undefined); const dismiss = mock(() => undefined);
    const current = state(); current.lastError = error;
    observe(current, emit, dismiss); observe(current, emit, dismiss);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(accountConnectionStatus(current)).toBe(error === 'unauthorized' ? 'expired' : 'revoked');
    expect(computerAvailability(current, 'running')).toBe('offline');
  });

  it('does not duplicate attention when a store read clears an error before failing again', () => {
    const observe = createConnectionAttentionObserver(); const emit = mock(() => undefined); const dismiss = mock(() => undefined);
    const current = { ...state(), busy: false }; current.lastError = 'unauthorized'; observe(current, emit, dismiss);
    current.busy = true; current.lastError = null; observe(current, emit, dismiss);
    current.lastError = 'unauthorized'; observe(current, emit, dismiss);
    current.busy = false; observe(current, emit, dismiss);
    expect(emit).toHaveBeenCalledTimes(1); expect(dismiss).not.toHaveBeenCalled();
  });

  it('shows a saved active account separately from paused or offline computer availability', () => {
    const current = state(); current.status = 'vault_unavailable'; current.vaultStatus = 'cancelled';
    expect(accountConnectionStatus(current)).toBe('connected'); expect(computerAvailability(current, 'running')).toBe('cancelled');
    current.status = 'offline'; current.vaultStatus = 'ready';
    expect(accountConnectionStatus(current)).toBe('connected'); expect(computerAvailability(current, 'running')).toBe('offline');
  });
});
