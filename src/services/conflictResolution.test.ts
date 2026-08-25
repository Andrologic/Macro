import { describe, expect, it } from 'bun:test';
import {
  buildMacroConflictAssistantPrompt,
  buildPlanFinalizationConflictAssistantPrompt,
  describeMacroNextStep,
  describePlanFinalizationNextStep,
  toMacroConflictResolutionEntries,
  toPlanConflictResolutionEntries,
} from './conflictResolution';

describe('conflictResolution', () => {
  it('maps plan finalization blockers into conflict resolution entries', () => {
    const entries = toPlanConflictResolutionEntries([
      {
        id: 'api::/repos/api',
        projectId: 'api',
        repoPath: '/repos/api',
        planBranchName: 'plan/checkout',
        baseBranchName: 'develop',
        isClean: false,
        hasChanges: true,
        mergeable: false,
        conflictFiles: ['src/conflict.ts'],
        mergeInProgress: true,
        diff: 'diff --git a/src/conflict.ts b/src/conflict.ts',
        checkStatus: 'not_run',
        blockingKind: 'merge_conflict',
        nextAction: 'resolve_conflicts',
        blockingReason: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
      },
    ]);

    expect(entries).toEqual([
      {
        id: 'api::/repos/api',
        repoPath: '/repos/api',
        subtitle: 'plan/checkout -> develop',
        worktreePath: null,
        statusLabel: 'Conflict',
        statusTone: 'danger',
        reason: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
        nextStep: 'Resolve the conflicting files, then retry finalization.',
        conflictFiles: ['src/conflict.ts'],
      },
    ]);
  });

  it('maps @macro blockers into conflict resolution entries', () => {
    const entries = toMacroConflictResolutionEntries([
      {
        repoPath: '/repos/web',
        projectId: 'web',
        worktreePath: '/repos/web/.git/worktrees/@macro',
        state: 'conflict',
        error: null,
        reason: 'merge_conflict',
        nextAction: 'resolve_conflict',
        conflictFiles: ['macro/state.json'],
      },
    ]);

    expect(entries).toEqual([
      {
        id: 'web::/repos/web',
        repoPath: '/repos/web',
        subtitle: '@macro metadata branch',
        worktreePath: '/repos/web/.git/worktrees/@macro',
        statusLabel: 'conflict',
        statusTone: 'danger',
        reason: 'merge_conflict',
        nextStep: 'Resolve the conflicted metadata files, then retry sync.',
        conflictFiles: ['macro/state.json'],
      },
    ]);
  });

  it('builds structured assistant prompts for plan finalization blockers', () => {
    const prompt = buildPlanFinalizationConflictAssistantPrompt({
      planTitle: 'Checkout',
      repositories: [
        {
          id: 'api::/repos/api',
          projectId: 'api',
          repoPath: '/repos/api',
          planBranchName: 'plan/checkout',
          baseBranchName: 'develop',
          isClean: false,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/conflict.ts'],
          mergeInProgress: false,
          diff: '',
          checkStatus: 'not_run',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Cannot finalize plan because /repos/api would conflict in: src/conflict.ts.',
        },
      ],
    });

    expect(prompt).toContain('Checkout');
    expect(prompt).toContain('This flow is preflight-blocked');
    expect(prompt).toContain('/repos/api');
    expect(prompt).toContain('src/conflict.ts');
  });

  it('builds structured assistant prompts for @macro blockers', () => {
    const prompt = buildMacroConflictAssistantPrompt({
      repositories: [
        {
          repoPath: '/repos/web',
          projectId: 'web',
          worktreePath: '/repos/web/.git/worktrees/@macro',
          state: 'conflict',
          error: 'Metadata has unresolved merge conflicts.',
          reason: 'merge_conflict',
          nextAction: 'resolve_conflict',
          conflictFiles: ['macro/state.json'],
        },
      ],
    });

    expect(prompt).toContain('@macro metadata sync blockers');
    expect(prompt).toContain('/repos/web');
    expect(prompt).toContain('macro/state.json');
  });

  it('describes next steps for plan and @macro workflows', () => {
    expect(describePlanFinalizationNextStep('finish_or_abort_merge')).toBe(
      'Finish or abort the in-progress merge, then retry finalization.'
    );
    expect(describeMacroNextStep('configure_auth')).toBe(
      'Configure Git authentication before retrying sync.'
    );
  });
});
