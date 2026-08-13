import { describe, expect, it, mock } from 'bun:test';

const actualTauriIpc = await import('./tauriIpc');

mock.module('./tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  dbGetAppSetting: async () => ({
    key: 'pendingPlanLifecycles:v1',
    value_json: JSON.stringify([{ planId: 'plan-1', branchName: 'develop', operation: 'delete', phase: 'metadata_commit_pending', requiresMetadataCommit: true, createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z' }]),
    updated_at: '2026-08-13T00:00:00.000Z',
  }),
}));

const saga = await import('./planLifecycleSaga');

describe('planLifecycleSaga', () => {
  it('fails closed for a semantically impossible delete phase', async () => {
    await expect(saga.loadPlanLifecycleSagas()).rejects.toMatchObject({
      name: 'PlanLifecycleSagaCorruptionError',
    });
  });
});
