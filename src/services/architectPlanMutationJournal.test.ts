import { describe, expect, it } from 'bun:test';
import {
  loadArchitectPlanMutationJournal,
  type ArchitectPlanMutationJournalEntry,
} from './architectPlanMutationJournal';

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
      'pendingArchitectPlanReplicaMutations:v1',
      JSON.stringify([{ ...validEntry(), workspaceKey: '' }, validEntry()]),
    ]]);
    const transport = {
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key: string) => {
        const value = settings.get(key);
        return value === undefined ? null : { key, value_json: value, updated_at: '' };
      },
      dbSetAppSetting: async ({ key, valueJson }: { key: string; valueJson: string }) => {
        settings.set(key, valueJson);
        return { key, value_json: valueJson, updated_at: '' };
      },
    };

    expect(await loadArchitectPlanMutationJournal(transport)).toEqual([validEntry()]);
    expect(JSON.parse(settings.get('pendingArchitectPlanReplicaMutations:v1') || '[]')).toEqual([validEntry()]);
    expect(JSON.parse(settings.get('pendingArchitectPlanReplicaMutationsQuarantine:v1') || '[]')).toHaveLength(1);
  });
});
