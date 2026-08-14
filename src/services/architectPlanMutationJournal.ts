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

type JournalTransport = Pick<typeof tauriIpc, 'isTauriAvailable' | 'dbGetAppSetting' | 'dbSetAppSetting'>;

const loadUnlocked = async (transport: JournalTransport): Promise<ArchitectPlanMutationJournalEntry[]> => {
  if (!transport.isTauriAvailable()) return [];
  const raw = (await transport.dbGetAppSetting(JOURNAL_KEY))?.value_json;
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const valid = values.filter(isEntry);
  const invalid = values.filter((entry) => !isEntry(entry));
  if (invalid.length > 0) {
    await transport.dbSetAppSetting({
      key: QUARANTINE_KEY,
      valueJson: JSON.stringify(invalid.map((entry) => ({
        entry,
        quarantinedAt: new Date().toISOString(),
        reason: 'Entrée de transaction de réplication invalide ; aucune mutation n’a été déduite depuis cette entrée.',
      }))),
    });
    await transport.dbSetAppSetting({ key: JOURNAL_KEY, valueJson: JSON.stringify(valid) });
  }
  return valid;
};

const saveUnlocked = async (entries: ArchitectPlanMutationJournalEntry[], transport: JournalTransport): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  await transport.dbSetAppSetting({ key: JOURNAL_KEY, valueJson: JSON.stringify(entries) });
};

export const createArchitectPlanMutationId = (entry: Pick<ArchitectPlanMutationJournalEntry, 'branchName' | 'planId' | 'operation'>): string =>
  `${toPlanLocatorKey(entry)}:${entry.operation}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

export const loadArchitectPlanMutationJournal = async (transport: JournalTransport = tauriIpc): Promise<ArchitectPlanMutationJournalEntry[]> =>
  locked(() => loadUnlocked(transport));

export const upsertArchitectPlanMutationJournal = async (entry: ArchitectPlanMutationJournalEntry, transport: JournalTransport = tauriIpc): Promise<void> =>
  locked(async () => {
    const entries = await loadUnlocked(transport);
    await saveUnlocked([...entries.filter((candidate) => candidate.id !== entry.id), entry], transport);
  });

export const removeArchitectPlanMutationJournal = async (id: string, transport: JournalTransport = tauriIpc): Promise<void> =>
  locked(async () => {
    const entries = await loadUnlocked(transport);
    await saveUnlocked(entries.filter((entry) => entry.id !== id), transport);
  });

export const quarantineArchitectPlanMutationJournal = async (
  entry: ArchitectPlanMutationJournalEntry,
  reason: string,
  transport: JournalTransport = tauriIpc,
): Promise<void> => locked(async () => {
  const existingRaw = (await transport.dbGetAppSetting(QUARANTINE_KEY))?.value_json;
  let existing: unknown = [];
  try { existing = existingRaw ? JSON.parse(existingRaw) : []; } catch { existing = []; }
  const quarantine = Array.isArray(existing) ? existing : [];
  await transport.dbSetAppSetting({
    key: QUARANTINE_KEY,
    valueJson: JSON.stringify([...quarantine, { entry, reason, quarantinedAt: new Date().toISOString() }]),
  });
  const entries = await loadUnlocked(transport);
  await saveUnlocked(entries.filter((candidate) => candidate.id !== entry.id), transport);
});
