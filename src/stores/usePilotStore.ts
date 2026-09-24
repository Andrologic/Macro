import { create } from 'zustand';
import {
  macroPilotNativeClient,
  PilotClientError,
  type PilotAccessRequest,
  type PilotAccountCatalog,
  type PilotAccountConfirmation,
  type PilotPublicState,
} from '../services/macroPilot/nativeClient';

interface PilotStore extends PilotPublicState {
  busy: boolean;
  reading: boolean;
  accountCatalog: PilotAccountCatalog | null;
  accessRequests: PilotAccessRequest[];
  accessRequestsLoaded: boolean;
  initialize: () => Promise<void>;
  connect: (relayOrigin: string, deviceLabel: string) => Promise<void>;
  pollAuth: () => Promise<boolean>;
  confirmAccount: () => Promise<void>;
  createOrAttachInstance: (label: string) => Promise<void>;
  refreshAccount: () => Promise<void>;
  /** The UI must invoke this only from its explicit resume-access action. */
  resumeVaultAccess: () => Promise<void>;
  refreshAccessRequests: () => Promise<void>;
  resolveAccess: (accessRequestId: string, verdict: 'grant' | 'deny') => Promise<void>;
  revokeSession: (sessionId: string) => Promise<boolean>;
  revokeAllSessions: () => Promise<boolean>;
  deleteAccount: (confirmation: PilotAccountConfirmation, relayOrigin: string) => Promise<boolean>;
  logout: () => Promise<boolean>;
  clearError: () => void;
}

const client = macroPilotNativeClient;
const errorCode = (error: unknown): PilotPublicState['lastError'] =>
  error instanceof PilotClientError ? error.code : 'offline';
const scopeOf = (state: PilotPublicState) => JSON.stringify([
  state.relayOrigin, state.account?.account_id, state.deviceSession?.ref.session_id,
]);

export const usePilotStore = create<PilotStore>((set, get) => {
  let scope = scopeOf(client.getState());
  let generation = 0;
  let activeAction: { kind: 'read' | 'mutation'; controller: AbortController } | null = null;
  let instanceId = client.getState().instance?.ref.instance_id;
  const sync = () => {
    const state = client.getState();
    const nextScope = scopeOf(state);
    const changed = nextScope !== scope;
    const instanceChanged = instanceId !== state.instance?.ref.instance_id;
    if (changed) generation++;
    if ((changed || instanceChanged) && activeAction?.kind === 'read') activeAction.controller.abort();
    scope = nextScope;
    instanceId = state.instance?.ref.instance_id;
    set({ ...state, ...(changed ? { accountCatalog: null } : {}),
      ...(changed || instanceChanged ? { accessRequests: [], accessRequestsLoaded: false } : {}) });
  };
  client.subscribe(sync);

  // Logout may cancel a read, but cannot overlap any mutation.
  const action = async <T,>(
    work: (signal: AbortSignal) => Promise<T>,
    kind: 'read' | 'mutation' = 'mutation',
    preemptRead = false,
  ): Promise<T> => {
    const previous = activeAction;
    if (previous && !(preemptRead && previous.kind === 'read')) throw new PilotClientError('conflict');
    const current = { kind, controller: new AbortController() };
    activeAction = current;
    previous?.controller.abort();
    const started = generation;
    set({ busy: true, reading: kind === 'read', lastError: null });
    try { return await work(current.controller.signal); }
    catch (error) {
      if (activeAction === current && started === generation) set({ lastError: errorCode(error) });
      throw error;
    } finally {
      if (activeAction === current) {
        activeAction = null;
        set({ busy: false, reading: false });
      }
    }
  };
  const readAccount = async (signal: AbortSignal) => {
    const started = generation;
    set({ accountCatalog: null });
    const catalog = await client.getAccountCatalog(signal);
    if (signal.aborted || started !== generation) throw new PilotClientError('context_changed');
    set({ accountCatalog: catalog });
  };
  const finishMutation = async (work: () => Promise<{ revocationConfirmed: boolean }>) => {
    set({ accountCatalog: null });
    const result = await work();
    sync();
    return result.revocationConfirmed;
  };

  return {
    ...client.getState(), busy: false, reading: false, accountCatalog: null,
    accessRequests: [], accessRequestsLoaded: false,
    initialize: async () => {
      // Mounts can overlap, including React StrictMode.
      if (get().busy) return;
      await action(async () => { await client.initialize(); sync(); }, 'read').catch(() => undefined);
    },
    connect: (origin, label) => action(async () => { await client.connect(origin, label); sync(); }),
    pollAuth: () => action(async () => { const identified = await client.pollAuth(); sync(); return Boolean(identified); }),
    confirmAccount: () => action(async () => {
      const accountId = get().attempt?.identifiedAccount?.account_id;
      if (!accountId) throw new PilotClientError('context_changed');
      await client.confirmAccount(accountId); sync();
    }),
    createOrAttachInstance: (label) => action(async () => { await client.createOrAttachInstance({ label }); sync(); }),
    refreshAccount: () => action(readAccount, 'read'),
    resumeVaultAccess: () => action(async signal => {
      await client.resumeVaultAccess();
      if (signal.aborted) throw new PilotClientError('context_changed');
      sync();
      if (get().status === 'connected') await readAccount(signal);
    }, 'read'),
    refreshAccessRequests: () => action(async (signal) => {
      const started = generation;
      const target = instanceId;
      set({ accessRequests: [], accessRequestsLoaded: false });
      const accessRequests = await client.listAccessRequests(signal);
      if (signal.aborted || started !== generation || target !== instanceId) throw new PilotClientError('context_changed');
      set({ accessRequests, accessRequestsLoaded: true });
    }, 'read'),
    resolveAccess: (id, verdict) => action(async () => {
      const started = generation;
      const target = instanceId;
      await client.resolveAccess(id, verdict);
      if (started !== generation || target !== instanceId) throw new PilotClientError('context_changed');
      set({ accessRequests: get().accessRequests.filter(request => request.access_request_id !== id) });
    }),
    revokeSession: (id) => action(() => finishMutation(() => client.revokeSession(id))),
    revokeAllSessions: () => action(() => finishMutation(() => client.revokeAllSessions())),
    deleteAccount: (confirmation, origin) => action(async () => {
      const current = get();
      const identity = current.accountCatalog?.identity;
      if (origin !== current.relayOrigin || !identity
        || confirmation.account_id !== identity.account_id || confirmation.session_id !== identity.session_id
        || confirmation.login !== identity.login || confirmation.subject !== identity.subject
        || confirmation.account_id !== current.account?.account_id
        || confirmation.session_id !== current.deviceSession?.ref.session_id) {
        throw new PilotClientError('context_changed');
      }
      return finishMutation(() => client.deleteAccount(confirmation));
    }),
    logout: () => action(() => finishMutation(() => client.logout()), 'mutation', true),
    clearError: () => set({ lastError: null }),
  };
});
