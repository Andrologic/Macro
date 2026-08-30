import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { LinkedConversationDeletionSaga, LinkedTaskDeletionSagaTransport } from './linkedTaskDeletionSaga';

const actualTauriIpc = await import('./tauriIpc');

const malformedSagaJson = JSON.stringify([
  {
    ownerType: 'plan',
    ownerId: 'plan-1',
    conversationId: 'conversation-1',
    phase: 'prepared',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  },
]);
let currentSagaJson = malformedSagaJson;

mock.module('./tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  dbGetAppSetting: async () => ({
    key: 'pendingLinkedTaskDeletions:v1',
    value_json: currentSagaJson,
    updated_at: '2026-08-12T00:00:00.000Z',
  }),
}));

const sagaService = await import('./linkedTaskDeletionSaga');

describe('linkedTaskDeletionSaga', () => {
  beforeEach(() => {
    currentSagaJson = malformedSagaJson;
  });

  it('includes the target branch in task deletion identity', () => {
    expect(sagaService.getLinkedDeletionSagaKey({ ownerType: 'task', ownerId: 'node-1', targetBranch: 'develop' }))
      .not.toBe(sagaService.getLinkedDeletionSagaKey({ ownerType: 'task', ownerId: 'node-1', targetBranch: 'release/next' }));
  });
  it('fails closed for syntactically valid but semantically impossible owner-phase pairs', async () => {
    await expect(
      sagaService.loadLinkedConversationDeletionSagas(),
    ).rejects.toMatchObject({
      name: 'LinkedConversationDeletionSagaCorruptionError',
      recoverableConversationIds: ['conversation-1'],
    });
  });

  it('accepts a durable task return-to-draft phase', async () => {
    currentSagaJson = JSON.stringify([{
      ownerType: 'task',
      ownerId: 'task-1',
      conversationId: 'conversation-1',
      phase: 'draft_reverting',
      targetBranch: '@direct-draft-revert',
      revertTitle: 'Draft title',
      revertDescription: 'Draft description',
      executionTargets: [],
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }]);

    await expect(sagaService.loadLinkedConversationDeletionSagas()).resolves.toEqual([
      expect.objectContaining({
        ownerType: 'task',
        ownerId: 'task-1',
        phase: 'draft_reverting',
      }),
    ]);
  });

  it('rejects a return-to-draft phase owned by a plan', async () => {
    currentSagaJson = JSON.stringify([{
      ownerType: 'plan',
      ownerId: 'plan-1',
      conversationId: 'conversation-1',
      phase: 'draft_reverting',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }]);

    await expect(sagaService.loadLinkedConversationDeletionSagas()).rejects.toMatchObject({
      name: 'LinkedConversationDeletionSagaCorruptionError',
    });
  });

  it('preserves concurrent updates from independent journal clients', async () => {
    let persisted: string | null = null;
    let initialReads = 0;
    let releaseInitialReads!: () => void;
    const initialReadsReleased = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const transport = (): LinkedTaskDeletionSagaTransport => ({
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const valueJson = persisted;
        if (persisted === null && initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) releaseInitialReads();
          await initialReadsReleased;
        }
        return valueJson === null
          ? null
          : { key, value_json: valueJson, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ expectedValueJson, valueJson }) => {
        if (persisted !== expectedValueJson) return { applied: false };
        persisted = valueJson;
        return { applied: true };
      },
    });
    const saga = (ownerId: string): LinkedConversationDeletionSaga => ({
      ownerType: 'task',
      ownerId,
      conversationId: `conversation-${ownerId}`,
      phase: 'prepared',
      targetBranch: `feature/${ownerId}`,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });

    await Promise.all([
      sagaService.upsertLinkedConversationDeletionSaga(saga('first'), transport()),
      sagaService.upsertLinkedConversationDeletionSaga(saga('second'), transport()),
    ]);

    expect(JSON.parse(persisted ?? '[]')).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: 'first' }),
      expect.objectContaining({ ownerId: 'second' }),
    ]));
  });
});
