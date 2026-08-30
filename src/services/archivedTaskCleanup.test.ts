import { describe, expect, it } from 'bun:test';
import {
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
      saga('task-a'), saga('task-b'),
    ]);
  });
});
