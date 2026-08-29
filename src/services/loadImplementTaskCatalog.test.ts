import { describe, expect, it } from 'bun:test';
import type { Task } from '../types';
import type {
  ArchitectPlanRecord,
  ArchitectPlanSummary,
} from './architectPlanService';
import { buildImplementTaskCatalog } from './implementTaskCatalog';
import { createLoadImplementTaskCatalog } from './loadImplementTaskCatalog';

const makePlan = (
  overrides: Partial<ArchitectPlanRecord> & Pick<ArchitectPlanRecord, 'id' | 'title' | 'status' | 'targetBranch'>
): ArchitectPlanRecord => ({
  id: overrides.id,
  slug: overrides.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  title: overrides.title,
  description: overrides.description || '',
  status: overrides.status,
  targetBranch: overrides.targetBranch,
  conversationId: overrides.conversationId,
  projectId: overrides.projectId || 'web',
  projectIds: overrides.projectIds || ['web'],
  createdAt: overrides.createdAt || '2026-03-08T00:00:00.000Z',
  updatedAt: overrides.updatedAt || '2026-03-08T00:00:00.000Z',
  nodes: overrides.nodes || [],
  predictedBranches: overrides.predictedBranches || [],
});

const toSummary = (plan: ArchitectPlanRecord): ArchitectPlanSummary => ({
  id: plan.id,
  slug: plan.slug,
  title: plan.title,
  description: plan.description,
  status: plan.status,
  targetBranch: plan.targetBranch,
  conversationId: plan.conversationId,
  projectId: plan.projectId,
  projectIds: plan.projectIds,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
  nodeCount: plan.nodes.length,
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

describe('createLoadImplementTaskCatalog', () => {
  it('persists a Git mode snapshot for legacy plan targets only when the project is confirmed ready', async () => {
    const legacyPlan = makePlan({
      id: 'plan-legacy-git',
      title: 'Legacy Git plan',
      status: 'validated',
      targetBranch: 'develop',
      projectId: 'web',
      projectIds: ['web'],
      nodes: [
        {
          id: 'task-legacy-git',
          title: 'Migrate legacy target',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'legacy-target',
          projectId: 'web',
        },
      ],
      predictedBranches: [
        {
          id: 'branch-legacy-git',
          name: 'legacy-target',
          color: '#3b82f6',
          parentBranch: 'plan/legacy-git',
          projectId: 'web',
          taskIds: ['task-legacy-git'],
          status: 'pending',
        },
      ],
    });
    const updates: Array<{
      branchName: string;
      planId: string;
      nodes?: ArchitectPlanRecord['nodes'];
      setActive?: boolean;
    }> = [];
    const loadImplementTaskCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        selectedGroupId: null,
        selectedProjectId: 'web',
        standaloneProjects: [
          {
            id: 'web',
            name: 'Web',
            mountName: 'web',
            path: '/repos/web',
            created_at: '',
            status: 'active',
            gitSetupState: 'ready',
            directEdit: false,
            metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
          },
        ],
        projectGroups: [],
      } as never),
      listArchitectPlans: async () => ({
        activePlanId: null,
        plans: [toSummary(legacyPlan)],
      }),
      getArchitectPlan: async () => legacyPlan,
      listArchitectPlanTargetBranches: async () => ['develop'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value || 'develop'),
      buildImplementTaskCatalog,
      updateArchitectPlan: async (input) => {
        updates.push(input);
        return { ...legacyPlan, nodes: input.nodes || legacyPlan.nodes };
      },
    });

    const catalog = await loadImplementTaskCatalog([]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      branchName: 'develop',
      planId: 'plan-legacy-git',
      setActive: false,
      nodes: [
        expect.objectContaining({
          id: 'task-legacy-git',
          executionModesByProjectId: { web: 'git' },
        }),
      ],
    });
    expect(catalog.tasks.find((task) => task.node_id === 'task-legacy-git')?.execution_targets).toEqual([
      expect.objectContaining({ projectId: 'web', executionMode: 'git' }),
    ]);
  });

  it('aggregates executable plans across every project and target branch', async () => {
    const webPlan = makePlan({
      id: 'plan-web',
      title: 'Web Checkout',
      status: 'validated',
      targetBranch: 'develop',
      projectId: 'web',
      projectIds: ['web'],
      nodes: [
        {
          id: 'task-web',
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
          id: 'branch-web',
          name: 'checkout-ui',
          color: '#3b82f6',
          parentBranch: 'plan/web-checkout',
          projectId: 'web',
          taskIds: ['task-web'],
          status: 'pending',
        },
      ],
    });
    const apiPlan = makePlan({
      id: 'plan-api',
      title: 'API Payments',
      status: 'in_progress',
      targetBranch: 'feature/payments',
      projectId: 'api',
      projectIds: ['api'],
      nodes: [
        {
          id: 'task-api',
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
          id: 'branch-api',
          name: 'payments-api',
          color: '#10b981',
          parentBranch: 'plan/api-payments',
          projectId: 'api',
          taskIds: ['task-api'],
          status: 'active',
        },
      ],
    });
    const unrelatedPlan = makePlan({
      id: 'plan-mobile',
      title: 'Mobile Push',
      status: 'validated',
      targetBranch: 'release/mobile',
      projectId: 'mobile',
      projectIds: ['mobile'],
      nodes: [
        {
          id: 'task-mobile',
          title: 'Add push permissions',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'mobile-push',
          projectId: 'mobile',
        },
      ],
      predictedBranches: [
        {
          id: 'branch-mobile',
          name: 'mobile-push',
          color: '#f97316',
          parentBranch: 'plan/mobile-push',
          projectId: 'mobile',
          taskIds: ['task-mobile'],
          status: 'pending',
        },
      ],
    });
    const plansByKey = new Map([
      ['develop:plan-web', webPlan],
      ['feature/payments:plan-api', apiPlan],
      ['release/mobile:plan-mobile', unrelatedPlan],
    ]);
    const summariesByBranch = new Map<string, ArchitectPlanSummary[]>([
      ['develop', [toSummary(webPlan)]],
      ['feature/payments', [toSummary(apiPlan)]],
      ['release/mobile', [toSummary(unrelatedPlan)]],
    ]);

    const loadImplementTaskCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        selectedGroupId: 'group-1',
        selectedProjectId: 'web',
        projectGroups: [
          {
            id: 'group-1',
            name: 'Checkout',
            isOpen: true,
            projects: [
              { id: 'web', name: 'Web', mountName: 'web', path: '/repos/web', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
              { id: 'api', name: 'API', mountName: 'api', path: '/repos/api', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
            ],
          },
          {
            id: 'group-2',
            name: 'Mobile',
            isOpen: true,
            projects: [
              { id: 'mobile', name: 'Mobile', mountName: 'mobile', path: '/repos/mobile', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
            ],
          },
        ],
        getProjectById: () => undefined,
      } as never),
      listArchitectPlans: async (branchName: string) => ({
        activePlanId: null,
        plans: summariesByBranch.get(branchName) || [],
      }),
      getArchitectPlan: async (branchName: string, planId: string) =>
        plansByKey.get(`${branchName}:${planId}`) || null,
      listArchitectPlanTargetBranches: async () => ['develop', 'feature/payments', 'release/mobile'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value || 'develop'),
      buildImplementTaskCatalog,
    });

    const catalog = await loadImplementTaskCatalog([
      makeTask({
        id: 'task-web',
        title: 'Duplicate architect task',
        plan_id: 'plan-web',
        project_id: 'web',
      }),
      makeTask({
        id: 'standalone-1',
        title: 'Fix production typo',
        project_id: 'web',
        status: 'InProgress',
      }),
    ]);

    expect(catalog.source).toBe('mixed');
    expect(catalog.tasks.map((task) => task.node_id || task.id)).toEqual([
      'task-api',
      'task-mobile',
      'task-web',
      'plan-finalization:plan-api',
      'plan-finalization:plan-mobile',
      'plan-finalization:plan-web',
      'standalone-1',
    ]);
    expect(catalog.plans.map((plan) => ({
      id: plan.id,
      targetBranch: plan.targetBranch,
    }))).toEqual([
      { id: 'plan-api', targetBranch: 'feature/payments' },
      { id: 'plan-mobile', targetBranch: 'release/mobile' },
      { id: 'plan-web', targetBranch: 'develop' },
    ]);
  });

  it('injects the executable active plan from memory even when it is not yet discoverable from metadata', async () => {
    const stalePersistedPlan = makePlan({
      id: 'plan-live',
      title: 'Checkout Live',
      status: 'validated',
      targetBranch: 'develop',
      projectId: 'web',
      projectIds: ['web'],
      nodes: [
        {
          id: 'stale-task',
          title: 'Persisted stale task',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'checkout-old',
          projectId: 'web',
        },
      ],
      predictedBranches: [
        {
          id: 'stale-branch',
          name: 'checkout-old',
          color: '#64748b',
          parentBranch: 'plan/checkout-live',
          projectId: 'web',
          taskIds: ['stale-task'],
          status: 'pending',
        },
      ],
    });

    const loadImplementTaskCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: 'plan-live',
        activePlanContext: {
          id: 'plan-live',
          title: 'Checkout Live',
          description: 'Live in-memory version',
          status: 'validated',
          targetBranch: 'feature/live-checkout',
          executionModesByProjectId: { web: 'direct' },
        },
        planNodes: [
          {
            id: 'live-task',
            title: 'Live in-memory task',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'checkout-live',
            projectId: 'web',
          },
        ],
        predictedBranches: [
          {
            id: 'live-branch',
            name: 'checkout-live',
            color: '#8b5cf6',
            parentBranch: 'plan/checkout-live',
            projectId: 'web',
            taskIds: ['live-task'],
            status: 'pending',
          },
        ],
        selectedGroupId: 'group-1',
        selectedProjectId: 'web',
        projectGroups: [
          {
            id: 'group-1',
            name: 'Checkout',
            isOpen: true,
            projects: [
              { id: 'web', name: 'Web', mountName: 'web', path: '/repos/web', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
            ],
          },
        ],
        getProjectById: () => undefined,
      } as never),
      listArchitectPlans: async () => ({
        activePlanId: 'plan-live',
        plans: [toSummary(stalePersistedPlan)],
      }),
      getArchitectPlan: async () => stalePersistedPlan,
      listArchitectPlanTargetBranches: async () => ['develop'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value || 'develop'),
      buildImplementTaskCatalog,
    });

    const catalog = await loadImplementTaskCatalog([]);

    expect(catalog.tasks.map((task) => task.node_id || task.id)).toEqual([
      'live-task',
      'stale-task',
      'plan-finalization:plan-live',
      'plan-finalization:plan-live',
    ]);
    expect(catalog.tasks[0]?.plan_target_branch).toBe('feature/live-checkout');
    expect(
      catalog.plans.find((plan) => plan.targetBranch === 'feature/live-checkout')
        ?.executionModesByProjectId,
    ).toEqual({ web: 'direct' });
    expect(catalog.plans.map((plan) => [plan.id, plan.targetBranch])).toEqual([
      ['plan-live', 'develop'],
      ['plan-live', 'feature/live-checkout'],
    ]);
  });

  it('uses standalone project git flow settings when injecting the active plan from memory', async () => {
    const loadImplementTaskCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: 'plan-standalone-active',
        activePlanContext: {
          id: 'plan-standalone-active',
          title: 'Standalone Active Plan',
          description: 'Plan restored from app state after reload',
          status: 'validated',
          targetBranch: 'main',
        },
        planNodes: [
          {
            id: 'standalone-task',
            title: 'Implement restored standalone task',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'feature/restored-task',
            projectId: 'project-octan-sales',
          },
        ],
        predictedBranches: [
          {
            id: 'standalone-branch',
            name: 'feature/restored-task',
            color: '#6366f1',
            parentBranch: 'main',
            projectId: 'project-octan-sales',
            taskIds: ['standalone-task'],
            status: 'pending',
          },
        ],
        selectedGroupId: null,
        selectedProjectId: 'project-octan-sales',
        standaloneProjects: [
          {
            id: 'project-octan-sales',
            name: 'octan_sales',
            mountName: 'octan-sales',
            path: '/Users/oscarlahaie/github/octan_sales',
            created_at: '',
            status: 'active',
            gitFlowSettings: {
              mainBranch: 'main',
              baseBranch: 'develop',
              planBranchTemplate: 'plan/{planSlug}',
              featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
              standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
              releaseBranchTemplate: 'release/{releaseSlug}',
              hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
              bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
              completionMergePolicy: 'merge_commit',
            },
            metadata: {
              description: '',
              tags: [],
              team_members: [],
              api_contracts: [],
              dependencies: [],
            },
          },
        ],
        projectGroups: [],
      }),
      listArchitectPlans: async () => ({
        activePlanId: null,
        plans: [],
      }),
      getArchitectPlan: async () => null,
      listArchitectPlanTargetBranches: async () => ['develop'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value || 'develop'),
      buildImplementTaskCatalog,
    });

    const catalog = await loadImplementTaskCatalog([]);
    const task = catalog.tasks.find((candidate) => (candidate.node_id || candidate.id) === 'standalone-task');
    const finalizationTask = catalog.tasks.find(
      (candidate) => candidate.node_id === 'plan-finalization:plan-standalone-active',
    );

    expect(task?.plan_target_branch).toBe('develop');
    expect(task?.plan_target_branches_by_project_id).toEqual({
      'project-octan-sales': 'develop',
    });
    expect(finalizationTask?.execution_targets).toEqual([
      {
        projectId: 'project-octan-sales',
        branchName: 'develop',
        targetBranchName: 'develop',
        executionKind: 'repository_root',
        worktreeKey: 'plan-finalization:project-octan-sales:project-octan-sales',
      },
    ]);
  });

  it('retargets a physically scoped standalone project plan when stored project ids are stale', async () => {
    const plan = makePlan({
      id: 'plan-lplr',
      title: 'Refonte catalogue produit',
      status: 'validated',
      targetBranch: 'develop',
      projectId: 'project-lplr-app-1780237886690',
      projectIds: ['project-lplr-app-1780237886690'],
      availableProjectIds: ['project-lplr-current'],
      replicas: [
        {
          scopeKey: 'repo:/Users/oscarlahaie/github/lplr-app',
          projectId: 'project-lplr-current',
          repoPath: '/Users/oscarlahaie/github/lplr-app',
          workspacePath: '/Users/oscarlahaie/github/lplr-app',
          source: 'project',
          updatedAt: '2026-03-08T00:00:00.000Z',
        },
      ],
      nodes: [
        {
          id: 'task-catalogue',
          title: 'Refondre le catalogue produit',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'feature/catalogue',
          projectId: 'project-lplr-app-1780237886690',
          projectIds: ['project-lplr-app-1780237886690'],
        },
      ],
      predictedBranches: [
        {
          id: 'branch-catalogue',
          name: 'feature/catalogue',
          color: '#6366f1',
          parentBranch: 'develop',
          projectId: 'project-lplr-app-1780237886690',
          taskIds: ['task-catalogue'],
          status: 'pending',
        },
      ],
    });
    const summary = {
      ...toSummary(plan),
      availableProjectIds: ['project-lplr-current'],
      replicas: plan.replicas,
    };
    const loadImplementTaskCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        selectedGroupId: null,
        selectedProjectId: 'project-lplr-current',
        standaloneProjects: [
          { id: 'project-lplr-current', name: 'lplr-app', mountName: 'lplr-app', path: '/Users/oscarlahaie/github/lplr-app', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
        ],
        projectGroups: [],
      }),
      listArchitectPlans: async () => ({
        activePlanId: null,
        plans: [summary],
      }),
      getArchitectPlan: async () => plan,
      listArchitectPlanTargetBranches: async () => ['develop'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value || 'develop'),
      buildImplementTaskCatalog,
    });

    const catalog = await loadImplementTaskCatalog([]);
    const task = catalog.tasks.find((candidate) => candidate.node_id === 'task-catalogue');

    expect(task?.project_id).toBe('project-lplr-current');
    expect(task?.project_ids).toEqual(['project-lplr-current']);
    expect(task?.execution_targets.map((target) => target.projectId)).toEqual(['project-lplr-current']);
    expect(catalog.plans[0]?.projectIds).toEqual(['project-lplr-current']);
  });

  it('keeps replica diagnostics while retargeting stale plan ids for execution', async () => {
    let capturedPlans: ArchitectPlanRecord[] = [];
    const plan = {
      ...makePlan({
        id: 'plan-lplr',
        title: 'Refonte catalogue produit',
        status: 'validated',
        targetBranch: 'develop',
        projectId: 'project-lplr-app-1780237886690',
        projectIds: ['project-lplr-app-1780237886690'],
        nodes: [],
        predictedBranches: [],
      }),
      expectedProjectIds: ['project-lplr-app-1780237886690', 'project-docs-old'],
      availableProjectIds: ['project-lplr-current'],
      missingProjectIds: ['project-docs-old'],
      replicationState: 'missing_projects',
      replicas: [
        {
          scopeKey: 'repo:/Users/oscarlahaie/github/lplr-app',
          projectId: 'project-lplr-current',
          repoPath: '/Users/oscarlahaie/github/lplr-app',
          workspacePath: '/Users/oscarlahaie/github/lplr-app',
          source: 'project',
          updatedAt: '2026-03-08T00:00:00.000Z',
        },
      ],
    } satisfies ArchitectPlanRecord;
    const loadImplementTaskCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        selectedGroupId: null,
        selectedProjectId: 'project-lplr-current',
        standaloneProjects: [
          { id: 'project-lplr-current', name: 'lplr-app', mountName: 'lplr-app', path: '/Users/oscarlahaie/github/lplr-app', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
        ],
        projectGroups: [],
      }),
      listArchitectPlans: async () => ({
        activePlanId: null,
        plans: [{ ...toSummary(plan), availableProjectIds: plan.availableProjectIds, replicas: plan.replicas }],
      }),
      getArchitectPlan: async () => plan,
      listArchitectPlanTargetBranches: async () => ['develop'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value || 'develop'),
      buildImplementTaskCatalog: (params) => {
        capturedPlans = params.plans;
        return buildImplementTaskCatalog(params);
      },
    });

    await loadImplementTaskCatalog([]);

    expect(capturedPlans[0]?.projectIds).toEqual(['project-lplr-current']);
    expect(capturedPlans[0]?.missingProjectIds).toEqual(['project-docs-old']);
    expect(capturedPlans[0]?.replicationState).toBe('missing_projects');
  });

  it('retargets standalone fallback tasks with stale project ids to the selected single project scope', async () => {
    const loadImplementTaskCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        selectedGroupId: null,
        selectedProjectId: 'project-lplr-current',
        standaloneProjects: [
          { id: 'project-lplr-current', name: 'lplr-app', mountName: 'lplr-app', path: '/Users/oscarlahaie/github/lplr-app', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
        ],
        projectGroups: [],
      }),
      listArchitectPlans: async () => ({
        activePlanId: null,
        plans: [],
      }),
      getArchitectPlan: async () => null,
      listArchitectPlanTargetBranches: async () => ['develop'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value || 'develop'),
      buildImplementTaskCatalog,
    });

    const catalog = await loadImplementTaskCatalog([
      makeTask({
        id: 'standalone-stale',
        title: 'Tâche indépendante',
        project_id: 'project-lplr-app-1780237886690',
        project_ids: ['project-lplr-app-1780237886690'],
        status: 'Pending',
      }),
    ]);
    const task = catalog.tasks.find((candidate) => candidate.id === 'standalone-stale');

    expect(task?.project_id).toBe('project-lplr-current');
    expect(task?.project_ids).toEqual(['project-lplr-current']);
    expect(task?.execution_targets.map((target) => target.projectId)).toEqual(['project-lplr-current']);
  });

  it('ignores invalid target branches and preserves valid plans when one branch or plan load fails', async () => {
    const webPlan = makePlan({
      id: 'plan-web',
      title: 'Web Checkout',
      status: 'validated',
      targetBranch: 'develop',
      projectId: 'web',
      projectIds: ['web'],
      nodes: [
        {
          id: 'task-web',
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
          id: 'branch-web',
          name: 'checkout-ui',
          color: '#3b82f6',
          parentBranch: 'plan/web-checkout',
          projectId: 'web',
          taskIds: ['task-web'],
          status: 'pending',
        },
      ],
    });
    const brokenPlan = makePlan({
      id: 'plan-broken',
      title: 'Broken Payments',
      status: 'validated',
      targetBranch: 'feature/payments',
      projectId: 'api',
      projectIds: ['api'],
      nodes: [
        {
          id: 'task-broken',
          title: 'Broken endpoint',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'broken-payments',
          projectId: 'api',
        },
      ],
      predictedBranches: [
        {
          id: 'branch-broken',
          name: 'broken-payments',
          color: '#ef4444',
          parentBranch: 'plan/broken-payments',
          projectId: 'api',
          taskIds: ['task-broken'],
          status: 'pending',
        },
      ],
    });

    const resolveTargetBranch = (value: unknown): string => {
      const normalized = String(value || '').trim();
      if (normalized === 'develop' || normalized === 'feature/payments') {
        return normalized;
      }
      throw new Error(`Invalid branch: ${normalized}`);
    };

    const loadImplementTaskCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        selectedGroupId: 'group-1',
        selectedProjectId: 'web',
        projectGroups: [
          {
            id: 'group-1',
            name: 'Checkout',
            isOpen: true,
            projects: [
              { id: 'web', name: 'Web', mountName: 'web', path: '/repos/web', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
              { id: 'api', name: 'API', mountName: 'api', path: '/repos/api', created_at: '', status: 'active', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } },
            ],
          },
        ],
        getProjectById: () => undefined,
      } as never),
      listArchitectPlans: async (branchName: string) => {
        if (branchName === 'feature/payments') {
          throw new Error('metadata branch unavailable');
        }
        return {
          activePlanId: null,
          plans: branchName === 'develop' ? [toSummary(webPlan), toSummary(brokenPlan)] : [],
        };
      },
      getArchitectPlan: async (_branchName: string, planId: string) => {
        if (planId === 'plan-broken') {
          throw new Error('plan replica divergence');
        }
        return webPlan;
      },
      listArchitectPlanTargetBranches: async () => ['develop', 'invalid branch', 'feature/payments'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch,
      buildImplementTaskCatalog,
    });

    const catalog = await loadImplementTaskCatalog([
      makeTask({
        id: 'standalone-1',
        title: 'Fix production typo',
        project_id: 'web',
        status: 'InProgress',
      }),
    ]);

    expect(catalog.tasks.map((task) => task.node_id || task.id)).toEqual([
      'task-web',
      'plan-finalization:plan-web',
      'standalone-1',
    ]);
    expect(catalog.plans).toEqual([
      expect.objectContaining({
        id: 'plan-web',
        targetBranch: 'develop',
      }),
    ]);
  });

  it('rejects when plan refs exist but every referenced plan fails to load', async () => {
    const summary = toSummary(makePlan({
      id: 'plan-unavailable',
      title: 'Unavailable',
      status: 'validated',
      targetBranch: 'develop',
    }));
    const loadCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        selectedGroupId: null,
        selectedProjectId: 'web',
        projectGroups: [],
        standaloneProjects: [],
      }),
      listArchitectPlans: async () => ({ activePlanId: null, plans: [summary] }),
      getArchitectPlan: async () => { throw new Error('replicas unavailable'); },
      listArchitectPlanTargetBranches: async () => ['develop'],
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value),
      buildImplementTaskCatalog,
    });

    await expect(loadCatalog([])).rejects.toThrow(
      'Unable to load any referenced Architect plan',
    );
  });

  it('still scans the Git-flow base branch when branch discovery fails', async () => {
    const plan = makePlan({
      id: 'plan-base',
      title: 'Base plan',
      status: 'validated',
      targetBranch: 'develop',
    });
    const attemptedBranches: string[] = [];
    const loadCatalog = createLoadImplementTaskCatalog({
      getAppState: () => ({
        activeArchitectPlanId: null,
        activePlanContext: null,
        planNodes: [],
        predictedBranches: [],
        selectedGroupId: null,
        selectedProjectId: 'web',
        projectGroups: [],
        standaloneProjects: [],
      }),
      listArchitectPlans: async (branchName) => {
        attemptedBranches.push(branchName);
        return { activePlanId: null, plans: [toSummary(plan)] };
      },
      getArchitectPlan: async () => plan,
      listArchitectPlanTargetBranches: async () => { throw new Error('discovery unavailable'); },
      getGitFlowBaseBranch: () => 'develop',
      resolveTargetBranch: (value: unknown) => String(value),
      buildImplementTaskCatalog,
    });

    await loadCatalog([]);
    expect(attemptedBranches).toEqual(['develop']);
  });
});
