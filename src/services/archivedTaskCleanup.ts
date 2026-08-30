import * as tauriIpc from './tauriIpc';
import { allocateDurableGeneration, isDurableGeneration } from './durableGeneration';

const CLEANUP_KEY = 'pendingArchivedTaskCleanups:v1';
const COMPLETED_CLEANUP_KEY = 'completedArchivedTaskCleanups:v1';
const GENERATION_COUNTER_KEY = 'archivedTaskCleanupGenerationCounters:v1';
const MAX_CAS_ATTEMPTS = 32;

export interface ArchivedTaskCleanupJournalTransport {
  isTauriAvailable: () => boolean;
  dbGetAppSetting: typeof tauriIpc.dbGetAppSetting;
  dbCompareAndSwapAppSetting: typeof tauriIpc.dbCompareAndSwapAppSetting;
}

const defaultTransport: ArchivedTaskCleanupJournalTransport = tauriIpc;

export class StaleArchivedTaskCleanupError extends Error {
  constructor() {
    super('Cette génération de nettoyage de tâche archivée n’est plus active.');
    this.name = 'StaleArchivedTaskCleanupError';
  }
}

export type ArchivedTaskCleanupTargetState = 'pending' | 'dirty' | 'failed';

export interface ArchivedTaskCleanupTarget {
  worktreeKey: string;
  repoPath: string;
  branchName: string;
  branchExisted?: boolean;
  expectedCommit?: string | null;
  expectedWorktreePath?: string | null;
  worktreePath: string | null;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  state: ArchivedTaskCleanupTargetState;
  lastError?: string;
}

export interface ArchivedTaskCleanupSaga {
  operationId: string;
  taskId: string;
  archiveToken: string | null;
  targets: ArchivedTaskCleanupTarget[];
  generation?: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

const isCleanupTarget = (value: unknown): value is ArchivedTaskCleanupTarget => {
  if (!value || typeof value !== 'object') return false;
  const target = value as Partial<ArchivedTaskCleanupTarget>;
  return typeof target.worktreeKey === 'string' &&
    typeof target.repoPath === 'string' &&
    typeof target.branchName === 'string' &&
    (target.branchExisted === undefined || typeof target.branchExisted === 'boolean') &&
    (
      target.expectedCommit === undefined ||
      typeof target.expectedCommit === 'string' ||
      target.expectedCommit === null
    ) &&
    (
      target.expectedWorktreePath === undefined ||
      typeof target.expectedWorktreePath === 'string' ||
      target.expectedWorktreePath === null
    ) &&
    (typeof target.worktreePath === 'string' || target.worktreePath === null) &&
    typeof target.worktreeRemoved === 'boolean' &&
    typeof target.branchRemoved === 'boolean' &&
    (target.state === 'pending' || target.state === 'dirty' || target.state === 'failed') &&
    (target.lastError === undefined || typeof target.lastError === 'string');
};

const parseCleanupSagas = (value: string | null | undefined): ArchivedTaskCleanupSaga[] => {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Le journal de nettoyage des tâches archivées est corrompu.");
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error("Le journal de nettoyage des tâches archivées est corrompu.");
    }
    const saga = entry as Partial<ArchivedTaskCleanupSaga>;
    if (
      typeof saga.operationId !== 'string' ||
      typeof saga.taskId !== 'string' ||
      (
        saga.archiveToken !== undefined &&
        typeof saga.archiveToken !== 'string' &&
        saga.archiveToken !== null
      ) ||
      !Array.isArray(saga.targets) ||
      !saga.targets.every(isCleanupTarget) ||
      (saga.generation !== undefined && !isDurableGeneration(saga.generation)) ||
      typeof saga.createdAt !== 'string' ||
      typeof saga.updatedAt !== 'string' ||
      (saga.lastError !== undefined && typeof saga.lastError !== 'string')
    ) {
      throw new Error("Le journal de nettoyage des tâches archivées est corrompu.");
    }
    return {
      ...saga,
      archiveToken: saga.archiveToken ?? null,
    } as ArchivedTaskCleanupSaga;
  });
};

export const loadArchivedTaskCleanupSagas = async (
  transport: ArchivedTaskCleanupJournalTransport = defaultTransport,
): Promise<ArchivedTaskCleanupSaga[]> => {
  if (!transport.isTauriAvailable()) return [];
  const setting = await transport.dbGetAppSetting(CLEANUP_KEY);
  const completed = await loadCompletedRegistry(transport);
  return parseCleanupSagas(setting?.value_json).filter((saga) => !registryCompletesSaga(completed, saga));
};

interface CompletedArchivedCleanupRegistry {
  version: 3;
  highWatermarks: Record<string, number>;
  legacyHighWatermarks: Record<string, { operationId: string; createdAt: string }>;
  legacyOperationIds: string[];
}

const emptyCompletedRegistry = (): CompletedArchivedCleanupRegistry => ({
  version: 3,
  highWatermarks: {},
  legacyHighWatermarks: {},
  legacyOperationIds: [],
});

const isLegacyCompletedWatermark = (
  value: unknown,
): value is { operationId: string; createdAt: string } => Boolean(
  value && typeof value === 'object' &&
  typeof (value as { operationId?: unknown }).operationId === 'string' &&
  typeof (value as { createdAt?: unknown }).createdAt === 'string'
);

const parseCompletedRegistry = (value: string | null | undefined): CompletedArchivedCleanupRegistry => {
  if (!value) return emptyCompletedRegistry();
  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
    return { ...emptyCompletedRegistry(), legacyOperationIds: parsed };
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Le registre des générations de nettoyage terminées est corrompu.');
  }
  const legacyRegistry = parsed as {
    version?: unknown;
    highWatermarks?: unknown;
    legacyOperationIds?: unknown;
  };
  if (
    legacyRegistry.version === 2 && legacyRegistry.highWatermarks &&
    typeof legacyRegistry.highWatermarks === 'object' &&
    Object.values(legacyRegistry.highWatermarks).every(isLegacyCompletedWatermark) &&
    Array.isArray(legacyRegistry.legacyOperationIds) &&
    legacyRegistry.legacyOperationIds.every((entry) => typeof entry === 'string')
  ) {
    return {
      ...emptyCompletedRegistry(),
      legacyHighWatermarks: legacyRegistry.highWatermarks as Record<
        string,
        { operationId: string; createdAt: string }
      >,
      legacyOperationIds: legacyRegistry.legacyOperationIds,
    };
  }
  const registry = parsed as Partial<CompletedArchivedCleanupRegistry>;
  if (
    registry.version !== 3 || !registry.highWatermarks || typeof registry.highWatermarks !== 'object' ||
    !Object.values(registry.highWatermarks).every(isDurableGeneration) ||
    !registry.legacyHighWatermarks || typeof registry.legacyHighWatermarks !== 'object' ||
    !Object.values(registry.legacyHighWatermarks).every(isLegacyCompletedWatermark) ||
    !Array.isArray(registry.legacyOperationIds) ||
    !registry.legacyOperationIds.every((entry) => typeof entry === 'string')
  ) throw new Error('Le registre des générations de nettoyage terminées est corrompu.');
  return registry as CompletedArchivedCleanupRegistry;
};

const loadCompletedRegistry = async (
  transport: ArchivedTaskCleanupJournalTransport,
): Promise<CompletedArchivedCleanupRegistry> => parseCompletedRegistry(
  (await transport.dbGetAppSetting(COMPLETED_CLEANUP_KEY))?.value_json,
);

const registryCompletesSaga = (
  registry: CompletedArchivedCleanupRegistry,
  saga: ArchivedTaskCleanupSaga,
): boolean => isDurableGeneration(saga.generation)
  ? (registry.highWatermarks[saga.taskId] ?? 0) >= saga.generation
  : registry.legacyOperationIds.includes(saga.operationId) ||
    registry.legacyHighWatermarks[saga.taskId]?.operationId === saga.operationId ||
    (registry.legacyHighWatermarks[saga.taskId]?.createdAt ?? '') >= saga.createdAt;

const updateSetting = async (
  key: string,
  mutation: (currentValue: string | null) => string,
  transport: ArchivedTaskCleanupJournalTransport,
): Promise<void> => {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const setting = await transport.dbGetAppSetting(key);
    const expectedValueJson = setting?.value_json ?? null;
    const result = await transport.dbCompareAndSwapAppSetting({
      key,
      expectedValueJson,
      valueJson: mutation(expectedValueJson),
    });
    if (result.applied) return;
  }
  throw new Error(`Conflit persistant pendant la mise à jour du réglage ${key}.`);
};

const mutateArchivedTaskCleanupSagas = async (
  mutate: (current: ArchivedTaskCleanupSaga[]) => ArchivedTaskCleanupSaga[],
  transport: ArchivedTaskCleanupJournalTransport,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const setting = await transport.dbGetAppSetting(CLEANUP_KEY);
    const currentValue = setting?.value_json ?? null;
    const nextValue = JSON.stringify(mutate(parseCleanupSagas(currentValue)));
    const result = await transport.dbCompareAndSwapAppSetting({
      key: CLEANUP_KEY,
      expectedValueJson: currentValue,
      valueJson: nextValue,
    });
    if (result.applied) return;
  }
  throw new Error('Conflit persistant pendant la mise à jour du journal de nettoyage des tâches archivées.');
};

const mergeCleanupSagaProgress = (
  current: ArchivedTaskCleanupSaga,
  incoming: ArchivedTaskCleanupSaga,
): ArchivedTaskCleanupSaga => ({
  ...incoming,
  targets: incoming.targets.map((target) => {
    const persisted = current.targets.find((candidate) => candidate.worktreeKey === target.worktreeKey);
    if (!persisted) return target;
    const worktreeRemoved = persisted.worktreeRemoved || target.worktreeRemoved;
    const branchRemoved = persisted.branchRemoved || target.branchRemoved;
    return {
      ...target,
      branchExisted: target.branchExisted ?? persisted.branchExisted,
      expectedCommit: target.expectedCommit ?? persisted.expectedCommit,
      expectedWorktreePath: target.expectedWorktreePath ?? persisted.expectedWorktreePath,
      worktreePath: target.worktreePath ?? persisted.worktreePath,
      worktreeRemoved,
      branchRemoved,
      state: worktreeRemoved && branchRemoved ? 'pending' : target.state,
      lastError: worktreeRemoved && branchRemoved ? undefined : target.lastError,
    };
  }),
});

const persistArchivedTaskCleanupSaga = async (
  saga: ArchivedTaskCleanupSaga,
  transport: ArchivedTaskCleanupJournalTransport,
  startNewGeneration: boolean,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  if (startNewGeneration && saga.generation !== undefined) {
    throw new StaleArchivedTaskCleanupError();
  }
  const completionIdentity = { ...saga };
  if (
    !startNewGeneration &&
    registryCompletesSaga(await loadCompletedRegistry(transport), completionIdentity)
  ) {
    throw new StaleArchivedTaskCleanupError();
  }
  if (!isDurableGeneration(saga.generation)) {
    saga.generation = await allocateDurableGeneration({
      settingKey: GENERATION_COUNTER_KEY,
      identityKey: saga.taskId,
      transport,
    });
  }
  const completedAfterAllocation = await loadCompletedRegistry(transport);
  if (
    (!startNewGeneration && registryCompletesSaga(completedAfterAllocation, completionIdentity)) ||
    registryCompletesSaga(completedAfterAllocation, saga)
  ) {
    throw new StaleArchivedTaskCleanupError();
  }
  await mutateArchivedTaskCleanupSagas(
    (current) => {
      const existing = current.find((entry) => entry.taskId === saga.taskId);
      if (existing && startNewGeneration) throw new StaleArchivedTaskCleanupError();
      if (existing && existing.operationId !== saga.operationId) {
        if (
          isDurableGeneration(existing.generation) &&
          existing.generation >= saga.generation!
        ) throw new StaleArchivedTaskCleanupError();
        if (!isDurableGeneration(existing.generation) && !isDurableGeneration(saga.generation) &&
          existing.createdAt >= saga.createdAt) throw new StaleArchivedTaskCleanupError();
        if (isDurableGeneration(existing.generation) && !isDurableGeneration(saga.generation)) {
          throw new StaleArchivedTaskCleanupError();
        }
        return [...current.filter((entry) => entry.taskId !== saga.taskId), saga];
      }
      const next = existing ? mergeCleanupSagaProgress(existing, saga) : saga;
      return [...current.filter((entry) => entry.taskId !== saga.taskId), next];
    },
    transport,
  );
  const completedAfterUpsert = await loadCompletedRegistry(transport);
  if (
    (!startNewGeneration && registryCompletesSaga(completedAfterUpsert, completionIdentity)) ||
    registryCompletesSaga(completedAfterUpsert, saga)
  ) {
    await mutateArchivedTaskCleanupSagas(
      (current) => current.filter((entry) => entry.operationId !== saga.operationId),
      transport,
    );
    throw new StaleArchivedTaskCleanupError();
  }
};

export const startArchivedTaskCleanupSaga = async (
  saga: ArchivedTaskCleanupSaga,
  transport: ArchivedTaskCleanupJournalTransport = defaultTransport,
): Promise<void> => persistArchivedTaskCleanupSaga(saga, transport, true);

export const upsertArchivedTaskCleanupSaga = async (
  saga: ArchivedTaskCleanupSaga,
  transport: ArchivedTaskCleanupJournalTransport = defaultTransport,
): Promise<void> => persistArchivedTaskCleanupSaga(saga, transport, false);

export const removeArchivedTaskCleanupSaga = async (
  taskId: string,
  operationId: string,
  transport: ArchivedTaskCleanupJournalTransport = defaultTransport,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  const currentSetting = await transport.dbGetAppSetting(CLEANUP_KEY);
  const completedSaga = parseCleanupSagas(currentSetting?.value_json).find(
    (entry) => entry.taskId === taskId && entry.operationId === operationId,
  );
  await updateSetting(
    COMPLETED_CLEANUP_KEY,
    (value) => {
      const registry = parseCompletedRegistry(value);
      if (!completedSaga) return JSON.stringify(registry);
      if (isDurableGeneration(completedSaga.generation)) {
        return JSON.stringify({
          ...registry,
          highWatermarks: {
            ...registry.highWatermarks,
            [taskId]: Math.max(
              registry.highWatermarks[taskId] ?? 0,
              completedSaga.generation,
            ),
          },
        });
      }
      const current = registry.legacyHighWatermarks[taskId];
      return JSON.stringify({
        ...registry,
        legacyHighWatermarks: {
          ...registry.legacyHighWatermarks,
          [taskId]: current && current.createdAt > completedSaga.createdAt
            ? current
            : { operationId, createdAt: completedSaga.createdAt },
        },
      });
    },
    transport,
  );
  await mutateArchivedTaskCleanupSagas(
    (current) => current.filter((entry) => entry.taskId !== taskId || entry.operationId !== operationId),
    transport,
  );
};

export const archivedTaskCleanupIsComplete = (
  saga: ArchivedTaskCleanupSaga,
): boolean => saga.targets.every((target) => target.worktreeRemoved && target.branchRemoved);
