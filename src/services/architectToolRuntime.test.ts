import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE,
  type ArchitectPlanRecord,
} from './architectPlanService';
import type { PlanNode, Project, ProjectGroup } from '../types';
import { handleArchitectToolCall } from './architectToolRuntime';
import { createChatToolDispatch } from './chatToolDispatch';
import type { FrozenToolCallContext } from './chatStreamContracts';
import type { ToolInvocation } from '../types/generated/ipc';
import { installArchitectPlanRuntimePorts } from './architectPlanRuntimeService';

let releasePlanRuntimePorts: (() => void) | undefined;
afterEach(() => {
  releasePlanRuntimePorts?.();
  releasePlanRuntimePorts = undefined;
});

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

const createRuntime = (
  plan: ArchitectPlanRecord,
  options: { directProjectIds?: string[] } = {},
) => {
  let appliedPlan = plan;
  const directProjectIds = new Set(options.directProjectIds ?? []);
  const runtimeProjectGroups = projectGroups.map((group) => ({
    ...group,
    projects: group.projects.map((project) => directProjectIds.has(project.id)
      ? { ...project, gitSetupState: 'not_git' as const, directEdit: true }
      : project),
  }));
  const getProjectById = (projectId: string) =>
    runtimeProjectGroups.flatMap((group) => group.projects).find((project) => project.id === projectId);
  releasePlanRuntimePorts?.();
  releasePlanRuntimePorts = installArchitectPlanRuntimePorts({ getProjectById });
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
          status: plan.status,
        },
        selectedGroupId: 'other-suite',
        selectedProjectId: 'opencode',
        projectGroups: runtimeProjectGroups,
        getProjectById,
        activateArchitectPlan: async () => true,
        consumeArchitectPlanActivationPayload: () => ({
          plan: appliedPlan,
          targetBranch: appliedPlan.targetBranch,
          conversationId: appliedPlan.conversationId ?? null,
          sharedConversation: false,
          resolutionMode: 'full' as const,
          chatMessages: [],
          chatMessagesLoaded: false,
          chatTranscriptRevision: 'transcript-revision-1',
          chatMessageCount: 2,
          replicaScopeKey: 'project:mouillage-app',
          replicaProjectId: 'mouillage-app',
        }),
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
            predictedBranches: resolvedProjectIds
              .filter((projectId) => input.candidateNodes.some((node) =>
                (node.projectIds || []).includes(projectId) &&
                node.executionModesByProjectId?.[projectId] !== 'direct'
              ))
              .map((projectId) => ({
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
  it('forwards the activation head identity to transcript reconciliation', async () => {
    const runtime = createRuntime(createPlan());
    const ensure = mock(runtime.params.ensureArchitectConversationForPlan);
    runtime.params.ensureArchitectConversationForPlan = ensure;

    const result = await handleArchitectToolCall(runtime.params);
    expect(typeof result).toBe('string');

    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({
      conversationIdHint: 'conversation-1',
      chatMessagesHint: [],
      chatMessagesLoaded: false,
      chatTranscriptRevision: 'transcript-revision-1',
      chatMessageCount: 2,
      replicaScopeKey: 'project:mouillage-app',
      replicaProjectId: 'mouillage-app',
    }));
  });

  it('reports the saved strategy and failed transcript reconciliation without applying it again', async () => {
    const runtime = createRuntime(createPlan());
    const apply = mock(runtime.params.strategyService.applyStrategyMutationPreview);
    runtime.params.strategyService.applyStrategyMutationPreview = apply;
    const refresh = mock(async () => undefined);
    runtime.params.getTaskState = () => ({ tasks: [], refreshFromPlan: refresh });
    runtime.params.ensureArchitectConversationForPlan = async () => {
      throw new Error('Architect transcript replica identity is incomplete');
    };

    const result = await handleArchitectToolCall(runtime.params);

    expect(result).toMatchObject({ kind: 'result', isError: true, errorKind: 'execution' });
    expect(String(result)).toContain('"mutation_status": "applied"');
    expect(String(result)).toContain('Architect transcript replica identity is incomplete');
    expect(String(result)).toContain('Reselect the plan');
    expect(String(result)).toContain('Do not regenerate');
    expect(runtime.getAppliedPlan().nodes).toHaveLength(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    runtime.params.ensureArchitectConversationForPlan = async () => ({
      conversationId: 'conversation-1', restoredTranscript: false, createdConversation: false,
    });
    runtime.params.toolName = 'strategy_get';
    runtime.params.args = {};
    expect(await handleArchitectToolCall(runtime.params)).toContain('Configurer la release');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('confirms the partial executor result in the journal and refuses replay of the same invocation', async () => {
    const runtime = createRuntime(createPlan());
    const apply = mock(runtime.params.strategyService.applyStrategyMutationPreview);
    runtime.params.strategyService.applyStrategyMutationPreview = apply;
    runtime.params.ensureArchitectConversationForPlan = async () => { throw new Error('replica unavailable'); };
    const operation = {
      conversationId: 'conversation-1', turnId: 'turn-1', assistantMessageId: 'message-1',
      signal: new AbortController().signal, allowedToolIds: ['strategy_generate'],
    } as unknown as FrozenToolCallContext;
    let recorded = false;
    const invocation = {} as ToolInvocation;
    const complete = mock(async () => invocation);
    const markUnknown = mock(async () => invocation);
    const dispatch = createChatToolDispatch(operation, {
      journal: {
        isRemoteRuntime: () => false,
        record: async () => { const is_new = !recorded; recorded = true; return { is_new, invocation }; },
        complete, markUnknown,
      },
      execute: () => handleArchitectToolCall(runtime.params),
      preserve: async (_operation, _name, _callId, result) => result,
      boundError: async (_operation, _name, _callId, error) => error,
    }, () => true, () => {});

    expect(await dispatch('strategy_generate', runtime.params.args, 'call-1')).toMatchObject({ isError: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(markUnknown).not.toHaveBeenCalled();
    expect(await dispatch('strategy_generate', runtime.params.args, 'call-1')).toMatchObject({ isError: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('reports an activation failure after the strategy was saved', async () => {
    const runtime = createRuntime(createPlan());
    const appState = runtime.params.getAppState();
    runtime.params.getAppState = () => ({ ...appState, activateArchitectPlan: async () => false });
    const ensure = mock(runtime.params.ensureArchitectConversationForPlan);
    runtime.params.ensureArchitectConversationForPlan = ensure;
    const result = await handleArchitectToolCall(runtime.params);
    expect(result).toMatchObject({ isError: true });
    expect(String(result)).toContain('could not be activated');
    expect(String(result)).toContain('"mutation_status": "applied"');
    expect(ensure).not.toHaveBeenCalled();
    expect(runtime.getAppliedPlan().nodes).toHaveLength(1);
  });

  it('reports a transcript replica conflict after saving without claiming full success', async () => {
    const runtime = createRuntime(createPlan({ hasReplicaDivergence: true, replicationState: 'diverged' }));
    runtime.params.ensureArchitectConversationForPlan = async () => {
      throw { code: 'ARCHITECT_PLAN_REPLICA_DIVERGENCE', message: 'Transcript replicas conflict' };
    };
    const result = await handleArchitectToolCall(runtime.params);
    expect(result).toMatchObject({ isError: true });
    expect(String(result)).toContain('Transcript replicas conflict');
    expect(String(result)).toContain('"mutation_status": "applied"');
    expect(runtime.getAppliedPlan().nodes).toHaveLength(1);
  });

  it('keeps cancellation explicit instead of converting it to partial success', async () => {
    const runtime = createRuntime(createPlan());
    runtime.params.ensureArchitectConversationForPlan = async () => {
      throw new Error('Tool execution aborted');
    };
    await expect(handleArchitectToolCall(runtime.params)).rejects.toThrow('Tool execution aborted');
    expect(runtime.getAppliedPlan().nodes).toHaveLength(1);
  });

  it('reports failed task refresh after a confirmed strategy update', async () => {
    const runtime = createRuntime(createPlan());
    runtime.params.toolName = 'strategy_update';
    runtime.params.getTaskState = () => ({ tasks: [], refreshFromPlan: async () => { throw new Error('task refresh unavailable'); } });
    const result = await handleArchitectToolCall(runtime.params);
    expect(result).toMatchObject({ isError: true });
    expect(String(result)).toContain('refresh_tasks');
    expect(String(result)).toContain('task refresh unavailable');
    expect(String(result)).toContain('"mutation_status": "applied"');
  });

  it('propagates a strategy persistence failure before reporting any saved mutation', async () => {
    const runtime = createRuntime(createPlan());
    runtime.params.strategyService.applyStrategyMutationPreview = async () => {
      throw new Error('replica revision conflict');
    };
    const ensure = mock(runtime.params.ensureArchitectConversationForPlan);
    runtime.params.ensureArchitectConversationForPlan = ensure;
    await expect(handleArchitectToolCall(runtime.params)).rejects.toThrow('replica revision conflict');
    expect(runtime.getAppliedPlan().nodes).toHaveLength(0);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('keeps unscoped generated nodes inside the active mono-project plan', async () => {
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

  it('uses the current Git mode for a new node after earlier direct execution', async () => {
    const runtime = createRuntime(createPlan({
      nodes: [{
        id: 'old-direct-task',
        title: 'Ancienne tâche directe',
        description: '',
        type: 'task',
        status: 'completed',
        dependencies: [],
        projectId: 'mouillage-app',
        projectIds: ['mouillage-app'],
        executionModesByProjectId: { 'mouillage-app': 'direct' },
      }],
    }));

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().nodes[0]?.executionModesByProjectId)
      .toEqual({ 'mouillage-app': 'git' });
  });

  it('does not create branch metadata for a direct strategy target', async () => {
    const runtime = createRuntime(createPlan(), {
      directProjectIds: ['mouillage-app'],
    });

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().nodes[0]).toMatchObject({
      executionModesByProjectId: { 'mouillage-app': 'direct' },
    });
    expect(runtime.getAppliedPlan().nodes[0]).not.toHaveProperty('assignedBranch');
    expect(runtime.getAppliedPlan().nodes[0]).not.toHaveProperty('branchType');
    expect(runtime.getAppliedPlan().nodes[0]).not.toHaveProperty('branchSlug');
    expect(runtime.getAppliedPlan().predictedBranches).toEqual([]);
  });

  it('keeps a persisted empty direct plan direct after the project gains Git', async () => {
    const runtime = createRuntime(createPlan({
      executionModesByProjectId: { 'mouillage-app': 'direct' },
      nodes: [],
    }));

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().nodes[0]).toMatchObject({
      executionModesByProjectId: { 'mouillage-app': 'direct' },
    });
    expect(runtime.getAppliedPlan().nodes[0]).not.toHaveProperty('assignedBranch');
    expect(runtime.getAppliedPlan().predictedBranches).toEqual([]);
  });

  it('coerces generated artifact contracts to required handoffs', async () => {
    const runtime = createRuntime(createPlan());
    runtime.params.args.nodes = [
      {
        title: 'Auditer les flux',
        description: 'Identifier les risques.',
        type: 'feature',
        featureSlug: 'audit',
        artifactContracts: [
          {
            id: 'audit-findings',
            title: 'Audit findings',
            kind: 'audit',
            required: false,
          },
          {
            id: 'migration-map',
            title: 'Migration map',
            kind: 'migration_map',
          },
        ],
      },
    ];

    await handleArchitectToolCall(runtime.params);

    expect(runtime.getAppliedPlan().nodes[0]?.artifactContracts).toEqual([
      {
        id: 'audit-findings',
        title: 'Audit findings',
        kind: 'audit',
        required: true,
      },
      {
        id: 'migration-map',
        title: 'Migration map',
        kind: 'migration_map',
        required: true,
      },
    ]);
  });

  it('uses every editable project already attached to a multi-project plan', async () => {
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

  it('rejects strategy mutations after plan validation', async () => {
    const plan = createPlan({
      status: 'validated',
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
        },
      ],
    });

    const generateRuntime = createRuntime(plan);
    await expect(handleArchitectToolCall(generateRuntime.params)).resolves.toBe(
      ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE,
    );

    const updateRuntime = createRuntime(plan);
    updateRuntime.params.toolName = 'strategy_update';
    updateRuntime.params.args = {
      operations: [{ action: 'update', node_id: 'node-1', title: 'Release verrouillée' }],
    };
    await expect(handleArchitectToolCall(updateRuntime.params)).resolves.toBe(
      ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE,
    );

    const deleteRuntime = createRuntime(plan);
    deleteRuntime.params.toolName = 'strategy_delete';
    deleteRuntime.params.args = { confirm: true };
    await expect(handleArchitectToolCall(deleteRuntime.params)).resolves.toBe(
      ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE,
    );
  });

  it('keeps strategy_get available after plan validation', async () => {
    const runtime = createRuntime(createPlan({
      status: 'validated',
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
        },
      ],
    }));
    runtime.params.toolName = 'strategy_get';
    runtime.params.args = {};

    const result = await handleArchitectToolCall(runtime.params);

    expect(result).toContain('Loaded strategy');
    expect(result).toContain('Configurer la release');
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

  it('rejects context-only and external projects in explicit node scope', async () => {
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

    await expect(handleArchitectToolCall(contextRuntime.params)).rejects.toThrow('context-only project');

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
