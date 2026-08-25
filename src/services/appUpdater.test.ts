import { describe, expect, mock, test } from 'bun:test';
import {
  TauriAppUpdaterClient,
  type NativeDownloadEvent,
  type NativeUpdate,
  type NativeUpdaterBindings,
} from './appUpdater';

const createFixture = () => {
  const close = mock(async () => undefined);
  const install = mock(async () => undefined);
  const download = mock(async (onEvent?: (event: NativeDownloadEvent) => void) => {
    onEvent?.({ event: 'Started', data: { contentLength: 12 } });
    onEvent?.({ event: 'Progress', data: { chunkLength: 12 } });
    onEvent?.({ event: 'Finished' });
  });
  const update: NativeUpdate = {
    currentVersion: '0.1.0',
    version: '0.2.0',
    date: '2026-08-19T10:20:30Z',
    body: '## Changes',
    close,
    install,
    download,
  };
  const check = mock(async (_options?: { timeout?: number }): Promise<NativeUpdate | null> => update);
  const relaunch = mock(async () => undefined);
  const bindings: NativeUpdaterBindings = {
    getVersion: mock(async () => '0.1.0'),
    getUpdaterTarget: mock(async () => 'windows-x86_64'),
    check,
    relaunch,
  };
  return { bindings, check, close, download, install, relaunch, update };
};

describe('TauriAppUpdaterClient', () => {
  test('maps metadata and native download progress', async () => {
    const fixture = createFixture();
    const client = new TauriAppUpdaterClient(async () => fixture.bindings);
    const events: unknown[] = [];

    await expect(client.check()).resolves.toEqual({
      currentVersion: '0.1.0',
      update: {
        currentVersion: '0.1.0',
        version: '0.2.0',
        date: '2026-08-19T10:20:30Z',
        notes: '## Changes',
      },
    });
    await client.download((event) => events.push(event));

    expect(fixture.check).toHaveBeenCalledWith({
      timeout: 30_000,
      target: 'stable-windows-x86_64',
      allowDowngrades: false,
    });
    expect(events).toEqual([
      { type: 'started', contentLength: 12 },
      { type: 'progress', chunkLength: 12 },
      { type: 'finished' },
    ]);
  });

  test('closes an obsolete update before checking again', async () => {
    const fixture = createFixture();
    const client = new TauriAppUpdaterClient(async () => fixture.bindings);

    await client.check();
    fixture.check.mockImplementationOnce(async () => null);
    await expect(client.check()).resolves.toEqual({ currentVersion: '0.1.0', update: null });

    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  test('checks the preview target without allowing downgrades', async () => {
    const fixture = createFixture();
    const client = new TauriAppUpdaterClient(
      async () => fixture.bindings,
      async () => 'preview',
    );

    await client.check();

    expect(fixture.check).toHaveBeenCalledWith({
      timeout: 30_000,
      target: 'preview-windows-x86_64',
      allowDowngrades: false,
    });
  });

  test('allows returning from a prerelease to the stable channel', async () => {
    const fixture = createFixture();
    fixture.bindings.getVersion = mock(async () => '0.2.0-nightly.20260825.12');
    const client = new TauriAppUpdaterClient(
      async () => fixture.bindings,
      async () => 'stable',
    );

    await client.check();

    expect(fixture.check).toHaveBeenCalledWith({
      timeout: 30_000,
      target: 'stable-windows-x86_64',
      allowDowngrades: true,
    });
  });

  test('installs, closes the native resource, and relaunches in order', async () => {
    const fixture = createFixture();
    const order: string[] = [];
    fixture.install.mockImplementation(async () => { order.push('install'); });
    fixture.close.mockImplementation(async () => { order.push('close'); });
    fixture.relaunch.mockImplementation(async () => { order.push('relaunch'); });
    const client = new TauriAppUpdaterClient(async () => fixture.bindings);

    await client.check();
    await client.installAndRelaunch();

    expect(order).toEqual(['install', 'close', 'relaunch']);
    await expect(client.download(() => undefined)).rejects.toThrow(
      'No update is available to download.',
    );
  });

  test('retries only the relaunch after the update was installed', async () => {
    const fixture = createFixture();
    fixture.relaunch
      .mockImplementationOnce(async () => {
        throw new Error('relaunch failed');
      })
      .mockImplementationOnce(async () => undefined);
    const client = new TauriAppUpdaterClient(async () => fixture.bindings);

    await client.check();
    await expect(client.installAndRelaunch()).rejects.toThrow('relaunch failed');
    await expect(client.installAndRelaunch()).resolves.toBeUndefined();

    expect(fixture.install).toHaveBeenCalledTimes(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.relaunch).toHaveBeenCalledTimes(2);
  });
});
