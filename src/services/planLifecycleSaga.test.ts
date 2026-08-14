import { describe, expect, it } from 'bun:test';
import { getPlanLifecycleSagaKey, parsePlanLifecycleSagas } from './planLifecycleSaga';

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
});
