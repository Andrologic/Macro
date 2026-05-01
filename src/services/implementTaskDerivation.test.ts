import { describe, expect, it } from 'bun:test';
import type { PlanNode, PredictedBranch } from '../types';
import { deriveImplementTasksFromStrategy } from './implementTaskDerivation';

const makeNode = (overrides: Partial<PlanNode> & Pick<PlanNode, 'id' | 'title'>): PlanNode => ({
  id: overrides.id,
  title: overrides.title,
  description: overrides.description ?? '',
  type: overrides.type ?? 'task',
  status: overrides.status ?? 'pending',
  dependencies: overrides.dependencies ?? [],
  assignedBranch: overrides.assignedBranch,
  branchType: overrides.branchType ?? 'feature',
  branchSlug: overrides.branchSlug,
  projectId: overrides.projectId ?? 'web',
  projectIds: overrides.projectIds ?? ['web'],
});

const makeBranch = (
  overrides: Partial<PredictedBranch> & Pick<PredictedBranch, 'id' | 'name' | 'taskIds'>,
): PredictedBranch => ({
  id: overrides.id,
  name: overrides.name,
  color: overrides.color ?? '#3b82f6',
  parentBranch: overrides.parentBranch ?? 'plan/checkout',
  projectId: overrides.projectId ?? 'web',
  taskIds: overrides.taskIds,
  status: overrides.status ?? 'pending',
  branchType: overrides.branchType,
  branchSlug: overrides.branchSlug,
});

describe('deriveImplementTasksFromStrategy', () => {
  it('splits legacy sequential branch groups into one branch per task', () => {
    const result = deriveImplementTasksFromStrategy({
      planId: 'plan-1',
      planSlug: 'checkout',
      targetBranchesByProjectId: { web: 'develop' },
      nodes: [
        makeNode({
          id: 'task-a',
          title: 'Build foundation',
          status: 'completed',
          branchSlug: 'shared-work',
        }),
        makeNode({
          id: 'task-b',
          title: 'Continue foundation',
          branchSlug: 'shared-work',
        }),
        makeNode({
          id: 'task-c',
          title: 'Use foundation',
          branchSlug: 'independent-work',
          dependencies: ['task-a'],
        }),
      ],
      predictedBranches: [
        makeBranch({
          id: 'branch-shared',
          name: 'feature/checkout/shared-work',
          taskIds: ['task-a', 'task-b'],
          branchSlug: 'shared-work',
        }),
        makeBranch({
          id: 'branch-c',
          name: 'feature/checkout/independent-work',
          taskIds: ['task-c'],
          branchSlug: 'independent-work',
        }),
      ],
    });

    expect(result.predictedBranches).toHaveLength(3);
    expect(result.predictedBranches.every((branch) => branch.taskIds.length === 1)).toBe(true);

    const branchByTaskId = new Map(
      result.predictedBranches.map((branch) => [branch.taskIds[0], branch]),
    );
    expect(branchByTaskId.get('task-a')?.name).toBe('feature/checkout/shared-work');
    expect(branchByTaskId.get('task-b')?.name).toMatch(
      /^feature\/checkout\/shared-work-[0-9a-f]{6}$/,
    );
    expect(branchByTaskId.get('task-c')?.name).toBe('feature/checkout/independent-work');

    expect(result.nodes.find((node) => node.id === 'task-b')?.dependencies).toEqual(['task-a']);
    expect(result.tasks.find((task) => task.id === 'task-c')).toMatchObject({
      status: 'Pending',
      is_ready: true,
      blocked_by_task_ids: [],
    });
  });

  it('does not keep stale per-task branches after slug collision repair', () => {
    const result = deriveImplementTasksFromStrategy({
      planId: 'plan-1',
      planSlug: 'checkout',
      targetBranchesByProjectId: { web: 'develop' },
      nodes: [
        makeNode({
          id: 'task-a',
          title: 'Build foundation',
          branchSlug: 'shared-work',
        }),
        makeNode({
          id: 'task-b',
          title: 'Continue foundation',
          branchSlug: 'shared-work',
        }),
      ],
      predictedBranches: [
        makeBranch({
          id: 'branch-a',
          name: 'feature/checkout/shared-work',
          taskIds: ['task-a'],
          branchSlug: 'shared-work',
        }),
        makeBranch({
          id: 'branch-b',
          name: 'feature/checkout/shared-work',
          taskIds: ['task-b'],
          branchSlug: 'shared-work',
        }),
      ],
    });

    expect(result.predictedBranches).toHaveLength(2);
    const branchNames = result.predictedBranches.map((branch) => branch.name);
    expect(branchNames).toContain('feature/checkout/shared-work');
    expect(branchNames).toContainEqual(
      expect.stringMatching(/^feature\/checkout\/shared-work-[0-9a-f]{6}$/),
    );
    expect(result.predictedBranches.map((branch) => branch.taskIds)).toEqual([
      ['task-a'],
      ['task-b'],
    ]);
  });

  it('keeps duplicate slug repair stable when pending nodes are reordered', () => {
    const deriveNamesByTaskId = (nodes: PlanNode[]) => {
      const result = deriveImplementTasksFromStrategy({
        planId: 'plan-1',
        planSlug: 'checkout',
        targetBranchesByProjectId: { web: 'develop' },
        nodes,
        predictedBranches: [],
      });
      return new Map(
        result.predictedBranches.map((branch) => [branch.taskIds[0], branch.name]),
      );
    };

    const ordered = deriveNamesByTaskId([
      makeNode({ id: 'task-a', title: 'First duplicate', branchSlug: 'shared-work' }),
      makeNode({ id: 'task-b', title: 'Second duplicate', branchSlug: 'shared-work' }),
    ]);
    const reversed = deriveNamesByTaskId([
      makeNode({ id: 'task-b', title: 'Second duplicate', branchSlug: 'shared-work' }),
      makeNode({ id: 'task-a', title: 'First duplicate', branchSlug: 'shared-work' }),
    ]);

    expect(ordered.get('task-a')).toBe('feature/checkout/shared-work');
    expect(reversed.get('task-a')).toBe('feature/checkout/shared-work');
    expect(ordered.get('task-b')).toBe(reversed.get('task-b'));
    expect(ordered.get('task-b')).toMatch(/^feature\/checkout\/shared-work-[0-9a-f]{6}$/);
  });

  it('reconciles existing task-scoped branch status from the owning node', () => {
    const result = deriveImplementTasksFromStrategy({
      planId: 'plan-1',
      planSlug: 'checkout',
      targetBranchesByProjectId: { web: 'develop' },
      nodes: [
        makeNode({
          id: 'task-a',
          title: 'Completed work',
          status: 'completed',
          branchSlug: 'completed-work',
        }),
      ],
      predictedBranches: [
        makeBranch({
          id: 'branch-a',
          name: 'feature/checkout/completed-work',
          taskIds: ['task-a'],
          branchSlug: 'completed-work',
          status: 'pending',
        }),
      ],
    });

    expect(result.predictedBranches).toHaveLength(1);
    expect(result.predictedBranches[0]?.status).toBe('merged');
  });
});
