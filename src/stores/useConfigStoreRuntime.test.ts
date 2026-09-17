import { afterEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';

const unlistenMock = mock(() => undefined);
const listenMock = mock(async () => unlistenMock);
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
