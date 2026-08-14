import { describe, expect, it } from 'bun:test';
import { parsePlanLifecycleSagaJournal, parsePlanLifecycleSagas } from './planLifecycleSaga';

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
});
