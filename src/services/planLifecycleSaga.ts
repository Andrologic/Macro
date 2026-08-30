import * as tauriIpc from './tauriIpc';
import { toPlanLocatorKey } from './durableIdentity';

const SAGA_KEY = 'pendingPlanLifecycles:v1';
const SAGA_QUARANTINE_KEY = 'pendingPlanLifecyclesQuarantine:v1';
const MAX_CAS_ATTEMPTS = 32;

export interface PlanLifecycleSagaTransport {
  isTauriAvailable: () => boolean;
  dbGetAppSetting: typeof tauriIpc.dbGetAppSetting;
  dbCompareAndSwapAppSetting: typeof tauriIpc.dbCompareAndSwapAppSetting;
}

const defaultTransport: PlanLifecycleSagaTransport = tauriIpc;

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

const parseUnknownArray = (value: string | null): unknown[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [value];
  }
};

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
    if (journal.quarantined.length === 0) return journal.sagas;

    await appendQuarantine(journal.quarantined, transport);
    const result = await transport.dbCompareAndSwapAppSetting({
      key: SAGA_KEY,
      expectedValueJson,
      valueJson: JSON.stringify(journal.sagas),
    });
    if (result.applied) return journal.sagas;
  }
  throw new Error('Conflit persistant pendant la normalisation du journal du cycle de vie des plans.');
};

export const upsertPlanLifecycleSaga = async (
  saga: PlanLifecycleSaga,
  transport: PlanLifecycleSagaTransport = defaultTransport,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  await loadPlanLifecycleSagas(transport);
  const sagaKey = getPlanLifecycleSagaKey(saga);
  await updateSetting(
    SAGA_KEY,
    (current) => JSON.stringify([
      ...parsePlanLifecycleSagas(current).filter((entry) => getPlanLifecycleSagaKey(entry) !== sagaKey),
      saga,
    ]),
    transport,
  );
};

export const removePlanLifecycleSaga = async (
  planId: string,
  operation: PlanLifecycleOperation,
  branchName?: string,
  transport: PlanLifecycleSagaTransport = defaultTransport,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  await loadPlanLifecycleSagas(transport);
  await updateSetting(
    SAGA_KEY,
    (value) => {
      const current = parsePlanLifecycleSagas(value);
      const matches = current.filter((entry) => entry.planId === planId && entry.operation === operation);
      if (!branchName && matches.length > 1) return JSON.stringify(current);
      return JSON.stringify(current.filter((entry) =>
        entry.planId !== planId || entry.operation !== operation ||
        (branchName !== undefined && entry.branchName !== branchName)
      ));
    },
    transport,
  );
};
