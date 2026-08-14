import { describe, expect, it } from 'bun:test';
import {
  loadArchitectPlanMutationJournal,
  quarantineArchitectPlanMutationJournal,
  removeArchitectPlanMutationJournal,
  upsertArchitectPlanMutationJournal,
  type ArchitectPlanMutationJournalEntry,
} from './architectPlanMutationJournal';

const JOURNAL_KEY = 'pendingArchitectPlanReplicaMutations:v1';
const QUARANTINE_KEY = 'pendingArchitectPlanReplicaMutationsQuarantine:v1';

const createTransport = (settings: Map<string, string>, onFirstCas?: (key: string) => void) => {
  let firstCas = true;
  return {
    isTauriAvailable: () => true,
    dbGetAppSetting: async (key: string) => {
      const value = settings.get(key);
      return value === undefined ? null : { key, value_json: value, updated_at: '' };
    },
    dbCompareAndSwapAppSetting: async ({ key, expectedValueJson, valueJson }: {
      key: string;
      expectedValueJson: string | null;
      valueJson: string;
    }) => {
      if (firstCas) {
        firstCas = false;
        onFirstCas?.(key);
      }
      if ((settings.get(key) ?? null) !== expectedValueJson) return { applied: false };
      settings.set(key, valueJson);
      return { applied: true };
    },
  };
};

const validEntry = (overrides: Partial<ArchitectPlanMutationJournalEntry> = {}): ArchitectPlanMutationJournalEntry => ({
  id: 'tx-1',
  workspaceKey: '/repos/api|/repos/web',
  branchName: 'develop',
  planId: 'plan-1',
  operation: 'update',
  phase: 'prepared',
  payload: { targets: [], commitMessage: 'test' },
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  ...overrides,
});

describe('architectPlanMutationJournal', () => {
  it('quarantines malformed entries, removes them from the primary journal, and preserves healthy work', async () => {
    const settings = new Map<string, string>([[
      JOURNAL_KEY,
      JSON.stringify([{ ...validEntry(), workspaceKey: '' }, validEntry()]),
    ]]);
    const transport = createTransport(settings);

    expect(await loadArchitectPlanMutationJournal(transport)).toEqual([validEntry()]);
    expect(JSON.parse(settings.get(JOURNAL_KEY) || '[]')).toEqual([validEntry()]);
    expect(JSON.parse(settings.get(QUARANTINE_KEY) || '[]')).toHaveLength(1);
  });

  it('retries an upsert after an interleaved write and preserves both entries', async () => {
    const concurrent = validEntry({ id: 'tx-concurrent', planId: 'plan-2' });
    const settings = new Map<string, string>([[JOURNAL_KEY, '[]']]);
    const transport = createTransport(settings, (key) => {
      if (key === JOURNAL_KEY) settings.set(key, JSON.stringify([concurrent]));
    });

    await upsertArchitectPlanMutationJournal(validEntry(), transport);
    expect(JSON.parse(settings.get(JOURNAL_KEY) || '[]')).toEqual([concurrent, validEntry()]);
  });

  it('retries a removal after an interleaved write without dropping the concurrent entry', async () => {
    const concurrent = validEntry({ id: 'tx-concurrent', planId: 'plan-2' });
    const settings = new Map<string, string>([[JOURNAL_KEY, JSON.stringify([validEntry()])]]);
    const transport = createTransport(settings, (key) => {
      if (key === JOURNAL_KEY) settings.set(key, JSON.stringify([validEntry(), concurrent]));
    });

    await removeArchitectPlanMutationJournal('tx-1', transport);
    expect(JSON.parse(settings.get(JOURNAL_KEY) || '[]')).toEqual([concurrent]);
  });

  it('does not overwrite a concurrent quarantine while quarantining an entry', async () => {
    const concurrentQuarantine = { entry: { malformed: true }, reason: 'concurrent', quarantinedAt: 'now' };
    const settings = new Map<string, string>([
      [JOURNAL_KEY, JSON.stringify([validEntry()])],
      [QUARANTINE_KEY, '[]'],
    ]);
    const transport = createTransport(settings, (key) => {
      if (key === QUARANTINE_KEY) settings.set(key, JSON.stringify([concurrentQuarantine]));
    });

    await quarantineArchitectPlanMutationJournal(validEntry(), 'test', transport);
    const quarantine = JSON.parse(settings.get(QUARANTINE_KEY) || '[]');
    expect(quarantine).toHaveLength(2);
    expect(quarantine[0]).toEqual(concurrentQuarantine);
    expect(JSON.parse(settings.get(JOURNAL_KEY) || '[]')).toEqual([]);
  });
});
