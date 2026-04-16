import { describe, expect, it, mock } from 'bun:test';
import type { PlanNode } from '../types';
import type { ArchitectPlanRecord } from './architectPlanService';
import {
  applyStrategyMutationPreview,
  buildFrozenPlanNodeMap,
  prepareStrategyMutationPreview,
} from './architectStrategyMutationGuard';

const createNode = (overrides: Partial<PlanNode> & Pick<PlanNode, 'id' | 'title'>): PlanNode => ({
  id: overrides.id,
  title: overrides.title,
  description: overrides.description ?? '',
  type: overrides.type ?? 'task',
  status: overrides.status ?? 'pending',
  dependencies: overrides.dependencies ?? [],
  assignedBranch: overrides.assignedBranch ?? `feature/${overrides.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  branchType: overrides.branchType ?? 'feature',
  branchSlug: overrides.branchSlug ?? overrides.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  projectId: overrides.projectId ?? 'web',
  projectIds: overrides.projectIds ?? ['web'],
});

const createPlan = (overrides: Partial<ArchitectPlanRecord> = {}): ArchitectPlanRecord => ({
  id: 'plan-1',
  slug: 'plan-1',
  title: 'plan-1',
  label: 'Checkout refresh',
  description: 'Plan description',
  status: 'draft',
  targetBranch: 'develop',
  targetBranchesByProjectId: { web: 'develop' },
  conversationId: 'conv-1',
  projectId: 'web',
  projectIds: ['web'],
  createdAt: '2026-03-19T00:00:00.000Z',
  updatedAt: '2026-03-19T00:00:00.000Z',
  revision: 3,
  nodes: [],
  predictedBranches: [],
  ...overrides,
});

describe('architectStrategyMutationGuard', () => {
  it('freezes started and completed nodes plus their ancestor dependencies', () => {
    const plan = createPlan({
      nodes: [
        createNode({ id: 'task-a', title: 'Prepare schema' }),
        createNode({
          id: 'task-b',
          title: 'Build endpoint',
          status: 'in-progress',
          dependencies: ['task-a'],
        }),
        createNode({
          id: 'task-c',
          title: 'QA rollout',
          status: 'completed',
          dependencies: ['task-b'],
        }),
        createNode({ id: 'task-d', title: 'Optional cleanup' }),
      ],
    });

    const frozen = buildFrozenPlanNodeMap({
      plan,
      tasks: [
        { id: 'task-b', plan_id: plan.id, status: 'InProgress' },
        { id: 'task-c', plan_id: plan.id, status: 'Completed' },
      ],
    });

    expect(frozen.get('task-a')?.reason).toBe('dependency_locked');
    expect(frozen.get('task-b')?.reason).toBe('started');
    expect(frozen.get('task-c')?.reason).toBe('completed');
    expect(frozen.has('task-d')).toBe(false);
  });

  it('stages a valid preview that preserves frozen ids and rewrites only editable pending work', () => {
    const plan = createPlan({
      status: 'in_progress',
      nodes: [
        createNode({ id: 'task-a', title: 'Prepare schema' }),
        createNode({
          id: 'task-b',
          title: 'Build endpoint',
          status: 'in-progress',
          dependencies: ['task-a'],
        }),
        createNode({
          id: 'task-c',
          title: 'Legacy cleanup',
          description: 'Old pending work',
        }),
      ],
    });

    const preview = prepareStrategyMutationPreview({
      source: 'strategy_generate',
      plan,
      candidateNodes: [
        createNode({ id: 'task-a', title: 'Prepare schema' }),
        createNode({
          id: 'task-b',
          title: 'Build endpoint',
          status: 'in-progress',
          dependencies: ['task-a'],
        }),
        createNode({
          id: 'candidate-d',
          title: 'Ship telemetry',
          dependencies: ['task-b'],
        }),
      ],
      tasks: [{ id: 'task-b', plan_id: plan.id, status: 'InProgress' }],
      metadataUpdate: { description: plan.description },
    });

    expect(preview.status).toBe('valid');
    expect(preview.requiresPreview).toBe(true);
    expect(preview.nextPlanStatus).toBe('in_progress');
    expect(preview.frozenNodes.map((node) => node.id)).toEqual(['task-a', 'task-b']);
    expect(preview.planNodes.find((node) => node.title === 'Prepare schema')?.id).toBe('task-a');
    expect(preview.planNodes.find((node) => node.title === 'Build endpoint')?.id).toBe('task-b');
    expect(preview.newNodes.map((node) => node.title)).toEqual(['Ship telemetry']);
    expect(preview.removedPendingNodes.map((node) => node.title)).toEqual(['Legacy cleanup']);
  });

  it('blocks the preview when a frozen node is modified or omitted', () => {
    const plan = createPlan({
      status: 'in_progress',
      nodes: [
        createNode({ id: 'task-a', title: 'Prepare schema' }),
        createNode({
          id: 'task-b',
          title: 'Build endpoint',
          status: 'in-progress',
          dependencies: ['task-a'],
        }),
      ],
    });

    const preview = prepareStrategyMutationPreview({
      source: 'strategy_update',
      plan,
      candidateNodes: [
        createNode({
          id: 'task-b',
          title: 'Build endpoint',
          description: 'Changed frozen description',
          status: 'in-progress',
          dependencies: ['task-a'],
        }),
      ],
      tasks: [{ id: 'task-b', plan_id: plan.id, status: 'InProgress' }],
      metadataUpdate: { description: plan.description },
      repairAttempted: true,
    });

    expect(preview.status).toBe('blocked');
    expect(preview.conflicts).toHaveLength(2);
    expect(preview.conflicts[0]).toContain('Prepare schema');
    expect(preview.conflicts[1]).toContain('Build endpoint');
  });

  it('treats a renamed pending node as a remove plus add instead of reusing its id', () => {
    const plan = createPlan({
      nodes: [createNode({ id: 'task-c', title: 'Legacy cleanup' })],
    });

    const preview = prepareStrategyMutationPreview({
      source: 'strategy_update',
      plan,
      candidateNodes: [
        createNode({
          id: 'task-c',
          title: 'Cleanup pass v2',
        }),
      ],
      metadataUpdate: { description: plan.description },
    });

    expect(preview.status).toBe('valid');
    expect(preview.planNodes[0]?.id).not.toBe('task-c');
    expect(preview.newNodes.map((node) => node.title)).toEqual(['Cleanup pass v2']);
    expect(preview.removedPendingNodes.map((node) => node.title)).toEqual(['Legacy cleanup']);
  });

  it('auto-provisions branches when applying a valid preview on an executable plan', async () => {
    const plan = createPlan({
      status: 'validated',
      nodes: [createNode({ id: 'task-a', title: 'Prepare schema' })],
    });
    const preview = prepareStrategyMutationPreview({
      source: 'strategy_generate',
      plan,
      candidateNodes: [
        createNode({ id: 'task-a', title: 'Prepare schema' }),
        createNode({ id: 'task-b', title: 'Build endpoint', dependencies: ['task-a'] }),
      ],
      metadataUpdate: { description: plan.description },
    });

    expect(preview.status).toBe('valid');
    expect(preview.requiresPreview).toBe(false);
    expect(preview.autoProvisionBranches).toBe(true);

    const getArchitectPlanMock = mock(async () => plan);
    const provisionPlanBranchesMock = mock(async () => ({
      planBranchName: 'plan/plan-1',
      repositories: [],
      createdPlanBranch: false,
      createdFeatureBranches: [],
      existingFeatureBranches: [],
    }));
    const updateArchitectPlanMock = mock(async (params: {
      status?: string;
      nodes?: PlanNode[];
    }) => ({
      ...plan,
      status: params.status ?? plan.status,
      nodes: params.nodes ?? plan.nodes,
      predictedBranches: preview.predictedBranches,
    }));

    const updated = await applyStrategyMutationPreview(
      { preview },
      {
        getArchitectPlan: getArchitectPlanMock as any,
        updateArchitectPlan: updateArchitectPlanMock as any,
        provisionPlanBranches: provisionPlanBranchesMock as any,
      }
    );

    expect(provisionPlanBranchesMock).toHaveBeenCalledTimes(1);
    expect(updateArchitectPlanMock).toHaveBeenCalledTimes(1);
    expect(updated.status).toBe('validated');
    expect(updated.nodes).toHaveLength(2);
  });
});
