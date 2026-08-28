import { describe, expect, it, mock } from 'bun:test';
import type { Project } from '../types';
import type { ArchitectPlanRecord } from './architectPlanService';
import { createArchitectScopePromotionService } from './architectScopePromotionService';

const buildPlan = (overrides: Partial<ArchitectPlanRecord> = {}): ArchitectPlanRecord => ({
  id: 'plan-1',
  slug: 'game',
  title: 'Game',
  label: 'Game',
  description: '',
  status: 'validated',
  targetBranch: 'develop',
  targetBranchesByProjectId: {
    api: 'develop',
    web: 'develop',
  },
  conversationId: undefined,
  projectId: 'api',
  projectIds: ['api'],
  contextProjectIds: ['web'],
  expectedProjectIds: ['api', 'web'],
  createdAt: '2026-04-24T00:00:00.000Z',
  updatedAt: '2026-04-24T00:00:00.000Z',
  revision: 1,
  nodes: [
    {
      id: 'task-1',
      title: 'Add mobile game backend',
      type: 'task',
      status: 'in-progress',
      dependencies: [],
      assignedBranch: 'feature/game/backend',
      branchType: 'feature',
      branchSlug: 'backend',
      projectId: 'api',
      projectIds: ['api'],
    },
  ],
  predictedBranches: [
    {
      id: 'branch-api',
      name: 'feature/game/backend',
      color: '#3b82f6',
      parentBranch: 'plan/game',
      projectId: 'api',
      taskIds: ['task-1'],
      status: 'active',
      branchType: 'feature',
      branchSlug: 'backend',
    },
  ],
  ...overrides,
});

const buildProject = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  name: id.toUpperCase(),
  mountName: id,
  path: `/repos/${id}`,
  created_at: '2026-04-24T00:00:00.000Z',
  status: 'active' as const,
  gitSetupState: 'ready' as const,
  isReadOnly: false,
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
  gitFlowSettings: {
    baseBranch: 'develop',
    mainBranch: 'main',
    planBranchTemplate: 'plan/{planSlug}',
    featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
    standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
    releaseBranchTemplate: 'release/{branchSlug}',
    hotfixBranchTemplate: 'hotfix/{branchSlug}',
    bugfixBranchTemplate: 'bugfix/{branchSlug}',
  },
  ...overrides,
});

describe('architectScopePromotionService', () => {
  it('promotes a context repo into the task and provisions its branches', async () => {
    let plan = buildPlan();
    const updateArchitectPlan = mock(async (input: Partial<ArchitectPlanRecord> & { planId: string }) => {
      plan = {
        ...plan,
        ...input,
        id: plan.id,
      };
      return plan;
    });
    const provisionPlanBranches = mock(async (updatedPlan: ArchitectPlanRecord) => ({
      planBranchName: 'plan/game',
      repositories: (updatedPlan.projectIds || []).map((projectId) => ({
        projectId,
        repoPath: `/repos/${projectId}`,
        planBranchName: 'plan/game',
        createdPlanBranch: projectId === 'web',
        createdFeatureBranches: projectId === 'web' ? ['feature/game/backend'] : [],
        existingFeatureBranches: [],
      })),
      createdPlanBranch: true,
      createdFeatureBranches: ['feature/game/backend'],
      existingFeatureBranches: [],
    }));

    const service = createArchitectScopePromotionService({
      getAppState: () => ({
        projectGroups: [{
          id: 'group',
          name: 'Group',
          isOpen: true,
          projects: [buildProject('api'), buildProject('web')],
        }],
        getProjectById: (projectId) => projectId === 'api' ? buildProject('api') : buildProject('web'),
      }),
      getArchitectPlan: mock(async () => plan),
      updateArchitectPlan: updateArchitectPlan as any,
      provisionPlanBranches: provisionPlanBranches as any,
    });

    const result = await service.promoteTaskContextProjects({
      branchName: 'develop',
      planId: 'plan-1',
      taskId: 'task-1',
      projectIds: ['web'],
      triggerTool: 'write',
    });

    expect(result.promotedProjectIds).toEqual(['web']);
    expect(updateArchitectPlan).toHaveBeenCalledWith(expect.objectContaining({
      projectIds: ['api', 'web'],
      contextProjectIds: [],
      expectedProjectIds: ['api', 'web'],
    }));
    expect(result.plan.nodes.find((node) => node.id === 'task-1')?.projectIds).toEqual(['api', 'web']);
    expect(result.plan.predictedBranches.map((branch) => `${branch.projectId}:${branch.name}`).sort()).toEqual([
      'api:feature/game/backend',
      'web:feature/game/backend',
    ]);
    expect(provisionPlanBranches).toHaveBeenCalledTimes(1);
  });

  it('refuses to promote a physically read-only context repo', async () => {
    const plan = buildPlan();
    const service = createArchitectScopePromotionService({
      getAppState: () => ({
        projectGroups: [{
          id: 'group',
          name: 'Group',
          isOpen: true,
          projects: [buildProject('api'), buildProject('web', { isReadOnly: true })],
        }],
        getProjectById: (projectId) =>
          projectId === 'web' ? buildProject('web', { isReadOnly: true }) : buildProject('api'),
      }),
      getArchitectPlan: mock(async () => plan),
      updateArchitectPlan: mock(async () => plan) as any,
      provisionPlanBranches: mock(async () => null) as any,
    });

    await expect(service.promoteTaskContextProjects({
      branchName: 'develop',
      planId: 'plan-1',
      taskId: 'task-1',
      projectIds: ['web'],
    })).rejects.toThrow('project access setting');
  });

  it('retries provisioning after the promoted scope was already persisted', async () => {
    let plan = buildPlan();
    const updateArchitectPlan = mock(async (input: Partial<ArchitectPlanRecord> & { planId: string }) => {
      plan = { ...plan, ...input, id: plan.id };
      return plan;
    });
    let provisionAttempt = 0;
    const provisionPlanBranches = mock(async () => {
      provisionAttempt += 1;
      if (provisionAttempt === 1) throw new Error('Git provisioning failed');
      return {
        planBranchName: 'plan/game',
        repositories: [],
        createdPlanBranch: false,
        createdFeatureBranches: [],
        existingFeatureBranches: ['feature/game/backend'],
      };
    });
    const service = createArchitectScopePromotionService({
      getAppState: () => ({
        projectGroups: [{
          id: 'group',
          name: 'Group',
          isOpen: true,
          projects: [buildProject('api'), buildProject('web')],
        }],
        getProjectById: (projectId) => buildProject(projectId),
      }),
      getArchitectPlan: mock(async () => plan),
      updateArchitectPlan: updateArchitectPlan as any,
      provisionPlanBranches: provisionPlanBranches as any,
    });
    const params = {
      branchName: 'develop',
      planId: 'plan-1',
      taskId: 'task-1',
      projectIds: ['web'],
    };

    await expect(service.promoteTaskContextProjects(params)).rejects.toThrow('Git provisioning failed');
    const resumed = await service.promoteTaskContextProjects(params);

    expect(updateArchitectPlan).toHaveBeenCalledTimes(1);
    expect(provisionPlanBranches).toHaveBeenCalledTimes(2);
    expect(resumed.promotedProjectIds).toEqual([]);
    expect(resumed.provision).not.toBeNull();
    expect(resumed.plan.projectIds).toEqual(['api', 'web']);
  });
});
