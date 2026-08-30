import * as tauriIpc from './tauriIpc';

const SAGA_KEY = 'pendingLinkedTaskDeletions:v1';
const MAX_CAS_ATTEMPTS = 32;

export interface LinkedTaskDeletionSagaTransport {
  isTauriAvailable: () => boolean;
  dbGetAppSetting: typeof tauriIpc.dbGetAppSetting;
  dbCompareAndSwapAppSetting: typeof tauriIpc.dbCompareAndSwapAppSetting;
}

const defaultTransport: LinkedTaskDeletionSagaTransport = tauriIpc;

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

export const loadLinkedConversationDeletionSagas = async (
  transport: LinkedTaskDeletionSagaTransport = defaultTransport,
): Promise<LinkedConversationDeletionSaga[]> => {
  if (!transport.isTauriAvailable()) return [];
  const setting = await transport.dbGetAppSetting(SAGA_KEY);
  return parseSagas(setting?.value_json);
};

const mutateLinkedConversationDeletionSagas = async (
  mutation: (current: LinkedConversationDeletionSaga[]) => LinkedConversationDeletionSaga[],
  transport: LinkedTaskDeletionSagaTransport,
): Promise<void> => {
  if (!transport.isTauriAvailable()) return;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const setting = await transport.dbGetAppSetting(SAGA_KEY);
    const expectedValueJson = setting?.value_json ?? null;
    const valueJson = JSON.stringify(mutation(parseSagas(expectedValueJson)));
    const result = await transport.dbCompareAndSwapAppSetting({
      key: SAGA_KEY,
      expectedValueJson,
      valueJson,
    });
    if (result.applied) return;
  }
  throw new Error('Conflit persistant pendant la mise à jour du journal de suppression liée.');
};

export const upsertLinkedConversationDeletionSaga = async (
  saga: LinkedConversationDeletionSaga,
  transport: LinkedTaskDeletionSagaTransport = defaultTransport,
): Promise<void> => {
  await mutateLinkedConversationDeletionSagas(
    (current) => [
      ...current.filter(
        (entry) => !hasSameOwnerIdentity(entry, saga),
      ),
      saga,
    ],
    transport,
  );
};

export const removeLinkedConversationDeletionSaga = async (
  ownerType: LinkedConversationDeletionOwner,
  ownerId: string,
  targetBranch?: string,
  transport: LinkedTaskDeletionSagaTransport = defaultTransport,
): Promise<void> => {
  await mutateLinkedConversationDeletionSagas((current) => {
    const matches = current.filter((entry) => entry.ownerType === ownerType && entry.ownerId === ownerId);
    if (ownerType !== 'conversation' && targetBranch === undefined && matches.length > 1) return current;
    return current.filter((entry) =>
      entry.ownerType !== ownerType || entry.ownerId !== ownerId ||
      (ownerType !== 'conversation' && targetBranch !== undefined && entry.targetBranch !== targetBranch)
    );
  }, transport);
};

export const loadLinkedTaskDeletionSagas = async (
  transport: LinkedTaskDeletionSagaTransport = defaultTransport,
): Promise<LinkedTaskDeletionSaga[]> =>
  (await loadLinkedConversationDeletionSagas(transport)).flatMap((saga) =>
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
        }]
      : [],
  );

export const upsertLinkedTaskDeletionSaga = async (
  saga: LinkedTaskDeletionSaga,
  transport: LinkedTaskDeletionSagaTransport = defaultTransport,
): Promise<void> =>
  upsertLinkedConversationDeletionSaga({
    ...saga,
    ownerType: 'task',
    ownerId: saga.taskId,
  }, transport);

export const removeLinkedTaskDeletionSaga = async (
  taskId: string,
  targetBranch?: string,
  transport: LinkedTaskDeletionSagaTransport = defaultTransport,
): Promise<void> => removeLinkedConversationDeletionSaga('task', taskId, targetBranch, transport);
