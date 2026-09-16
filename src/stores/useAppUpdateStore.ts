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
  reset: (beforeReset?: () => Promise<void>) => Promise<void>;
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
  let resetPromise: Promise<void> | null = null;
  let resetBlocked = false;
  let stateRevision = 0;
  let upToDateTimer: ReturnType<typeof setTimeout> | null = null;

  const clearUpToDateTimer = () => {
    if (upToDateTimer) clearTimeout(upToDateTimer);
    upToDateTimer = null;
  };

  return create<AppUpdateState>((set, get) => {
    const neutralizeStagedUpdate = () => set({
      ...INITIAL_STATE,
    });

    const runReset = async (beforeReset?: () => Promise<void>) => {
      clearUpToDateTimer();
      stateRevision += 1;
      neutralizeStagedUpdate();
      if (initializePromise) await initializePromise;
      if (checkPromise) await checkPromise;
      if (installPromise) await installPromise;

      let beforeResetError: unknown = null;
      try {
        await beforeReset?.();
      } catch (error) {
        beforeResetError = error;
      }

      let cleanupError: unknown = null;
      try {
        await client.reset();
      } catch (error) {
        cleanupError = error;
      }
      set(INITIAL_STATE);
      resetBlocked = cleanupError !== null;
      if (beforeResetError !== null) throw beforeResetError;
      if (cleanupError !== null) throw cleanupError;
    };

    const startReset = (beforeReset?: () => Promise<void>) => {
      let resolveReset!: () => void;
      let rejectReset!: (error: unknown) => void;
      const currentReset = new Promise<void>((resolve, reject) => {
        resolveReset = resolve;
        rejectReset = reject;
      });
      resetPromise = currentReset;
      void runReset(beforeReset).then(
        () => {
          if (resetPromise === currentReset) resetPromise = null;
          resolveReset();
        },
        (error) => {
          if (resetPromise === currentReset) resetPromise = null;
          rejectReset(error);
        },
      );
      return currentReset;
    };

    const queueReset = (
      previousReset: Promise<void>,
      beforeReset?: () => Promise<void>,
    ) => {
      let resolveReset!: () => void;
      let rejectReset!: (error: unknown) => void;
      const queuedReset = new Promise<void>((resolve, reject) => {
        resolveReset = resolve;
        rejectReset = reject;
      });
      resetPromise = queuedReset;
      void (async () => {
        try {
          await previousReset;
        } catch {
          // A queued transition still gets its own cleanup attempt.
        }
        try {
          await runReset(beforeReset);
          resolveReset();
        } catch (error) {
          rejectReset(error);
        } finally {
          if (resetPromise === queuedReset) resetPromise = null;
        }
      })();
      return queuedReset;
    };

    return {
      ...INITIAL_STATE,

      initialize: async () => {
        if (resetPromise || resetBlocked) return;
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
        if (resetPromise || resetBlocked) return 'error';
        const revision = stateRevision;
        if (initializePromise) await initializePromise;
        if (revision !== stateRevision) return 'error';
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
              if (revision !== stateRevision) return;
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

            if (revision !== stateRevision) return 'error';

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
            if (revision !== stateRevision) return 'error';
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
            if (revision === stateRevision) set({ checkInProgress: false });
            checkPromise = null;
          }
        })();

        return checkPromise;
      },

      installAndRestart: async () => {
        if (resetPromise || resetBlocked) return false;
        if (installPromise) return installPromise;
        const state = get();
        const canRetryInstall = state.phase === 'error'
          && state.errorOperation === 'install'
          && state.availableUpdate !== null;
        if (state.phase !== 'ready' && !canRetryInstall) return false;

        const revision = stateRevision;
        installPromise = (async () => {
          if (revision === stateRevision) {
            set({ phase: 'installing', error: null, errorOperation: null });
          }
          try {
            await client.installAndRelaunch();
            return true;
          } catch (error) {
            if (revision !== stateRevision) return false;
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
      reset: async (beforeReset) => {
        if (resetPromise) return queueReset(resetPromise, beforeReset);
        return startReset(beforeReset);
      },
    };
  });
};

export const useAppUpdateStore = createAppUpdateStore(appUpdaterClient);
