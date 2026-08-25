import * as tauriIpc from './tauriIpc';
import { toPlanLocatorKey } from './durableIdentity';

const JOURNAL_KEY = 'pendingArchitectPlanReplicaMutations:v1';
const QUARANTINE_KEY = 'pendingArchitectPlanReplicaMutationsQuarantine:v1';

export interface ArchitectPlanMutationJournalEntry<TPayload = unknown> {
  id: string;
  workspaceKey: string;
  branchName: string;
  planId: string;
  operation: 'create' | 'update' | 'archive' | 'restore' | 'delete' | 'repair' | 'bind' | 'activate' | 'chat' | 'auto_heal' | 'orphan_cleanup';
  phase: 'prepared' | 'applying' | 'files_applied' | 'committing';
  payload: TPayload;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

const isEntry = (value: unknown): value is ArchitectPlanMutationJournalEntry => {
  const entry = value as Partial<ArchitectPlanMutationJournalEntry>;
  return !!entry && typeof entry.id === 'string' && typeof entry.workspaceKey === 'string' && entry.workspaceKey.length > 0 && typeof entry.branchName === 'string' &&
    typeof entry.planId === 'string' &&
    ['create', 'update', 'archive', 'restore', 'delete', 'repair', 'bind', 'activate', 'chat', 'auto_heal', 'orphan_cleanup'].includes(entry.operation || '') &&
    ['prepared', 'applying', 'files_applied', 'committing'].includes(entry.phase || '') &&
    typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string' &&
    entry.payload !== undefined;
};

let tail = Promise.resolve();
const locked = async <T>(callback: () => Promise<T>): Promise<T> => {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try { return await callback(); } finally { release(); }
};

type JournalTransport = Pick<typeof tauriIpc, 'isTauriAvailable' | 'dbGetAppSetting' | 'dbCompareAndSwapAppSetting'>;
const MAX_CAS_ATTEMPTS = 12;

const parseArray = (raw: string | null): unknown[] => {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return Array.isArray(parsed) ? parsed : [parsed];
};

const updateSetting = async (
  key: string,
  update: (values: unknown[]) => unknown[],
  transport: JournalTransport,
): Promise<unknown[]> => {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const expectedValueJson = (await transport.dbGetAppSetting(key))?.value_json ?? null;
    const next = update(parseArray(expectedValueJson));
    const result = await transport.dbCompareAndSwapAppSetting({
      key,
      expectedValueJson,
      valueJson: JSON.stringify(next),
    });
    if (result.applied) return next;
  }
  throw new Error(`Conflit persistant lors de la mise à jour atomique du réglage ${key}.`);
};

const appendQuarantine = async (entries: unknown[], reason: string, transport: JournalTransport): Promise<void> => {
  if (entries.length === 0) return;
  const quarantinedAt = new Date().toISOString();
  await updateSetting(QUARANTINE_KEY, (existing) => [
    ...existing,
    ...entries.map((entry) => ({ entry, quarantinedAt, reason })),
  ], transport);
};

const loadUnlocked = async (transport: JournalTransport): Promise<ArchitectPlanMutationJournalEntry[]> => {
  if (!transport.isTauriAvailable()) return [];
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const expectedValueJson = (await transport.dbGetAppSetting(JOURNAL_KEY))?.value_json ?? null;
    const values = parseArray(expectedValueJson);
    const valid = values.filter(isEntry);
    const invalid = values.filter((entry) => !isEntry(entry));
    if (invalid.length === 0) return valid;

    await appendQuarantine(
      invalid,
      'Entrée de transaction de réplication invalide ; aucune mutation n’a été déduite depuis cette entrée.',
      transport,
    );
    const result = await transport.dbCompareAndSwapAppSetting({
      key: JOURNAL_KEY,
      expectedValueJson,
      valueJson: JSON.stringify(valid),
    });
    if (result.applied) return valid;
  }
  throw new Error('Conflit persistant lors de la normalisation du journal des mutations de plans.');
};

export const createArchitectPlanMutationId = (entry: Pick<ArchitectPlanMutationJournalEntry, 'branchName' | 'planId' | 'operation'>): string =>
  `${toPlanLocatorKey(entry)}:${entry.operation}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

export const loadArchitectPlanMutationJournal = async (transport: JournalTransport = tauriIpc): Promise<ArchitectPlanMutationJournalEntry[]> =>
  locked(() => loadUnlocked(transport));

export const upsertArchitectPlanMutationJournal = async (entry: ArchitectPlanMutationJournalEntry, transport: JournalTransport = tauriIpc): Promise<void> =>
  locked(async () => {
    if (!transport.isTauriAvailable()) return;
    await loadUnlocked(transport);
    await updateSetting(JOURNAL_KEY, (values) => [
      ...values.filter((candidate) => !isEntry(candidate) || candidate.id !== entry.id),
      entry,
    ], transport);
  });

export const removeArchitectPlanMutationJournal = async (id: string, transport: JournalTransport = tauriIpc): Promise<void> =>
  locked(async () => {
    if (!transport.isTauriAvailable()) return;
    await loadUnlocked(transport);
    await updateSetting(JOURNAL_KEY, (values) => values.filter((entry) => !isEntry(entry) || entry.id !== id), transport);
  });

export const quarantineArchitectPlanMutationJournal = async (
  entry: ArchitectPlanMutationJournalEntry,
  reason: string,
  transport: JournalTransport = tauriIpc,
): Promise<void> => locked(async () => {
  if (!transport.isTauriAvailable()) return;
  await appendQuarantine([entry], reason, transport);
  await loadUnlocked(transport);
  await updateSetting(JOURNAL_KEY, (values) => values.filter((candidate) => !isEntry(candidate) || candidate.id !== entry.id), transport);
});
