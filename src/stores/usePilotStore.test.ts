import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { sessionVerificationStatus, accountConnectionStatus } from '../services/macroPilot/connectionPresentation';
import type { PilotAccountCatalog, PilotPublicState } from '../services/macroPilot/nativeClient';

const native = await import('../services/macroPilot/nativeClient');
const initial = (): PilotPublicState => ({
  status: 'connected', configurationId: 'config:test', relayOrigin: 'https://pilot.example.com',
  account: { contract_version: '1.0', type: 'account', account_id: 'account:one', revision: 1,
    identity: { provider: 'github', subject: '1234', login: 'example' } },
  deviceSession: { contract_version: '1.0', type: 'device_session',
    ref: { type: 'session', account_id: 'account:one', session_id: 'session:one' },
    device_id: 'device:one', state: 'active', issued_at: '2026-09-01T00:00:00Z', revision: 1 },
  instance: null, instanceAccess: null, attempt: null, lastError: null, logoutRevocationConfirmed: null,
});
const catalog: PilotAccountCatalog = { identity: { account_id: 'account:one', session_id: 'session:one',
  provider: 'github', subject: '1234', login: 'example', revision: 1 }, sessions: [], revision: 1 };
let state = initial();
let subscriber: () => void;
const getAccountCatalog = mock(async (_signal?: AbortSignal) => catalog);
const listAccessRequests = mock(async (_signal?: AbortSignal) => []);
const revokeSession = mock(async (_id: string) => ({ revocationConfirmed: true }));
const deleteAccount = mock(async () => ({ revocationConfirmed: true }));
const resolveAccess = mock(async () => undefined);
const connect = mock(async () => undefined);
const pollAuth = mock(async () => state.attempt?.identifiedAccount ?? null);
const confirmAccount = mock(async (_id: string) => { state = { ...initial(), attempt: null }; subscriber(); return state.deviceSession!; });
const resumeVaultAccess = mock(async (): Promise<void> => undefined);
const signOut = async () => { state = { ...state, account: null, deviceSession: null, status: 'signed_out' as const }; subscriber(); return { revocationConfirmed: false }; };
const logout = mock(signOut);
mock.module('../services/macroPilot/nativeClient', () => ({ ...native, macroPilotNativeClient: {
  getState: () => state, subscribe: (listener: () => void) => { subscriber = listener; return () => undefined; },
  initialize: async () => undefined, getAccountCatalog, listAccessRequests, revokeSession, deleteAccount,
  resolveAccess, connect, resumeVaultAccess, pollAuth, confirmAccount,
  logout,
} }));
const { usePilotStore } = await import('./usePilotStore');
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  state = initial(); subscriber();
  usePilotStore.setState({ busy: false, reading: false, accountCatalog: null, accessRequests: [], accessRequestsLoaded: false, lastError: null });
  getAccountCatalog.mockReset(); getAccountCatalog.mockImplementation(async () => catalog);
  listAccessRequests.mockReset(); listAccessRequests.mockImplementation(async () => []);
  revokeSession.mockReset(); revokeSession.mockImplementation(async () => ({ revocationConfirmed: true }));
  logout.mockReset(); logout.mockImplementation(signOut);
  resumeVaultAccess.mockReset(); resumeVaultAccess.mockImplementation(async () => undefined);
  deleteAccount.mockClear(); resolveAccess.mockClear(); connect.mockClear(); pollAuth.mockClear(); confirmAccount.mockClear();
});

describe('Pilot account store', () => {
  it('claims the authenticated account automatically and resumes an identified attempt without polling again', async () => {
    state = { ...initial(), deviceSession: null, account: null, status: 'confirming_account', attempt: {
      attemptKey: 'attempt:key', attemptId: 'attempt:one', userCode: 'TEST-CODE',
      verificationUri: 'https://github.com/login/device', expiresAt: '2099-01-01T00:00:00Z', interval: 5,
      identifiedAccount: initial().account!,
    } }; subscriber();
    expect(await usePilotStore.getState().pollAuth()).toBe(true);
    expect(confirmAccount).toHaveBeenCalledWith('account:one');
    expect(pollAuth).not.toHaveBeenCalled();
    expect(usePilotStore.getState()).toMatchObject({ status: 'connected', attempt: null, busy: false });
  });

  it('finishes a successful authorization poll without asking for account confirmation', async () => {
    pollAuth.mockImplementationOnce(async () => initial().account);
    expect(await usePilotStore.getState().pollAuth()).toBe(true);
    expect(pollAuth).toHaveBeenCalledTimes(1);
    expect(confirmAccount).toHaveBeenCalledWith('account:one');
    expect(usePilotStore.getState().status).toBe('connected');
  });

  it('does not claim an account while GitHub authorization is pending' , async () => {
    await usePilotStore.getState().pollAuth();
    expect(pollAuth).toHaveBeenCalledTimes(1);
    expect(confirmAccount).not.toHaveBeenCalled();
  });
  it('allows logout to preempt explicit vault recovery and discards its late result', async () => {
    const pending = deferred<void>();
    resumeVaultAccess.mockImplementation(() => pending.promise);
    const recovery = usePilotStore.getState().resumeVaultAccess();
    await expect(usePilotStore.getState().resumeVaultAccess()).rejects.toThrow('conflict');
    await expect(usePilotStore.getState().logout()).resolves.toBe(false);
    pending.resolve();
    await expect(recovery).rejects.toThrow('context_changed');
    expect(resumeVaultAccess).toHaveBeenCalledTimes(1);
    expect(getAccountCatalog).not.toHaveBeenCalled();
    expect(usePilotStore.getState()).toMatchObject({ status: 'signed_out', busy: false });
  });

  it('updates the vault error badge from client recovery during account refresh', async () => {
    state = { ...state, status: 'vault_unavailable', lastError: 'vault_unavailable' }; subscriber();
    getAccountCatalog.mockImplementation(async () => {
      state = { ...state, status: 'connected', lastError: null }; subscriber();
      return catalog;
    });
    await usePilotStore.getState().refreshAccount();
    expect(usePilotStore.getState()).toMatchObject({
      status: 'connected', lastError: null, accountCatalog: catalog, busy: false, reading: false,
    });
  });

  it('loads Pilot account data after explicit vault recovery succeeds', async () => {
    state = { ...state, status: 'vault_unavailable', vaultStatus: 'intervention_required', lastError: 'vault_intervention_required' };
    subscriber();
    resumeVaultAccess.mockImplementation(async () => {
      state = { ...state, status: 'connected', vaultStatus: 'ready', lastError: null };
      subscriber();
    });

    await usePilotStore.getState().resumeVaultAccess();

    expect(resumeVaultAccess).toHaveBeenCalledTimes(1);
    expect(getAccountCatalog).toHaveBeenCalledTimes(1);
    expect(usePilotStore.getState()).toMatchObject({
      status: 'connected', vaultStatus: 'ready', accountCatalog: catalog, busy: false, reading: false,
    });
  });

  it('keeps the session verification failure across secondary reads and their busy/error updates', async () => {
    state = { ...state, vaultStatus: 'ready', status: 'vault_unavailable', sessionVerification: 'failed', lastError: 'offline' }; subscriber();
    const pending = deferred<PilotAccountCatalog>(); getAccountCatalog.mockImplementationOnce(() => pending.promise);
    const reading = usePilotStore.getState().refreshAccount();
    expect(usePilotStore.getState()).toMatchObject({ busy: true, lastError: null, sessionVerification: 'failed' });
    expect(sessionVerificationStatus(usePilotStore.getState())).toBe('retry');
    state = { ...state, lastError: null }; subscriber();
    pending.resolve(catalog); await reading;
    expect(sessionVerificationStatus(usePilotStore.getState())).toBe('retry');
    listAccessRequests.mockImplementationOnce(async () => { throw new native.PilotClientError('offline'); });
    await expect(usePilotStore.getState().refreshAccessRequests()).rejects.toThrow('offline');
    expect(sessionVerificationStatus(usePilotStore.getState())).toBe('retry');
    await usePilotStore.getState().refreshAccessRequests();
    expect(sessionVerificationStatus(usePilotStore.getState())).toBe('retry');
  });

  it.each(['unauthorized', 'session_revoked'] as const)('keeps the client session end reason %s across mount and read errors', async reason => {
    state = { ...state, account: null, deviceSession: null, status: 'signed_out', sessionEndReason: reason }; subscriber();
    await usePilotStore.getState().initialize();
    getAccountCatalog.mockImplementationOnce(async () => { throw new native.PilotClientError('unauthorized'); });
    await expect(usePilotStore.getState().refreshAccount()).rejects.toThrow('unauthorized');
    expect(usePilotStore.getState().sessionEndReason).toBe(reason);
    expect(accountConnectionStatus(usePilotStore.getState())).toBe(reason === 'unauthorized' ? 'expired' : 'revoked');
  });

  it('loads account management without an instance', async () => {
    await usePilotStore.getState().refreshAccount();
    expect(usePilotStore.getState().accountCatalog).toEqual(catalog);
    expect(usePilotStore.getState().instance).toBeNull();
  });

  it('keeps the list during revocation and refresh, removing only the confirmed session', async () => {
    const sessions: PilotAccountCatalog['sessions'] = ['one', 'other'].map(id => ({
      session_id: `session:${id}`, device_id: `device:${id}`, label: id,
      client_kind: 'desktop', state: 'active', created_at: '2026-09-01T00:00:00Z', expires_at: '2026-10-01T00:00:00Z',
    }));
    const before = { ...catalog, sessions };
    usePilotStore.setState({ accountCatalog: before });
    const pendingMutation = deferred<{ revocationConfirmed: boolean }>();
    const pendingRefresh = deferred<PilotAccountCatalog>();
    revokeSession.mockImplementation(() => pendingMutation.promise);
    getAccountCatalog.mockImplementation(() => pendingRefresh.promise);
    const mutation = usePilotStore.getState().revokeSession('session:other');
    expect(usePilotStore.getState().accountCatalog).toEqual(before);
    pendingMutation.resolve({ revocationConfirmed: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(usePilotStore.getState().accountCatalog?.sessions).toEqual([sessions[0]]);
    expect(usePilotStore.getState().busy).toBe(true);
    pendingRefresh.resolve({ ...catalog, sessions: [sessions[0]], revision: 2 });
    await expect(mutation).resolves.toBe(true);
    expect(usePilotStore.getState().accountCatalog?.revision).toBe(2);
  });

  it('keeps a session visible if revocation fails', async () => {
    const before: PilotAccountCatalog = { ...catalog, sessions: [{
      session_id: 'session:other', device_id: 'device:other', label: 'Phone', client_kind: 'mobile',
      state: 'active', created_at: '2026-09-01T00:00:00Z', expires_at: '2026-10-01T00:00:00Z',
    }] };
    usePilotStore.setState({ accountCatalog: before });
    revokeSession.mockImplementation(async () => { throw new native.PilotClientError('offline'); });
    await expect(usePilotStore.getState().revokeSession('session:other')).rejects.toThrow('offline');
    expect(usePilotStore.getState().accountCatalog).toEqual(before);
    expect(getAccountCatalog).not.toHaveBeenCalled();
  });

  it('does not reload the catalog after self-revocation', async () => {
    usePilotStore.setState({ accountCatalog: catalog });
    revokeSession.mockImplementation(signOut);
    await usePilotStore.getState().revokeSession('session:one');
    expect(usePilotStore.getState().accountCatalog).toBeNull();
    expect(getAccountCatalog).not.toHaveBeenCalled();
  });

  it('locks synchronously against duplicate mutations and existing actions', async () => {
    const pending = deferred<{ revocationConfirmed: boolean }>();
    revokeSession.mockImplementation(() => pending.promise);
    const first = usePilotStore.getState().revokeSession('session:other');
    await expect(usePilotStore.getState().revokeSession('session:other')).rejects.toThrow('conflict');
    await expect(usePilotStore.getState().connect('https://other.example.com', 'Desktop')).rejects.toThrow('conflict');
    expect(revokeSession).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    pending.resolve({ revocationConfirmed: true }); await first;
    expect(usePilotStore.getState().busy).toBe(false);
  });

  it.each(['origin', 'account', 'session'] as const)('discards account results after %s scope changes', async (field) => {
    usePilotStore.setState({ accountCatalog: catalog });
    const pending = deferred<PilotAccountCatalog>(); getAccountCatalog.mockImplementation(() => pending.promise);
    const read = usePilotStore.getState().refreshAccount();
    expect(usePilotStore.getState().accountCatalog).toEqual(catalog);
    if (field === 'origin') state = { ...state, relayOrigin: 'https://other.example.com' };
    if (field === 'account') state = { ...state, account: { ...state.account!, account_id: 'account:two' } };
    if (field === 'session') state = { ...state, deviceSession: { ...state.deviceSession!, ref: { ...state.deviceSession!.ref, session_id: 'session:two' } } };
    subscriber(); pending.resolve(catalog);
    await expect(read).rejects.toThrow('context_changed');
    expect(usePilotStore.getState().accountCatalog).toBeNull();
    expect(usePilotStore.getState().lastError).toBeNull();
  });

  it('discards pending access reads when the session changes', async () => {
    const pending = deferred<never[]>(); listAccessRequests.mockImplementation(() => pending.promise);
    const read = usePilotStore.getState().refreshAccessRequests();
    state = { ...state, deviceSession: null }; subscriber(); pending.resolve([]);
    await expect(read).rejects.toThrow('context_changed');
    expect(usePilotStore.getState().accessRequestsLoaded).toBe(false);
  });

  it('requires the confirmed identity and relay to still match before deletion', async () => {
    await usePilotStore.getState().refreshAccount();
    const identity = { account_id: 'account:one', session_id: 'session:one', login: 'example', subject: '1234' };
    await expect(usePilotStore.getState().deleteAccount(identity, 'https://other.example.com')).rejects.toThrow('context_changed');
    await expect(usePilotStore.getState().deleteAccount({ ...identity, login: 'someone-else' }, state.relayOrigin!)).rejects.toThrow('context_changed');
    expect(deleteAccount).not.toHaveBeenCalled();
    await usePilotStore.getState().deleteAccount(identity, state.relayOrigin!);
    expect(deleteAccount).toHaveBeenCalledWith(identity);
  });

  it('associates a device without a permission subset', async () => {
    await usePilotStore.getState().resolveAccess('request:one', 'grant');
    expect(resolveAccess).toHaveBeenCalledWith('request:one', 'grant');
  });

  it('clears private caches when an unconfirmed logout clears native credentials', async () => {
    await usePilotStore.getState().refreshAccount();
    expect(await usePilotStore.getState().logout()).toBe(false);
    expect(usePilotStore.getState().deviceSession).toBeNull();
    expect(usePilotStore.getState().accountCatalog).toBeNull();
    expect(usePilotStore.getState().accessRequests).toEqual([]);
  });
  it.each(['account', 'access'] as const)('lets logout cancel an %s read without releasing the logout lock on late completion', async (kind) => {
    const pendingRead = deferred<PilotAccountCatalog>();
    const pendingAccess = deferred<never[]>();
    const pendingLogout = deferred<{ revocationConfirmed: boolean }>();
    getAccountCatalog.mockImplementation(() => pendingRead.promise);
    listAccessRequests.mockImplementation(() => pendingAccess.promise);
    logout.mockImplementation(() => pendingLogout.promise);
    const reading = kind === 'account' ? usePilotStore.getState().refreshAccount() : usePilotStore.getState().refreshAccessRequests();
    expect(usePilotStore.getState().reading).toBe(true);
    const signal = kind === 'account' ? getAccountCatalog.mock.calls[0][0] : listAccessRequests.mock.calls[0][0];
    const signingOut = usePilotStore.getState().logout();
    expect(signal?.aborted).toBe(true);
    expect(usePilotStore.getState().reading).toBe(false);
    pendingRead.resolve(catalog); pendingAccess.resolve([]);
    await expect(reading).rejects.toThrow('context_changed');
    expect(usePilotStore.getState().busy).toBe(true);
    expect(usePilotStore.getState().accountCatalog).toBeNull();
    expect(usePilotStore.getState().accessRequestsLoaded).toBe(false);
    expect(usePilotStore.getState().lastError).toBeNull();
    await expect(usePilotStore.getState().logout()).rejects.toThrow('conflict');
    await expect(usePilotStore.getState().revokeSession('session:other')).rejects.toThrow('conflict');
    expect(logout).toHaveBeenCalledTimes(1);
    expect(revokeSession).not.toHaveBeenCalled();
    pendingLogout.resolve({ revocationConfirmed: true });
    await signingOut;
    expect(usePilotStore.getState().busy).toBe(false);
  });

  it('does not let a cancelled read unlock a mutation started after logout completes', async () => {
    const pendingRead = deferred<PilotAccountCatalog>();
    const pendingMutation = deferred<{ revocationConfirmed: boolean }>();
    getAccountCatalog.mockImplementation(() => pendingRead.promise);
    revokeSession.mockImplementation(() => pendingMutation.promise);
    const reading = usePilotStore.getState().refreshAccount();
    await usePilotStore.getState().logout();
    const mutation = usePilotStore.getState().revokeSession('session:other');
    pendingRead.resolve(catalog);
    await expect(reading).rejects.toThrow('context_changed');
    expect(usePilotStore.getState().busy).toBe(true);
    expect(usePilotStore.getState().lastError).toBeNull();
    await expect(usePilotStore.getState().logout()).rejects.toThrow('conflict');
    pendingMutation.resolve({ revocationConfirmed: true }); await mutation;
    expect(usePilotStore.getState().busy).toBe(false);
  });

});
