import { describe, expect, it } from 'bun:test';
import type { Task } from '../types';
import type { ArchitectPlanRecord } from './architectPlanService';
import {
  buildImplementTaskCatalog,
  deriveFallbackImplementTasks,
  taskMatchesProjectId,
} from './implementTaskCatalog';
import { buildPlanFinalizationTaskId } from './planFinalization';

const makePlan = (
  overrides: Partial<ArchitectPlanRecord> & Pick<ArchitectPlanRecord, 'id' | 'title' | 'status'>
): ArchitectPlanRecord => ({
  id: overrides.id,
  slug: overrides.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  title: overrides.title,
  description: overrides.description || '',
  status: overrides.status,
  targetBranch: overrides.targetBranch || 'develop',
  targetBranchesByProjectId: overrides.targetBranchesByProjectId,
  conversationId: overrides.conversationId,
  projectId: overrides.projectId || 'web',
  projectIds: overrides.projectIds || ['web'],
  contextProjectIds: overrides.contextProjectIds,
  createdAt: overrides.createdAt || '2026-03-07T00:00:00.000Z',
  updatedAt: overrides.updatedAt || '2026-03-07T00:00:00.000Z',
  nodes: overrides.nodes || [],
  predictedBranches: overrides.predictedBranches || [],
});

const makeTask = (overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task => ({
  id: overrides.id,
  plan_id: overrides.plan_id ?? '',
  project_id: overrides.project_id ?? 'web',
  project_ids: overrides.project_ids,
  title: overrides.title,
  description: overrides.description ?? '',
  status: overrides.status ?? 'Pending',
  dependencies: overrides.dependencies ?? [],
  estimated_changes: overrides.estimated_changes ?? [],
  code_diff: overrides.code_diff,
});

describe('buildImplementTaskCatalog', () => {
  it('aggregates executable architect plans and preserves standalone fallback tasks', () => {
    const plans = [
      makePlan({
        id: 'plan-a',
        title: 'Checkout',
        status: 'validated',
        projectId: 'web',
        projectIds: ['web'],
        contextProjectIds: ['docs'],
        nodes: [
          {
            id: 'task-a1',
            title: 'Build checkout UI',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'checkout-ui',
            projectId: 'web',
          },
        ],
        predictedBranches: [
          {
            id: 'branch-a',
            name: 'checkout-ui',
            color: '#3b82f6',
            parentBranch: 'plan-checkout',
            projectId: 'web',
            taskIds: ['task-a1'],
            status: 'pending',
          },
        ],
      }),
      makePlan({
        id: 'plan-b',
        title: 'Payments',
        status: 'in_progress',
        projectId: 'api',
        projectIds: ['api'],
        nodes: [
          {
            id: 'task-b1',
            title: 'Add payment endpoint',
            type: 'task',
            status: 'in-progress',
            dependencies: [],
            assignedBranch: 'payments-api',
            projectId: 'api',
          },
        ],
        predictedBranches: [
          {
            id: 'branch-b',
            name: 'payments-api',
            color: '#10b981',
            parentBranch: 'plan-payments',
            projectId: 'api',
            taskIds: ['task-b1'],
            status: 'active',
          },
        ],
      }),
      makePlan({
        id: 'plan-c',
        title: 'Draft plan',
        status: 'draft',
        projectId: 'web',
        projectIds: ['web'],
        nodes: [
          {
            id: 'task-c1',
            title: 'Draft only task',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'draft-task',
            projectId: 'web',
          },
        ],
      }),
    ];

    const fallbackTasks = [
      makeTask({
        id: 'task-a1',
        title: 'Duplicate architect task',
        plan_id: 'plan-a',
        project_id: 'web',
      }),
      makeTask({
        id: 'standalone-1',
        title: 'Fix production typo',
        plan_id: '',
        project_id: 'web',
        status: 'InProgress',
      }),
      makeTask({
        id: 'draft-shadow',
        title: 'Should stay hidden',
        plan_id: 'plan-c',
        project_id: 'web',
      }),
      makeTask({
        id: 'legacy-1',
        title: 'Legacy task',
        plan_id: 'legacy-plan',
        project_id: 'api',
        status: 'Pending',
      }),
    ];

    const catalog = buildImplementTaskCatalog({ plans, fallbackTasks });

    expect(catalog.source).toBe('mixed');
    expect(catalog.hasStandaloneTasks).toBe(true);
    expect(catalog.plans.map((plan) => [plan.id, plan.taskCount])).toEqual([
      ['plan-a', 1],
      ['plan-b', 1],
    ]);
    expect(catalog.tasks.map((task) => task.id)).toEqual([
      'task-a1',
      'task-b1',
      'standalone-1',
      'legacy-1',
    ]);
    expect(catalog.tasks.find((task) => task.id === 'task-a1')?.context_project_ids).toEqual(['docs']);

    const architectTask = catalog.tasks.find((task) => task.id === 'task-b1');
    expect(architectTask?.task_source).toBe('architect');
    expect(architectTask?.plan_title).toBe('Payments');
    expect(architectTask?.plan_status).toBe('in_progress');
    expect(architectTask?.plan_target_branch).toBe('develop');

    const standaloneTask = catalog.tasks.find((task) => task.id === 'standalone-1');
    expect(standaloneTask?.task_source).toBe('standalone');
    expect(standaloneTask?.plan_title).toBeNull();
    expect(standaloneTask?.plan_status).toBeNull();
  });

  it('keeps tasks grouped by plan when duplicate titles exist on different target branches', () => {
    const plans = [
      makePlan({
        id: 'plan-a',
        title: 'Checkout',
        status: 'validated',
        targetBranch: 'develop',
        projectId: 'web',
        projectIds: ['web'],
        nodes: [
          {
            id: 'task-a1',
            title: 'Checkout web step 1',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'checkout-web',
            projectId: 'web',
          },
          {
            id: 'task-a2',
            title: 'Checkout web step 2',
            type: 'task',
            status: 'pending',
            dependencies: ['task-a1'],
            assignedBranch: 'checkout-web',
            projectId: 'web',
          },
        ],
        predictedBranches: [
          {
            id: 'branch-a',
            name: 'checkout-web',
            color: '#3b82f6',
            parentBranch: 'plan/checkout-web',
            projectId: 'web',
            taskIds: ['task-a1', 'task-a2'],
            status: 'pending',
          },
        ],
      }),
      makePlan({
        id: 'plan-b',
        title: 'Checkout',
        status: 'validated',
        targetBranch: 'feature/payments',
        projectId: 'api',
        projectIds: ['api'],
        nodes: [
          {
            id: 'task-b1',
            title: 'Checkout API step 1',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'checkout-api',
            projectId: 'api',
          },
          {
            id: 'task-b2',
            title: 'Checkout API step 2',
            type: 'task',
            status: 'pending',
            dependencies: ['task-b1'],
            assignedBranch: 'checkout-api',
            projectId: 'api',
          },
        ],
        predictedBranches: [
          {
            id: 'branch-b',
            name: 'checkout-api',
            color: '#10b981',
            parentBranch: 'plan/checkout-api',
            projectId: 'api',
            taskIds: ['task-b1', 'task-b2'],
            status: 'pending',
          },
        ],
      }),
    ];

    const catalog = buildImplementTaskCatalog({ plans, fallbackTasks: [] });

    expect(catalog.tasks.map((task) => task.id)).toEqual([
      'task-a1',
      'task-a2',
      'task-b1',
      'task-b2',
    ]);
    expect(catalog.plans.map((plan) => [plan.id, plan.targetBranch])).toEqual([
      ['plan-a', 'develop'],
      ['plan-b', 'feature/payments'],
    ]);
  });

  it('creates a single synthetic plan finalization task when all architect tasks are completed', () => {
    const completedPlan = makePlan({
      id: 'plan-ready',
      title: 'Checkout refresh',
      status: 'in_progress',
      targetBranch: 'develop',
      projectId: 'web',
      projectIds: ['web', 'api'],
      targetBranchesByProjectId: {
        web: 'develop',
        api: 'integration',
      },
      nodes: [
        {
          id: 'task-ready-1',
          title: 'Finish checkout UI',
          type: 'task',
          status: 'completed',
          dependencies: [],
          assignedBranch: 'checkout-ui',
          projectId: 'web',
        },
      ],
      predictedBranches: [
        {
          id: 'branch-ready',
          name: 'checkout-ui',
          color: '#3b82f6',
          parentBranch: 'plan/checkout-refresh',
          projectId: 'web',
          taskIds: ['task-ready-1'],
          status: 'merged',
        },
      ],
    });

    const readyCatalog = buildImplementTaskCatalog({
      plans: [completedPlan],
      fallbackTasks: [],
    });

    expect(readyCatalog.plans).toHaveLength(1);
    expect(readyCatalog.tasks.map((task) => task.id)).toEqual([
      'task-ready-1',
      buildPlanFinalizationTaskId('plan-ready'),
    ]);

    const finalizationTask = readyCatalog.tasks[1];
    expect(finalizationTask?.task_source).toBe('plan_finalization');
    expect(finalizationTask?.plan_id).toBe('plan-ready');
    expect(finalizationTask?.status).toBe('Pending');
    expect(finalizationTask?.assigned_branch).toBe('develop');
    expect(finalizationTask?.execution_targets).toEqual([
      {
        projectId: 'web',
        branchName: 'develop',
        targetBranchName: 'develop',
        executionKind: 'repository_root',
        worktreeKey: 'plan-finalization:web:web',
      },
      {
        projectId: 'api',
        branchName: 'integration',
        targetBranchName: 'integration',
        executionKind: 'repository_root',
        worktreeKey: 'plan-finalization:web:api',
      },
    ]);

    const reopenedCatalog = buildImplementTaskCatalog({
      plans: [
        {
          ...completedPlan,
          nodes: [
            {
              ...completedPlan.nodes[0]!,
              status: 'in-progress',
            },
          ],
        },
      ],
      fallbackTasks: [],
    });

    expect(reopenedCatalog.tasks.map((task) => task.id)).toEqual(['task-ready-1']);
  });
});

describe('deriveFallbackImplementTasks', () => {
  it('recomputes dependency blocking for standalone tasks', () => {
    const tasks = deriveFallbackImplementTasks([
      makeTask({
        id: 'task-1',
        title: 'Foundation',
        status: 'Completed',
        project_id: 'web',
      }),
      makeTask({
        id: 'task-2',
        title: 'Dependent work',
        status: 'Pending',
        project_id: 'web',
        dependencies: ['task-1'],
      }),
      makeTask({
        id: 'task-3',
        title: 'Blocked work',
        status: 'Pending',
        project_id: 'web',
        dependencies: ['task-2'],
      }),
    ]);

    expect(tasks.find((task) => task.id === 'task-2')?.is_blocked).toBe(false);
    expect(tasks.find((task) => task.id === 'task-2')?.is_ready).toBe(true);
    expect(tasks.find((task) => task.id === 'task-3')?.status).toBe('Blocked');
    expect(tasks.find((task) => task.id === 'task-3')?.blocked_by).toEqual(['Dependent work']);
  });
});

describe('taskMatchesProjectId', () => {
  it('matches primary, secondary and execution target projects', () => {
    const tasks = deriveFallbackImplementTasks([
      makeTask({
        id: 'multi',
        title: 'Cross-project task',
        project_id: 'web',
        project_ids: ['web', 'api'],
      }),
    ]);

    expect(taskMatchesProjectId(tasks[0], 'web')).toBe(true);
    expect(taskMatchesProjectId(tasks[0], 'api')).toBe(true);
    expect(taskMatchesProjectId(tasks[0], 'mobile')).toBe(false);
  });
});
