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
  dbGetAppSetting: async (key: string) => key === 'pendingLinkedTaskDeletions:v1'
    ? {
        key,
        value_json: currentSagaJson,
        updated_at: '2026-08-12T00:00:00.000Z',
      }
    : null,
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
        if (key !== 'pendingLinkedTaskDeletions:v1') return null;
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
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if (key !== 'pendingLinkedTaskDeletions:v1') return { applied: true };
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

  it('rejects stale progress and completion for the same owner generation', async () => {
    const values = new Map<string, string>();
    const transport: LinkedTaskDeletionSagaTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const valueJson = values.get(key);
        return valueJson === undefined
          ? null
          : { key, value_json: valueJson, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((values.get(key) ?? null) !== expectedValueJson) return { applied: false };
        values.set(key, valueJson);
        return { applied: true };
      },
    };
    const prepared: LinkedConversationDeletionSaga = {
      ownerType: 'task',
      ownerId: 'shared',
      conversationId: 'conversation-shared',
      phase: 'prepared',
      targetBranch: 'feature/shared',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    await sagaService.upsertLinkedConversationDeletionSaga(prepared, transport);
    const completed: LinkedConversationDeletionSaga = {
      ...prepared,
      phase: 'task_deleted',
      updatedAt: '2026-08-30T00:00:01.000Z',
    };
    await sagaService.upsertLinkedConversationDeletionSaga(completed, transport);
    await expect(sagaService.upsertLinkedConversationDeletionSaga(prepared, transport))
      .rejects.toBeInstanceOf(sagaService.StaleLinkedTaskDeletionSagaError);
    await sagaService.removeLinkedConversationDeletionSaga(
      'task',
      'shared',
      'feature/shared',
      sagaService.getLinkedDeletionSagaGeneration(completed),
      transport,
    );
    await expect(sagaService.upsertLinkedConversationDeletionSaga(completed, transport))
      .rejects.toBeInstanceOf(sagaService.StaleLinkedTaskDeletionSagaError);
    expect(JSON.parse(values.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);
  });

  it('does not convert and resurrect a completed historical linked deletion', async () => {
    const values = new Map<string, string>();
    const transport: LinkedTaskDeletionSagaTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const valueJson = values.get(key);
        return valueJson === undefined
          ? null
          : { key, value_json: valueJson, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((values.get(key) ?? null) !== expectedValueJson) return { applied: false };
        values.set(key, valueJson);
        return { applied: true };
      },
    };
    const historical: LinkedConversationDeletionSaga = {
      ownerType: 'task',
      ownerId: 'historical-task',
      conversationId: 'historical-conversation',
      phase: 'task_deleted',
      targetBranch: 'feature/historical-task',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:01.000Z',
    };
    values.set('pendingLinkedTaskDeletions:v1', JSON.stringify([historical]));
    await sagaService.removeLinkedConversationDeletionSaga(
      historical.ownerType,
      historical.ownerId,
      historical.targetBranch,
      sagaService.getLinkedDeletionSagaGeneration(historical),
      transport,
    );

    await expect(sagaService.upsertLinkedConversationDeletionSaga(historical, transport))
      .rejects.toBeInstanceOf(sagaService.StaleLinkedTaskDeletionSagaError);

    expect(historical.generation).toBeUndefined();
    expect(JSON.parse(values.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([]);

    const fresh: LinkedConversationDeletionSaga = {
      ...historical,
      conversationId: 'fresh-conversation',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    await sagaService.startLinkedConversationDeletionSaga(fresh, transport);
    expect(fresh.generation).toBe(1);

    const competing = {
      ...fresh,
      generation: undefined,
      conversationId: 'competing-conversation',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
    };
    await expect(sagaService.startLinkedConversationDeletionSaga(competing, transport))
      .rejects.toBeInstanceOf(sagaService.StaleLinkedTaskDeletionSagaError);
    expect(JSON.parse(values.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([fresh]);
  });

  it('keeps durable high-water marks after more than 512 completed owner identities', async () => {
    const values = new Map<string, string>();
    const transport: LinkedTaskDeletionSagaTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const valueJson = values.get(key);
        return valueJson === undefined
          ? null
          : { key, value_json: valueJson, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((values.get(key) ?? null) !== expectedValueJson) return { applied: false };
        values.set(key, valueJson);
        return { applied: true };
      },
    };
    let first!: LinkedConversationDeletionSaga;
    for (let index = 0; index < 520; index += 1) {
      const completed: LinkedConversationDeletionSaga = {
        ownerType: 'task',
        ownerId: `task-${index}`,
        conversationId: `conversation-${index}`,
        phase: 'task_deleted',
        targetBranch: `feature/task-${index}`,
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:01.000Z',
      };
      first ??= completed;
      await sagaService.upsertLinkedConversationDeletionSaga(completed, transport);
      await sagaService.removeLinkedConversationDeletionSaga(
        completed.ownerType,
        completed.ownerId,
        completed.targetBranch,
        sagaService.getLinkedDeletionSagaGeneration(completed),
        transport,
      );
    }

    await expect(sagaService.upsertLinkedConversationDeletionSaga(first, transport))
      .rejects.toBeInstanceOf(sagaService.StaleLinkedTaskDeletionSagaError);
    const registry = JSON.parse(values.get('completedLinkedTaskDeletions:v1') ?? '{}') as {
      highWatermarks?: Record<string, string>;
    };
    expect(Object.keys(registry.highWatermarks ?? {})).toHaveLength(520);
  });

  it('accepts a new owner generation when the wall clock moves backwards', async () => {
    const values = new Map<string, string>();
    const transport: LinkedTaskDeletionSagaTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const valueJson = values.get(key);
        return valueJson === undefined
          ? null
          : { key, value_json: valueJson, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((values.get(key) ?? null) !== expectedValueJson) return { applied: false };
        values.set(key, valueJson);
        return { applied: true };
      },
    };
    const first: LinkedConversationDeletionSaga = {
      ownerType: 'task',
      ownerId: 'clock-task',
      conversationId: 'clock-conversation',
      phase: 'task_deleted',
      targetBranch: 'feature/clock-task',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
    };
    await sagaService.upsertLinkedConversationDeletionSaga(first, transport);
    await sagaService.removeLinkedConversationDeletionSaga(
      first.ownerType,
      first.ownerId,
      first.targetBranch,
      sagaService.getLinkedDeletionSagaGeneration(first),
      transport,
    );
    const second: LinkedConversationDeletionSaga = {
      ...first,
      generation: undefined,
      conversationId: 'clock-conversation-new',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };

    await sagaService.startLinkedConversationDeletionSaga(second, transport);

    expect(second.generation).toBe(2);
    expect(JSON.parse(values.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([second]);
  });

  it('keeps target checkpoints monotonic within one deletion generation', async () => {
    const values = new Map<string, string>();
    const transport: LinkedTaskDeletionSagaTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const valueJson = values.get(key);
        return valueJson === undefined
          ? null
          : { key, value_json: valueJson, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((values.get(key) ?? null) !== expectedValueJson) return { applied: false };
        values.set(key, valueJson);
        return { applied: true };
      },
    };
    const pending: LinkedConversationDeletionSaga = {
      ownerType: 'task',
      ownerId: 'checkpoint-task',
      conversationId: 'checkpoint-conversation',
      phase: 'task_deleting',
      targetBranch: 'feature/checkpoint-task',
      executionTargets: [{
        worktreeKey: 'project-1::feature/checkpoint-task',
        repoPath: '/repos/web',
        branchName: 'feature/checkpoint-task',
        branchExisted: true,
        worktreeRemoved: false,
        branchRemoved: false,
      }],
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const transferred: LinkedConversationDeletionSaga = {
      ...pending,
      archivedCleanupOperationId: 'archive-generation',
      archivedCleanupCreatedAt: '2026-08-30T00:00:01.000Z',
      executionTargets: [
        ...(pending.executionTargets ?? []).map((target) => ({
          ...target,
          repoPath: '/repos/current-web',
          worktreeRemoved: true,
        })),
        {
          worktreeKey: 'project-2::feature/checkpoint-task',
          repoPath: '/repos/api',
          branchName: 'feature/checkpoint-task',
          branchExisted: true,
          worktreeRemoved: false,
          branchRemoved: false,
        },
      ],
      updatedAt: '2026-08-30T00:00:02.000Z',
    };
    await sagaService.upsertLinkedConversationDeletionSaga(transferred, transport);
    await sagaService.upsertLinkedConversationDeletionSaga({
      ...transferred,
      executionTargets: pending.executionTargets,
      archivedCleanupOperationId: undefined,
      archivedCleanupCreatedAt: undefined,
      updatedAt: '2026-08-30T00:00:01.000Z',
    }, transport);

    expect(JSON.parse(values.get('pendingLinkedTaskDeletions:v1') ?? '[]')).toEqual([
      expect.objectContaining({
        archivedCleanupOperationId: 'archive-generation',
        archivedCleanupCreatedAt: '2026-08-30T00:00:01.000Z',
        executionTargets: [
          expect.objectContaining({
            repoPath: '/repos/current-web',
            worktreeRemoved: true,
          }),
          expect.objectContaining({ repoPath: '/repos/api' }),
        ],
      }),
    ]);
  });
});
