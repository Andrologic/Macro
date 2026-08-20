import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import type { ConfigSnapshot } from '../types/generated/config';
import {
  selectConfigProvenance,
  selectConfigValue,
  useConfigStore,
} from './useConfigStore';

const snapshot: ConfigSnapshot = {
  schemaVersion: 1,
  effective: {
    settings: { appearance: { theme: 'light' } },
  },
  projectEffective: {},
  documents: [],
  provenance: [{
    jsonPointer: '/settings/appearance/theme',
    origin: 'user',
    projectId: null,
  }],
  diagnostics: [],
  pendingRestartPaths: [],
};

describe('useConfigStore', () => {
  beforeEach(() => {
    useConfigStore.setState({
      snapshot: null,
      status: 'idle',
      error: null,
      activeProjectIds: [],
      pendingChanges: [],
    });
  });

  afterEach(() => {
    removeTauriRuntimeMock();
  });

  it('deduplicates concurrent hydration requests', async () => {
    let resolveSnapshot!: (value: ConfigSnapshot) => void;
    const pending = new Promise<ConfigSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const invoke = installTauriRuntimeMock(mock(async (command) => {
      if (command === 'config_get_snapshot') return pending;
      if (command === 'config_list_pending_changes') return [];
      return undefined;
    }));

    const first = useConfigStore.getState().hydrate();
    const second = useConfigStore.getState().hydrate();
    expect(invoke).toHaveBeenCalledTimes(2);
    resolveSnapshot(snapshot);

    expect(await first).toEqual(snapshot);
    expect(await second).toEqual(snapshot);
    expect(useConfigStore.getState().status).toBe('ready');
  });

  it('selects effective values and their provenance without copying inheritance', () => {
    expect(selectConfigValue(snapshot, 'settings', ['appearance', 'theme'], 'dark')).toBe(
      'light',
    );
    expect(selectConfigValue(snapshot, 'settings', ['appearance', 'zoomLevel'], 1)).toBe(1);
    expect(
      selectConfigProvenance(snapshot, 'settings', '/appearance/theme'),
    ).toEqual(snapshot.provenance[0]);
  });
});
