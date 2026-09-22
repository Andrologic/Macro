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
let compareAndSwapCalls = 0;
let setAppSettingCalls = 0;
let compareAndSwap: (params: { expectedValueJson: string | null; valueJson: string }) => Promise<{ applied: boolean }> = async ({
  expectedValueJson,
  valueJson,
}) => {
  if (currentSagaJson !== expectedValueJson) return { applied: false };
  currentSagaJson = valueJson;
  return { applied: true };
};

mock.module('./tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  dbGetAppSetting: async () => ({
    key: 'pendingLinkedTaskDeletions:v1',
    value_json: currentSagaJson,
    updated_at: '2026-08-12T00:00:00.000Z',
  }),
  dbSetAppSetting: async ({ valueJson }: { valueJson: string }) => {
    setAppSettingCalls += 1;
    currentSagaJson = valueJson;
    return {
      key: 'pendingLinkedTaskDeletions:v1',
      value_json: valueJson,
      updated_at: '2026-08-12T00:00:00.000Z',
    };
  },
  dbCompareAndSwapAppSetting: async ({ expectedValueJson, valueJson }: { expectedValueJson: string | null; valueJson: string }) => {
    compareAndSwapCalls += 1;
    return compareAndSwap({ expectedValueJson, valueJson });
  },
}));

const sagaService = await import('./linkedTaskDeletionSaga');

describe('linkedTaskDeletionSaga', () => {
  beforeEach(() => {
    currentSagaJson = malformedSagaJson;
    compareAndSwapCalls = 0;
    setAppSettingCalls = 0;
    compareAndSwap = async ({ expectedValueJson, valueJson }) => {
      if (currentSagaJson !== expectedValueJson) return { applied: false };
      currentSagaJson = valueJson;
      return { applied: true };
    };
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

  it('preserves foreign legacy and unknown entries during a Pilot upsert', async () => {
    const foreignLegacy = {
      taskId: 'foreign-task',
      conversationId: 'foreign-conversation',
      phase: 'task_deleted',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      legacyField: 'keep-me',
    };
    const foreignUnknown = { journal: 'foreign', payload: { keep: true } };
    currentSagaJson = JSON.stringify([foreignLegacy, foreignUnknown]);

    await sagaService.upsertLinkedTaskDeletionSaga({
      taskId: 'pilot-task',
      conversationId: 'pilot-conversation',
      phase: 'prepared',
      targetBranch: 'feature/pilot',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      requiresPilotAuthorization: true,
    });

    const entries = JSON.parse(currentSagaJson) as unknown[];
    expect(entries.slice(0, 2)).toEqual([foreignLegacy, foreignUnknown]);
    expect(entries[2]).toMatchObject({
      taskId: 'pilot-task',
      ownerType: 'task',
      ownerId: 'pilot-task',
      requiresPilotAuthorization: true,
    });
    expect(compareAndSwapCalls).toBe(1);
    expect(setAppSettingCalls).toBe(0);
  });

  it('preserves foreign legacy and unknown entries during a Pilot remove', async () => {
    const foreignLegacy = {
      taskId: 'foreign-task',
      conversationId: 'foreign-conversation',
      phase: 'task_deleted',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    };
    const foreignUnknown = { journal: 'foreign', payload: ['keep'] };
    const pilotSaga = {
      ownerType: 'task',
      ownerId: 'pilot-task',
      conversationId: 'pilot-conversation',
      phase: 'task_deleted',
      targetBranch: 'feature/pilot',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      requiresPilotAuthorization: true,
    };
    currentSagaJson = JSON.stringify([foreignLegacy, pilotSaga, foreignUnknown]);

    await sagaService.removeLinkedTaskDeletionSaga('pilot-task', 'feature/pilot', true);

    expect(JSON.parse(currentSagaJson)).toEqual([foreignLegacy, foreignUnknown]);
    expect(compareAndSwapCalls).toBe(1);
    expect(setAppSettingCalls).toBe(0);
  });

  it('retries a failed Pilot CAS without losing a concurrent entry', async () => {
    const concurrentEntry = { journal: 'concurrent', payload: 'keep' };
    let failures = 1;
    compareAndSwap = async ({ expectedValueJson, valueJson }) => {
      if (failures > 0) {
        failures -= 1;
        currentSagaJson = JSON.stringify([...(JSON.parse(currentSagaJson) as unknown[]), concurrentEntry]);
        return { applied: false };
      }
      if (currentSagaJson !== expectedValueJson) return { applied: false };
      currentSagaJson = valueJson;
      return { applied: true };
    };
    currentSagaJson = JSON.stringify([]);

    await sagaService.upsertLinkedConversationDeletionSaga({
      ownerType: 'conversation',
      ownerId: 'pilot-conversation',
      conversationId: 'pilot-conversation',
      phase: 'task_deleted',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      requiresPilotAuthorization: true,
    });

    expect(JSON.parse(currentSagaJson)).toEqual([
      concurrentEntry,
      expect.objectContaining({ ownerId: 'pilot-conversation' }),
    ]);
    expect(compareAndSwapCalls).toBe(2);
  });

  it('refuses a persistent Pilot CAS conflict without changing the journal', async () => {
    const original = JSON.stringify([]);
    currentSagaJson = original;
    compareAndSwap = async () => ({ applied: false });

    await expect(sagaService.upsertLinkedConversationDeletionSaga({
      ownerType: 'conversation',
      ownerId: 'pilot-conversation',
      conversationId: 'pilot-conversation',
      phase: 'task_deleted',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      requiresPilotAuthorization: true,
    })).rejects.toThrow(/Conflit persistant/);

    expect(currentSagaJson).toBe(original);
    expect(compareAndSwapCalls).toBe(12);
    expect(setAppSettingCalls).toBe(0);
  });

  it('refuses an invalid Pilot journal before any write', async () => {
    currentSagaJson = JSON.stringify({ invalid: true });
    const original = currentSagaJson;

    await expect(sagaService.upsertLinkedConversationDeletionSaga({
      ownerType: 'conversation',
      ownerId: 'pilot-conversation',
      conversationId: 'pilot-conversation',
      phase: 'task_deleted',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      requiresPilotAuthorization: true,
    })).rejects.toMatchObject({ name: 'LinkedConversationDeletionSagaCorruptionError' });

    expect(currentSagaJson).toBe(original);
    expect(compareAndSwapCalls).toBe(0);
    expect(setAppSettingCalls).toBe(0);
  });
});
