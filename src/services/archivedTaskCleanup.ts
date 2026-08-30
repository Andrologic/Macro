import * as tauriIpc from './tauriIpc';

const CLEANUP_KEY = 'pendingArchivedTaskCleanups:v1';

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
      !Array.isArray(saga.targets) ||
      !saga.targets.every(isCleanupTarget) ||
      typeof saga.createdAt !== 'string' ||
      typeof saga.updatedAt !== 'string' ||
      (saga.lastError !== undefined && typeof saga.lastError !== 'string')
    ) {
      throw new Error("Le journal de nettoyage des tâches archivées est corrompu.");
    }
    return saga as ArchivedTaskCleanupSaga;
  });
};

export const loadArchivedTaskCleanupSagas = async (): Promise<ArchivedTaskCleanupSaga[]> => {
  if (!tauriIpc.isTauriAvailable()) return [];
  const setting = await tauriIpc.dbGetAppSetting(CLEANUP_KEY);
  return parseCleanupSagas(setting?.value_json);
};

const saveArchivedTaskCleanupSagas = async (
  sagas: ArchivedTaskCleanupSaga[],
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return;
  await tauriIpc.dbSetAppSetting({
    key: CLEANUP_KEY,
    valueJson: JSON.stringify(sagas),
  });
};

let pendingMutation: Promise<void> = Promise.resolve();

const serializeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = pendingMutation;
  let release!: () => void;
  pendingMutation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
};

export const upsertArchivedTaskCleanupSaga = async (
  saga: ArchivedTaskCleanupSaga,
): Promise<void> => {
  await serializeMutation(async () => {
    const current = await loadArchivedTaskCleanupSagas();
    await saveArchivedTaskCleanupSagas([
      ...current.filter((entry) => entry.taskId !== saga.taskId),
      saga,
    ]);
  });
};

export const removeArchivedTaskCleanupSaga = async (taskId: string): Promise<void> => {
  await serializeMutation(async () => {
    const current = await loadArchivedTaskCleanupSagas();
    await saveArchivedTaskCleanupSagas(
      current.filter((entry) => entry.taskId !== taskId),
    );
  });
};

export const archivedTaskCleanupIsComplete = (
  saga: ArchivedTaskCleanupSaga,
): boolean => saga.targets.every((target) => target.worktreeRemoved && target.branchRemoved);
