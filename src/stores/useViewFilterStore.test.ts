import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  loadPersistedPreference,
  PREF_KEYS,
  savePreference,
} from '../services/preferences';
import {
  DEFAULT_ARCHITECT_VIEW_FILTERS,
  DEFAULT_CHAT_VIEW_FILTERS,
  DEFAULT_IMPLEMENT_VIEW_FILTERS,
  type ArchivedViewFilter,
  type ImplementViewFilters,
  normalizeArchivedViewFilter,
  normalizeImplementViewFilters,
  resolveAvailableProjectFilter,
} from '../services/viewFilterPreferences';
import {
  useViewFilterStore,
  waitForViewFilterPersistence,
} from './useViewFilterStore';
import {
  installTauriRuntimeMock,
  removeTauriRuntimeMock,
} from '../test-utils/tauriRuntime';

const resetInMemoryStore = () => {
  useViewFilterStore.setState({
    implement: { ...DEFAULT_IMPLEMENT_VIEW_FILTERS },
    architect: { ...DEFAULT_ARCHITECT_VIEW_FILTERS },
    chat: { ...DEFAULT_CHAT_VIEW_FILTERS },
    isHydrated: false,
  });
};

describe('useViewFilterStore', () => {
  beforeEach(async () => {
    removeTauriRuntimeMock();
    await waitForViewFilterPersistence();
    await savePreference(PREF_KEYS.IMPLEMENT_VIEW_FILTERS, {
      ...DEFAULT_IMPLEMENT_VIEW_FILTERS,
    });
    await savePreference(PREF_KEYS.ARCHITECT_VIEW_FILTERS, {
      ...DEFAULT_ARCHITECT_VIEW_FILTERS,
    });
    await savePreference(PREF_KEYS.CHAT_VIEW_FILTERS, {
      ...DEFAULT_CHAT_VIEW_FILTERS,
    });
    resetInMemoryStore();
  });

  afterEach(() => {
    removeTauriRuntimeMock();
  });

  it('hydrates the durable filters after an in-memory restart', async () => {
    await savePreference(PREF_KEYS.IMPLEMENT_VIEW_FILTERS, {
      version: 1,
      projectId: 'project-2',
      status: 'blocked',
      showArchived: true,
    });
    await savePreference(PREF_KEYS.ARCHITECT_VIEW_FILTERS, {
      version: 1,
      showArchived: true,
    });
    await savePreference(PREF_KEYS.CHAT_VIEW_FILTERS, {
      version: 1,
      showArchived: true,
    });

    resetInMemoryStore();
    await useViewFilterStore.getState().hydrate();

    expect(useViewFilterStore.getState()).toMatchObject({
      implement: {
        version: 1,
        projectId: 'project-2',
        status: 'blocked',
        showArchived: true,
      },
      architect: { version: 1, showArchived: true },
      chat: { version: 1, showArchived: true },
      isHydrated: true,
    });
  });

  it('sanitizes invalid current values and safely rejects an old version', () => {
    expect(normalizeImplementViewFilters({
      version: 1,
      projectId: '',
      status: 'unknown',
      showArchived: 'yes',
    })).toEqual(DEFAULT_IMPLEMENT_VIEW_FILTERS);
    expect(normalizeImplementViewFilters({
      version: 0,
      projectId: 'project-2',
      status: 'blocked',
      showArchived: true,
    })).toEqual(DEFAULT_IMPLEMENT_VIEW_FILTERS);
    expect(normalizeArchivedViewFilter(
      { version: 0, showArchived: true },
      DEFAULT_ARCHITECT_VIEW_FILTERS,
    )).toEqual(DEFAULT_ARCHITECT_VIEW_FILTERS);
  });

  it('repairs invalid and old persisted values during hydration', async () => {
    await savePreference(PREF_KEYS.IMPLEMENT_VIEW_FILTERS, {
      version: 1,
      projectId: '',
      status: 'unknown',
      showArchived: 'yes',
    });
    await savePreference(PREF_KEYS.ARCHITECT_VIEW_FILTERS, {
      version: 0,
      showArchived: true,
    });
    await savePreference(PREF_KEYS.CHAT_VIEW_FILTERS, {
      version: 1,
      showArchived: 'yes',
    });

    resetInMemoryStore();
    await useViewFilterStore.getState().hydrate();
    await waitForViewFilterPersistence();

    expect(useViewFilterStore.getState()).toMatchObject({
      implement: DEFAULT_IMPLEMENT_VIEW_FILTERS,
      architect: DEFAULT_ARCHITECT_VIEW_FILTERS,
      chat: DEFAULT_CHAT_VIEW_FILTERS,
    });
    expect(await loadPersistedPreference<ImplementViewFilters>(PREF_KEYS.IMPLEMENT_VIEW_FILTERS))
      .toEqual(DEFAULT_IMPLEMENT_VIEW_FILTERS);
    expect(await loadPersistedPreference<ArchivedViewFilter>(PREF_KEYS.ARCHITECT_VIEW_FILTERS))
      .toEqual(DEFAULT_ARCHITECT_VIEW_FILTERS);
    expect(await loadPersistedPreference<ArchivedViewFilter>(PREF_KEYS.CHAT_VIEW_FILTERS))
      .toEqual(DEFAULT_CHAT_VIEW_FILTERS);
  });

  it('keeps a user mutation made while hydration is in flight', async () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    let resolveSnapshot!: (value: unknown) => void;
    const snapshotPromise = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    installTauriRuntimeMock(mock(async (command, payload) => {
      if (command === 'state_get_snapshot') return snapshotPromise;
      if (command === 'state_set_value') {
        writes.push({
          key: String(payload?.key),
          value: payload?.value,
        });
        return {
          schemaVersion: 1,
          values: { [String(payload?.key)]: payload?.value },
        };
      }
      return undefined;
    }));

    resetInMemoryStore();
    const hydration = useViewFilterStore.getState().hydrate();
    await Promise.resolve();
    useViewFilterStore.getState().setImplementStatusFilter('waiting');
    resolveSnapshot({
      schemaVersion: 1,
      values: {
        [PREF_KEYS.IMPLEMENT_VIEW_FILTERS]: {
          version: 1,
          projectId: 'project-2',
          status: 'blocked',
          showArchived: true,
        },
      },
    });
    await hydration;
    await waitForViewFilterPersistence();

    expect(useViewFilterStore.getState().implement).toEqual({
      version: 1,
      projectId: 'project-2',
      status: 'waiting',
      showArchived: true,
    });
    expect(writes.at(-1)).toEqual({
      key: PREF_KEYS.IMPLEMENT_VIEW_FILTERS,
      value: {
        version: 1,
        projectId: 'project-2',
        status: 'waiting',
        showArchived: true,
      },
    });
  });

  it('does not rehydrate over an in-flight persisted mutation', async () => {
    let resolveWrite!: (value: unknown) => void;
    const writePromise = new Promise((resolve) => {
      resolveWrite = resolve;
    });
    installTauriRuntimeMock(mock(async (command) => {
      if (command === 'state_set_value') return writePromise;
      if (command === 'state_get_snapshot') {
        return {
          schemaVersion: 1,
          values: {
            [PREF_KEYS.IMPLEMENT_VIEW_FILTERS]: {
              version: 1,
              projectId: 'project-2',
              status: 'blocked',
              showArchived: true,
            },
          },
        };
      }
      return undefined;
    }));
    useViewFilterStore.setState({
      implement: {
        version: 1,
        projectId: 'project-2',
        status: 'blocked',
        showArchived: true,
      },
      isHydrated: true,
    });

    useViewFilterStore.getState().setImplementStatusFilter('ready');
    await useViewFilterStore.getState().hydrate();

    expect(useViewFilterStore.getState().implement).toEqual({
      version: 1,
      projectId: 'project-2',
      status: 'ready',
      showArchived: true,
    });
    resolveWrite({
      schemaVersion: 1,
      values: {
        [PREF_KEYS.IMPLEMENT_VIEW_FILTERS]: useViewFilterStore.getState().implement,
      },
    });
    await waitForViewFilterPersistence();
  });

  it('resets a project filter that no longer exists', () => {
    expect(resolveAvailableProjectFilter('project-2', ['project-1']))
      .toBe(DEFAULT_IMPLEMENT_VIEW_FILTERS.projectId);
    expect(resolveAvailableProjectFilter('project-2', ['project-1', 'project-2']))
      .toBe('project-2');
  });

  it('persists reset values for every mode', async () => {
    useViewFilterStore.getState().setImplementProjectFilter('project-2');
    useViewFilterStore.getState().setImplementStatusFilter('waiting');
    useViewFilterStore.getState().setImplementShowArchived(true);
    useViewFilterStore.getState().setArchitectShowArchived(true);
    useViewFilterStore.getState().setChatShowArchived(true);

    useViewFilterStore.getState().resetImplementFilters();
    useViewFilterStore.getState().resetArchitectFilters();
    useViewFilterStore.getState().resetChatFilters();
    await waitForViewFilterPersistence();

    expect(await loadPersistedPreference<ImplementViewFilters>(PREF_KEYS.IMPLEMENT_VIEW_FILTERS))
      .toEqual(DEFAULT_IMPLEMENT_VIEW_FILTERS);
    expect(await loadPersistedPreference<ArchivedViewFilter>(PREF_KEYS.ARCHITECT_VIEW_FILTERS))
      .toEqual(DEFAULT_ARCHITECT_VIEW_FILTERS);
    expect(await loadPersistedPreference<ArchivedViewFilter>(PREF_KEYS.CHAT_VIEW_FILTERS))
      .toEqual(DEFAULT_CHAT_VIEW_FILTERS);
  });

  it('serializes rapid writes and leaves the latest value durable', async () => {
    useViewFilterStore.getState().setImplementStatusFilter('ready');
    useViewFilterStore.getState().setImplementStatusFilter('blocked');
    useViewFilterStore.getState().setImplementStatusFilter('in_progress');
    await waitForViewFilterPersistence();

    expect(await loadPersistedPreference<ImplementViewFilters>(PREF_KEYS.IMPLEMENT_VIEW_FILTERS))
      .toEqual({
        version: 1,
        projectId: DEFAULT_IMPLEMENT_VIEW_FILTERS.projectId,
        status: 'in_progress',
        showArchived: false,
      });
  });
});
