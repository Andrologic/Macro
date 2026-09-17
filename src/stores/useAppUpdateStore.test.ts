import { describe, expect, mock, test } from 'bun:test';
import type {
  AppUpdateDownloadEvent,
  AppUpdaterClient,
} from '../services/appUpdater';
import { createAppUpdateStore } from './useAppUpdateStore';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const update = {
  currentVersion: '0.1.0',
  version: '0.1.1',
  date: '2026-08-19T10:00:00Z',
  notes: '## Changes',
  activationAttempts: 0,
  activationError: null,
};

const buildClient = (options?: {
  hasUpdate?: boolean;
  downloadError?: Error;
  installError?: Error;
  stagedError?: string;
}) => {
  const reset = mock(async () => undefined);
  const status = mock(async () => ({
    currentVersion: '0.1.0',
    update: options?.stagedError
      ? { ...update, activationError: options.stagedError }
      : null,
  }));
  const checkAndDownload = mock(async (
    onEvent: (event: AppUpdateDownloadEvent) => void,
  ) => {
    if (options?.hasUpdate === false) {
      return { currentVersion: '0.1.0', update: null };
    }
    onEvent({ type: 'started', contentLength: 100 });
    onEvent({ type: 'progress', chunkLength: 40 });
    if (options?.downloadError) throw options.downloadError;
    onEvent({ type: 'progress', chunkLength: 60 });
    onEvent({ type: 'finished' });
    return { currentVersion: '0.1.0', update };
  });
  const client: AppUpdaterClient = {
    status,
    checkAndDownload,
    installAndRelaunch: mock(async () => {
      if (options?.installError) throw options.installError;
    }),
    reset,
  };
  return { checkAndDownload, client, reset, status };
};

describe('app update store', () => {
  test('shows an up-to-date result only for an explicit check', async () => {
    const { client } = buildClient({ hasUpdate: false });
    const store = createAppUpdateStore(client, 5);

    expect(await store.getState().checkForUpdates()).toBe('upToDate');
    expect(store.getState().phase).toBe('upToDate');
    await delay(10);
    expect(store.getState().phase).toBe('idle');

    expect(await store.getState().checkForUpdates({ explicit: false })).toBe('upToDate');
    expect(store.getState().phase).toBe('idle');
  });

  test('waits for an in-flight check before discarding its staged result', async () => {
    let finishCheck!: () => void;
    let emitEvent!: (event: AppUpdateDownloadEvent) => void;
    const checkFinished = new Promise<void>((resolve) => { finishCheck = resolve; });
    const calls: string[] = [];
    const client: AppUpdaterClient = {
      status: mock(async () => ({ currentVersion: '0.1.0', update: null })),
      checkAndDownload: mock(async (onEvent: (event: AppUpdateDownloadEvent) => void) => {
        emitEvent = onEvent;
        calls.push('check');
        await checkFinished;
        calls.push('staged');
        return { currentVersion: '0.1.0', update };
      }),
      installAndRelaunch: mock(async () => undefined),
      reset: mock(async () => { calls.push('discard'); }),
    };
    const store = createAppUpdateStore(client);

    const checking = store.getState().checkForUpdates({ explicit: false });
    const resetting = store.getState().reset();
    expect(store.getState()).toMatchObject({
      phase: 'idle',
      availableUpdate: null,
      checkInProgress: false,
    });
    emitEvent({ type: 'started', contentLength: 100 });
    emitEvent({ type: 'progress', chunkLength: 100 });
    expect(store.getState()).toMatchObject({
      phase: 'idle',
      availableUpdate: null,
      downloadedBytes: 0,
    });
    finishCheck();
    await Promise.all([checking, resetting]);

    expect(calls).toEqual(['check', 'staged', 'discard']);
    expect(store.getState().phase).toBe('idle');
  });

  test('invalidates an in-flight initialization before resetting the channel', async () => {
    let finishStatus!: (value: { currentVersion: string; update: typeof update }) => void;
    const statusResult = new Promise<{ currentVersion: string; update: typeof update }>((resolve) => {
      finishStatus = resolve;
    });
    const reset = mock(async () => undefined);
    const client: AppUpdaterClient = {
      status: mock(() => statusResult),
      checkAndDownload: mock(async () => ({ currentVersion: '0.1.0', update: null })),
      installAndRelaunch: mock(async () => undefined),
      reset,
    };
    const store = createAppUpdateStore(client);

    const initializing = store.getState().initialize();
    const resetting = store.getState().reset();
    finishStatus({ currentVersion: '0.1.0', update });
    await Promise.all([initializing, resetting]);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      phase: 'idle',
      availableUpdate: null,
      currentVersion: null,
    });
  });

  test('downloads an available update and records progress', async () => {
    const { client } = buildClient();
    const store = createAppUpdateStore(client);

    expect(await store.getState().checkForUpdates()).toBe('ready');
    expect(store.getState()).toMatchObject({
      phase: 'ready',
      currentVersion: '0.1.0',
      downloadedBytes: 100,
      totalBytes: 100,
      availableUpdate: { version: '0.1.1' },
    });
  });

  test('classifies a failure after progress as a download error', async () => {
    const { client } = buildClient({ downloadError: new Error('offline') });
    const store = createAppUpdateStore(client);

    expect(await store.getState().checkForUpdates()).toBe('error');
    expect(store.getState()).toMatchObject({
      phase: 'error',
      error: 'The update could not be downloaded',
      errorOperation: 'download',
    });
  });

  test('restores a staged installation error from native state', async () => {
    const { client } = buildClient({ stagedError: 'installation failed' });
    const store = createAppUpdateStore(client);

    await store.getState().initialize();
    expect(store.getState()).toMatchObject({
      phase: 'error',
      errorOperation: 'install',
      error: 'The update could not be installed',
      availableUpdate: { version: '0.1.1' },
    });
  });

  test('installs only when an update is ready', async () => {
    const { client } = buildClient();
    const store = createAppUpdateStore(client);

    expect(await store.getState().installAndRestart()).toBe(false);
    await store.getState().checkForUpdates();
    expect(await store.getState().installAndRestart()).toBe(true);
    expect(client.installAndRelaunch).toHaveBeenCalledTimes(1);
  });

  test('keeps the staged update when installation fails and permits retry', async () => {
    const { client } = buildClient({ installError: new Error('installer rejected') });
    const store = createAppUpdateStore(client);
    await store.getState().checkForUpdates();

    expect(await store.getState().installAndRestart()).toBe(false);
    expect(store.getState()).toMatchObject({
      phase: 'error',
      error: 'The update could not be installed',
      availableUpdate: { version: '0.1.1' },
    });
  });
  test('releases installing state when the native cache has disappeared and permits redownload', async () => {
    const { client } = buildClient({ installError: new Error('UPDATE_STAGED_PACKAGE_MISSING') });
    const store = createAppUpdateStore(client);
    await store.getState().checkForUpdates();
    store.getState().openDetails();
    expect(await store.getState().installAndRestart()).toBe(false);
    expect(store.getState().phase).toBe('error');
    store.getState().closeDetails();
    expect(store.getState().detailsOpen).toBe(false);
    await store.getState().reset();
    expect(await store.getState().checkForUpdates()).toBe('ready');
  });

  test('clears a staged update when resetting the native cache fails', async () => {
    const resetError = new Error('cache reset denied');
    const { client, reset } = buildClient();
    reset.mockRejectedValueOnce(resetError);
    const store = createAppUpdateStore(client);
    await store.getState().checkForUpdates();

    await expect(store.getState().reset()).rejects.toBe(resetError);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      phase: 'idle',
      availableUpdate: null,
      downloadedBytes: 0,
      totalBytes: null,
    });
    expect(await store.getState().installAndRestart()).toBe(false);
  });

  test('blocks concurrent checks and installs while reset is pending', async () => {
    let rejectReset!: (error: Error) => void;
    const resetError = new Error('cache reset denied');
    const { client, checkAndDownload, reset } = buildClient();
    reset.mockImplementationOnce((): Promise<undefined> => new Promise<undefined>((_, reject) => {
      rejectReset = reject;
    }));
    const store = createAppUpdateStore(client);
    await store.getState().checkForUpdates();

    const resetting = store.getState().reset();
    const checking = store.getState().checkForUpdates();
    const installing = store.getState().installAndRestart();

    expect(checkAndDownload).toHaveBeenCalledTimes(1);
    expect(store.getState().phase).toBe('idle');
    await Promise.resolve();
    rejectReset(resetError);

    await expect(resetting).rejects.toBe(resetError);
    expect(await checking).toBe('error');
    expect(await installing).toBe(false);
    expect(checkAndDownload).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      phase: 'idle',
      availableUpdate: null,
    });
  });

  test('queues a channel save callback behind an in-flight reset', async () => {
    let finishReset!: () => void;
    const calls: string[] = [];
    const { client, reset } = buildClient();
    reset.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishReset = () => {
        calls.push('first reset');
        resolve(undefined);
      };
    }));
    const store = createAppUpdateStore(client);

    const firstReset = store.getState().reset();
    let callbackFinished = false;
    const queuedReset = store.getState().reset(async () => {
      calls.push('save');
      callbackFinished = true;
    });

    await Promise.resolve();
    expect(callbackFinished).toBe(false);
    finishReset();
    await firstReset;
    await queuedReset;

    expect(callbackFinished).toBe(true);
    expect(calls).toEqual(['first reset', 'save']);
    expect(reset).toHaveBeenCalledTimes(2);
  });

  test('rejects a check while a queued reset transition is still running', async () => {
    let finishReset!: () => void;
    const { client, reset, checkAndDownload } = buildClient();
    reset.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishReset = () => resolve(undefined);
    }));
    const store = createAppUpdateStore(client);

    const firstReset = store.getState().reset();
    const queuedReset = store.getState().reset(async () => undefined);
    const check = store.getState().checkForUpdates();

    expect(await check).toBe('error');
    expect(checkAndDownload).not.toHaveBeenCalled();
    finishReset();
    await firstReset;
    await queuedReset;
  });

  test('ignores late downloads throughout channel persistence and failed cleanup', async () => {
    const { client, status, reset } = buildClient();
    let finishDownload!: (value: { currentVersion: string; update: typeof update }) => void;
    let emit!: (event: AppUpdateDownloadEvent) => void;
    client.checkAndDownload = (onEvent) => {
      emit = onEvent;
      return new Promise((resolve) => { finishDownload = resolve; });
    };
    let finishSave!: () => void;
    const save = mock(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    reset.mockRejectedValueOnce(new Error('cleanup failed'));
    const store = createAppUpdateStore(client);
    const checking = store.getState().checkForUpdates();
    const resetting = store.getState().reset(save);
    const rejected = resetting.catch((error: unknown) => error);
    emit({ type: 'started', contentLength: 100 });
    finishDownload({ currentVersion: '0.1.0', update });
    expect(await checking).toBe('error');
    await Promise.resolve();
    expect(store.getState().availableUpdate).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    expect(await store.getState().installAndRestart()).toBe(false);
    expect(await store.getState().checkForUpdates()).toBe('error');
    finishSave();
    expect(await rejected).toEqual(new Error('cleanup failed'));
    await store.getState().initialize();
    expect(status).not.toHaveBeenCalled();
    expect(store.getState().availableUpdate).toBeNull();
    await store.getState().reset();
    await store.getState().initialize();
    expect(status).toHaveBeenCalledTimes(1);
  });

});
