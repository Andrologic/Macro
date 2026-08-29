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
  checkInProgress: boolean;
  error: string | null;
  errorOperation: 'check' | 'download' | 'install' | null;
  detailsOpen: boolean;
  initialize: () => Promise<void>;
  checkForUpdates: (options?: { explicit?: boolean }) => Promise<AppUpdateCheckOutcome>;
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
  checkInProgress: false,
  error: null,
  errorOperation: null,
  detailsOpen: false,
};

export const createAppUpdateStore = (
  client: AppUpdaterClient,
  upToDateDisplayMs = 4_000,
): UseBoundStore<StoreApi<AppUpdateState>> => {
  let initializePromise: Promise<void> | null = null;
  let checkPromise: Promise<AppUpdateCheckOutcome> | null = null;
  let installPromise: Promise<boolean> | null = null;
  let stateRevision = 0;
  let upToDateTimer: ReturnType<typeof setTimeout> | null = null;

  const clearUpToDateTimer = () => {
    if (upToDateTimer) clearTimeout(upToDateTimer);
    upToDateTimer = null;
  };

  return create<AppUpdateState>((set, get) => ({
    ...INITIAL_STATE,

    initialize: async () => {
      if (initializePromise) return initializePromise;
      const revision = stateRevision;
      initializePromise = (async () => {
        try {
          const result = await client.status();
          if (revision !== stateRevision) return;
          if (!result.update) {
            set({ currentVersion: result.currentVersion });
            return;
          }
          const activationFailed = Boolean(result.update.activationError);
          set({
            phase: activationFailed ? 'error' : 'ready',
            currentVersion: result.currentVersion,
            availableUpdate: result.update,
            downloadedBytes: 0,
            totalBytes: result.update.activationError ? null : 0,
            error: activationFailed
              ? toAppUpdateErrorMessage(result.update.activationError, 'install')
              : null,
            errorOperation: activationFailed ? 'install' : null,
          });
        } catch (error) {
          if (revision !== stateRevision) return;
          set({
            phase: 'error',
            error: toAppUpdateErrorMessage(error, 'check'),
            errorOperation: 'check',
          });
        } finally {
          initializePromise = null;
        }
      })();
      return initializePromise;
    },

    checkForUpdates: async (options) => {
      if (initializePromise) await initializePromise;
      if (checkPromise) return checkPromise;
      if (get().phase === 'installing') return 'error';
      const explicit = options?.explicit !== false;

      checkPromise = (async () => {
        clearUpToDateTimer();
        let downloadStarted = false;
        set({
          phase: explicit ? 'checking' : 'idle',
          checkInProgress: true,
          error: null,
          errorOperation: null,
          downloadedBytes: 0,
          totalBytes: null,
        });

        try {
          const result = await client.checkAndDownload((event) => {
            if (event.type === 'started') {
              downloadStarted = true;
              set({
                phase: 'downloading',
                downloadedBytes: 0,
                totalBytes: event.contentLength,
              });
            } else if (event.type === 'progress') {
              downloadStarted = true;
              set((state) => ({
                phase: 'downloading',
                downloadedBytes: state.downloadedBytes + event.chunkLength,
              }));
            }
          });

          if (!result.update) {
            set({
              phase: explicit ? 'upToDate' : 'idle',
              currentVersion: result.currentVersion,
              availableUpdate: null,
            });
            if (explicit) {
              upToDateTimer = setTimeout(() => {
                if (get().phase === 'upToDate') set({ phase: 'idle' });
                upToDateTimer = null;
              }, upToDateDisplayMs);
            }
            return 'upToDate';
          }

          set((state) => ({
            phase: result.update?.activationError ? 'error' : 'ready',
            currentVersion: result.currentVersion,
            availableUpdate: result.update,
            downloadedBytes: state.totalBytes ?? state.downloadedBytes,
            error: result.update?.activationError
              ? toAppUpdateErrorMessage(result.update.activationError, 'install')
              : null,
            errorOperation: result.update?.activationError ? 'install' : null,
          }));
          return 'ready';
        } catch (error) {
          set({
            phase: 'error',
            error: toAppUpdateErrorMessage(
              error,
              downloadStarted ? 'download' : 'check',
            ),
            errorOperation: downloadStarted ? 'download' : 'check',
            downloadedBytes: 0,
            totalBytes: null,
          });
          return 'error';
        } finally {
          set({ checkInProgress: false });
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
            error: toAppUpdateErrorMessage(error, 'install'),
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
      clearUpToDateTimer();
      stateRevision += 1;
      if (initializePromise) await initializePromise;
      if (checkPromise) await checkPromise;
      await client.reset();
      set(INITIAL_STATE);
    },
  }));
};

export const useAppUpdateStore = createAppUpdateStore(appUpdaterClient);
