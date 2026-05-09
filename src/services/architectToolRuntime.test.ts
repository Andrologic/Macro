import { describe, expect, it } from 'bun:test';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { PlanNode, Project, ProjectGroup } from '../types';
import { handleArchitectToolCall } from './architectToolRuntime';

type ArchitectToolRuntimeParams = Parameters<typeof handleArchitectToolCall>[0];

const createProject = (overrides: Pick<Project, 'id' | 'name' | 'path'> & Partial<Project>): Project => ({
  id: overrides.id,
  name: overrides.name,
  path: overrides.path,
  mountName: overrides.mountName ?? overrides.name.toLowerCase(),
  created_at: overrides.created_at || '2026-04-28T00:00:00.000Z',
  status: overrides.status || 'active',
  userReadOnly: overrides.userReadOnly ?? false,
  gitSetupState: overrides.gitSetupState || 'ready',
  isReadOnly: overrides.isReadOnly ?? false,
  readOnlyReason: overrides.readOnlyReason ?? null,
  metadata: overrides.metadata || {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
  gitFlowSettings: overrides.gitFlowSettings,
});

const projectGroups: ProjectGroup[] = [
  {
    id: 'mouillage-suite',
    name: 'Mouillage',
    isOpen: true,
    projects: [
      createProject({ id: 'mouillage-app', name: 'Mouillage App', path: '/repos/mouillage' }),
      createProject({ id: 'mouillage-docs', name: 'Mouillage Docs', path: '/repos/mouillage-docs' }),
      createProject({
        id: 'mouillage-context',
        name: 'Mouillage Context',
        path: '/repos/mouillage-context',
        isReadOnly: true,
      }),
    ],
  },
  {
    id: 'other-suite',
    name: 'Other',
    isOpen: true,
    projects: [
      createProject({ id: 'projectsetr2', name: 'ProjectSETR2', path: '/repos/projectsetr2' }),
      createProject({ id: 'opencode', name: 'opencode', path: '/repos/opencode' }),
    ],
  },
];

const createPlan = (overrides: Partial<ArchitectPlanRecord> = {}): ArchitectPlanRecord => ({
  id: 'plan-1',
  slug: 'play-store-deployment',
  title: 'plan-1',
  label: 'Préparer le déploiement sur Play Store',
  description: 'Prepare Mouillage for release.',
  planKind: 'feature',
  status: 'draft',
  targetBranch: 'main',
  targetBranchesByProjectId: {
    'mouillage-app': 'main',
  },
  conversationId: 'conversation-1',
  projectId: 'mouillage-app',
  projectIds: ['mouillage-app'],
  contextProjectIds: [],
  expectedProjectIds: ['mouillage-app'],
  createdAt: '2026-04-28T00:00:00.000Z',
  updatedAt: '2026-04-28T00:00:00.000Z',
  revision: 1,
  nodes: [],
  predictedBranches: [],
  ...overrides,
});

const createRuntime = (plan: ArchitectPlanRecord) => {
  let appliedPlan = plan;
  const getProjectById = (projectId: string) =>
    projectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId);
  const args: Record<string, unknown> = {
    plan_id: plan.id,
    nodes: [
      {
        title: 'Configurer la release',
        description: 'Préparer le build Android.',
        type: 'feature',
        featureSlug: 'release',
      },
    ],
  };

  return {
    getAppliedPlan: () => appliedPlan,
    params: {
      assistantMessageId: 'assistant-message-1',
      toolName: 'strategy_generate',
      args,
      getAppState: () => ({
        activeArchitectPlanId: plan.id,
        activePlanContext: {
          id: plan.id,
          targetBranch: plan.targetBranch,
        },
        selectedGroupId: 'other-suite',
        selectedProjectId: 'opencode',
        projectGroups,
        getProjectById,
        activateArchitectPlan: async () => true,
        setStrategyMutationPreview: () => undefined,
      }),
      getNeedsState: () => ({
        addNeed: () => 'need-1',
        updateNeed: () => undefined,
        deleteNeed: () => undefined,
        flushPendingPersistence: async () => undefined,
        getNeed: () => undefined,
        getNeedsForPlan: () => [],
      }),
      getTaskState: () => ({
        tasks: [],
        refreshFromPlan: async () => undefined,
      }),
      ensureArchitectConversationForPlan: async () => ({
        conversationId: 'conversation-1',
        restoredTranscript: false,
        createdConversation: false,
      }),
      planService: {
        createArchitectPlan: async () => plan,
        getArchitectPlan: async () => appliedPlan,
        getGitFlowBaseBranch: () => 'main',
        isArchitectPlanSlugAvailable: async () => true,
        isArchitectPlanSlugMutable: () => true,
        listArchitectPlans: async () => ({
          activePlanId: plan.id,
          plans: [],
        }),
        resolvePlanProjectContextId: () => plan.projectId ?? null,
        resolveTargetBranch: (value: unknown) => (typeof value === 'string' ? value : 'main'),
        updateArchitectPlan: async (input: unknown) => {
          appliedPlan = {
            ...appliedPlan,
            ...(input as Record<string, unknown>),
          } as ArchitectPlanRecord;
          return appliedPlan;
        },
      },
      strategyService: {
        prepareStrategyMutationPreview: (input: {
          candidateNodes: PlanNode[];
          targetBranchesByProjectId?: Record<string, string>;
          metadataUpdate?: { description?: string; slug?: string; label?: string; title?: string };
        }) => {
          const resolvedProjectIds = Array.from(
            new Set(input.candidateNodes.flatMap((node) => node.projectIds || [])),
          );
          return {
            planId: plan.id,
            planTitle: plan.label || plan.title,
            source: 'strategy_generate' as const,
            status: 'valid' as const,
            requiresPreview: false,
            repairAttempted: false,
            baseRevision: plan.revision ?? null,
            targetBranch: plan.targetBranch,
            nextPlanStatus: plan.status,
            autoProvisionBranches: false,
            metadataUpdate: {
              description: input.metadataUpdate?.description ?? plan.description,
              ...(input.metadataUpdate?.slug ? { slug: input.metadataUpdate.slug } : {}),
              ...(input.metadataUpdate?.label ? { label: input.metadataUpdate.label } : {}),
              ...(input.metadataUpdate?.title ? { title: input.metadataUpdate.title } : {}),
            },
            resolvedProjectIds,
            targetBranchesByProjectId: input.targetBranchesByProjectId || {},
            planNodes: input.candidateNodes,
            predictedBranches: resolvedProjectIds.map((projectId) => ({
              id: `branch-${projectId}`,
              name: `feature/play-store-deployment/release`,
              color: '#3b82f6',
              parentBranch: 'plan/play-store-deployment',
              projectId,
              taskIds: input.candidateNodes
                .filter((node) => (node.projectIds || []).includes(projectId))
                .map((node) => node.id),
              status: 'pending' as const,
              branchType: 'feature' as const,
              branchSlug: 'release',
            })),
            frozenNodes: [],
            rewrittenPendingNodes: [],
            newNodes: input.candidateNodes.map((node) => ({ id: node.id, title: node.title })),
            removedPendingNodes: [],
            conflicts: [],
          };
        },
        applyStrategyMutationPreview: async ({ preview }: { preview: {
          planNodes: PlanNode[];
          predictedBranches: ArchitectPlanRecord['predictedBranches'];
          resolvedProjectIds: string[];
          targetBranchesByProjectId: Record<string, string>;
          metadataUpdate: { description: string; slug?: string; label?: string; title?: string };
        } }) => {
          appliedPlan = {
            ...appliedPlan,
            description: preview.metadataUpdate.description,
            ...(preview.metadataUpdate.slug ? { slug: preview.metadataUpdate.slug } : {}),
            ...(preview.metadataUpdate.label ? { label: preview.metadataUpdate.label } : {}),
            ...(preview.metadataUpdate.title ? { title: preview.metadataUpdate.title } : {}),
            nodes: preview.planNodes,
            predictedBranches: preview.predictedBranches,
            projectId: preview.resolvedProjectIds[0],
            projectIds: preview.resolvedProjectIds,
            targetBranchesByProjectId: preview.targetBranchesByProjectId,
          };
          return appliedPlan;
        },
        guardDeps: {} as ArchitectToolRuntimeParams['strategyService']['guardDeps'],
      },
    } as ArchitectToolRuntimeParams,
  };
};

describe('architectToolRuntime strategy scope', () => {
  it('keeps unscoped generated nodes inside the active mono-subproject plan', async () => {
    const runtime = createRuntime(createPlan());

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().projectIds).toEqual(['mouillage-app']);
    expect(runtime.getAppliedPlan().contextProjectIds).toEqual([]);
    expect(runtime.getAppliedPlan().nodes.map((node) => node.projectIds)).toEqual([
      ['mouillage-app'],
    ]);
    expect(runtime.getAppliedPlan().predictedBranches.map((branch) => branch.projectId)).toEqual([
      'mouillage-app',
    ]);
  });

  it('uses every editable subproject already attached to a multi-subproject plan', async () => {
    const runtime = createRuntime(createPlan({
      projectIds: ['mouillage-app', 'mouillage-docs'],
      expectedProjectIds: ['mouillage-app', 'mouillage-docs', 'mouillage-context'],
      contextProjectIds: ['mouillage-context'],
      targetBranchesByProjectId: {
        'mouillage-app': 'main',
        'mouillage-docs': 'main',
      },
    }));

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().projectIds).toEqual(['mouillage-app', 'mouillage-docs']);
    expect(runtime.getAppliedPlan().contextProjectIds).toEqual(['mouillage-context']);
    expect(runtime.getAppliedPlan().nodes[0]?.projectIds).toEqual(['mouillage-app', 'mouillage-docs']);
    expect(runtime.getAppliedPlan().predictedBranches.map((branch) => branch.projectId)).toEqual([
      'mouillage-app',
      'mouillage-docs',
    ]);
  });

  it('normalizes duplicate generated feature slugs into task-specific slugs', async () => {
    const runtime = createRuntime(createPlan());
    runtime.params.args.nodes = [
      {
        title: 'Configurer la release',
        description: 'Préparer le build Android.',
        type: 'task',
        featureSlug: 'release',
      },
      {
        title: 'Publier la release',
        description: 'Préparer la publication.',
        type: 'task',
        featureSlug: 'release',
      },
    ];

    await handleArchitectToolCall(runtime.params);

    const branchSlugs = runtime.getAppliedPlan().nodes.map((node) => node.branchSlug);
    expect(branchSlugs[0]).toBe('release');
    expect(branchSlugs[1]).toMatch(/^release-[0-9a-f]{6}$/);
  });

  it('persists generated todos on strategy nodes', async () => {
    const runtime = createRuntime(createPlan());
    runtime.params.args.nodes = [
      {
        title: 'Configurer la release',
        description: 'Préparer le build Android.',
        type: 'task',
        featureSlug: 'release',
        todos: [
          { title: 'Mettre à jour la version', status: 'done' },
          { id: 'todo-build', title: 'Lancer le build Android', status: 'in-progress' },
        ],
      },
    ];

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().nodes[0]?.todos).toEqual([
      expect.objectContaining({
        title: 'Mettre à jour la version',
        status: 'done',
      }),
      {
        id: 'todo-build',
        title: 'Lancer le build Android',
        status: 'in-progress',
      },
    ]);
  });

  it('creates a required fallback todo when generated nodes omit todos', async () => {
    const runtime = createRuntime(createPlan());
    runtime.params.args.nodes = [
      {
        title: 'Configurer la release',
        description: 'Préparer le build Android.',
        type: 'task',
        featureSlug: 'release',
      },
    ];

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().nodes[0]?.todos).toEqual([
      expect.objectContaining({
        title: 'Configurer la release',
        description: 'Préparer le build Android.',
        status: 'pending',
      }),
    ]);
  });

  it('updates todos through strategy_update operations', async () => {
    const plan = createPlan({
      nodes: [
        {
          id: 'node-1',
          title: 'Configurer la release',
          description: 'Préparer le build Android.',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'release',
          branchType: 'feature',
          branchSlug: 'release',
          projectId: 'mouillage-app',
          projectIds: ['mouillage-app'],
          todos: [{ id: 'todo-1', title: 'Ancien todo', status: 'pending' }],
        },
      ],
    });
    const runtime = createRuntime(plan);
    runtime.params.toolName = 'strategy_update';
    runtime.params.args = {
      operations: [
        {
          action: 'update',
          node_id: 'node-1',
          todos: [
            { id: 'todo-1', title: 'Ancien todo', status: 'done' },
            { id: 'todo-2', title: 'Nouveau todo', status: 'pending' },
          ],
        },
      ],
    };

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().nodes[0]?.todos).toEqual([
      { id: 'todo-1', title: 'Ancien todo', status: 'done' },
      { id: 'todo-2', title: 'Nouveau todo', status: 'pending' },
    ]);
  });

  it('preserves existing todo ids when strategy_update sends title-only matching todos', async () => {
    const plan = createPlan({
      nodes: [
        {
          id: 'node-1',
          title: 'Configurer la release',
          description: 'Préparer le build Android.',
          type: 'task',
          status: 'pending',
          dependencies: [],
          assignedBranch: 'release',
          branchType: 'feature',
          branchSlug: 'release',
          projectId: 'mouillage-app',
          projectIds: ['mouillage-app'],
          todos: [{ id: 'todo-existing', title: 'Lancer le build Android', status: 'pending' }],
        },
      ],
    });
    const runtime = createRuntime(plan);
    runtime.params.toolName = 'strategy_update';
    runtime.params.args = {
      operations: [
        {
          action: 'update',
          node_id: 'node-1',
          todos: [{ title: 'Lancer le build Android', status: 'done' }],
        },
      ],
    };

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().nodes[0]?.todos).toEqual([
      { id: 'todo-existing', title: 'Lancer le build Android', status: 'done' },
    ]);
  });

  it('rejects context-only and external subprojects in explicit node scope', async () => {
    const contextRuntime = createRuntime(createPlan({
      contextProjectIds: ['mouillage-context'],
      expectedProjectIds: ['mouillage-app', 'mouillage-context'],
    }));
    contextRuntime.params.args.nodes = [
      {
        title: 'Modifier le contexte',
        type: 'task',
        project_ids: ['mouillage-context'],
      },
    ];

    await expect(handleArchitectToolCall(contextRuntime.params)).rejects.toThrow('context-only subproject');

    const externalRuntime = createRuntime(createPlan());
    externalRuntime.params.args.nodes = [
      {
        title: 'Modifier un autre projet',
        type: 'task',
        project_ids: ['opencode'],
      },
    ];

    await expect(handleArchitectToolCall(externalRuntime.params)).rejects.toThrow('outside this plan');
  });
});
