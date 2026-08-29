import { describe, expect, it } from 'bun:test';
import { retargetPlanForExecution, retargetTaskForExecution } from './projectIdentityReconciliation';
import { toBranchWorktreeKey } from './implementTaskDerivation';
import type { PlanNode, PredictedBranch } from '../types';

describe('projectIdentityReconciliation', () => {
  it('does not move an orphaned execution target onto the selected project', () => {
    const task = {
      id: 'orphaned-task',
      project_id: 'removed-project',
      project_ids: ['removed-project'],
      execution_targets: [{
        projectId: 'removed-project',
        executionMode: 'direct' as const,
        checkpointId: 'checkpoint-1',
        branchName: '',
        worktreeKey: 'removed-project::checkpoint-1',
        repoPath: 'C:/removed/project',
      }],
    };

    const retargeted = retargetTaskForExecution(task, {
      scopedProjectIds: ['current-project'],
      knownProjectIds: ['current-project'],
    });

    expect(retargeted.execution_targets?.[0]).toEqual(task.execution_targets[0]);
    expect(retargeted.execution_targets?.[0]?.projectId).toBe('removed-project');
    expect(retargeted.project_id).toBe('removed-project');
  });

  it('retargets a stale target only when its persisted path matches the current project', () => {
    const task = {
      id: 'reopened-task',
      project_id: 'old-project-id',
      project_ids: ['old-project-id'],
      execution_targets: [{
        projectId: 'old-project-id',
        branchName: 'feature/reopened',
        worktreeKey: 'old-project-id::feature/reopened',
        repoPath: 'C:\\repos\\reopened-app\\',
      }],
    };
    const currentProject = {
      id: 'current-project-id',
      name: 'Reopened App',
      mountName: 'reopened-app',
      path: 'c:/repos/reopened-app',
      created_at: '',
      status: 'active' as const,
      metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
    };

    const retargeted = retargetTaskForExecution(task, {
      scopedProjectIds: [currentProject.id],
      knownProjectIds: [currentProject.id],
      knownProjects: [currentProject],
    });

    expect(retargeted.project_id).toBe(currentProject.id);
    expect(retargeted.execution_targets?.[0]?.projectId).toBe(currentProject.id);
    expect(retargeted.execution_targets?.[0]?.worktreeKey).toBe(
      toBranchWorktreeKey(currentProject.id, 'feature/reopened')
    );
  });

  it('does not move a plan with a persisted mode onto the selected project', () => {
    const plan = {
      id: 'orphaned-plan',
      projectId: 'removed-project',
      projectIds: ['removed-project'],
      executionModesByProjectId: { 'removed-project': 'direct' as const },
      nodes: [{
        id: 'node-1',
        title: 'Orphaned direct work',
        type: 'task' as const,
        status: 'pending' as const,
        dependencies: [],
        projectId: 'removed-project',
        projectIds: ['removed-project'],
        executionModesByProjectId: { 'removed-project': 'direct' as const },
      }],
      predictedBranches: [],
    };

    const retargeted = retargetPlanForExecution(plan, {
      scopedProjectIds: ['current-project'],
      knownProjectIds: ['current-project'],
    });

    expect(retargeted).toEqual(plan);
  });

  it('does not move a legacy plan without physical identity proof', () => {
    const plan = {
      id: 'orphaned-legacy-plan',
      projectId: 'removed-project',
      projectIds: ['removed-project'],
      nodes: [],
      predictedBranches: [],
    };

    const retargeted = retargetPlanForExecution(plan, {
      scopedProjectIds: ['current-project'],
      knownProjectIds: ['current-project'],
    });

    expect(retargeted).toEqual(plan);
  });

  it('retargets stale strategy children even when the plan already points to the current project', () => {
    const currentProjectId = 'project-octan-sales-1780653766405';
    const staleProjectId = 'project-lplr-app-1780329499166';
    const plan = {
      id: 'plan-renamed-project',
      projectId: currentProjectId,
      projectIds: [currentProjectId],
      availableProjectIds: [currentProjectId],
      nodes: [
        {
          id: 'node-1',
          title: 'Node one',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: staleProjectId,
          projectIds: [staleProjectId],
        },
      ] satisfies PlanNode[],
      predictedBranches: [
        {
          id: 'branch-1',
          name: 'feature/renamed-project',
          color: '#6366f1',
          parentBranch: 'develop',
          projectId: staleProjectId,
          taskIds: ['node-1'],
          status: 'pending',
        },
      ] satisfies PredictedBranch[],
    };

    const retargeted = retargetPlanForExecution(plan, {
      scopedProjectIds: [currentProjectId],
      knownProjectIds: [currentProjectId],
    });

    expect(retargeted.projectId).toBe(currentProjectId);
    expect(retargeted.projectIds).toEqual([currentProjectId]);
    expect(retargeted.nodes?.[0]?.projectId).toBe(currentProjectId);
    expect(retargeted.nodes?.[0]?.projectIds).toEqual([currentProjectId]);
    expect(retargeted.predictedBranches?.[0]?.projectId).toBe(currentProjectId);
  });
});
