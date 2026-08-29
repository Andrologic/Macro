import { describe, expect, it } from 'bun:test';
import {
  presentGitFlowBlockingIssue,
  presentMetadataSyncIssue,
  presentReadOnlyProjectIssue,
  presentReplicaIssue,
  presentServiceError,
  presentWorktreeError,
  resolveDegradedErrorMessage,
  resolveDegradedErrorPresentation,
} from './degradedErrorPresentation';

describe('degradedErrorPresentation', () => {
  it('presents missing metadata replicas as repairable blockers', () => {
    const presentation = presentReplicaIssue({
      reason: 'missing_replica',
      planId: 'plan-1',
      missingCount: 2,
    });

    expect(presentation.title.key).toBe('errors.degraded.replica.missing.titlePlural');
    expect(presentation.title.params).toEqual({ count: 2 });
    expect(presentation.primaryAction).toBe('repair_metadata');
    expect(presentation.severity).toBe('danger');
  });

  it('presents divergent metadata replicas with newest repair guidance', () => {
    const presentation = presentReplicaIssue({
      reason: 'content_diverged',
      planId: 'plan-1',
    });

    expect(presentation.title.key).toBe('errors.degraded.replica.diverged.title');
    expect(presentation.nextStep?.key).toBe('errors.degraded.replica.diverged.nextStep');
  });

  it('presents read-only projects as context-only', () => {
    const presentation = presentReadOnlyProjectIssue({
      projectName: 'Web',
      reason: 'missing_git',
    });

    expect(presentation.body.key).toBe('errors.degraded.readOnly.namedBody');
    expect(presentation.body.params).toEqual({ projectName: 'Web' });
    expect(presentation.primaryAction).toBe('configure_git');
  });

  it('presents branch checked out worktree errors with a concrete next step', () => {
    const presentation = presentWorktreeError(
      'Cannot create a task worktree for feature/demo because that branch is still checked out in the primary repository and has uncommitted changes'
    );

    expect(presentation.title.key).toBe('errors.degraded.worktree.checkedOut.title');
    expect(presentation.nextStep?.key).toBe('errors.degraded.worktree.checkedOut.nextStep');
  });

  it('presents Git workflow conflicts as resolvable merge blockers', () => {
    const presentation = presentGitFlowBlockingIssue({
      blockingKind: 'merge_conflict',
      conflictFiles: ['src/main.ts'],
      reason: 'Cannot finalize plan because /repo would conflict.',
    });

    expect(presentation.title.key).toBe('errors.degraded.gitFlow.conflict.title');
    expect(presentation.nextStep?.key).toBe('errors.degraded.gitFlow.conflict.filesNextStep');
    expect(presentation.primaryAction).toBe('use_ai_assistant');
  });

  it('presents @macro metadata states with clear actions', () => {
    const presentation = presentMetadataSyncIssue({
      reason: 'auth_required',
      nextAction: 'configure_auth',
    });

    expect(presentation.title.key).toBe('errors.degraded.metadata.authRequired.title');
    expect(presentation.primaryAction).toBe('configure_git');
  });

  it('detects generic read-only service errors', () => {
    const presentation = presentServiceError('Cannot promote project Web: the project is read-only.');

    expect(presentation.title.key).toBe('errors.degraded.service.gitNotReady.title');
    expect(presentation.primaryAction).toBe('open_project_settings');
  });

  it('presents too many open files as temporary resource pressure', () => {
    const presentation = presentServiceError('Failed to read workspace state: Too many open files (os error 24)');

    expect(presentation.title.key).toBe('errors.degraded.service.resourcePressure.title');
    expect(presentation.severity).toBe('warning');
    expect(presentation.nextStep?.key).toBe('errors.degraded.service.resourcePressure.nextStep');
  });

  it('presents a missing Git object without exposing the raw libgit2 message', () => {
    const presentation = presentServiceError({
      code: 'GIT_OBJECT_MISSING',
      message: 'A Git object required for this operation is missing.',
      details: {
        objectId: '0123456789abcdef0123456789abcdef01234567',
        worktreeModified: false,
      },
    });

    expect(presentation.title.key).toBe('errors.degraded.service.gitObjectMissing.title');
    expect(presentation.body.key).toBe('errors.degraded.service.gitObjectMissing.body');
    expect(presentation.nextStep?.key).toBe('errors.degraded.service.gitObjectMissing.nextStep');
    expect(presentation.severity).toBe('warning');
    expect(presentation.technicalDetails).toContain('0123456789abcdef');
  });

  it('does not claim the worktree is unchanged without read-only operation context', () => {
    const presentation = presentServiceError({
      code: 'GIT_OBJECT_MISSING',
      message: 'A Git object required for this operation is missing.',
      details: { worktreeModified: null },
    });

    expect(presentation.body.key).toBe('errors.degraded.service.gitObjectMissing.bodyUncertain');
  });

  it('identifies a damaged Macro checkpoint without blaming the project repository', () => {
    const presentation = presentServiceError({
      code: 'DIRECT_CHECKPOINT_CORRUPT',
      message: "Macro's internal review checkpoint is incomplete.",
      details: {
        checkpointId: 'task-1-0123456789abcdef',
        objectId: '0123456789abcdef0123456789abcdef01234567',
        acceptedHistoryAtRisk: true,
        worktreeModified: false,
      },
    });

    expect(presentation.title.key).toBe('errors.degraded.service.directCheckpointCorrupt.title');
    expect(presentation.body.key).toBe('errors.degraded.service.directCheckpointCorrupt.body');
    expect(presentation.technicalDetails).toContain('acceptedHistoryAtRisk');
    expect(presentation.technicalDetails).not.toContain('C:\\Users');
  });

  it('presents a checkpoint project mismatch as a settings action without retry', () => {
    const presentation = presentServiceError({
      code: 'DIRECT_CHECKPOINT_PROJECT_MISMATCH',
      message: "Macro's internal review checkpoint belongs to another project path.",
      details: { checkpointId: 'task-1-0123456789abcdef' },
    });

    expect(presentation.title.key)
      .toBe('errors.degraded.service.directCheckpointProjectMismatch.title');
    expect(presentation.body.key)
      .toBe('errors.degraded.service.directCheckpointProjectMismatch.body');
    expect(presentation.primaryAction).toBe('open_project_settings');
  });

  it('routes missing direct-mode configuration to project settings', () => {
    const presentation = presentServiceError({
      code: 'DIRECT_MODE_CONFIGURATION_REQUIRED',
      message: 'Direct review requires project configuration.',
      details: { projectId: 'project-direct' },
    });

    expect(presentation.title.key)
      .toBe('errors.degraded.service.directModeConfigurationRequired.title');
    expect(presentation.primaryAction).toBe('open_project_settings');
  });

  it('presents missing plan metadata as a repairable metadata issue', () => {
    const presentation = presentServiceError({
      code: 'PLAN_METADATA_MISSING',
      message: 'Plan not found: plan-1778264869268-ples-0',
    });

    expect(presentation.title.key).toBe('errors.degraded.service.metadataMissing.title');
    expect(presentation.primaryAction).toBe('repair_metadata');
    expect(presentation.body.key).toBe('errors.degraded.service.metadataMissing.body');
  });

  it('presents workspace state failures without generic attention copy', () => {
    const presentation = presentServiceError({
      code: 'WORKSPACE_STATE_UNAVAILABLE',
      message: 'Failed to read workspace state',
    });

    expect(presentation.title.key).toBe('errors.degraded.service.workspaceUnavailable.title');
    expect(presentation.primaryAction).toBe('retry');
  });

  it('presents stable backend validation errors without serde serialization noise', () => {
    const presentation = presentServiceError({
      code: 'Validation',
      message: 'Staged files outside this task were found: src/extra.ts.',
    });

    expect(presentation.body.key).toBe('errors.degraded.fallback.dynamic');
    expect(presentation.body.params).toEqual({
      message: 'Staged files outside this task were found: src/extra.ts.',
    });
    expect(presentation.technicalDetails).not.toContain('cannot serialize tagged newtype variant');
  });

  it('resolves keys and interpolation parameters only at the presentation boundary', () => {
    const presentation = presentReplicaIssue({
      reason: 'missing_replica',
      planId: 'plan-1',
      missingCount: 3,
    });
    const resolved = resolveDegradedErrorPresentation(presentation, (key, options) => {
      if (key === 'errors.degraded.replica.missing.titlePlural') {
        return `Métadonnées absentes dans ${options?.count} dépôts`;
      }
      return `traduit:${key}`;
    });

    expect(resolved.title).toBe('Métadonnées absentes dans 3 dépôts');
    expect(resolved.body).toBe('traduit:errors.degraded.replica.missing.body');
    expect(resolved.primaryAction).toBe('repair_metadata');
  });

  it('uses a localized fallback key when a requested translation is unavailable', () => {
    const resolved = resolveDegradedErrorMessage(
      {
        key: 'errors.degraded.worktree.checkedOut.title',
        fallbackKey: 'errors.degraded.fallback.title',
      },
      (key) => key === 'errors.degraded.fallback.title' ? 'Une intervention est nécessaire' : key
    );

    expect(resolved).toBe('Une intervention est nécessaire');
  });
});
