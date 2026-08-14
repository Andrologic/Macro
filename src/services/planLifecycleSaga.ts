import * as tauriIpc from './tauriIpc';
import { toPlanLocatorKey } from './durableIdentity';

const SAGA_KEY = 'pendingPlanLifecycles:v1';
const SAGA_QUARANTINE_KEY = 'pendingPlanLifecyclesQuarantine:v1';

export type PlanLifecycleOperation = 'archive' | 'delete';
export type PlanLifecyclePhase = 'prepared' | 'metadata_written' | 'git_cleanup_complete' | 'metadata_commit_pending' | 'metadata_committed' | 'metadata_deleted';

export interface PlanLifecycleSaga {
  planId: string;
  branchName: string;
  operation: PlanLifecycleOperation;
  phase: PlanLifecyclePhase;
  conversationId?: string | null;
  requiresMetadataCommit?: boolean;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export const getPlanLifecycleSagaKey = (
  saga: Pick<PlanLifecycleSaga, 'branchName' | 'planId' | 'operation'>,
): string => `${toPlanLocatorKey(saga)}:${saga.operation}`;

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

let tail = Promise.resolve();
const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try { return await operation(); } finally { release(); }
};

export const loadPlanLifecycleSagas = async (): Promise<PlanLifecycleSaga[]> => {
  if (!tauriIpc.isTauriAvailable()) return [];
  const journal = parsePlanLifecycleSagaJournal((await tauriIpc.dbGetAppSetting(SAGA_KEY))?.value_json);
  if (journal.quarantined.length > 0) {
    await tauriIpc.dbSetAppSetting({
      key: SAGA_QUARANTINE_KEY,
      valueJson: JSON.stringify(journal.quarantined),
    });
  }
  return journal.sagas;
};

const save = async (sagas: PlanLifecycleSaga[]): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return;
  await tauriIpc.dbSetAppSetting({ key: SAGA_KEY, valueJson: JSON.stringify(sagas) });
};

export const upsertPlanLifecycleSaga = async (saga: PlanLifecycleSaga): Promise<void> => mutate(async () => {
  const current = await loadPlanLifecycleSagas();
  const sagaKey = getPlanLifecycleSagaKey(saga);
  await save([...current.filter((entry) =>
    getPlanLifecycleSagaKey(entry) !== sagaKey
  ), saga]);
});

export const removePlanLifecycleSaga = async (
  planId: string,
  operation: PlanLifecycleOperation,
  branchName?: string,
): Promise<void> => mutate(async () => {
  const current = await loadPlanLifecycleSagas();
  const matches = current.filter((entry) => entry.planId === planId && entry.operation === operation);
  if (!branchName && matches.length > 1) return;
  await save(current.filter((entry) =>
    entry.planId !== planId || entry.operation !== operation ||
    (branchName !== undefined && entry.branchName !== branchName)
  ));
});
