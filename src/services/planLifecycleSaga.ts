import * as tauriIpc from './tauriIpc';
import { toPlanLocatorKey } from './durableIdentity';

const SAGA_KEY = 'pendingPlanLifecycles:v1';
const SAGA_QUARANTINE_KEY = 'pendingPlanLifecyclesQuarantine:v1';
const COMPLETED_SAGA_KEY = 'completedPlanLifecycles:v1';
const MAX_CAS_ATTEMPTS = 32;

export interface PlanLifecycleSagaTransport {
  isTauriAvailable: () => boolean;
  dbGetAppSetting: typeof tauriIpc.dbGetAppSetting;
  dbCompareAndSwapAppSetting: typeof tauriIpc.dbCompareAndSwapAppSetting;
}

const defaultTransport: PlanLifecycleSagaTransport = tauriIpc;

export class StalePlanLifecycleSagaError extends Error {
  constructor() {
    super('Cette génération du cycle de vie du plan n’est plus active.');
    this.name = 'StalePlanLifecycleSagaError';
  }
}

export type PlanLifecycleOperation = 'archive' | 'delete' | 'finalize';
export type PlanLifecyclePhase = 'prepared' | 'git_merges_complete' | 'metadata_written' | 'git_cleanup_complete' | 'metadata_commit_pending' | 'metadata_committed' | 'metadata_deleted';

export type PlanFinalizationRepositoryPhase =
  | 'prepared'
  | 'base_synced'
  | 'plan_merged'
  | 'backmerge_synced'
  | 'complete';

export interface PlanFinalizationRepositoryCheckpoint {
  projectId: string;
  repoPath: string;
  planBranchName: string;
  baseBranchName: string;
  backmergeBranchName: string | null;
  expectedPlanCommit: string;
  expectedBaseCommit: string;
  expectedBackmergeCommit: string | null;
  phase: PlanFinalizationRepositoryPhase;
  mergeRequired?: boolean;
  baseCommitAfterSync?: string;
  baseCommitAfterMerge?: string;
  backmergeCommitAfterSync?: string;
  backmergeCommitAfterMerge?: string;
  mergeOutput?: string;
  backmergeOutput?: string;
}

export interface PlanLifecycleCleanupResource {
  kind: 'branch' | 'worktree';
  projectId: string;
  repoPath: string;
  branchName: string;
  expectedCommit: string | null;
  worktreeKey?: string;
  expectedWorktreePath?: string;
}

export interface PlanLifecycleSaga {
  planId: string;
  branchName: string;
  operation: PlanLifecycleOperation;
  phase: PlanLifecyclePhase;
  conversationId?: string | null;
  requiresMetadataCommit?: boolean;
  cleanupResources?: PlanLifecycleCleanupResource[];
  finalizationRepositories?: PlanFinalizationRepositoryCheckpoint[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export const getPlanLifecycleSagaKey = (
  saga: Pick<PlanLifecycleSaga, 'branchName' | 'planId' | 'operation'>,
): string => `${toPlanLocatorKey(saga)}:${saga.operation}`;

export const getPlanLifecycleSagaGeneration = (
  saga: Pick<PlanLifecycleSaga, 'branchName' | 'planId' | 'operation' | 'createdAt'>,
): string => `${getPlanLifecycleSagaKey(saga)}:${saga.createdAt}`;

export class PlanLifecycleSagaCorruptionError extends Error {
  constructor() {
    super('Le journal du cycle de vie des plans est corrompu. La reprise est bloquée afin de préserver les métadonnées et les ressources Git.');
    this.name = 'PlanLifecycleSagaCorruptionError';
  }
}

export interface PlanLifecycleSagaQuarantineEntry {
  entry: unknown;
  reason: string;
  quarantinedAt: string;
}

export interface PlanLifecycleSagaJournal {
  sagas: PlanLifecycleSaga[];
  quarantined: PlanLifecycleSagaQuarantineEntry[];
}

const isCleanupResource = (value: unknown): value is PlanLifecycleCleanupResource => {
  if (!value || typeof value !== 'object') return false;
  const resource = value as Partial<PlanLifecycleCleanupResource>;
  return (resource.kind === 'branch' || resource.kind === 'worktree') &&
    typeof resource.projectId === 'string' &&
    typeof resource.repoPath === 'string' &&
    typeof resource.branchName === 'string' &&
    (typeof resource.expectedCommit === 'string' || resource.expectedCommit === null) &&
    (resource.worktreeKey === undefined || typeof resource.worktreeKey === 'string') &&
    (resource.expectedWorktreePath === undefined || typeof resource.expectedWorktreePath === 'string');
};

const isFinalizationRepository = (
  value: unknown,
): value is PlanFinalizationRepositoryCheckpoint => {
  if (!value || typeof value !== 'object') return false;
  const repository = value as Partial<PlanFinalizationRepositoryCheckpoint>;
  const validPhase = repository.phase === 'prepared' || repository.phase === 'base_synced' ||
    repository.phase === 'plan_merged' || repository.phase === 'backmerge_synced' ||
    repository.phase === 'complete';
  const validOptionalString = (candidate: unknown): boolean =>
    candidate === undefined || typeof candidate === 'string';
  if (
    typeof repository.projectId !== 'string' || typeof repository.repoPath !== 'string' ||
    typeof repository.planBranchName !== 'string' || typeof repository.baseBranchName !== 'string' ||
    (typeof repository.backmergeBranchName !== 'string' && repository.backmergeBranchName !== null) ||
    typeof repository.expectedPlanCommit !== 'string' ||
    typeof repository.expectedBaseCommit !== 'string' ||
    (typeof repository.expectedBackmergeCommit !== 'string' && repository.expectedBackmergeCommit !== null) ||
    !validPhase ||
    (repository.mergeRequired !== undefined && typeof repository.mergeRequired !== 'boolean') ||
    !validOptionalString(repository.baseCommitAfterSync) ||
    !validOptionalString(repository.baseCommitAfterMerge) ||
    !validOptionalString(repository.backmergeCommitAfterSync) ||
    !validOptionalString(repository.backmergeCommitAfterMerge) ||
    !validOptionalString(repository.mergeOutput) ||
    !validOptionalString(repository.backmergeOutput)
  ) return false;
  if (repository.phase !== 'prepared' && typeof repository.baseCommitAfterSync !== 'string') {
    return false;
  }
  if (
    (repository.phase === 'plan_merged' || repository.phase === 'backmerge_synced' || repository.phase === 'complete') &&
    (typeof repository.mergeRequired !== 'boolean' || typeof repository.baseCommitAfterMerge !== 'string')
  ) return false;
  if (repository.phase === 'backmerge_synced' && (
    !repository.backmergeBranchName ||
    typeof repository.backmergeCommitAfterSync !== 'string'
  )) return false;
  if (repository.phase === 'complete' && repository.backmergeBranchName &&
    typeof repository.backmergeCommitAfterMerge !== 'string') return false;
  return true;
};

const parseSagaEntry = (entry: unknown): PlanLifecycleSaga => {
  const saga = entry as Partial<PlanLifecycleSaga>;
  const allowedPhases: Record<PlanLifecycleOperation, readonly PlanLifecyclePhase[]> = {
    archive: ['prepared', 'metadata_written', 'git_cleanup_complete', 'metadata_commit_pending', 'metadata_committed'],
    delete: ['prepared', 'git_cleanup_complete', 'metadata_deleted'],
    finalize: ['prepared', 'git_merges_complete', 'metadata_written'],
  };
  if (
    !saga || typeof saga.planId !== 'string' || typeof saga.branchName !== 'string' ||
    (saga.operation !== 'archive' && saga.operation !== 'delete' && saga.operation !== 'finalize') ||
    !allowedPhases[saga.operation as PlanLifecycleOperation]?.includes(saga.phase as PlanLifecyclePhase) ||
    typeof saga.createdAt !== 'string' || typeof saga.updatedAt !== 'string'
  ) throw new PlanLifecycleSagaCorruptionError();
  if (saga.requiresMetadataCommit !== undefined && (saga.operation !== 'archive' || typeof saga.requiresMetadataCommit !== 'boolean')) {
    throw new PlanLifecycleSagaCorruptionError();
  }
  if (saga.cleanupResources !== undefined && (
    !Array.isArray(saga.cleanupResources) || !saga.cleanupResources.every(isCleanupResource)
  )) throw new PlanLifecycleSagaCorruptionError();
  if (
    saga.operation === 'finalize' && (
      !Array.isArray(saga.finalizationRepositories) ||
      !saga.finalizationRepositories.every(isFinalizationRepository)
    )
  ) throw new PlanLifecycleSagaCorruptionError();
  if (saga.operation !== 'finalize' && saga.finalizationRepositories !== undefined) {
    throw new PlanLifecycleSagaCorruptionError();
  }
  if (saga.operation === 'archive' && saga.requiresMetadataCommit === false &&
    (saga.phase === 'metadata_commit_pending' || saga.phase === 'metadata_committed')) {
    throw new PlanLifecycleSagaCorruptionError();
  }
  return saga as PlanLifecycleSaga;
};

export const parsePlanLifecycleSagaJournal = (value: string | null | undefined): PlanLifecycleSagaJournal => {
  if (!value) return { sagas: [], quarantined: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      sagas: [],
      quarantined: [{
        entry: value,
        reason: 'Journal de saga JSON illisible : valeur brute conservée, aucune reprise automatique exécutée.',
        quarantinedAt: new Date().toISOString(),
      }],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      sagas: [],
      quarantined: [{
        entry: parsed,
        reason: 'Racine du journal de saga invalide : un tableau était attendu, aucune reprise automatique exécutée.',
        quarantinedAt: new Date().toISOString(),
      }],
    };
  }
  const journal: PlanLifecycleSagaJournal = { sagas: [], quarantined: [] };
  for (const entry of parsed) {
    try {
      journal.sagas.push(parseSagaEntry(entry));
    } catch {
      journal.quarantined.push({
        entry,
        reason: 'Entrée de saga invalide : reprise automatique ignorée pour cette entrée uniquement.',
        quarantinedAt: new Date().toISOString(),
      });
    }
  }
  return journal;
};

export const parsePlanLifecycleSagas = (value: string | null | undefined): PlanLifecycleSaga[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new PlanLifecycleSagaCorruptionError();
    return parsed.map((entry) => {
      const saga = entry as Partial<PlanLifecycleSaga>;
      const allowedPhases: Record<PlanLifecycleOperation, readonly PlanLifecyclePhase[]> = {
        archive: ['prepared', 'metadata_written', 'git_cleanup_complete', 'metadata_commit_pending', 'metadata_committed'],
        delete: ['prepared', 'git_cleanup_complete', 'metadata_deleted'],
        finalize: ['prepared', 'git_merges_complete', 'metadata_written'],
      };
      if (
        !saga || typeof saga.planId !== 'string' || typeof saga.branchName !== 'string' ||
        (saga.operation !== 'archive' && saga.operation !== 'delete' && saga.operation !== 'finalize') ||
        !allowedPhases[saga.operation as PlanLifecycleOperation]?.includes(saga.phase as PlanLifecyclePhase) ||
        typeof saga.createdAt !== 'string' || typeof saga.updatedAt !== 'string'
      ) throw new PlanLifecycleSagaCorruptionError();
      if (saga.requiresMetadataCommit !== undefined && (saga.operation !== 'archive' || typeof saga.requiresMetadataCommit !== 'boolean')) {
        throw new PlanLifecycleSagaCorruptionError();
      }
      if (saga.cleanupResources !== undefined && (
        !Array.isArray(saga.cleanupResources) || !saga.cleanupResources.every(isCleanupResource)
      )) throw new PlanLifecycleSagaCorruptionError();
      if (
        saga.operation === 'finalize' && (
          !Array.isArray(saga.finalizationRepositories) ||
          !saga.finalizationRepositories.every(isFinalizationRepository)
        )
      ) throw new PlanLifecycleSagaCorruptionError();
      if (saga.operation !== 'finalize' && saga.finalizationRepositories !== undefined) {
        throw new PlanLifecycleSagaCorruptionError();
      }
      if (
        saga.operation === 'archive' &&
        saga.requiresMetadataCommit === false &&
        (saga.phase === 'metadata_commit_pending' || saga.phase === 'metadata_committed')
      ) {
        throw new PlanLifecycleSagaCorruptionError();
      }
      return saga as PlanLifecycleSaga;
    });
  } catch (error) {
    if (error instanceof PlanLifecycleSagaCorruptionError) throw error;
    throw new PlanLifecycleSagaCorruptionError();
  }
};

const parseUnknownArray = (value: string | null): unknown[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [value];
  }
};

interface CompletedPlanLifecycleRegistry {
  version: 2;
  highWatermarks: Record<string, string>;
  legacyGenerations: string[];
}

const emptyCompletedRegistry = (): CompletedPlanLifecycleRegistry => ({
  version: 2,
  highWatermarks: {},
  legacyGenerations: [],
});

const parseCompletedRegistry = (value: string | null | undefined): CompletedPlanLifecycleRegistry => {
  if (!value) return emptyCompletedRegistry();
  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
    return { ...emptyCompletedRegistry(), legacyGenerations: parsed };
  }
  if (!parsed || typeof parsed !== 'object') throw new PlanLifecycleSagaCorruptionError();
  const registry = parsed as Partial<CompletedPlanLifecycleRegistry>;
  if (
    registry.version !== 2 || !registry.highWatermarks || typeof registry.highWatermarks !== 'object' ||
    !Object.values(registry.highWatermarks).every((entry) => typeof entry === 'string') ||
    !Array.isArray(registry.legacyGenerations) ||
    !registry.legacyGenerations.every((entry) => typeof entry === 'string')
  ) throw new PlanLifecycleSagaCorruptionError();
  return registry as CompletedPlanLifecycleRegistry;
};

const loadCompletedRegistry = async (
  transport: PlanLifecycleSagaTransport,
): Promise<CompletedPlanLifecycleRegistry> => parseCompletedRegistry(
  (await transport.dbGetAppSetting(COMPLETED_SAGA_KEY))?.value_json,
);

const registryCompletesSaga = (
  registry: CompletedPlanLifecycleRegistry,
  saga: PlanLifecycleSaga,
): boolean => registry.legacyGenerations.includes(getPlanLifecycleSagaGeneration(saga)) ||
  (registry.highWatermarks[getPlanLifecycleSagaKey(saga)] ?? '') >= saga.createdAt;

const updateSetting = async (
  key: string,
  mutation: (value: string | null) => string,
  transport: PlanLifecycleSagaTransport,
): Promise<void> => {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const expectedValueJson = (await transport.dbGetAppSetting(key))?.value_json ?? null;
    const valueJson = mutation(expectedValueJson);
    const result = await transport.dbCompareAndSwapAppSetting({
      key,
      expectedValueJson,
      valueJson,
    });
    if (result.applied) return;
  }
  throw new Error(`Conflit persistant pendant la mise à jour du réglage ${key}.`);
};

const appendQuarantine = async (
  entries: PlanLifecycleSagaQuarantineEntry[],
  transport: PlanLifecycleSagaTransport,
): Promise<void> => {
  if (entries.length === 0) return;
  await updateSetting(
    SAGA_QUARANTINE_KEY,
    (current) => JSON.stringify([...parseUnknownArray(current), ...entries]),
    transport,
  );
};

export const loadPlanLifecycleSagas = async (
  transport: PlanLifecycleSagaTransport = defaultTransport,
): Promise<PlanLifecycleSaga[]> => {
  if (!transport.isTauriAvailable()) return [];
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const setting = await transport.dbGetAppSetting(SAGA_KEY);
    const expectedValueJson = setting?.value_json ?? null;
    const journal = parsePlanLifecycleSagaJournal(expectedValueJson);
    if (journal.quarantined.length === 0) {
      const completed = await loadCompletedRegistry(transport);
      return journal.sagas.filter((saga) => !registryCompletesSaga(completed, saga));
    }

    await appendQuarantine(journal.quarantined, transport);
    const result = await transport.dbCompareAndSwapAppSetting({
      key: SAGA_KEY,
      expectedValueJson,
      valueJson: JSON.stringify(journal.sagas),
    });
    if (result.applied) {
      const completed = await loadCompletedRegistry(transport);
      return journal.sagas.filter((saga) => !registryCompletesSaga(completed, saga));
    }
  }
  throw new Error('Conflit persistant pendant la normalisation du journal du cycle de vie des plans.');
};

const finalizationRepositoryPhaseRank = (phase: PlanFinalizationRepositoryPhase): number => [
  'prepared',
  'base_synced',
  'plan_merged',
  'backmerge_synced',
  'complete',
].indexOf(phase);

const getFinalizationRepositoryKey = (
  repository: Pick<PlanFinalizationRepositoryCheckpoint, 'projectId' | 'repoPath'>,
): string => `${repository.projectId}:${repository.repoPath}`;

const mergeFinalizationRepositoryProgress = (
  persisted: PlanFinalizationRepositoryCheckpoint[],
  incoming: PlanFinalizationRepositoryCheckpoint[],
): PlanFinalizationRepositoryCheckpoint[] => {
  if (persisted.length !== incoming.length) throw new PlanLifecycleSagaCorruptionError();
  const incomingByKey = new Map(incoming.map((repository) => [
    getFinalizationRepositoryKey(repository),
    repository,
  ]));
  return persisted.map((current) => {
    const next = incomingByKey.get(getFinalizationRepositoryKey(current));
    if (!next) throw new PlanLifecycleSagaCorruptionError();
    const immutableCurrent = {
      projectId: current.projectId,
      repoPath: current.repoPath,
      planBranchName: current.planBranchName,
      baseBranchName: current.baseBranchName,
      backmergeBranchName: current.backmergeBranchName,
      expectedPlanCommit: current.expectedPlanCommit,
      expectedBaseCommit: current.expectedBaseCommit,
      expectedBackmergeCommit: current.expectedBackmergeCommit,
    };
    const immutableNext = {
      projectId: next.projectId,
      repoPath: next.repoPath,
      planBranchName: next.planBranchName,
      baseBranchName: next.baseBranchName,
      backmergeBranchName: next.backmergeBranchName,
      expectedPlanCommit: next.expectedPlanCommit,
      expectedBaseCommit: next.expectedBaseCommit,
      expectedBackmergeCommit: next.expectedBackmergeCommit,
    };
    if (JSON.stringify(immutableCurrent) !== JSON.stringify(immutableNext)) {
      throw new PlanLifecycleSagaCorruptionError();
    }
    if (finalizationRepositoryPhaseRank(next.phase) < finalizationRepositoryPhaseRank(current.phase)) {
      throw new StalePlanLifecycleSagaError();
    }
    return { ...current, ...next };
  });
};

export const upsertPlanLifecycleSaga = async (
  saga: PlanLifecycleSaga,
  transport: PlanLifecycleSagaTransport = defaultTransport,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  const generation = getPlanLifecycleSagaGeneration(saga);
  if (registryCompletesSaga(await loadCompletedRegistry(transport), saga)) {
    throw new StalePlanLifecycleSagaError();
  }
  await loadPlanLifecycleSagas(transport);
  const sagaKey = getPlanLifecycleSagaKey(saga);
  const phaseOrder: Record<PlanLifecycleOperation, readonly PlanLifecyclePhase[]> = {
    archive: ['prepared', 'metadata_written', 'git_cleanup_complete', 'metadata_commit_pending', 'metadata_committed'],
    delete: ['prepared', 'git_cleanup_complete', 'metadata_deleted'],
    finalize: ['prepared', 'git_merges_complete', 'metadata_written'],
  };
  await updateSetting(
    SAGA_KEY,
    (current) => {
      const sagas = parsePlanLifecycleSagas(current);
      const existing = sagas.find((entry) => getPlanLifecycleSagaKey(entry) === sagaKey);
      let nextSaga = saga;
      if (existing) {
        const existingGeneration = getPlanLifecycleSagaGeneration(existing);
        if (existingGeneration !== generation) {
          if (existing.createdAt >= saga.createdAt) throw new StalePlanLifecycleSagaError();
        } else if (phaseOrder[saga.operation].indexOf(existing.phase) > phaseOrder[saga.operation].indexOf(saga.phase)) {
          throw new StalePlanLifecycleSagaError();
        } else {
          if (existing.cleanupResources && saga.cleanupResources &&
            JSON.stringify(existing.cleanupResources) !== JSON.stringify(saga.cleanupResources)) {
            throw new PlanLifecycleSagaCorruptionError();
          }
          if (existing.finalizationRepositories) {
            if (!saga.finalizationRepositories) throw new PlanLifecycleSagaCorruptionError();
            nextSaga = {
              ...saga,
              cleanupResources: existing.cleanupResources ?? saga.cleanupResources,
              finalizationRepositories: mergeFinalizationRepositoryProgress(
                existing.finalizationRepositories,
                saga.finalizationRepositories,
              ),
            };
          } else if (existing.cleanupResources) {
            nextSaga = { ...saga, cleanupResources: existing.cleanupResources };
          }
        }
      }
      return JSON.stringify([
        ...sagas.filter((entry) => getPlanLifecycleSagaKey(entry) !== sagaKey),
        nextSaga,
      ]);
    },
    transport,
  );
  if (registryCompletesSaga(await loadCompletedRegistry(transport), saga)) {
    await updateSetting(
      SAGA_KEY,
      (current) => JSON.stringify(parsePlanLifecycleSagas(current).filter(
        (entry) => getPlanLifecycleSagaGeneration(entry) !== generation,
      )),
      transport,
    );
    throw new StalePlanLifecycleSagaError();
  }
};

export const removePlanLifecycleSaga = async (
  planId: string,
  operation: PlanLifecycleOperation,
  branchName?: string,
  generation?: string,
  transport: PlanLifecycleSagaTransport = defaultTransport,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  if (!generation) throw new Error('La génération du cycle de vie du plan est requise.');
  const sagaKey = getPlanLifecycleSagaKey({ planId, operation, branchName: branchName ?? '' });
  const generationPrefix = `${sagaKey}:`;
  if (!generation.startsWith(generationPrefix) || generation.length === generationPrefix.length) {
    throw new Error('La génération du cycle de vie du plan ne correspond pas à son identité.');
  }
  const completedAt = generation.slice(generationPrefix.length);
  await loadPlanLifecycleSagas(transport);
  await updateSetting(
    COMPLETED_SAGA_KEY,
    (value) => {
      const registry = parseCompletedRegistry(value);
      const current = registry.highWatermarks[sagaKey];
      return JSON.stringify({
        ...registry,
        highWatermarks: {
          ...registry.highWatermarks,
          [sagaKey]: current && current > completedAt ? current : completedAt,
        },
      });
    },
    transport,
  );
  await updateSetting(
    SAGA_KEY,
    (value) => {
      const current = parsePlanLifecycleSagas(value);
      const matches = current.filter((entry) => entry.planId === planId && entry.operation === operation);
      if (!branchName && matches.length > 1) return JSON.stringify(current);
      return JSON.stringify(current.filter((entry) =>
        entry.planId !== planId || entry.operation !== operation ||
        (branchName !== undefined && entry.branchName !== branchName) ||
        getPlanLifecycleSagaGeneration(entry) !== generation
      ));
    },
    transport,
  );
};
