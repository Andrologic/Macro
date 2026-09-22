import * as tauriIpc from './tauriIpc';

const SAGA_KEY = 'pendingLinkedTaskDeletions:v1';
const MAX_PILOT_CAS_ATTEMPTS = 12;

export type LinkedConversationDeletionOwner = 'task' | 'plan' | 'conversation';
export type LinkedConversationDeletionPhase =
  | 'prepared'
  | 'task_deleting'
  | 'task_deleted'
  | 'draft_reverting'
  | 'draft_reverted'
  | 'plan_conversation_created'
  | 'plan_deleting';

export interface LinkedTaskDeletionTarget {
  worktreeKey: string;
  repoPath: string;
  branchName: string;
  branchExisted: boolean;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  cleanupKind?: 'git' | 'direct';
  checkpointRemoved?: boolean;
  checkpointId?: string;
}

export interface LinkedConversationDeletionSaga {
  ownerType: LinkedConversationDeletionOwner;
  ownerId: string;
  conversationId: string;
  phase: LinkedConversationDeletionPhase;
  draft?: boolean;
  executionTargets?: LinkedTaskDeletionTarget[];
  targetBranch?: string;
  revertTitle?: string | null;
  revertDescription?: string | null;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  requiresPilotAuthorization?: boolean;
}

export interface LinkedTaskDeletionSaga {
  taskId: string;
  conversationId: string;
  phase: LinkedConversationDeletionPhase;
  draft?: boolean;
  executionTargets?: LinkedTaskDeletionTarget[];
  targetBranch?: string;
  revertTitle?: string | null;
  revertDescription?: string | null;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  requiresPilotAuthorization?: boolean;
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

const isAllowedOwnerPhase = (
  ownerType: LinkedConversationDeletionOwner,
  phase: LinkedConversationDeletionPhase,
): boolean => {
  if (ownerType === 'task') {
    return phase === 'prepared' || phase === 'task_deleting' || phase === 'task_deleted' ||
      phase === 'draft_reverting' || phase === 'draft_reverted';
  }
  if (ownerType === 'plan') {
    return phase === 'task_deleted' || phase === 'plan_conversation_created' || phase === 'plan_deleting';
  }
  return phase === 'task_deleted';
};

const hasSameOwnerIdentity = (
  left: Pick<LinkedConversationDeletionSaga, 'ownerType' | 'ownerId' | 'targetBranch'>,
  right: Pick<LinkedConversationDeletionSaga, 'ownerType' | 'ownerId' | 'targetBranch'>,
): boolean => left.ownerType === right.ownerType && left.ownerId === right.ownerId &&
  (left.ownerType === 'conversation' || left.targetBranch === right.targetBranch);

export const getLinkedDeletionSagaKey = (
  saga: Pick<LinkedConversationDeletionSaga, 'ownerType' | 'ownerId' | 'targetBranch'>,
): string => saga.ownerType === 'conversation'
  ? `conversation:${encodeURIComponent(saga.ownerId)}`
  : `${saga.ownerType}:${encodeURIComponent(saga.targetBranch || '')}:${encodeURIComponent(saga.ownerId)}`;

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
        (ownerType !== 'task' && ownerType !== 'plan' && ownerType !== 'conversation') ||
        typeof ownerId !== 'string' ||
        typeof candidate.conversationId !== 'string' ||
        (candidate.phase !== 'prepared' &&
          candidate.phase !== 'task_deleting' &&
          candidate.phase !== 'task_deleted' &&
          candidate.phase !== 'draft_reverting' &&
          candidate.phase !== 'draft_reverted' &&
          candidate.phase !== 'plan_conversation_created' &&
          candidate.phase !== 'plan_deleting') ||
        !isAllowedOwnerPhase(ownerType, candidate.phase)
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

type RawSagaEntry = Record<string, unknown>;

const isRawSagaEntry = (value: unknown): value is RawSagaEntry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const looksLikeLinkedConversationDeletionSaga = (entry: RawSagaEntry): boolean =>
  ['ownerType', 'ownerId', 'taskId', 'conversationId', 'phase', 'requiresPilotAuthorization']
    .some((key) => Object.prototype.hasOwnProperty.call(entry, key));

const parsePilotRawSagas = (value: string | null | undefined): unknown[] => {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LinkedConversationDeletionSagaCorruptionError(value);
  }
  if (!Array.isArray(parsed)) {
    throw new LinkedConversationDeletionSagaCorruptionError(value);
  }
  for (const entry of parsed) {
    if (!isRawSagaEntry(entry)) {
      throw new LinkedConversationDeletionSagaCorruptionError(value);
    }
    if (looksLikeLinkedConversationDeletionSaga(entry)) {
      parseSagas(JSON.stringify([entry]));
    }
  }
  return parsed;
};

const rawSagaOwner = (entry: RawSagaEntry): Pick<LinkedConversationDeletionSaga, 'ownerType' | 'ownerId'> | null => {
  const ownerType = entry.ownerType ?? (typeof entry.taskId === 'string' ? 'task' : null);
  const ownerId = entry.ownerId ?? entry.taskId;
  if (
    (ownerType !== 'task' && ownerType !== 'plan' && ownerType !== 'conversation') ||
    typeof ownerId !== 'string'
  ) {
    return null;
  }
  return { ownerType, ownerId };
};

const rawSagaMatches = (
  entry: unknown,
  ownerType: LinkedConversationDeletionOwner,
  ownerId: string,
  targetBranch: string | undefined,
  pilotOnly: boolean,
  matchAnyTargetBranch = false,
): boolean => {
  if (!isRawSagaEntry(entry) || (pilotOnly && entry.requiresPilotAuthorization !== true)) return false;
  const owner = rawSagaOwner(entry);
  if (!owner || owner.ownerType !== ownerType || owner.ownerId !== ownerId) return false;
  return ownerType === 'conversation' ||
    (targetBranch === undefined && matchAnyTargetBranch) ||
    entry.targetBranch === targetBranch;
};

const updatePilotRawSagas = async (
  update: (entries: unknown[]) => unknown[],
): Promise<void> => {
  for (let attempt = 0; attempt < MAX_PILOT_CAS_ATTEMPTS; attempt += 1) {
    const expectedValueJson = (await tauriIpc.dbGetAppSetting(SAGA_KEY))?.value_json ?? null;
    const current = parsePilotRawSagas(expectedValueJson);
    const next = update(current);
    const valueJson = JSON.stringify(next);
    if (valueJson === expectedValueJson || (expectedValueJson === null && next.length === 0)) return;
    const result = await tauriIpc.dbCompareAndSwapAppSetting({
      key: SAGA_KEY,
      expectedValueJson,
      valueJson,
    });
    if (result.applied) return;
  }
  throw new Error('Conflit persistant lors de la mise à jour CAS du journal de suppression liée.');
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
    if (saga.requiresPilotAuthorization === true) {
      if (!tauriIpc.isTauriAvailable()) return;
      const validatedSaga = parseSagas(JSON.stringify([saga]))[0];
      await updatePilotRawSagas((current) => [
        ...current.filter((entry) => !rawSagaMatches(
          entry,
          validatedSaga.ownerType,
          validatedSaga.ownerId,
          validatedSaga.targetBranch,
          true,
        )),
        saga,
      ]);
      return;
    }
    const current = await loadLinkedConversationDeletionSagas();
    await saveLinkedConversationDeletionSagas([
      ...current.filter(
        (entry) => !hasSameOwnerIdentity(entry, saga),
      ),
      saga,
    ]);
  });
};

export const removeLinkedConversationDeletionSaga = async (
  ownerType: LinkedConversationDeletionOwner,
  ownerId: string,
  targetBranch?: string,
  pilotOnly = false,
): Promise<void> => {
  await serializeMutation(async () => {
    if (pilotOnly) {
      if (!tauriIpc.isTauriAvailable()) return;
      await updatePilotRawSagas((current) => {
        const matches = current.filter((entry) => rawSagaMatches(entry, ownerType, ownerId, targetBranch, true, true));
        if (ownerType !== 'conversation' && targetBranch === undefined && matches.length > 1) return current;
        return current.filter((entry) => !rawSagaMatches(entry, ownerType, ownerId, targetBranch, true, true));
      });
      return;
    }
    const current = await loadLinkedConversationDeletionSagas();
    const matches = current.filter((entry) => entry.ownerType === ownerType && entry.ownerId === ownerId);
    if (ownerType !== 'conversation' && targetBranch === undefined && matches.length > 1) return;
    await saveLinkedConversationDeletionSagas(current.filter((entry) =>
      entry.ownerType !== ownerType || entry.ownerId !== ownerId ||
      (ownerType !== 'conversation' && targetBranch !== undefined && entry.targetBranch !== targetBranch)
    ));
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
          targetBranch: saga.targetBranch,
          revertTitle: saga.revertTitle,
          revertDescription: saga.revertDescription,
          createdAt: saga.createdAt,
          updatedAt: saga.updatedAt,
          lastError: saga.lastError,
          requiresPilotAuthorization: saga.requiresPilotAuthorization,
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

export const removeLinkedTaskDeletionSaga = async (
  taskId: string,
  targetBranch?: string,
  pilotOnly = false,
): Promise<void> => removeLinkedConversationDeletionSaga('task', taskId, targetBranch, pilotOnly);
