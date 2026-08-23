import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  appUpdaterClient,
  toAppUpdateErrorMessage,
  type AppUpdateMetadata,
  type AppUpdaterClient,
} from '../services/appUpdater';

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export type AppUpdateCheckOutcome = 'upToDate' | 'ready' | 'error';

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string | null;
  availableUpdate: AppUpdateMetadata | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  errorOperation: 'check' | 'download' | 'install' | null;
  detailsOpen: boolean;
  checkForUpdates: () => Promise<AppUpdateCheckOutcome>;
  installAndRestart: () => Promise<boolean>;
  openDetails: () => void;
  closeDetails: () => void;
  reset: () => Promise<void>;
}

const INITIAL_STATE = {
  phase: 'idle' as const,
  currentVersion: null,
  availableUpdate: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  errorOperation: null,
  detailsOpen: false,
};

export const createAppUpdateStore = (
  client: AppUpdaterClient,
): UseBoundStore<StoreApi<AppUpdateState>> => {
  let checkPromise: Promise<AppUpdateCheckOutcome> | null = null;
  let installPromise: Promise<boolean> | null = null;

  return create<AppUpdateState>((set, get) => ({
    ...INITIAL_STATE,

    checkForUpdates: async () => {
      if (checkPromise) return checkPromise;
      if (get().phase === 'installing') return 'error';

      checkPromise = (async () => {
        set({
          phase: 'checking',
          error: null,
          errorOperation: null,
          availableUpdate: null,
          downloadedBytes: 0,
          totalBytes: null,
        });

        try {
          const result = await client.check();
          if (!result.update) {
            set({
              phase: 'upToDate',
              currentVersion: result.currentVersion,
              availableUpdate: null,
            });
            return 'upToDate';
          }

          set({
            phase: 'downloading',
            currentVersion: result.currentVersion,
            availableUpdate: result.update,
          });

          await client.download((event) => {
            if (event.type === 'started') {
              set({ downloadedBytes: 0, totalBytes: event.contentLength });
              return;
            }
            if (event.type === 'progress') {
              set((state) => ({
                downloadedBytes: state.downloadedBytes + event.chunkLength,
              }));
            }
          });

          set((state) => ({
            phase: 'ready',
            downloadedBytes: state.totalBytes ?? state.downloadedBytes,
          }));
          return 'ready';
        } catch (error) {
          const failedOperation = get().availableUpdate ? 'download' : 'check';
          await client.reset();
          set({
            phase: 'error',
            error: toAppUpdateErrorMessage(error),
            errorOperation: failedOperation,
            availableUpdate: null,
            downloadedBytes: 0,
            totalBytes: null,
          });
          return 'error';
        } finally {
          checkPromise = null;
        }
      })();

      return checkPromise;
    },

    installAndRestart: async () => {
      if (installPromise) return installPromise;
      const state = get();
      const canRetryInstall = state.phase === 'error'
        && state.errorOperation === 'install'
        && state.availableUpdate !== null;
      if (state.phase !== 'ready' && !canRetryInstall) return false;

      installPromise = (async () => {
        set({ phase: 'installing', error: null, errorOperation: null });
        try {
          await client.installAndRelaunch();
          return true;
        } catch (error) {
          set({
            phase: 'error',
            error: toAppUpdateErrorMessage(error),
            errorOperation: 'install',
          });
          return false;
        } finally {
          installPromise = null;
        }
      })();

      return installPromise;
    },

    openDetails: () => set({ detailsOpen: true }),
    closeDetails: () => {
      if (get().phase !== 'installing') set({ detailsOpen: false });
    },
    reset: async () => {
      await client.reset();
      set(INITIAL_STATE);
    },
  }));
};

export const useAppUpdateStore = createAppUpdateStore(appUpdaterClient);
