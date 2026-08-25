import { describe, expect, mock, test } from 'bun:test';
import type {
  AppUpdateDownloadEvent,
  AppUpdaterClient,
} from '../services/appUpdater';
import { createAppUpdateStore } from './useAppUpdateStore';

const buildClient = (options?: {
  hasUpdate?: boolean;
  downloadError?: Error;
  installError?: Error;
}) => {
  const reset = mock(async () => undefined);
  const client: AppUpdaterClient = {
    check: mock(async () => ({
      currentVersion: '0.1.0',
      update: options?.hasUpdate === false
        ? null
        : {
            currentVersion: '0.1.0',
            version: '0.1.1',
            date: '2026-08-19T10:00:00Z',
            notes: '## Changes',
          },
    })),
    download: mock(async (onEvent: (event: AppUpdateDownloadEvent) => void) => {
      onEvent({ type: 'started', contentLength: 100 });
      onEvent({ type: 'progress', chunkLength: 40 });
      if (options?.downloadError) throw options.downloadError;
      onEvent({ type: 'progress', chunkLength: 60 });
      onEvent({ type: 'finished' });
    }),
    installAndRelaunch: mock(async () => {
      if (options?.installError) throw options.installError;
    }),
    reset,
  };
  return { client, reset };
};

describe('app update store', () => {
  test('reports an up-to-date application without downloading', async () => {
    const { client } = buildClient({ hasUpdate: false });
    const store = createAppUpdateStore(client);

    expect(await store.getState().checkForUpdates()).toBe('upToDate');
    expect(store.getState()).toMatchObject({
      phase: 'upToDate',
      currentVersion: '0.1.0',
      availableUpdate: null,
    });
    expect(client.download).not.toHaveBeenCalled();
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

  test('releases the pending updater resource after a download failure', async () => {
    const { client, reset } = buildClient({ downloadError: new Error('offline') });
    const store = createAppUpdateStore(client);

    expect(await store.getState().checkForUpdates()).toBe('error');
    expect(store.getState()).toMatchObject({ phase: 'error', error: 'offline' });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test('installs and relaunches only when an update is ready', async () => {
    const { client } = buildClient();
    const store = createAppUpdateStore(client);

    expect(await store.getState().installAndRestart()).toBe(false);
    await store.getState().checkForUpdates();
    expect(await store.getState().installAndRestart()).toBe(true);
    expect(client.installAndRelaunch).toHaveBeenCalledTimes(1);
  });

  test('keeps the error available when installation fails', async () => {
    const { client } = buildClient({ installError: new Error('signature rejected') });
    const store = createAppUpdateStore(client);
    await store.getState().checkForUpdates();

    expect(await store.getState().installAndRestart()).toBe(false);
    expect(store.getState()).toMatchObject({
      phase: 'error',
      error: 'signature rejected',
      availableUpdate: { version: '0.1.1' },
    });
  });

  test('allows retrying a failed install or relaunch operation', async () => {
    const { client } = buildClient();
    client.installAndRelaunch = mock()
      .mockImplementationOnce(async () => {
        throw new Error('relaunch failed');
      })
      .mockImplementationOnce(async () => undefined);
    const store = createAppUpdateStore(client);
    await store.getState().checkForUpdates();

    expect(await store.getState().installAndRestart()).toBe(false);
    expect(await store.getState().installAndRestart()).toBe(true);
    expect(client.installAndRelaunch).toHaveBeenCalledTimes(2);
  });
});
