import { describe, expect, it } from 'bun:test';
import {
  getPlanLifecycleSagaKey,
  getPlanLifecycleSagaGeneration,
  loadPlanLifecycleSagas,
  parsePlanLifecycleSagaJournal,
  parsePlanLifecycleSagas,
  removePlanLifecycleSaga,
  StalePlanLifecycleSagaError,
  upsertPlanLifecycleSaga,
  type PlanLifecycleSaga,
  type PlanLifecycleSagaTransport,
} from './planLifecycleSaga';

const serializeSaga = (overrides: Record<string, unknown> = {}) => JSON.stringify([{
  planId: 'plan-1',
  branchName: 'develop',
  operation: 'archive',
  phase: 'prepared',
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  ...overrides,
}]);

describe('planLifecycleSaga', () => {
  it('fails closed for impossible operation, phase, and commit requirement combinations', () => {
    expect(() => parsePlanLifecycleSagas(serializeSaga({ operation: 'archive', phase: 'metadata_deleted' })))
      .toThrow('journal du cycle de vie des plans est corrompu');
    expect(() => parsePlanLifecycleSagas(serializeSaga({ operation: 'delete', phase: 'metadata_commit_pending' })))
      .toThrow('journal du cycle de vie des plans est corrompu');
    expect(() => parsePlanLifecycleSagas(serializeSaga({ operation: 'delete', requiresMetadataCommit: true })))
      .toThrow('journal du cycle de vie des plans est corrompu');
    expect(() => parsePlanLifecycleSagas(serializeSaga({ phase: 'metadata_commit_pending', requiresMetadataCommit: false })))
      .toThrow('journal du cycle de vie des plans est corrompu');
    expect(() => parsePlanLifecycleSagas(serializeSaga({ phase: 'metadata_committed', requiresMetadataCommit: false })))
      .toThrow('journal du cycle de vie des plans est corrompu');
  });

  it('accepts the absent metadata commit field for historical archive journals', () => {
    const [historicalSaga] = parsePlanLifecycleSagas(serializeSaga({ phase: 'metadata_commit_pending' }));

    expect(historicalSaga).toMatchObject({ phase: 'metadata_commit_pending' });
    expect(historicalSaga).not.toHaveProperty('requiresMetadataCommit');
  });

  it('keeps identical plan ids on distinct branches as separate sagas', () => {
    const common = { planId: 'shared', operation: 'archive' as const };
    expect(getPlanLifecycleSagaKey({ ...common, branchName: 'develop' }))
      .not.toBe(getPlanLifecycleSagaKey({ ...common, branchName: 'release/next' }));
  });

  it('quarantines an invalid entry while preserving valid recovery work', () => {
    const valid = JSON.parse(serializeSaga())[0];
    const invalid = { ...valid, planId: 'broken', phase: 'metadata_deleted' };

    const journal = parsePlanLifecycleSagaJournal(JSON.stringify([invalid, valid]));

    expect(journal.sagas).toEqual([valid]);
    expect(journal.quarantined).toHaveLength(1);
    expect(journal.quarantined[0]?.entry).toEqual(invalid);
    expect(journal.quarantined[0]?.reason).toContain('invalide');
  });

  it('quarantines a syntactically invalid journal without blocking bootstrap', () => {
    const rawJournal = '{not-json';

    const journal = parsePlanLifecycleSagaJournal(rawJournal);

    expect(journal.sagas).toEqual([]);
    expect(journal.quarantined).toHaveLength(1);
    expect(journal.quarantined[0]?.entry).toBe(rawJournal);
    expect(journal.quarantined[0]?.reason).toContain('JSON illisible');
  });

  it('quarantines a non-array root without treating it as an empty valid journal', () => {
    const invalidRoot = { planId: 'plan-1', operation: 'archive' };

    const journal = parsePlanLifecycleSagaJournal(JSON.stringify(invalidRoot));

    expect(journal.sagas).toEqual([]);
    expect(journal.quarantined).toHaveLength(1);
    expect(journal.quarantined[0]?.entry).toEqual(invalidRoot);
    expect(journal.quarantined[0]?.reason).toContain('tableau était attendu');
  });

  it('does not duplicate quarantine entries when source normalization must retry', async () => {
    const valid = JSON.parse(serializeSaga())[0];
    const invalid = { ...valid, planId: 'broken', phase: 'metadata_deleted' };
    const values = new Map<string, string>([
      ['pendingPlanLifecycles:v1', JSON.stringify([invalid, valid])],
    ]);
    let rejectFirstSourceNormalization = true;
    const transport: PlanLifecycleSagaTransport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key) => {
        const valueJson = values.get(key);
        return valueJson === undefined
          ? null
          : { key, value_json: valueJson, updated_at: 'source-revision-1' };
      },
      dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }) => {
        if ((values.get(key) ?? null) !== expectedValueJson) return { applied: false };
        if (key === 'pendingPlanLifecycles:v1' && rejectFirstSourceNormalization) {
          rejectFirstSourceNormalization = false;
          return { applied: false };
        }
        values.set(key, valueJson);
        return { applied: true };
      },
    };

    await expect(loadPlanLifecycleSagas(transport)).resolves.toEqual([valid]);

    const quarantine = JSON.parse(
      values.get('pendingPlanLifecyclesQuarantine:v1') ?? '[]',
    ) as Array<{ entry: unknown; sourceRevision: string; sourceIndex: number }>;
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toMatchObject({
      entry: invalid,
      sourceRevision: 'source-revision-1',
      sourceIndex: 0,
    });
    expect(JSON.parse(values.get('pendingPlanLifecycles:v1') ?? '[]')).toEqual([valid]);
  });

  it('preserves concurrent lifecycle updates from independent clients', async () => {
    const values = new Map<string, string>();
    let mutationReads = 0;
    let releaseMutationReads!: () => void;
    const mutationReadsReleased = new Promise<void>((resolve) => {
      releaseMutationReads = resolve;
    });
    const transport = (): PlanLifecycleSagaTransport => {
      let primaryReads = 0;
      return {
        isTauriAvailable: () => true,
        dbGetAppSetting: async (key) => {
          const valueJson = values.get(key);
          if (key === 'pendingPlanLifecycles:v1') {
            primaryReads += 1;
            if (primaryReads === 2) {
              mutationReads += 1;
              if (mutationReads === 2) releaseMutationReads();
              await mutationReadsReleased;
            }
          }
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
    };
    const saga = (planId: string): PlanLifecycleSaga => ({
      planId,
      branchName: `feature/${planId}`,
      operation: 'archive',
      phase: 'prepared',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });

    await Promise.all([
      upsertPlanLifecycleSaga(saga('first'), transport()),
      upsertPlanLifecycleSaga(saga('second'), transport()),
    ]);

    expect(JSON.parse(values.get('pendingPlanLifecycles:v1') ?? '[]')).toEqual(expect.arrayContaining([
      expect.objectContaining({ planId: 'first' }),
      expect.objectContaining({ planId: 'second' }),
    ]));
  });

  it('rejects phase regression and resurrection for the same plan generation', async () => {
    const values = new Map<string, string>();
    const transport: PlanLifecycleSagaTransport = {
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
    const prepared: PlanLifecycleSaga = {
      planId: 'shared',
      branchName: 'develop',
      operation: 'archive',
      phase: 'prepared',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    await upsertPlanLifecycleSaga(prepared, transport);
    const committed: PlanLifecycleSaga = {
      ...prepared,
      phase: 'metadata_committed',
      updatedAt: '2026-08-30T00:00:01.000Z',
    };
    await upsertPlanLifecycleSaga(committed, transport);
    await expect(upsertPlanLifecycleSaga(prepared, transport))
      .rejects.toBeInstanceOf(StalePlanLifecycleSagaError);
    await removePlanLifecycleSaga(
      'shared',
      'archive',
      'develop',
      getPlanLifecycleSagaGeneration(committed),
      transport,
    );
    await expect(upsertPlanLifecycleSaga(committed, transport))
      .rejects.toBeInstanceOf(StalePlanLifecycleSagaError);
    expect(JSON.parse(values.get('pendingPlanLifecycles:v1') ?? '[]')).toEqual([]);
  });

  it('keeps durable high-water marks after more than 512 completed plan identities', async () => {
    const values = new Map<string, string>();
    const transport: PlanLifecycleSagaTransport = {
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
    let first!: PlanLifecycleSaga;
    for (let index = 0; index < 520; index += 1) {
      const completed: PlanLifecycleSaga = {
        planId: `plan-${index}`,
        branchName: `feature/plan-${index}`,
        operation: 'archive',
        phase: 'git_cleanup_complete',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:01.000Z',
      };
      first ??= completed;
      await upsertPlanLifecycleSaga(completed, transport);
      await removePlanLifecycleSaga(
        completed.planId,
        completed.operation,
        completed.branchName,
        getPlanLifecycleSagaGeneration(completed),
        transport,
      );
    }

    await expect(upsertPlanLifecycleSaga(first, transport))
      .rejects.toBeInstanceOf(StalePlanLifecycleSagaError);
    const registry = JSON.parse(values.get('completedPlanLifecycles:v1') ?? '{}') as {
      highWatermarks?: Record<string, string>;
    };
    expect(Object.keys(registry.highWatermarks ?? {})).toHaveLength(520);
  });

  it('accepts a new plan generation when the wall clock moves backwards', async () => {
    const values = new Map<string, string>();
    const transport: PlanLifecycleSagaTransport = {
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
    const first: PlanLifecycleSaga = {
      planId: 'clock-plan',
      branchName: 'develop',
      operation: 'archive',
      phase: 'git_cleanup_complete',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
    };
    await upsertPlanLifecycleSaga(first, transport);
    await removePlanLifecycleSaga(
      first.planId,
      first.operation,
      first.branchName,
      getPlanLifecycleSagaGeneration(first),
      transport,
    );
    const second: PlanLifecycleSaga = {
      ...first,
      generation: undefined,
      phase: 'prepared',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };

    await upsertPlanLifecycleSaga(second, transport);

    expect(second.generation).toBe(2);
    expect(JSON.parse(values.get('pendingPlanLifecycles:v1') ?? '[]')).toEqual([second]);
  });
});
