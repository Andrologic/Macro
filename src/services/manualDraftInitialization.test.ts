import { describe, expect, it } from 'bun:test';
import { isManualDraftPendingInitialization } from './manualDraftInitialization';

describe('isManualDraftPendingInitialization', () => {
  const draft = {
    draft: true,
    task_source: 'standalone',
    standalone_kind: 'manual_feature' as const,
  };

  it('waits for the first message when no branch has been selected', () => {
    expect(isManualDraftPendingInitialization(draft)).toBe(true);
  });

  it('allows an existing branch or worktree to initialize immediately', () => {
    expect(isManualDraftPendingInitialization({
      ...draft,
      branch_name: 'feature/existing-work',
    })).toBe(false);
  });
});
