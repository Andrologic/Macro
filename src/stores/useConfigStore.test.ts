import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import type { ConfigSnapshot, PendingSensitiveConfigChange } from '../types/generated/config';
import {
  disposeConfigRuntimeForTests,
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
    disposeConfigRuntimeForTests();
    useConfigStore.setState({
      snapshot: null,
      status: 'idle',
      error: null,
      activeProjectIds: [],
      pendingChanges: [],
    });
  });

  afterEach(() => {
    disposeConfigRuntimeForTests();
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

  it('deduplicates only identical project scopes', async () => {
    const calls: string[][] = [];
    const deferredByScope = new Map<string, (value: ConfigSnapshot) => void>();
    const invoke = installTauriRuntimeMock(mock(async (command, payload) => {
      if (command === 'config_list_pending_changes') return [];
      if (command !== 'config_get_snapshot') return undefined;
      const projectIds = (payload?.projectIds as string[] | undefined) ?? [];
      const key = JSON.stringify(projectIds);
      calls.push(projectIds);
      return new Promise<ConfigSnapshot>((resolve) => {
        deferredByScope.set(key, resolve);
      });
    }));

    const firstA = useConfigStore.getState().hydrate(['project-a']);
    const secondA = useConfigStore.getState().hydrate(['project-a']);
    const requestB = useConfigStore.getState().hydrate(['project-b']);

    expect(calls).toEqual([['project-a'], ['project-b']]);
    expect(invoke).toHaveBeenCalledTimes(4);

    deferredByScope.get('["project-a"]')?.(snapshot);
    deferredByScope.get('["project-b"]')?.({
      ...snapshot,
      effective: { settings: { appearance: { theme: 'dark' } } },
    });

    await expect(firstA).resolves.toEqual(snapshot);
    await expect(secondA).resolves.toEqual(snapshot);
    await expect(requestB).resolves.toMatchObject({
      effective: { settings: { appearance: { theme: 'dark' } } },
    });
  });

  it('keeps the latest project scope when an older hydration resolves or fails later', async () => {
    let resolveA!: (value: ConfigSnapshot) => void;
    let rejectA!: (error: Error) => void;
    let resolveB!: (value: ConfigSnapshot) => void;
    const invoke = installTauriRuntimeMock(mock(async (command, payload) => {
      if (command === 'config_list_pending_changes') return [];
      if (command !== 'config_get_snapshot') return undefined;
      const projectId = (payload?.projectIds as string[] | undefined)?.[0];
      if (projectId === 'project-a') {
        return new Promise<ConfigSnapshot>((resolve, reject) => {
          resolveA = resolve;
          rejectA = reject;
        });
      }
      return new Promise<ConfigSnapshot>((resolve) => {
        resolveB = resolve;
      });
    }));

    const requestA = useConfigStore.getState().hydrate(['project-a']);
    const requestB = useConfigStore.getState().hydrate(['project-b']);
    expect(invoke).toHaveBeenCalledTimes(4);

    const snapshotB: ConfigSnapshot = {
      ...snapshot,
      effective: { settings: { appearance: { theme: 'project-b' } } },
    };
    resolveB(snapshotB);
    await expect(requestB).resolves.toEqual(snapshotB);

    resolveA(snapshot);
    await expect(requestA).resolves.toEqual(snapshot);
    expect(useConfigStore.getState()).toMatchObject({
      snapshot: snapshotB,
      activeProjectIds: ['project-b'],
      status: 'ready',
      error: null,
      pendingChanges: [],
    });

    const failedA = useConfigStore.getState().hydrate(['project-a']);
    const requestBAgain = useConfigStore.getState().hydrate(['project-b']);
    resolveB(snapshotB);
    await expect(requestBAgain).resolves.toEqual(snapshotB);
    rejectA(new Error('obsolete request'));
    await expect(failedA).rejects.toThrow('obsolete request');
    expect(useConfigStore.getState()).toMatchObject({
      snapshot: snapshotB,
      activeProjectIds: ['project-b'],
      status: 'ready',
      error: null,
    });
  });

  it('can make an already in-flight scope active again', async () => {
    const resolvers = new Map<string, (value: ConfigSnapshot) => void>();
    installTauriRuntimeMock(mock(async (command, payload) => {
      if (command === 'config_list_pending_changes') return [];
      if (command !== 'config_get_snapshot') return undefined;
      const projectId = (payload?.projectIds as string[] | undefined)?.[0] ?? 'none';
      return new Promise<ConfigSnapshot>((resolve) => {
        resolvers.set(projectId, resolve);
      });
    }));

    const firstA = useConfigStore.getState().hydrate(['project-a']);
    const requestB = useConfigStore.getState().hydrate(['project-b']);
    const latestA = useConfigStore.getState().hydrate(['project-a']);

    const snapshotA = {
      ...snapshot,
      effective: { settings: { appearance: { theme: 'project-a' } } },
    };
    const snapshotB = {
      ...snapshot,
      effective: { settings: { appearance: { theme: 'project-b' } } },
    };
    resolvers.get('project-b')?.(snapshotB);
    await requestB;
    resolvers.get('project-a')?.(snapshotA);
    await Promise.all([firstA, latestA]);

    expect(useConfigStore.getState()).toMatchObject({
      snapshot: snapshotA,
      activeProjectIds: ['project-a'],
      status: 'ready',
      error: null,
    });
  });

  it('keeps pending approvals paired with the accepted hydration scope', async () => {
    const snapshotResolvers = new Map<string, (value: ConfigSnapshot) => void>();
    const pendingResolvers: Array<(value: PendingSensitiveConfigChange[]) => void> = [];
    installTauriRuntimeMock(mock(async (command, payload) => {
      if (command === 'config_get_snapshot') {
        const projectId = (payload?.projectIds as string[] | undefined)?.[0] ?? 'none';
        return new Promise<ConfigSnapshot>((resolve) => {
          snapshotResolvers.set(projectId, resolve);
        });
      }
      if (command === 'config_list_pending_changes') {
        return new Promise<PendingSensitiveConfigChange[]>((resolve) => {
          pendingResolvers.push(resolve);
        });
      }
      return undefined;
    }));
    const pendingA: PendingSensitiveConfigChange = {
      id: 'pending-a',
      document: 'tools',
      scope: { type: 'project', projectId: 'project-a' },
      source: 'externalEditor',
      changedPaths: ['/mcpServers/a'],
      reasons: ['server'],
      proposedDocument: {},
      proposedEtag: 'a',
      createdAt: '2026-08-20T12:00:00Z',
    };
    const pendingB = { ...pendingA, id: 'pending-b', scope: {
      type: 'project' as const,
      projectId: 'project-b',
    } };

    const requestA = useConfigStore.getState().hydrate(['project-a']);
    const requestB = useConfigStore.getState().hydrate(['project-b']);
    snapshotResolvers.get('project-b')?.(snapshot);
    pendingResolvers[1]?.([pendingB]);
    await expect(requestB).resolves.toEqual(snapshot);

    snapshotResolvers.get('project-a')?.({
      ...snapshot,
      effective: { settings: { appearance: { theme: 'light' } } },
    });
    pendingResolvers[0]?.([pendingA]);
    await requestA;

    expect(useConfigStore.getState()).toMatchObject({
      activeProjectIds: ['project-b'],
      pendingChanges: [pendingB],
    });
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
