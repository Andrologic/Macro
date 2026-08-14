import { describe, expect, it } from 'bun:test';
import { resolveTaskReference, toPlanLocatorKey, toTaskRuntimeId } from './durableIdentity';

describe('durable identity', () => {
  it('qualifies plans and tasks without changing their business ids', () => {
    expect(toPlanLocatorKey({ branchName: 'develop', planId: 'shared' }))
      .not.toBe(toPlanLocatorKey({ branchName: 'release/next', planId: 'shared' }));
    expect(toTaskRuntimeId({ branchName: 'develop', planId: 'plan-a', nodeId: 'same' }))
      .not.toBe(toTaskRuntimeId({ branchName: 'develop', planId: 'plan-b', nodeId: 'same' }));
  });

  it('resolves a legacy node id only when it is unambiguous', () => {
    const unique = [{ id: 'qualified-a', node_id: 'legacy-a' }];
    expect(resolveTaskReference(unique, 'legacy-a')?.id).toBe('qualified-a');

    const ambiguous = [
      { id: 'qualified-a', node_id: 'shared' },
      { id: 'qualified-b', node_id: 'shared' },
    ];
    expect(resolveTaskReference(ambiguous, 'shared')).toBeUndefined();
  });
});
