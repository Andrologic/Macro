import * as tauriIpc from './tauriIpc';
import { toPlanLocatorKey } from './durableIdentity';

const SAGA_KEY = 'pendingPlanLifecycles:v1';
const SAGA_QUARANTINE_KEY = 'pendingPlanLifecyclesQuarantine:v1';
const COMPLETED_SAGA_KEY = 'completedPlanLifecycles:v1';
const MAX_CAS_ATTEMPTS = 32;
const MAX_COMPLETED_GENERATIONS = 512;

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

export type PlanLifecycleOperation = 'archive' | 'delete';
export type PlanLifecyclePhase = 'prepared' | 'metadata_written' | 'git_cleanup_complete' | 'metadata_commit_pending' | 'metadata_committed' | 'metadata_deleted';

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

const parseSagaEntry = (entry: unknown): PlanLifecycleSaga => {
  const saga = entry as Partial<PlanLifecycleSaga>;
  const allowedPhases: Record<PlanLifecycleOperation, readonly PlanLifecyclePhase[]> = {
    archive: ['prepared', 'metadata_written', 'git_cleanup_complete', 'metadata_commit_pending', 'metadata_committed'],
    delete: ['prepared', 'git_cleanup_complete', 'metadata_deleted'],
  };
  if (
    !saga || typeof saga.planId !== 'string' || typeof saga.branchName !== 'string' ||
    (saga.operation !== 'archive' && saga.operation !== 'delete') ||
    !allowedPhases[saga.operation as PlanLifecycleOperation]?.includes(saga.phase as PlanLifecyclePhase) ||
    typeof saga.createdAt !== 'string' || typeof saga.updatedAt !== 'string'
  ) throw new PlanLifecycleSagaCorruptionError();
  if (saga.requiresMetadataCommit !== undefined && (saga.operation !== 'archive' || typeof saga.requiresMetadataCommit !== 'boolean')) {
    throw new PlanLifecycleSagaCorruptionError();
  }
  if (saga.cleanupResources !== undefined && (
    !Array.isArray(saga.cleanupResources) || !saga.cleanupResources.every(isCleanupResource)
  )) throw new PlanLifecycleSagaCorruptionError();
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
      };
      if (
        !saga || typeof saga.planId !== 'string' || typeof saga.branchName !== 'string' ||
        (saga.operation !== 'archive' && saga.operation !== 'delete') ||
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

const parseCompletedGenerations = (value: string | null | undefined): string[] => {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new PlanLifecycleSagaCorruptionError();
  }
  return parsed;
};

const loadCompletedGenerations = async (
  transport: PlanLifecycleSagaTransport,
): Promise<Set<string>> => new Set(parseCompletedGenerations(
  (await transport.dbGetAppSetting(COMPLETED_SAGA_KEY))?.value_json,
));

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
      const completed = await loadCompletedGenerations(transport);
      return journal.sagas.filter((saga) => !completed.has(getPlanLifecycleSagaGeneration(saga)));
    }

    await appendQuarantine(journal.quarantined, transport);
    const result = await transport.dbCompareAndSwapAppSetting({
      key: SAGA_KEY,
      expectedValueJson,
      valueJson: JSON.stringify(journal.sagas),
    });
    if (result.applied) {
      const completed = await loadCompletedGenerations(transport);
      return journal.sagas.filter((saga) => !completed.has(getPlanLifecycleSagaGeneration(saga)));
    }
  }
  throw new Error('Conflit persistant pendant la normalisation du journal du cycle de vie des plans.');
};

export const upsertPlanLifecycleSaga = async (
  saga: PlanLifecycleSaga,
  transport: PlanLifecycleSagaTransport = defaultTransport,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  const generation = getPlanLifecycleSagaGeneration(saga);
  if ((await loadCompletedGenerations(transport)).has(generation)) {
    throw new StalePlanLifecycleSagaError();
  }
  await loadPlanLifecycleSagas(transport);
  const sagaKey = getPlanLifecycleSagaKey(saga);
  const phaseOrder: Record<PlanLifecycleOperation, readonly PlanLifecyclePhase[]> = {
    archive: ['prepared', 'metadata_written', 'git_cleanup_complete', 'metadata_commit_pending', 'metadata_committed'],
    delete: ['prepared', 'git_cleanup_complete', 'metadata_deleted'],
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
        } else if (existing.cleanupResources) {
          if (saga.cleanupResources && JSON.stringify(existing.cleanupResources) !== JSON.stringify(saga.cleanupResources)) {
            throw new PlanLifecycleSagaCorruptionError();
          }
          nextSaga = { ...saga, cleanupResources: existing.cleanupResources };
        }
      }
      return JSON.stringify([
        ...sagas.filter((entry) => getPlanLifecycleSagaKey(entry) !== sagaKey),
        nextSaga,
      ]);
    },
    transport,
  );
  if ((await loadCompletedGenerations(transport)).has(generation)) {
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
  await loadPlanLifecycleSagas(transport);
  await updateSetting(
    COMPLETED_SAGA_KEY,
    (value) => JSON.stringify([
      ...parseCompletedGenerations(value).filter((entry) => entry !== generation),
      generation,
    ].slice(-MAX_COMPLETED_GENERATIONS)),
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
