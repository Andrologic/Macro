import { describe, expect, it } from 'bun:test';
import { retargetPlanForExecution } from './projectIdentityReconciliation';
import type { PlanNode, PredictedBranch } from '../types';

describe('projectIdentityReconciliation', () => {
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
