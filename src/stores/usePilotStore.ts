import { create } from 'zustand';
import {
  macroPilotNativeClient,
  PilotClientError,
  type PilotAccessRequest,
  type PilotPermission,
  type PilotPublicState,
} from '../services/macroPilot/nativeClient';

interface PilotStore extends PilotPublicState {
  busy: boolean;
  accessRequests: PilotAccessRequest[];
  initialize: () => Promise<void>;
  connect: (relayOrigin: string, deviceLabel: string) => Promise<void>;
  pollAuth: () => Promise<boolean>;
  confirmAccount: () => Promise<void>;
  createOrAttachInstance: (label: string) => Promise<void>;
  refreshAccessRequests: () => Promise<void>;
  resolveAccess: (
    accessRequestId: string,
    verdict: 'grant' | 'deny',
    permissions?: PilotPermission[],
  ) => Promise<void>;
  logout: () => Promise<boolean>;
  clearError: () => void;
}

const client = macroPilotNativeClient;

const errorCode = (error: unknown): PilotPublicState['lastError'] =>
  error instanceof PilotClientError ? error.code : 'offline';

export const usePilotStore = create<PilotStore>((set, get) => {
  const sync = () => set(client.getState());
  client.subscribe(sync);

  return {
    ...client.getState(),
    busy: false,
    accessRequests: [],

    initialize: async () => {
      set({ busy: true });
      try {
        await client.initialize();
        sync();
      } catch (error) {
        set({ lastError: errorCode(error) });
      } finally {
        set({ busy: false });
      }
    },

    connect: async (relayOrigin, deviceLabel) => {
      set({ busy: true, lastError: null });
      try {
        await client.connect(relayOrigin, deviceLabel);
        sync();
      } catch (error) {
        set({ lastError: errorCode(error) });
        throw error;
      } finally {
        set({ busy: false });
      }
    },

    pollAuth: async () => {
      set({ busy: true, lastError: null });
      try {
        const identified = await client.pollAuth();
        sync();
        return Boolean(identified);
      } catch (error) {
        set({ lastError: errorCode(error) });
        throw error;
      } finally {
        set({ busy: false });
      }
    },

    confirmAccount: async () => {
      const accountId = get().attempt?.identifiedAccount?.account_id;
      if (!accountId) return;
      set({ busy: true, lastError: null });
      try {
        await client.confirmAccount(accountId);
        sync();
      } catch (error) {
        set({ lastError: errorCode(error) });
        throw error;
      } finally {
        set({ busy: false });
      }
    },

    createOrAttachInstance: async (label) => {
      set({ busy: true, lastError: null });
      try {
        await client.createOrAttachInstance({ label });
        sync();
      } catch (error) {
        set({ lastError: errorCode(error) });
        throw error;
      } finally {
        set({ busy: false });
      }
    },

    refreshAccessRequests: async () => {
      set({ busy: true, lastError: null });
      try {
        set({ accessRequests: await client.listAccessRequests() });
      } catch (error) {
        set({ lastError: errorCode(error) });
        throw error;
      } finally {
        set({ busy: false });
      }
    },

    resolveAccess: async (accessRequestId, verdict, permissions) => {
      set({ busy: true, lastError: null });
      try {
        await client.resolveAccess(accessRequestId, verdict, permissions);
        set({ accessRequests: get().accessRequests.filter((request) => request.access_request_id !== accessRequestId) });
      } catch (error) {
        set({ lastError: errorCode(error) });
        throw error;
      } finally {
        set({ busy: false });
      }
    },

    logout: async () => {
      set({ busy: true, lastError: null });
      try {
        const result = await client.logout();
        sync();
        set({ accessRequests: [] });
        return result.revocationConfirmed;
      } finally {
        set({ busy: false });
      }
    },

    clearError: () => set({ lastError: null }),
  };
});
