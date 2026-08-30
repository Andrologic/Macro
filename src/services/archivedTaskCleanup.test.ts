import { describe, expect, it } from 'bun:test';
import {
  loadArchivedTaskCleanupSagas,
  removeArchivedTaskCleanupSaga,
  startArchivedTaskCleanupSaga,
  StaleArchivedTaskCleanupError,
  upsertArchivedTaskCleanupSaga,
  type ArchivedTaskCleanupJournalTransport,
  type ArchivedTaskCleanupSaga,
} from './archivedTaskCleanup';

const CLEANUP_KEY = 'pendingArchivedTaskCleanups:v1';

const saga = (taskId: string): ArchivedTaskCleanupSaga => ({
  operationId: `archive-${taskId}`,
  taskId,
  archiveToken: `token-${taskId}`,
  targets: [],
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
});

describe('archivedTaskCleanup', () => {
  it('preserves updates from two independent clients that read the same journal revision', async () => {
    const settings = new Map<string, string>([[CLEANUP_KEY, '[]']]);
    let initialReads = 0;
    let releaseInitialReads!: () => void;
    const bothClientsRead = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const createClient = (): ArchivedTaskCleanupJournalTransport => ({
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const value = settings.get(key);
        if (initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) releaseInitialReads();
          await bothClientsRead;
        }
        return value === undefined
          ? null
          : { key, value_json: value, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((settings.get(key) ?? null) !== expectedValueJson) return { applied: false };
        settings.set(key, valueJson);
        return { applied: true };
      },
    });

    await Promise.all([
      upsertArchivedTaskCleanupSaga(saga('task-a'), createClient()),
      upsertArchivedTaskCleanupSaga(saga('task-b'), createClient()),
    ]);

    const persisted = JSON.parse(settings.get(CLEANUP_KEY) ?? '[]') as ArchivedTaskCleanupSaga[];
    expect(persisted.sort((left, right) => left.taskId.localeCompare(right.taskId))).toEqual([
      { ...saga('task-a'), generation: 1 },
      { ...saga('task-b'), generation: 1 },
    ]);
  });

  it('does not let an obsolete generation overwrite, remove, or resurrect its replacement', async () => {
    const settings = new Map<string, string>();
    const transport: ArchivedTaskCleanupJournalTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const value = settings.get(key);
        return value === undefined
          ? null
          : { key, value_json: value, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((settings.get(key) ?? null) !== expectedValueJson) return { applied: false };
        settings.set(key, valueJson);
        return { applied: true };
      },
    };
    const obsolete = {
      ...saga('shared'),
      operationId: 'archive-obsolete',
      createdAt: '2026-08-30T00:00:00.000Z',
    };
    const replacement = {
      ...saga('shared'),
      operationId: 'archive-replacement',
      createdAt: '2020-01-01T00:00:00.000Z',
    };

    await upsertArchivedTaskCleanupSaga(obsolete, transport);
    await upsertArchivedTaskCleanupSaga(replacement, transport);
    await expect(upsertArchivedTaskCleanupSaga(obsolete, transport))
      .rejects.toBeInstanceOf(StaleArchivedTaskCleanupError);
    await removeArchivedTaskCleanupSaga(obsolete.taskId, obsolete.operationId, transport);

    expect(JSON.parse(settings.get(CLEANUP_KEY) ?? '[]')).toEqual([replacement]);

    await removeArchivedTaskCleanupSaga(replacement.taskId, replacement.operationId, transport);
    await expect(upsertArchivedTaskCleanupSaga(replacement, transport))
      .rejects.toBeInstanceOf(StaleArchivedTaskCleanupError);
    const afterClockRollback = {
      ...saga('shared'),
      operationId: 'archive-after-clock-rollback',
      createdAt: '2010-01-01T00:00:00.000Z',
    };
    await startArchivedTaskCleanupSaga(afterClockRollback, transport);
    expect(afterClockRollback.generation).toBe(3);
    expect(JSON.parse(settings.get(CLEANUP_KEY) ?? '[]')).toEqual([afterClockRollback]);
  });

  it('does not convert and resurrect a completed historical cleanup', async () => {
    const settings = new Map<string, string>();
    const transport: ArchivedTaskCleanupJournalTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const value = settings.get(key);
        return value === undefined
          ? null
          : { key, value_json: value, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((settings.get(key) ?? null) !== expectedValueJson) return { applied: false };
        settings.set(key, valueJson);
        return { applied: true };
      },
    };
    const historical = {
      ...saga('historical-task'),
      operationId: 'historical-operation',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:01.000Z',
    };
    settings.set(CLEANUP_KEY, JSON.stringify([historical]));
    await removeArchivedTaskCleanupSaga(
      historical.taskId,
      historical.operationId,
      transport,
    );

    await expect(upsertArchivedTaskCleanupSaga(historical, transport))
      .rejects.toBeInstanceOf(StaleArchivedTaskCleanupError);

    expect(historical.generation).toBeUndefined();
    expect(JSON.parse(settings.get(CLEANUP_KEY) ?? '[]')).toEqual([]);

    const fresh = {
      ...historical,
      operationId: 'fresh-operation',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    await startArchivedTaskCleanupSaga(fresh, transport);
    expect(fresh.generation).toBe(1);

    const competing = {
      ...fresh,
      generation: undefined,
      operationId: 'competing-operation',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
    };
    await expect(startArchivedTaskCleanupSaga(competing, transport))
      .rejects.toBeInstanceOf(StaleArchivedTaskCleanupError);
    expect(JSON.parse(settings.get(CLEANUP_KEY) ?? '[]')).toEqual([fresh]);
  });

  it('retires a historical archive cleanup completed during numeric conversion', async () => {
    const historical = {
      ...saga('conversion-race-task'),
      operationId: 'conversion-race-operation',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:01.000Z',
    };
    const settings = new Map<string, string>([[CLEANUP_KEY, JSON.stringify([historical])]]);
    let releaseCompletion!: () => void;
    const completionReleased = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let reportCompletionBlocked!: () => void;
    const completionBlocked = new Promise<void>((resolve) => {
      reportCompletionBlocked = resolve;
    });
    let shouldBlockCompletion = true;
    const transport: ArchivedTaskCleanupJournalTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const valueJson = settings.get(key);
        return valueJson === undefined
          ? null
          : { key, value_json: valueJson, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if (key === 'completedArchivedTaskCleanups:v1' && shouldBlockCompletion) {
          shouldBlockCompletion = false;
          reportCompletionBlocked();
          await completionReleased;
        }
        if ((settings.get(key) ?? null) !== expectedValueJson) return { applied: false };
        settings.set(key, valueJson);
        return { applied: true };
      },
    };

    const removal = removeArchivedTaskCleanupSaga(
      historical.taskId,
      historical.operationId,
      transport,
    );
    await completionBlocked;
    const converted = { ...historical };
    await upsertArchivedTaskCleanupSaga(converted, transport);
    expect(converted.generation).toBe(1);

    releaseCompletion();
    await removal;
    expect(JSON.parse(settings.get(CLEANUP_KEY) ?? '[]')).toEqual([]);

    await expect(upsertArchivedTaskCleanupSaga({
      ...converted,
      updatedAt: '2026-08-30T00:00:02.000Z',
    }, transport)).rejects.toBeInstanceOf(StaleArchivedTaskCleanupError);
    expect(await loadArchivedTaskCleanupSagas(transport)).toEqual([]);
  });

  it('keeps durable high-water marks after more than 256 completed task identities', async () => {
    const settings = new Map<string, string>();
    const transport: ArchivedTaskCleanupJournalTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const value = settings.get(key);
        return value === undefined
          ? null
          : { key, value_json: value, updated_at: '2026-08-30T00:00:00.000Z' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((settings.get(key) ?? null) !== expectedValueJson) return { applied: false };
        settings.set(key, valueJson);
        return { applied: true };
      },
    };
    let first!: ArchivedTaskCleanupSaga;
    for (let index = 0; index < 264; index += 1) {
      const completed = saga(`task-${index}`);
      first ??= completed;
      await upsertArchivedTaskCleanupSaga(completed, transport);
      await removeArchivedTaskCleanupSaga(completed.taskId, completed.operationId, transport);
    }

    await expect(upsertArchivedTaskCleanupSaga(first, transport))
      .rejects.toBeInstanceOf(StaleArchivedTaskCleanupError);
    const registry = JSON.parse(settings.get('completedArchivedTaskCleanups:v1') ?? '{}') as {
      highWatermarks?: Record<string, unknown>;
    };
    expect(Object.keys(registry.highWatermarks ?? {})).toHaveLength(264);
  });
});
