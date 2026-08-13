import { describe, expect, it, mock } from 'bun:test';

const actualTauriIpc = await import('./tauriIpc');

mock.module('./tauriIpc', () => ({
  ...actualTauriIpc,
  isTauriAvailable: () => true,
  dbGetAppSetting: async () => ({
    key: 'pendingPlanLifecycles:v1',
    value_json: JSON.stringify([{ planId: 'plan-1', branchName: 'develop', operation: 'delete', phase: 'impossible' }]),
    updated_at: '2026-08-13T00:00:00.000Z',
  }),
}));

const saga = await import('./planLifecycleSaga');

describe('planLifecycleSaga', () => {
  it('fails closed when a persisted lifecycle phase is invalid', async () => {
    await expect(saga.loadPlanLifecycleSagas()).rejects.toMatchObject({
      name: 'PlanLifecycleSagaCorruptionError',
    });
  });
});
