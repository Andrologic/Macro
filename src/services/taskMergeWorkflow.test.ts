import { describe, expect, it, mock } from 'bun:test';
import { createTaskMergeWorkflow } from './taskMergeWorkflow';
import { createTaskReviewWorkflow } from './taskReviewWorkflow';
import { toPersistedMergeWorkflowSession } from './mergeWorkflowPersistence';
import { archiveTaskMergeWorkflow } from './taskArchiveWorkflow';
import { runTaskPlanFinalizationWorkflow } from './taskPlanFinalizationWorkflow';
import { buildTaskCompletionMergeWorkflowRuntime, runRepositoryMergeStrategy, cleanupTaskExecutionTargets } from './taskRepositoryWorkflow';
import { buildInitialMergeWorkflowRuntimeState, toPendingMergeWorkflowRepositoryResult, type MergeWorkflowRuntimeState } from './mergeWorkflow';
import type { TaskMergeWorkflowPorts, TaskWorkflowTask, TaskWorkflowTarget } from './taskPortsWorkflow';
import type { GitStatusDto, GitWorkflowSessionDto } from './tauriIpc';
import type { ArchitectPlanRecord } from './architectPlanService';

const task = {
  id: 'task-a', title: 'Implement A', status: 'InReview', task_source: 'standalone',
  plan_id: 'plan-a', plan_title: null, standalone_kind: 'legacy', draft: false,
} as TaskWorkflowTask;
const target = (projectId: string): TaskWorkflowTarget & { worktreePath: string } => ({
  projectId, repoPath: `/repo/${projectId}`, worktreePath: `/work/${projectId}`,
  branchName: 'feature/a', planBranchName: 'develop', worktreeKey: projectId,
});
const receipt = (status: GitWorkflowSessionDto['status'] = 'integrated'): GitWorkflowSessionDto => ({
  taskId: task.id, sessionId: 'session-a', sourceBranch: 'feature/a', targetBranch: 'develop',
  sourceCommit: 'source', targetCommit: 'target', integratedCommit: status === 'integrated' ? 'merged' : null,
  status, output: 'Integrated A',
});
const clean: GitStatusDto = {
  branch: 'develop', head_commit: null, staged_files: [], unstaged_files: [], untracked_files: [],
  conflictedFiles: [], mergeInProgress: false, is_clean: true, has_origin: false, has_upstream: false, ahead: 0, behind: 0,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const unexpected = (): never => { throw new Error('Unexpected port invocation'); };

function fixture(tasks: TaskWorkflowTask[] = [task]) {
  const runtimes = new Map<string, MergeWorkflowRuntimeState>();
  const persisted: Array<MergeWorkflowRuntimeState | null> = [];
  const git: TaskMergeWorkflowPorts['git'] = {
    gitWorkflow: mock(async () => null), gitStatus: mock(async () => clean),
    gitCheckout: unexpected, gitDiff: mock(async () => 'diff'),
    gitMergeCheck: mock(async () => ({ mergeable: true, conflictFiles: [], hasChanges: true, ahead: 1, behind: 0 })),
    gitBranchList: mock(async () => ({ current: 'develop', local: [], remote: [] })), gitRebaseCheck: unexpected,
    isTauriAvailable: () => false, workspaceArchiveManualFeature: unexpected,
    gitWorktreeInspect: unexpected, gitWorkflowCleanup: unexpected,
  };
  const ports: TaskMergeWorkflowPorts = {
    translate: (_key, fallback) => fallback,
    findTask: (id) => tasks.find((candidate) => candidate.id === id),
    readRuntime: (id) => runtimes.get(id) ?? null,
    publishRuntime: (id, runtime) => { runtimes.set(id, runtime); },
    persistRuntime: mock(async (captured, runtime) => {
      persisted.push(runtime);
      if (runtime) runtimes.set(captured.id, runtime);
      else runtimes.delete(captured.id);
    }),
    reportError: mock(() => {}), findPlanSummary: () => undefined,
    getExecutionTargets: () => [target('a')], getExecutionTargetsWithRepoPaths: () => [target('a')],
    assertExecutionTargetRunnable: () => {}, isGitExecutionTarget: () => true, isDirectEditTarget: () => false,
    getTaskIntegrationBranch: () => 'develop', getReviewTargetBranch: () => 'develop',
    ensureIntegrationWorktree: mock(async () => null), syncIntegrationBranch: mock(async () => {}),
    git, loadPlanReview: unexpected,
    isPlanMutationActive: () => false, isTaskCommandRunActive: () => false,
    acquireOperation: mock(() => true), releaseOperation: mock(() => {}), mutationBlockedMessage: () => 'Operation active',
    validatePlanFinalization: () => {}, createTaskTodosBlockedErrorFromPlan: async () => null,
    createTaskArtifactsBlockedErrorFromPlan: async () => null, assertTaskBranchExclusive: () => {},
    prepareExecutionTargets: mock(async () => [target('a')]), isMissingBaseBranchError: () => false,
    completionMergePolicy: () => 'merge_commit', serializeRepositoryOperation: async (_repo, operation) => operation(),
    loadPlanLifecycleSagas: async () => [], resolveTargetBranch: (branch) => branch,
    finalizePlanIntoBaseBranch: unexpected, refreshCatalog: mock(async () => {}), clearPlanRuntime: mock(() => {}),
    applyTaskCleanup: mock(async () => {}), syncManualFeatureTaskMetadata: unexpected, commitManualFeatureTaskMetadata: unexpected,
    deselectTaskIfSelected: mock(() => {}), getTaskPlanStorageBranch: () => 'develop', getTaskBusinessId: () => task.id,
    deriveCompletedPlanStatus: (plan) => ({ nodes: plan.nodes, predictedBranches: plan.predictedBranches, status: plan.status }),
    mutateArchitectPlanTaskStatus: unexpected, publishCompletedPlan: mock(() => {}), writeArchitectTaskExecution: unexpected,
    commitArchitectPlanMetadataForTask: unexpected, completeTask: mock(async () => {}),
  };
  return { ports, git, runtimes, persisted };
}

describe('task review workflow without stores', () => {
  it('reuses a load and ignores a superseded load before persistence', async () => {
    const { ports, git, persisted } = fixture();
    const pending = deferred<GitWorkflowSessionDto | null>();
    let calls = 0;
    git.gitWorkflow = mock(async () => ++calls === 1 ? pending.promise : receipt());
    const review = createTaskReviewWorkflow(ports);
    const first = review.load(task.id);
    const shared = review.load(task.id);
    await Promise.resolve();
    const latest = await review.load(task.id, { force: true });
    pending.resolve(receipt());
    expect(await first).toBe(latest);
    expect(await shared).toBe(latest);
    expect(git.gitWorkflow).toHaveBeenCalledTimes(2);
    expect(persisted).toHaveLength(1);
  });

  it('recognizes native integration before preparing or synchronizing the target', async () => {
    const { ports, git } = fixture();
    git.gitWorkflow = mock(async () => receipt());
    const runtime = await buildTaskCompletionMergeWorkflowRuntime(ports, {
      task, executionTargets: [target('a')], prepareTargetBranches: true, syncStandaloneTargets: true,
    });
    expect(runtime.repositories[0].progressState).toBe('merged');
    expect(ports.ensureIntegrationWorktree).not.toHaveBeenCalled();
    expect(ports.syncIntegrationBranch).not.toHaveBeenCalled();
    expect(git.gitStatus).not.toHaveBeenCalled();
  });

  it('persists review errors and retains the task identity', async () => {
    const { ports, git, persisted } = fixture();
    git.gitWorkflow = async () => { throw new Error('inspect failed'); };
    await expect(createTaskReviewWorkflow(ports).load(task.id)).rejects.toMatchObject({ message: 'inspect failed' });
    expect(persisted.at(-1)).toMatchObject({ taskId: task.id, phase: 'failed' });
  });
});

describe('task merge workflow without stores', () => {
  it('does not release an operation guard it never acquired', async () => {
    const { ports } = fixture();
    ports.acquireOperation = () => false;
    await expect(createTaskMergeWorkflow(ports, { load: unexpected }).run(task.id)).rejects.toThrow('Operation active');
    expect(ports.releaseOperation).not.toHaveBeenCalled();
  });

  it('deduplicates a run and releases its guard when validation rejects', async () => {
    const { ports } = fixture();
    const gate = deferred<Error | null>();
    ports.createTaskTodosBlockedErrorFromPlan = () => gate.promise;
    const workflow = createTaskMergeWorkflow(ports, { load: unexpected });
    const first = workflow.run(task.id);
    const second = workflow.run(task.id);
    const settled = Promise.allSettled([first, second]);
    gate.resolve(new Error('Open todos'));
    const results = await settled;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(ports.acquireOperation).toHaveBeenCalledTimes(1);
    expect(ports.releaseOperation).toHaveBeenCalledTimes(1);
    expect(ports.completeTask).not.toHaveBeenCalled();
  });

  it('keeps a successful first repository after the second merge fails and resumes from native receipts', async () => {
    const { ports, git, persisted } = fixture();
    const targets = [target('a'), target('b')];
    const integrated = new Set<string>();
    let failSecond = true;
    const actions: string[] = [];
    ports.getExecutionTargets = () => targets;
    ports.getExecutionTargetsWithRepoPaths = () => targets;
    ports.prepareExecutionTargets = mock(async (_task, skip) => targets.filter((candidate) => !skip.has(candidate.worktreeKey)));
    git.gitWorkflow = async (input) => {
      if (input.action === 'inspect') return integrated.has(input.repoPath) ? receipt() : null;
      actions.push(input.repoPath);
      if (input.repoPath === '/repo/b' && failSecond) throw new Error('second repository failed');
      integrated.add(input.repoPath);
      return receipt();
    };
    const review = createTaskReviewWorkflow(ports);
    const workflow = createTaskMergeWorkflow(ports, review);
    await expect(workflow.run(task.id)).rejects.toMatchObject({ message: 'second repository failed' });
    expect(integrated.has('/repo/a')).toBe(true);
    expect(persisted.some((runtime) => runtime?.repositories[0]?.progressState === 'merged')).toBe(true);
    expect(ports.completeTask).not.toHaveBeenCalled();
    failSecond = false;
    await workflow.run(task.id);
    expect(actions).toEqual(['/repo/a', '/repo/b', '/repo/b']);
    expect(ports.completeTask).toHaveBeenCalledWith(task);
    expect(ports.releaseOperation).toHaveBeenCalledTimes(2);
  });

  it('finishes a captured task after the selected catalog no longer contains it', async () => {
    const { ports, git } = fixture();
    git.gitWorkflow = async (input) => {
      if (input.action === 'inspect') return null;
      ports.findTask = () => undefined;
      return receipt();
    };
    await createTaskMergeWorkflow(ports, createTaskReviewWorkflow(ports)).run(task.id);
    expect(ports.completeTask).toHaveBeenCalledWith(task);
    expect(ports.applyTaskCleanup).toHaveBeenCalledWith(task, []);
  });

  it('requires a native integration receipt before reporting a strategy successful', async () => {
    const { ports, git } = fixture();
    const repository = toPendingMergeWorkflowRepositoryResult({ id: 'a', projectId: 'a', repoPath: '/repo/a', sourceBranchName: 'feature/a', targetBranchName: 'develop' });
    repository.workflowSession = receipt('prepared');
    git.gitWorkflow = mock(async () => receipt('conflicted'));
    await expect(runRepositoryMergeStrategy(ports, task.id, repository, 'merge_commit')).rejects.toThrow('Merge integration was not confirmed');
    expect(git.gitWorkflow).toHaveBeenCalledWith(expect.objectContaining({ action: 'merge_commit', expectedSessionId: 'session-a' }));
  });

  it('resumes metadata completion when the task is already completed but its workflow remains durable', async () => {
    const completed = { ...task, status: 'Completed' } as TaskWorkflowTask;
    const { ports, git, runtimes } = fixture([completed]);
    runtimes.set(task.id, { ...buildInitialMergeWorkflowRuntimeState({ taskId: task.id, kind: 'task_completion' }), phase: 'archiving' });
    ports.prepareExecutionTargets = mock(async (_task, skip) => {
      expect(skip.has('a')).toBe(true);
      return [];
    });
    git.gitWorkflow = mock(async () => receipt());
    await createTaskMergeWorkflow(ports, createTaskReviewWorkflow(ports)).run(task.id);
    expect(ports.completeTask).toHaveBeenCalledWith(completed);
    expect(git.gitWorkflow).toHaveBeenCalledTimes(1);
  });

  for (const failure of ['completion_write', 'completion_ack', 'receipt_clear'] as const) {
    it(`retains durable recovery through ${failure} and retries after restart without merging again`, async () => {
      const { ports, git, runtimes } = fixture();
      let durableTask: TaskWorkflowTask = { ...task };
      let fail = true;
      let integrated = false;
      let mergeCount = 0;
      const completionEvents: string[] = [];
      const persistRuntime = ports.persistRuntime;
      ports.findTask = () => durableTask;
      ports.persistRuntime = async (captured, runtime) => {
        if (runtime === null) {
          completionEvents.push('clear');
          if (fail && failure === 'receipt_clear') throw new Error(failure);
        }
        durableTask = {
          ...durableTask,
          merge_workflow: runtime ? toPersistedMergeWorkflowSession({ runtime, previous: durableTask.merge_workflow }) : null,
        };
        await persistRuntime(captured, runtime);
      };
      ports.completeTask = mock(async () => {
        completionEvents.push('complete');
        if (fail && failure === 'completion_write') throw new Error(failure);
        durableTask = { ...durableTask, status: 'Completed' };
        if (fail && failure === 'completion_ack') throw new Error(failure);
      });
      ports.prepareExecutionTargets = async (_captured, skip) => skip.has('a') ? [] : [target('a')];
      git.gitWorkflow = async (input) => {
        if (input.action === 'inspect') return integrated ? receipt() : null;
        mergeCount++;
        integrated = true;
        return receipt();
      };
      // Recovery must not depend on a best-effort review rebuilding an erased receipt.
      const review = { load: mock(async () => {
        if (fail && failure === 'receipt_clear') throw new Error('review unavailable');
        return null;
      }) };
      await expect(createTaskMergeWorkflow(ports, review).run(task.id)).rejects.toMatchObject({ message: failure });
      expect(durableTask.merge_workflow?.phase).toBe(failure === 'receipt_clear' ? 'failed' : 'archiving');
      expect(durableTask.merge_workflow?.repositories[0].state).toBe('merged');
      expect(durableTask.status).toBe(failure === 'completion_write' ? 'InReview' : 'Completed');
      expect(completionEvents).toEqual(failure === 'receipt_clear' ? ['complete', 'clear'] : ['complete']);

      // Recreate the coordinator with only durable task/session state surviving.
      runtimes.clear();
      fail = false;
      await createTaskMergeWorkflow(ports, review).run(task.id);
      expect(durableTask.status).toBe('Completed');
      expect(durableTask.merge_workflow).toBeNull();
      expect(completionEvents.slice(-2)).toEqual(['complete', 'clear']);
      expect(ports.completeTask).toHaveBeenCalledTimes(2);
      expect(mergeCount).toBe(1);
    });
  }

  it('executes native mutation only inside the shared repository queue', async () => {
    const { ports, git } = fixture();
    const gate = deferred<void>();
    ports.serializeRepositoryOperation = async (_repo, operation) => { await gate.promise; return operation(); };
    git.gitWorkflow = mock(async () => receipt());
    const repository = toPendingMergeWorkflowRepositoryResult({ id: 'a', projectId: 'a', repoPath: '/repo/a', sourceBranchName: 'feature/a', targetBranchName: 'develop' });
    const merging = runRepositoryMergeStrategy(ports, task.id, repository, 'merge_commit');
    await Promise.resolve();
    expect(git.gitWorkflow).not.toHaveBeenCalled();
    gate.resolve();
    await merging;
    expect(git.gitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuses cleanup without a native integration receipt', async () => {
    const { ports, git } = fixture();
    git.gitWorkflowCleanup = mock(unexpected);
    await expect(cleanupTaskExecutionTargets(ports, [target('a')], task)).rejects.toThrow('Cleanup requires a verified integrated merge');
    expect(git.gitWorkflowCleanup).not.toHaveBeenCalled();
  });

  it('records native no-change integration before completing without code changes', async () => {
    const { ports, git } = fixture();
    git.gitDiff = async () => '';
    git.gitMergeCheck = async () => ({ mergeable: true, conflictFiles: [], hasChanges: false, ahead: 0, behind: 0 });
    git.gitWorkflow = mock(async (input) => input.action === 'no_changes' ? receipt() : receipt('prepared'));
    await createTaskMergeWorkflow(ports, createTaskReviewWorkflow(ports)).run(task.id, { allowWithoutCodeChanges: true });
    expect(git.gitWorkflow).toHaveBeenCalledWith(expect.objectContaining({ action: 'no_changes', expectedSessionId: 'session-a' }));
    expect(ports.completeTask).toHaveBeenCalledWith(task);
  });

  it('does not bypass a dirty repository with allowWithoutCodeChanges', async () => {
    const { ports, git } = fixture();
    git.gitStatus = async () => ({ ...clean, is_clean: false });
    await expect(createTaskMergeWorkflow(ports, createTaskReviewWorkflow(ports)).run(task.id, { allowWithoutCodeChanges: true }))
      .rejects.toMatchObject({ message: expect.stringContaining('uncommitted changes') });
    expect(ports.completeTask).not.toHaveBeenCalled();
  });
});

describe('plan completion contracts', () => {
  it('derives metadata from the plan supplied inside the atomic mutation', async () => {
    const { ports } = fixture();
    const architect = { ...task, task_source: 'architect', plan_storage_branch: 'develop' } as TaskWorkflowTask;
    const plan: ArchitectPlanRecord = {
      id: 'plan-a', slug: 'plan-a', title: 'Plan', description: '', status: 'in_progress', targetBranch: 'develop',
      createdAt: '2026-01-01', updatedAt: '2026-01-01', predictedBranches: [],
      nodes: [
        { id: task.id, title: 'Newest title', type: 'task', status: 'pending', dependencies: [] },
        { id: 'other', title: 'Concurrent edit', type: 'task', status: 'in-progress', dependencies: [] },
      ],
    };
    ports.mutateArchitectPlanTaskStatus = mock(async (_input, derive) => ({ ...plan, ...derive(plan) }));
    ports.writeArchitectTaskExecution = mock(async () => {});
    ports.commitArchitectPlanMetadataForTask = mock(async () => {});
    await archiveTaskMergeWorkflow(ports, architect, [], false);
    expect(ports.publishCompletedPlan).toHaveBeenCalledWith(expect.objectContaining({ nodes: [
      expect.objectContaining({ id: task.id, title: 'Newest title', status: 'completed' }), plan.nodes[1],
    ] }));
    expect(ports.writeArchitectTaskExecution).toHaveBeenCalledTimes(1);
  });

  for (const missing of [
    { code: 'PLAN_METADATA_MISSING', message: 'Missing canonical replica', details: { planId: 'missing-plan' } },
    { code: 'UNEXPECTED_ERROR', message: 'Plan not found: missing-plan' },
  ]) {
    it(`rejects completion with translated missing-plan metadata error for ${missing.code}`, async () => {
      const architect = { ...task, task_source: 'architect', plan_storage_branch: 'develop', plan_id: 'missing-plan' } as TaskWorkflowTask;
      const { ports, git, persisted } = fixture([architect]);
      ports.translate = mock((_key, fallback, values) => fallback.replace('{{taskId}}', String(values?.taskId)));
      ports.mutateArchitectPlanTaskStatus = async () => { throw missing; };
      ports.prepareExecutionTargets = async () => [];
      git.gitWorkflow = async () => receipt();
      const message = `Cannot update plan metadata for task ${task.id}.`;
      await expect(createTaskMergeWorkflow(ports, { load: async () => null }).run(task.id)).rejects.toMatchObject({ ...missing, message });
      expect(ports.translate).toHaveBeenCalledWith('implement.errors.unknownTaskPlan', 'Cannot update plan metadata for task {{taskId}}.', { taskId: task.id });
      expect(ports.reportError).toHaveBeenLastCalledWith(message);
      expect(ports.completeTask).not.toHaveBeenCalled();
      expect(persisted).not.toContain(null);
    });
  }

  it('keeps metadata failures observable after a successful archive mutation', async () => {
    const { ports } = fixture();
    const manual = { ...task, standalone_kind: 'manual_feature' } as TaskWorkflowTask;
    ports.git.workspaceArchiveManualFeature = mock(async () => ({} as Awaited<ReturnType<TaskMergeWorkflowPorts['git']['workspaceArchiveManualFeature']>>));
    ports.findTask = () => undefined;
    ports.syncManualFeatureTaskMetadata = mock(async () => {});
    ports.commitManualFeatureTaskMetadata = mock(async () => { throw new Error('metadata commit failed'); });
    await expect(archiveTaskMergeWorkflow(ports, manual, [], false)).rejects.toThrow('metadata commit failed');
    expect(ports.syncManualFeatureTaskMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id, status: 'Completed', archive_reason: 'merged',
    }), expect.any(Function));
    expect(ports.deselectTaskIfSelected).not.toHaveBeenCalled();
  });

  it('locks the strategy when a finalization saga is already pending', async () => {
    const { ports } = fixture();
    const finalization = { ...task, task_source: 'plan_finalization' } as TaskWorkflowTask;
    ports.findPlanSummary = () => ({ id: 'plan-a', storageBranch: 'develop' }) as ReturnType<TaskMergeWorkflowPorts['findPlanSummary']>;
    ports.loadPlanReview = async () => ({ plan: { id: 'plan-a', title: 'Plan' }, tasks: [], repositories: [] }) as unknown as Awaited<ReturnType<TaskMergeWorkflowPorts['loadPlanReview']>>;
    ports.loadPlanLifecycleSagas = async () => [{ operation: 'finalize', planId: 'plan-a', branchName: 'develop' }];
    ports.finalizePlanIntoBaseBranch = mock(unexpected);
    await expect(runTaskPlanFinalizationWorkflow(ports, finalization, { mergeStrategyAction: 'fast_forward' }, {
      persist: async () => {}, reloadAfterFailure: unexpected,
    })).rejects.toThrow('Finalization has already started');
    expect(ports.finalizePlanIntoBaseBranch).not.toHaveBeenCalled();
  });

  it('delegates forward recovery to the saga with explicit pending-merge completion', async () => {
    const { ports } = fixture();
    const finalization = { ...task, task_source: 'plan_finalization' } as TaskWorkflowTask;
    ports.findPlanSummary = () => ({ id: 'plan-a', storageBranch: 'develop' }) as ReturnType<TaskMergeWorkflowPorts['findPlanSummary']>;
    ports.loadPlanReview = async () => ({ plan: { id: 'plan-a', title: 'Plan' }, tasks: [], repositories: [] }) as unknown as Awaited<ReturnType<TaskMergeWorkflowPorts['loadPlanReview']>>;
    ports.loadPlanLifecycleSagas = async () => [{ operation: 'finalize', planId: 'plan-a', branchName: 'develop' }];
    ports.finalizePlanIntoBaseBranch = mock(async () => { throw new Error('cleanup pending'); });
    const reload = mock(async () => buildInitialMergeWorkflowRuntimeState({ taskId: task.id, kind: 'plan_finalization' }));
    await expect(runTaskPlanFinalizationWorkflow(ports, finalization, { mergeStrategyAction: 'complete_merge' }, {
      persist: async () => {}, reloadAfterFailure: reload,
    })).rejects.toThrow('cleanup pending');
    expect(ports.finalizePlanIntoBaseBranch).toHaveBeenCalledWith({ branchName: 'develop', planId: 'plan-a', completePendingMerges: true });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ports.clearPlanRuntime).not.toHaveBeenCalled();
  });
});
