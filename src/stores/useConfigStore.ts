import { createLifecycleScope, type LifecycleContext } from '../services/lifecycleScope';
import { listen, type UnlistenFn } from '../services/tauriRuntimeBridge';
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
  hydrate: (projectIds?: string[], context?: LifecycleContext) => Promise<ConfigSnapshot | null>;
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

/**
 * A snapshot depends on the project scope passed to the backend. Keep in-flight
 * requests separate so a request for project A can never satisfy project B.
 */
type HydrationResult = readonly [ConfigSnapshot, PendingSensitiveConfigChange[]];

const hydrationPromises = new Map<string, Promise<HydrationResult>>();
let hydrationGeneration = 0;
let listenerPromise: Promise<void> | null = null;
let runtime = createLifecycleScope();
let retirement: Promise<void> = Promise.resolve();

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

  hydrate: async (projectIds = get().activeProjectIds, context) => {
    const owner = runtime;
    if (!owner.isActive() || context?.isActive() === false) return null;
    const normalizedProjectIds = [...new Set(projectIds)].sort();
    if (!isConfigurationClientAvailable()) {
      set({ status: 'ready', error: null });
      return null;
    }
    const scopeKey = JSON.stringify(normalizedProjectIds);
    const generation = ++hydrationGeneration;
    set({ status: 'loading', error: null });
    let request = hydrationPromises.get(scopeKey);
    if (!request) {
      request = owner.track(Promise.all([
        configurationGetSnapshot(normalizedProjectIds),
        configurationListPendingChanges(),
      ])).finally(() => {
        if (hydrationPromises.get(scopeKey) === request) {
          hydrationPromises.delete(scopeKey);
        }
      });
      hydrationPromises.set(scopeKey, request);
    }

    return request
      .then(([snapshot, pendingChanges]) => {
        // A different scope may have become active while this request was in
        // flight. Its response must not replace the newer snapshot or pending
        // approval list.
        if (generation === hydrationGeneration && owner.isActive() && context?.isActive() !== false) {
          set({
            snapshot,
            pendingChanges,
            activeProjectIds: normalizedProjectIds,
            status: 'ready',
            error: null,
          });
        }
        return snapshot;
      })
      .catch((error: unknown) => {
        if (generation === hydrationGeneration && owner.isActive() && context?.isActive() !== false) {
          set({ status: 'error', error: errorMessage(error) });
        }
        throw error;
      });
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
    const owner = runtime;
    owner.assertActive();
    const result = await owner.track(configurationApplyPatch({
      kind,
      scope,
      expectedEtag,
      patch,
      source,
    }));
    if (!owner.isActive()) return result;
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
    const owner = runtime;
    owner.assertActive();
    const result = await owner.track(configurationResetPath({ kind, scope, path, expectedEtag }));
    if (!owner.isActive()) return result;
    await get().refresh();
    return result;
  },

  reloadDocument: async (kind, scope = { type: 'user' }) => {
    const owner = runtime;
    owner.assertActive();
    const document = await owner.track(configurationReload({ kind, scope }));
    if (!owner.isActive()) return document;
    await get().refresh();
    return document;
  },

  acceptPendingChange: async (id) => {
    const owner = runtime;
    owner.assertActive();
    const document = await owner.track(configurationAcceptPendingChange(id));
    if (!owner.isActive()) return document;
    set((state) => ({
      pendingChanges: state.pendingChanges.filter((entry) => entry.id !== id),
    }));
    await get().refresh();
    return document;
  },

  rejectPendingChange: async (id, restoreApproved) => {
    const owner = runtime;
    owner.assertActive();
    const document = await owner.track(configurationRejectPendingChange({ id, restoreApproved }));
    if (!owner.isActive()) return document;
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

/** Configuration listeners belong to the application, not to its settings view. */
export const initializeConfigRuntime = async (context?: LifecycleContext): Promise<void> => {
  context?.assertActive();
  if (!runtime.isActive()) {
    await retirement;
    context?.assertActive();
    if (!runtime.isActive()) runtime = createLifecycleScope();
  }
  const owner = runtime;
  if (!isConfigurationClientAvailable()) {
    useConfigStore.setState({ status: 'ready', error: null });
    return;
  }
  if (isTauriAvailable() && !listenerPromise) {
    const acquisition = createLifecycleScope();
    const release = owner.own(() => acquisition.stop());
    if (context) {
      context.signal.addEventListener('abort', release, { once: true });
      acquisition.own(() => context.signal.removeEventListener('abort', release));
    }
    const refresh = () => {
      if (acquisition.isActive()) void useConfigStore.getState().hydrate(undefined, acquisition).catch(() => undefined);
    };
    const registrations = [
      listen<ConfigDocument>('config://changed', refresh),
      listen<ConfigDocument>('config://invalid', refresh),
      listen<PendingSensitiveConfigChange>('config://pending-sensitive-change', (event) => {
        if (!acquisition.isActive()) return;
        useConfigStore.setState((state) => ({ pendingChanges: upsertPending(state.pendingChanges, event.payload) }));
        refresh();
      }),
      listen<ConfigDocument>('config://restart-required', refresh),
    ].map((registration) => registration.then((unlisten: UnlistenFn) => { acquisition.own(unlisten); }).catch((error) => { release(); throw error; }));
    const current = owner.track(Promise.allSettled(registrations).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') { release(); throw failure.reason; }
    }));
    listenerPromise = current;
    void current.catch(() => { if (listenerPromise === current) listenerPromise = null; });
  }
  if (listenerPromise) await listenerPromise;
  if (!owner.isActive() || context?.isActive() === false) return;
  await useConfigStore.getState().hydrate(undefined, context ?? owner);
};

export const stopConfigRuntime = (): Promise<void> => {
  const retiring = runtime;
  hydrationGeneration += 1;
  listenerPromise = null;
  hydrationPromises.clear();
  let failure: unknown;
  try { retiring.stop(); } catch (error) { failure = error; }
  retirement = Promise.all([retirement, retiring.drain()]).then(() => undefined);
  return retirement.then(() => { if (failure) throw failure; });
};

export const disposeConfigRuntimeForTests = (): void => {
  void stopConfigRuntime();
  runtime = createLifecycleScope();
};
