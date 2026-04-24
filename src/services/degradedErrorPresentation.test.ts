import { describe, expect, it } from 'bun:test';
import {
  presentGitFlowBlockingIssue,
  presentMetadataSyncIssue,
  presentReadOnlyProjectIssue,
  presentReplicaIssue,
  presentServiceError,
  presentWorktreeError,
} from './degradedErrorPresentation';

describe('degradedErrorPresentation', () => {
  it('presents missing metadata replicas as repairable blockers', () => {
    const presentation = presentReplicaIssue({
      reason: 'missing_replica',
      planId: 'plan-1',
      missingCount: 2,
    });

    expect(presentation.title).toContain('2 repositories');
    expect(presentation.primaryAction).toBe('repair_metadata');
    expect(presentation.severity).toBe('danger');
  });

  it('presents divergent metadata replicas with newest repair guidance', () => {
    const presentation = presentReplicaIssue({
      reason: 'content_diverged',
      planId: 'plan-1',
    });

    expect(presentation.title).toContain('differs');
    expect(presentation.nextStep).toContain('newest');
  });

  it('presents read-only projects as context-only', () => {
    const presentation = presentReadOnlyProjectIssue({
      projectName: 'Web',
      reason: 'missing_git',
    });

    expect(presentation.body).toContain('context');
    expect(presentation.primaryAction).toBe('configure_git');
  });

  it('presents branch checked out worktree errors with a concrete next step', () => {
    const presentation = presentWorktreeError(
      'Cannot create a task worktree for feature/demo because that branch is still checked out in the primary repository and has uncommitted changes'
    );

    expect(presentation.title).toContain('workspace');
    expect(presentation.nextStep).toContain('Commit, stash, or discard');
  });

  it('presents GitFlow conflicts as resolvable merge blockers', () => {
    const presentation = presentGitFlowBlockingIssue({
      blockingKind: 'merge_conflict',
      conflictFiles: ['src/main.ts'],
      reason: 'Cannot finalize plan because /repo would conflict.',
    });

    expect(presentation.title).toContain('Resolve');
    expect(presentation.primaryAction).toBe('use_ai_assistant');
  });

  it('presents @macro metadata states with clear actions', () => {
    const presentation = presentMetadataSyncIssue({
      reason: 'auth_required',
      nextAction: 'configure_auth',
    });

    expect(presentation.title).toContain('authentication');
    expect(presentation.primaryAction).toBe('configure_git');
  });

  it('detects generic read-only service errors', () => {
    const presentation = presentServiceError('Cannot promote project Web: the subproject is read-only.');

    expect(presentation.title).toContain('not ready');
    expect(presentation.primaryAction).toBe('open_project_settings');
  });
});
