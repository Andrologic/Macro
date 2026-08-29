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
    const checkFinished = new Promise<void>((resolve) => { finishCheck = resolve; });
    const calls: string[] = [];
    const client: AppUpdaterClient = {
      status: mock(async () => ({ currentVersion: '0.1.0', update: null })),
      checkAndDownload: mock(async () => {
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
    expect(store.getState().checkInProgress).toBe(true);
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
});
