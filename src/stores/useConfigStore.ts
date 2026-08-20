import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { create } from 'zustand';
import type {
  ConfigDiagnostic,
  ConfigDocument,
  ConfigDocumentKind,
  ConfigPatchRequest,
  ConfigPatchResult,
  ConfigScope,
  ConfigSnapshot,
  JsonPatchOperation,
  PendingSensitiveConfigChange,
} from '../types/generated/config';
import {
  configurationAcceptPendingChange,
  configurationApplyPatch,
  configurationGetDocument,
  configurationGetSnapshot,
  configurationListPendingChanges,
  configurationRejectPendingChange,
  configurationReload,
  configurationResetPath,
  isConfigurationClientAvailable,
} from '../services/configurationClient';
import {
  isTauriAvailable,
} from '../services/tauriIpc';

type HydrationStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ConfigStore {
  snapshot: ConfigSnapshot | null;
  status: HydrationStatus;
  error: string | null;
  activeProjectIds: string[];
  pendingChanges: PendingSensitiveConfigChange[];
  hydrate: (projectIds?: string[]) => Promise<ConfigSnapshot | null>;
  refresh: () => Promise<ConfigSnapshot | null>;
  getDocument: (
    kind: ConfigDocumentKind,
    scope?: ConfigScope,
  ) => Promise<ConfigDocument>;
  patch: (input: {
    kind: ConfigDocumentKind;
    scope?: ConfigScope;
    expectedEtag: string;
    patch: JsonPatchOperation[];
    source?: ConfigPatchRequest['source'];
  }) => Promise<ConfigPatchResult>;
  resetPath: (input: {
    kind: ConfigDocumentKind;
    scope?: ConfigScope;
    path: string;
    expectedEtag: string;
  }) => Promise<ConfigPatchResult>;
  reloadDocument: (
    kind: ConfigDocumentKind,
    scope?: ConfigScope,
  ) => Promise<ConfigDocument>;
  acceptPendingChange: (id: string) => Promise<ConfigDocument>;
  rejectPendingChange: (
    id: string,
    restoreApproved: boolean,
  ) => Promise<ConfigDocument>;
}

let hydrationPromise: Promise<ConfigSnapshot | null> | null = null;
let listenerPromise: Promise<void> | null = null;
let eventUnlisteners: UnlistenFn[] = [];

const errorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; code?: unknown };
    if (typeof candidate.message === 'string') return candidate.message;
    if (typeof candidate.code === 'string') return candidate.code;
  }
  return 'Impossible de charger la configuration de Macro.';
};

const upsertPending = (
  current: PendingSensitiveConfigChange[],
  pending: PendingSensitiveConfigChange,
): PendingSensitiveConfigChange[] => [
  ...current.filter((entry) => entry.id !== pending.id),
  pending,
];

export const useConfigStore = create<ConfigStore>((set, get) => ({
  snapshot: null,
  status: 'idle',
  error: null,
  activeProjectIds: [],
  pendingChanges: [],

  hydrate: async (projectIds = get().activeProjectIds) => {
    const normalizedProjectIds = [...new Set(projectIds)].sort();
    set({ activeProjectIds: normalizedProjectIds });
    if (!isConfigurationClientAvailable()) {
      set({ status: 'ready', error: null });
      return null;
    }
    if (hydrationPromise) return hydrationPromise;

    set({ status: 'loading', error: null });
    hydrationPromise = Promise.all([
      configurationGetSnapshot(normalizedProjectIds),
      configurationListPendingChanges(),
    ])
      .then(([snapshot, pendingChanges]) => {
        set({ snapshot, pendingChanges, status: 'ready', error: null });
        return snapshot;
      })
      .catch((error: unknown) => {
        set({ status: 'error', error: errorMessage(error) });
        throw error;
      })
      .finally(() => {
        hydrationPromise = null;
      });
    return hydrationPromise;
  },

  refresh: () => get().hydrate(get().activeProjectIds),

  getDocument: (kind, scope = { type: 'user' }) =>
    configurationGetDocument(kind, scope),

  patch: async ({
    kind,
    scope = { type: 'user' },
    expectedEtag,
    patch,
    source = 'userInterface',
  }) => {
    const result = await configurationApplyPatch({
      kind,
      scope,
      expectedEtag,
      patch,
      source,
    });
    if (result.pendingChange) {
      set((state) => ({
        pendingChanges: upsertPending(
          state.pendingChanges,
          result.pendingChange as PendingSensitiveConfigChange,
        ),
      }));
    }
    await get().refresh();
    return result;
  },

  resetPath: async ({ kind, scope = { type: 'user' }, path, expectedEtag }) => {
    const result = await configurationResetPath({ kind, scope, path, expectedEtag });
    await get().refresh();
    return result;
  },

  reloadDocument: async (kind, scope = { type: 'user' }) => {
    const document = await configurationReload({ kind, scope });
    await get().refresh();
    return document;
  },

  acceptPendingChange: async (id) => {
    const document = await configurationAcceptPendingChange(id);
    set((state) => ({
      pendingChanges: state.pendingChanges.filter((entry) => entry.id !== id),
    }));
    await get().refresh();
    return document;
  },

  rejectPendingChange: async (id, restoreApproved) => {
    const document = await configurationRejectPendingChange({ id, restoreApproved });
    set((state) => ({
      pendingChanges: state.pendingChanges.filter((entry) => entry.id !== id),
    }));
    await get().refresh();
    return document;
  },
}));

export const selectEffectiveConfigDocument = <T = Record<string, unknown>>(
  snapshot: ConfigSnapshot | null,
  kind: ConfigDocumentKind,
): T | null => (snapshot?.effective[kind] as T | undefined) ?? null;

export const selectConfigValue = <T>(
  snapshot: ConfigSnapshot | null,
  kind: ConfigDocumentKind,
  path: readonly string[],
  fallback: T,
): T => {
  let value: unknown = snapshot?.effective[kind];
  for (const segment of path) {
    if (!value || typeof value !== 'object' || !(segment in value)) return fallback;
    value = (value as Record<string, unknown>)[segment];
  }
  return (value as T | undefined) ?? fallback;
};

export const selectConfigProvenance = (
  snapshot: ConfigSnapshot | null,
  kind: ConfigDocumentKind,
  jsonPointer: string,
) => snapshot?.provenance.find(
  (entry) => entry.jsonPointer === `/${kind}/${jsonPointer.replace(/^\//, '')}`,
) ?? null;

export const selectConfigDiagnostics = (
  snapshot: ConfigSnapshot | null,
  kind?: ConfigDocumentKind,
): ConfigDiagnostic[] => kind
  ? snapshot?.diagnostics.filter((diagnostic) => diagnostic.document === kind) ?? []
  : snapshot?.diagnostics ?? [];

export const initializeConfigRuntime = async (): Promise<void> => {
  if (!isConfigurationClientAvailable()) {
    useConfigStore.setState({ status: 'ready', error: null });
    return;
  }
  if (isTauriAvailable() && !listenerPromise) {
    listenerPromise = Promise.all([
      listen<ConfigDocument>('config://changed', () => {
        void useConfigStore.getState().refresh();
      }),
      listen<ConfigDocument>('config://invalid', () => {
        void useConfigStore.getState().refresh();
      }),
      listen<PendingSensitiveConfigChange>(
        'config://pending-sensitive-change',
        (event) => {
          useConfigStore.setState((state) => ({
            pendingChanges: upsertPending(state.pendingChanges, event.payload),
          }));
          void useConfigStore.getState().refresh();
        },
      ),
      listen<ConfigDocument>('config://restart-required', () => {
        void useConfigStore.getState().refresh();
      }),
    ]).then((unlisteners) => {
      eventUnlisteners = unlisteners;
    });
  }
  if (listenerPromise) await listenerPromise;
  await useConfigStore.getState().hydrate();
};

export const disposeConfigRuntimeForTests = (): void => {
  for (const unlisten of eventUnlisteners) unlisten();
  eventUnlisteners = [];
  listenerPromise = null;
  hydrationPromise = null;
};
