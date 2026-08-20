import { beforeEach, describe, expect, it, mock } from 'bun:test';

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
});
