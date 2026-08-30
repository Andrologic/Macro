import * as tauriIpc from './tauriIpc';

const CLEANUP_KEY = 'pendingArchivedTaskCleanups:v1';
const MAX_CAS_ATTEMPTS = 32;

export interface ArchivedTaskCleanupJournalTransport {
  isTauriAvailable: () => boolean;
  dbGetAppSetting: typeof tauriIpc.dbGetAppSetting;
  dbCompareAndSwapAppSetting: typeof tauriIpc.dbCompareAndSwapAppSetting;
}

const defaultTransport: ArchivedTaskCleanupJournalTransport = tauriIpc;

export type ArchivedTaskCleanupTargetState = 'pending' | 'dirty' | 'failed';

export interface ArchivedTaskCleanupTarget {
  worktreeKey: string;
  repoPath: string;
  branchName: string;
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
  return parseCleanupSagas(setting?.value_json);
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

export const upsertArchivedTaskCleanupSaga = async (
  saga: ArchivedTaskCleanupSaga,
  transport: ArchivedTaskCleanupJournalTransport = defaultTransport,
): Promise<void> => {
  await mutateArchivedTaskCleanupSagas(
    (current) => [
      ...current.filter((entry) => entry.taskId !== saga.taskId),
      saga,
    ],
    transport,
  );
};

export const removeArchivedTaskCleanupSaga = async (
  taskId: string,
  transport: ArchivedTaskCleanupJournalTransport = defaultTransport,
): Promise<void> => {
  await mutateArchivedTaskCleanupSagas(
    (current) => current.filter((entry) => entry.taskId !== taskId),
    transport,
  );
};

export const archivedTaskCleanupIsComplete = (
  saga: ArchivedTaskCleanupSaga,
): boolean => saga.targets.every((target) => target.worktreeRemoved && target.branchRemoved);
