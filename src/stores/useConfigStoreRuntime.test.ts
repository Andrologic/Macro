import { afterEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';

const unlistenMock = mock(() => undefined);
const listenMock = mock(async (): Promise<() => void> => unlistenMock);
const actualTauriRuntimeBridge = await import('../services/tauriRuntimeBridge');

mock.module('../services/tauriRuntimeBridge', () => ({
  ...actualTauriRuntimeBridge,
  listen: listenMock,
}));

let importCounter = 0;

describe('configuration runtime listener initialization', () => {
  afterEach(() => {
    removeTauriRuntimeMock();
    mock.restore();
  });

  it('cleans up a partial listener registration and retries after an initial failure', async () => {
    let registration = 0;
    listenMock.mockClear();
    unlistenMock.mockClear();
    listenMock.mockImplementation(async () => {
      registration += 1;
      if (registration === 1) throw new Error('listener unavailable');
      return unlistenMock;
    });
    installTauriRuntimeMock(mock(async (command) => {
      if (command === 'config_get_snapshot') {
        return {
          schemaVersion: 1,
          effective: {},
          projectEffective: {},
          documents: [],
          provenance: [],
          diagnostics: [],
          pendingRestartPaths: [],
        };
      }
      if (command === 'config_list_pending_changes') return [];
      return undefined;
    }));
    importCounter += 1;
    const configStore = await import(`./useConfigStore.ts?listener-retry=${importCounter}`);

    await expect(configStore.initializeConfigRuntime()).rejects.toThrow('listener unavailable');
    expect(listenMock).toHaveBeenCalledTimes(4);
    expect(unlistenMock).toHaveBeenCalledTimes(3);

    await expect(configStore.initializeConfigRuntime()).resolves.toBeUndefined();
    expect(listenMock).toHaveBeenCalledTimes(8);
    expect(configStore.useConfigStore.getState().status).toBe('ready');
    configStore.disposeConfigRuntimeForTests();
  });
});

describe('configuration runtime retirement', () => {
  it('releases late listener acquisitions once and admits no hydration after stop', async () => {
    const registrations: Array<(release: () => void) => void> = [];
    const releases = Array.from({ length: 4 }, () => mock(() => undefined));
    listenMock.mockImplementation(() => new Promise((resolve) => { registrations.push(resolve); }));
    const invoke = mock(async () => undefined);
    installTauriRuntimeMock(invoke);
    const module = await import(`./useConfigStore.ts?retirement=${++importCounter}`);
    const starting = module.initializeConfigRuntime();
    const stopping = module.stopConfigRuntime();
    expect(registrations).toHaveLength(4);
    registrations.forEach((resolve, index) => resolve(releases[index]));
    await Promise.all([starting, stopping]);
    await module.stopConfigRuntime();
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    removeTauriRuntimeMock();
  });
});
