import { describe, expect, mock, test } from 'bun:test';
import {
  TauriAppUpdaterClient,
  type NativeUpdaterBindings,
} from './appUpdater';
import type { NativeAppUpdateSnapshotDto } from './tauriIpc';

const snapshot = (currentVersion = '0.1.0'): NativeAppUpdateSnapshotDto => ({
  currentVersion,
  update: {
    currentVersion,
    version: '0.2.0',
    date: '2026-08-19T10:20:30Z',
    notes: '## Changes',
    target: 'stable-windows-x86_64',
    sha256: 'abc',
    packageSize: 12,
    phase: 'staged',
    activationAttempts: 0,
    error: null,
  },
});

const createFixture = (currentVersion = '0.1.0') => {
  let progressListener: ((event: {
    type: 'started' | 'progress' | 'finished';
    contentLength?: number;
    chunkLength?: number;
  }) => void) | null = null;
  const status = mock(async () => ({ currentVersion, update: null }));
  const checkAndStage = mock(async () => {
    progressListener?.({ type: 'started', contentLength: 12 });
    progressListener?.({ type: 'progress', chunkLength: 12 });
    progressListener?.({ type: 'finished' });
    return snapshot(currentVersion);
  });
  const installNow = mock(async () => undefined);
  const discard = mock(async () => undefined);
  const unlisten = mock(() => undefined);
  const bindings: NativeUpdaterBindings = {
    getUpdaterTarget: mock(async () => 'windows-x86_64'),
    status,
    checkAndStage,
    installNow,
    discard,
    listenForProgress: mock(async (listener) => {
      progressListener = listener;
      return unlisten;
    }),
  };
  return { bindings, checkAndStage, discard, installNow, status, unlisten };
};

describe('TauriAppUpdaterClient', () => {
  test('stages an update and maps native progress', async () => {
    const fixture = createFixture();
    const client = new TauriAppUpdaterClient(async () => fixture.bindings);
    const events: unknown[] = [];

    await expect(client.checkAndDownload((event) => events.push(event))).resolves.toEqual({
      currentVersion: '0.1.0',
      update: {
        currentVersion: '0.1.0',
        version: '0.2.0',
        date: '2026-08-19T10:20:30Z',
        notes: '## Changes',
        activationAttempts: 0,
        activationError: null,
      },
    });
    expect(fixture.checkAndStage).toHaveBeenCalledWith({
      target: 'stable-windows-x86_64',
      allowDowngrades: false,
    });
    expect(events).toEqual([
      { type: 'started', contentLength: 12 },
      { type: 'progress', chunkLength: 12 },
      { type: 'finished' },
    ]);
    expect(fixture.unlisten).toHaveBeenCalledTimes(1);
  });

  test('selects the preview target without allowing downgrades', async () => {
    const fixture = createFixture();
    const client = new TauriAppUpdaterClient(
      async () => fixture.bindings,
      async () => 'preview',
    );

    await client.checkAndDownload(() => undefined);
    expect(fixture.checkAndStage).toHaveBeenCalledWith({
      target: 'preview-windows-x86_64',
      allowDowngrades: false,
    });
  });

  test('allows returning from a prerelease to stable', async () => {
    const fixture = createFixture('0.2.0-nightly.20260825.12');
    const client = new TauriAppUpdaterClient(async () => fixture.bindings);

    await client.checkAndDownload(() => undefined);
    expect(fixture.checkAndStage).toHaveBeenCalledWith({
      target: 'stable-windows-x86_64',
      allowDowngrades: true,
    });
  });

  test('delegates installation and discard to the native updater', async () => {
    const fixture = createFixture();
    const client = new TauriAppUpdaterClient(async () => fixture.bindings);

    await client.installAndRelaunch();
    await client.reset();

    expect(fixture.installNow).toHaveBeenCalledTimes(1);
    expect(fixture.discard).toHaveBeenCalledTimes(1);
  });
});
