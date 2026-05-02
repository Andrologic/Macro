import { describe, expect, it, mock } from 'bun:test';
import {
  buildPlanFinalizationTaskId,
  type PlanFinalizationRuntimeState,
} from './planFinalization';
import {
  loadPlanFinalizationReviewRuntime,
  resolvePlanFinalizationActivationContext,
  sendPlanFinalizationConflictPrompt,
} from './planFinalizationRuntime';

const buildPlanRecord = () => ({
  id: 'plan-1',
  slug: 'checkout-refresh',
  title: 'Checkout refresh',
  description: '',
  status: 'in_progress' as const,
  targetBranch: 'develop',
  projectId: 'web',
  projectIds: ['web'],
  createdAt: '2026-04-22T10:00:00.000Z',
  updatedAt: '2026-04-22T10:00:00.000Z',
  nodes: [],
  predictedBranches: [],
});

describe('planFinalizationRuntime', () => {
  it('loads plan review with synced base branches before building runtime state', async () => {
    const loadReview = mock(async () => ({
      plan: buildPlanRecord(),
      tasks: [],
      repositories: [],
    }));

    const runtime = await loadPlanFinalizationReviewRuntime({
      summary: {
        id: 'plan-1',
        storageBranch: 'develop',
      },
      loadReview,
    });

    expect(loadReview).toHaveBeenCalledWith({
      branchName: 'develop',
      planId: 'plan-1',
      syncBaseBranches: true,
    });
    expect(runtime).toMatchObject({
      planId: 'plan-1',
      branchName: 'develop',
      phase: 'ready',
      taskStatus: 'Pending',
    });
  });

  it('prefers the selected runtime repository when resolving the activation context', () => {
    const context = resolvePlanFinalizationActivationContext({
      task: {
        execution_targets: [
          {
            projectId: 'web',
            branchName: 'develop',
            targetBranchName: 'develop',
            executionKind: 'repository_root',
            worktreeKey: 'plan-finalization:web:web',
          },
        ],
        plan_target_branch: 'develop',
        assigned_branch: 'develop',
      },
      runtime: {
        repositories: [
          {
            id: 'api::/repos/api',
            projectId: 'api',
            repoPath: '/repos/api',
            planBranchName: 'plan/checkout',
            baseBranchName: 'integration',
            isClean: true,
            hasChanges: true,
            mergeable: true,
            conflictFiles: [],
            mergeInProgress: false,
            diff: '',
            checkStatus: 'not_run',
            blockingKind: null,
            nextAction: null,
            blockingReason: null,
          },
        ],
      },
      preferredProjectId: 'api',
      resolveRepoPath: () => null,
    });

    expect(context).toEqual({
      repoPath: '/repos/api',
      branchName: 'integration',
    });
  });

  it('reuses the current Implement conversation when posting automatic conflict-resolution help', async () => {
    const setMode = mock(() => undefined);
    const setSelectedTask = mock(() => undefined);
    const activateTask = mock(async () => undefined);
    const ensureConversationForCurrentMode = mock(async () => 'conv-1');
    const createConversation = mock(async () => ({ id: 'created-conv' }));
    const sendMessage = mock(async () => undefined);

    const runtime: Pick<PlanFinalizationRuntimeState, 'blockedRepositories' | 'review'> = {
      blockedRepositories: [
        {
          id: 'web::/repos/web',
          projectId: 'web',
          repoPath: '/repos/web',
          planBranchName: 'plan/checkout',
          baseBranchName: 'develop',
          isClean: false,
          hasChanges: true,
          mergeable: false,
          conflictFiles: ['src/conflict.ts'],
          mergeInProgress: true,
          diff: '',
          checkStatus: 'not_run',
          blockingKind: 'merge_conflict',
          nextAction: 'resolve_conflicts',
          blockingReason: 'Conflict detected in /repos/web.',
        },
      ],
      review: {
        plan: buildPlanRecord(),
        tasks: [],
        repositories: [],
      },
    };

    const conversationId = await sendPlanFinalizationConflictPrompt({
      task: {
        id: buildPlanFinalizationTaskId('plan-1'),
        title: 'Finalize plan: Checkout refresh',
        plan_id: 'plan-1',
        plan_title: 'Checkout refresh',
        project_id: 'web',
      },
      runtime,
      selectedGroupId: 'group-1',
      selectedTaskId: buildPlanFinalizationTaskId('plan-1'),
      ensureConversationForCurrentMode,
      createConversation,
      sendMessage,
      activateTask,
      setMode,
      setSelectedTask,
      internalAgentProfile: 'repo_auditor',
    });

    expect(conversationId).toBe('conv-1');
    expect(setMode).toHaveBeenCalledWith('Implement');
    expect(setSelectedTask).not.toHaveBeenCalled();
    expect(activateTask).not.toHaveBeenCalled();
    expect(createConversation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        taskId: buildPlanFinalizationTaskId('plan-1'),
        internalAgentProfile: 'repo_auditor',
      })
    );
  });
});
