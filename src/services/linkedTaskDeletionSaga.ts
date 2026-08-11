import * as tauriIpc from './tauriIpc';

const SAGA_KEY = 'pendingLinkedTaskDeletions:v1';

export type LinkedConversationDeletionOwner = 'task' | 'plan';

export interface LinkedTaskDeletionTarget {
  worktreeKey: string;
  repoPath: string;
  branchName: string;
  branchExisted: boolean;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
}

export interface LinkedConversationDeletionSaga {
  ownerType: LinkedConversationDeletionOwner;
  ownerId: string;
  conversationId: string;
  phase: 'prepared' | 'task_deleting' | 'task_deleted';
  draft?: boolean;
  executionTargets?: LinkedTaskDeletionTarget[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface LinkedTaskDeletionSaga {
  taskId: string;
  conversationId: string;
  phase: 'prepared' | 'task_deleting' | 'task_deleted';
  draft?: boolean;
  executionTargets?: LinkedTaskDeletionTarget[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export class LinkedConversationDeletionSagaCorruptionError extends Error {
  readonly recoverableConversationIds: string[];

  constructor(value: string) {
    super('Le journal de suppression liée est corrompu et doit être réparé avant de réafficher les conversations concernées.');
    this.name = 'LinkedConversationDeletionSagaCorruptionError';
    this.recoverableConversationIds = Array.from(
      value.matchAll(/"conversationId"\s*:\s*"([^"\\]+)"/g),
      (match) => match[1],
    );
  }
}

const parseSagas = (value: string | null | undefined): LinkedConversationDeletionSaga[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new LinkedConversationDeletionSagaCorruptionError(value);
    return parsed.flatMap((entry): LinkedConversationDeletionSaga[] => {
      if (typeof entry !== 'object' || entry === null) {
        throw new LinkedConversationDeletionSagaCorruptionError(value);
      }
      const candidate = entry as Partial<LinkedConversationDeletionSaga & { taskId: string }>;
      const ownerType = candidate.ownerType ?? (typeof candidate.taskId === 'string' ? 'task' : null);
      const ownerId = candidate.ownerId ?? candidate.taskId;
      if (
        (ownerType !== 'task' && ownerType !== 'plan') ||
        typeof ownerId !== 'string' ||
        typeof candidate.conversationId !== 'string' ||
        (candidate.phase !== 'prepared' &&
          candidate.phase !== 'task_deleting' &&
          candidate.phase !== 'task_deleted')
      ) {
        throw new LinkedConversationDeletionSagaCorruptionError(value);
      }
      return [{
        ...candidate,
        ownerType,
        ownerId,
      } as LinkedConversationDeletionSaga];
    });
  } catch (error) {
    if (error instanceof LinkedConversationDeletionSagaCorruptionError) throw error;
    throw new LinkedConversationDeletionSagaCorruptionError(value);
  }
};

export const loadLinkedConversationDeletionSagas = async (): Promise<LinkedConversationDeletionSaga[]> => {
  if (!tauriIpc.isTauriAvailable()) return [];
  const setting = await tauriIpc.dbGetAppSetting(SAGA_KEY);
  return parseSagas(setting?.value_json);
};

const saveLinkedConversationDeletionSagas = async (sagas: LinkedConversationDeletionSaga[]): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return;
  await tauriIpc.dbSetAppSetting({ key: SAGA_KEY, valueJson: JSON.stringify(sagas) });
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

export const upsertLinkedConversationDeletionSaga = async (
  saga: LinkedConversationDeletionSaga,
): Promise<void> => {
  await serializeMutation(async () => {
    const current = await loadLinkedConversationDeletionSagas();
    await saveLinkedConversationDeletionSagas([
      ...current.filter(
        (entry) => entry.ownerType !== saga.ownerType || entry.ownerId !== saga.ownerId,
      ),
      saga,
    ]);
  });
};

export const removeLinkedConversationDeletionSaga = async (
  ownerType: LinkedConversationDeletionOwner,
  ownerId: string,
): Promise<void> => {
  await serializeMutation(async () => {
    const current = await loadLinkedConversationDeletionSagas();
    await saveLinkedConversationDeletionSagas(
      current.filter((entry) => entry.ownerType !== ownerType || entry.ownerId !== ownerId),
    );
  });
};

export const loadLinkedTaskDeletionSagas = async (): Promise<LinkedTaskDeletionSaga[]> =>
  (await loadLinkedConversationDeletionSagas()).flatMap((saga) =>
    saga.ownerType === 'task'
      ? [{
          taskId: saga.ownerId,
          conversationId: saga.conversationId,
          phase: saga.phase,
          draft: saga.draft,
          executionTargets: saga.executionTargets,
          createdAt: saga.createdAt,
          updatedAt: saga.updatedAt,
          lastError: saga.lastError,
        }]
      : [],
  );

export const upsertLinkedTaskDeletionSaga = async (
  saga: LinkedTaskDeletionSaga,
): Promise<void> =>
  upsertLinkedConversationDeletionSaga({
    ...saga,
    ownerType: 'task',
    ownerId: saga.taskId,
  });

export const removeLinkedTaskDeletionSaga = async (taskId: string): Promise<void> =>
  removeLinkedConversationDeletionSaga('task', taskId);
