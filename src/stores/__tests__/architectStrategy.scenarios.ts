import { describe, expect, it } from 'bun:test';
import {
  ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE,
  type ArchitectPlanRecord,
} from '../../services/architectPlanService';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerArchitectStrategyScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    activateArchitectPlanForTest,
    appState,
    architectPlanMessages,
    architectPlans,
    createConversation,
    createImplementTask,
    createPlan,
    createScenarioPlan,
    createTranscriptEntry,
    expectArchitectSelection,
    getArchitectPlanMock,
    getLatestStreamOptions,
    loadChatStore,
    providerState,
    projectGroups,
    savePreferenceForTest,
    sendArchitectMessageAndGetToolHandler,
    setArchitectStoreState,
    streamChatMock,
    taskStoreState,
    updateArchitectPlanMock,
  } = context;

  describe('useChatStore Architect strategy and policy', () => {
    it('does not pass label metadata during strategy generation unless explicitly requested', async () => {
      const plan = createPlan({
        id: 'plan-1',
        slug: 'plan-1',
        title: 'plan-1',
        label: 'Checkout refresh',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('plan-conv')],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Generate the strategy.',
      });
      updateArchitectPlanMock.mockClear();

      await onToolCall('strategy_generate', {
        nodes: [{ title: 'Implement checkout' }],
      });

      const lastCall = ((updateArchitectPlanMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

      expect('label' in lastCall).toBe(false);
      expect('title' in lastCall).toBe(false);
    });

    it('persists a renamed draft slug through strategy generation and rebuilds rendered branches', async () => {
      const plan = createPlan({
        id: 'draft-plan',
        slug: 'checkout-refresh',
        title: 'checkout-refresh',
        label: 'Checkout refresh',
        status: 'draft',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Generate the strategy.',
      });
      updateArchitectPlanMock.mockClear();

      await onToolCall('strategy_generate', {
        plan_slug: 'checkout-rework',
        nodes: [
          {
            title: 'Prepare schema',
            featureSlug: 'prepare-schema',
          },
        ],
      });

      const lastCall = ((updateArchitectPlanMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
      const predictedBranches = (lastCall.predictedBranches as Array<Record<string, unknown>>) ?? [];
      const persistedPlan = architectPlans.get(plan.id);

      expect(lastCall.slug).toBe('checkout-rework');
      expect(predictedBranches.map((branch) => branch.name)).toEqual([
        'feature/checkout-rework/prepare-schema',
      ]);
      expect(predictedBranches.map((branch) => branch.parentBranch)).toEqual([
        'plan/checkout-rework',
      ]);
      expect(
        predictedBranches.some((branch) =>
          String(branch.name || '').includes('checkout-refresh'),
        ),
      ).toBe(false);
      expect(
        predictedBranches.some((branch) =>
          String(branch.parentBranch || '').includes('checkout-refresh'),
        ),
      ).toBe(false);
      expect(persistedPlan?.slug).toBe('checkout-rework');
      expect(persistedPlan?.predictedBranches.map((branch) => branch.name)).toEqual([
        'feature/checkout-rework/prepare-schema',
      ]);
    });

    it('rejects generated strategy nodes that target outside the active plan scope', async () => {
      const plan = createPlan({
        id: 'scope-change-plan',
        slug: 'scope-change-plan',
        title: 'scope-change-plan',
        conversationId: 'plan-conv',
        status: 'draft',
        projectId: 'project-1',
        projectIds: ['project-1'],
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Generate the strategy.',
      });
      updateArchitectPlanMock.mockClear();

      await expect(
        onToolCall('strategy_generate', {
          nodes: [
            {
              title: 'Implement API release prep',
              projectId: 'project-2',
              featureSlug: 'api-release-prep',
            },
          ],
        }),
      ).rejects.toThrow('outside this plan');
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
      expect(architectPlans.get(plan.id)?.projectIds).toEqual(['project-1']);
    });

    it('returns strategy_get results when only operational transcript state differs', async () => {
      const plan = createPlan({
        id: 'strategy-readable-plan',
        conversationId: 'plan-conv',
        nodes: [
          {
            id: 'node-1',
            title: 'Readable strategy node',
            type: 'task',
            status: 'pending',
            dependencies: [],
            projectId: 'project-1',
            projectIds: ['project-1'],
            executionModesByProjectId: { 'project-1': 'git' },
          },
        ],
      });
      architectPlans.set(plan.id, plan);
      architectPlanMessages.set(plan.id, [
        createTranscriptEntry({
          id: 'transcript-only',
          content: 'Operational transcript mismatch only.',
        }),
      ]);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Read the strategy.',
      });

      const result = await onToolCall('strategy_get', {});

      expect(String(result)).toContain('Loaded strategy');
      expect(String(result)).toContain('Readable strategy node');
    });

    it('includes a replica warning when strategy generation writes despite post-write divergence', async () => {
      const plan = createPlan({
        id: 'post-write-warning-plan',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      updateArchitectPlanMock.mockImplementationOnce(async (params) => {
        const existing = architectPlans.get(params.planId);
        if (!existing) {
          throw new Error(`Unknown plan ${params.planId}`);
        }
        const updated = {
          ...existing,
          conversationId: existing.conversationId,
          label: existing.label,
          nodes: (params.nodes as ArchitectPlanRecord['nodes'] | undefined) ?? existing.nodes,
          predictedBranches:
            (params.predictedBranches as ArchitectPlanRecord['predictedBranches'] | undefined) ??
            existing.predictedBranches,
          projectId: existing.projectId,
          projectIds: params.projectIds ?? existing.projectIds,
          targetBranchesByProjectId: existing.targetBranchesByProjectId,
          hasReplicaDivergence: true,
          replicationState: 'diverged' as const,
          replicas: [
            {
              scopeKey: 'project:project-1:/repos/web',
              projectId: 'project-1',
              repoPath: '/repos/web',
              workspacePath: '/repos/web',
              source: 'project' as const,
              updatedAt: '2026-03-19T01:00:00.000Z',
            },
          ],
        };
        architectPlans.set(params.planId, updated);
        return updated;
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Generate the strategy.',
      });

      const result = await onToolCall('strategy_generate', {
        nodes: [
          {
            title: 'Warn after write',
            projectId: 'project-1',
            featureSlug: 'warn-after-write',
          },
        ],
      });

      expect(String(result)).toContain('Strategy updated');
      expect(String(result)).toContain('replica_warning');
      expect(String(result)).toContain('repair_metadata');
    });

    it('returns structured repair metadata for true plan replica divergence', async () => {
      const plan = createPlan({
        id: 'diverged-plan',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop' };

      const divergenceError = Object.assign(
        new Error('Plan diverged-plan has diverged metadata replicas across repositories.'),
        {
          code: 'ARCHITECT_PLAN_REPLICA_DIVERGENCE',
          divergence: {
            branchName: 'develop',
            planId: plan.id,
            reason: 'content_diverged',
            replicas: [
              {
                scopeKey: 'project:project-1:/repos/web',
                projectId: 'project-1',
                repoPath: '/repos/web',
                workspacePath: '/repos/web',
                source: 'project',
                updatedAt: '2026-03-19T01:00:00.000Z',
              },
            ],
          },
        }
      );
      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Read the strategy.',
      });

      getArchitectPlanMock.mockImplementationOnce(async () => {
        throw divergenceError;
      });

      const result = await onToolCall('strategy_get', {});

      expect(String(result)).toContain('architect_plan_replica_divergence');
      expect(String(result)).toContain('repair_metadata');
      expect(String(result)).toContain('content_diverged');
    });

    it('keeps the active plan and conversation stable during strategy generation with blank sibling drafts', async () => {
      const activePlan = createScenarioPlan('started', {
        id: 'started-plan',
        conversationId: 'plan-conv',
      });
      const blankSibling = createScenarioPlan('blank', {
        id: 'blank-sibling',
        conversationId: 'blank-conv',
        label: 'new plan 2',
      });
      architectPlans.set(activePlan.id, activePlan);
      architectPlans.set(blankSibling.id, blankSibling);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv'), createConversation('blank-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Generate the strategy.',
      });
      updateArchitectPlanMock.mockClear();

      await onToolCall('strategy_generate', {
        nodes: [{ title: 'Implement checkout' }],
      });

      const lastCall = ((updateArchitectPlanMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

      expectArchitectSelection(useChatStore, {
        planId: activePlan.id,
        conversationId: 'plan-conv',
      });
      expect('label' in lastCall).toBe(false);
      expect('title' in lastCall).toBe(false);
      expect(architectPlans.get(blankSibling.id)?.label).toBe('new plan 2');
    });

    it('stages a non-destructive preview during draft strategy generation when frozen work exists', async () => {
      const activePlan = createPlan({
        id: 'started-plan',
        conversationId: 'plan-conv',
        status: 'draft',
        nodes: [
          {
            id: 'task-a',
            title: 'Prepare schema',
            description: '',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'feature/prepare-schema',
            branchType: 'feature',
            branchSlug: 'prepare-schema',
            projectId: 'project-1',
            projectIds: ['project-1'],
          },
          {
            id: 'task-b',
            title: 'Build endpoint',
            description: '',
            type: 'task',
            status: 'in-progress',
            dependencies: ['task-a'],
            assignedBranch: 'feature/build-endpoint',
            branchType: 'feature',
            branchSlug: 'build-endpoint',
            projectId: 'project-1',
            projectIds: ['project-1'],
          },
        ],
      });
      architectPlans.set(activePlan.id, activePlan);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop' };
      taskStoreState.tasks = [
        createImplementTask({
          id: 'task-a',
          title: 'Prepare schema',
          status: 'Pending',
          plan_id: activePlan.id,
          assigned_branch: 'feature/prepare-schema',
          branch_name: 'feature/prepare-schema',
        }),
        createImplementTask({
          id: 'task-b',
          title: 'Build endpoint',
          status: 'InProgress',
          plan_id: activePlan.id,
          assigned_branch: 'feature/build-endpoint',
          branch_name: 'feature/build-endpoint',
          dependencies: ['task-a'],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Regenerate the strategy safely.',
      });
      updateArchitectPlanMock.mockClear();

      const result = await onToolCall('strategy_generate', {
        nodes: [
          {
            id: 'task-a',
            title: 'Prepare schema',
            dependencies: [],
            status: 'pending',
          },
          {
            id: 'task-b',
            title: 'Build endpoint',
            dependencies: ['task-a'],
            status: 'in-progress',
          },
          {
            title: 'Ship telemetry',
            dependencies: ['task-b'],
          },
        ],
      });

      expect(String(result)).toContain('preview_staged');
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
      expect(appState.strategyMutationPreview).not.toBeNull();
      expect((appState.strategyMutationPreview as { status: string }).status).toBe('valid');
    });

    it('rejects strategy generation and updates after validation before slug checks', async () => {
      const activePlan = createPlan({
        id: 'plan-active',
        slug: 'checkout-refresh',
        title: 'checkout-refresh',
        conversationId: 'plan-conv',
        status: 'validated',
      });
      architectPlans.set(activePlan.id, activePlan);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Update the active strategy.',
      });
      updateArchitectPlanMock.mockClear();

      const generateResult = await onToolCall('strategy_generate', {
        plan_slug: 'checkout-rework',
        nodes: [{ title: 'Implement checkout' }],
      });
      const updateResult = await onToolCall('strategy_update', {
        replace: true,
        plan_slug: 'checkout-rework',
        nodes: [{ title: 'Implement checkout' }],
      });

      expect(String(generateResult)).toBe(ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE);
      expect(String(updateResult)).toBe(ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE);
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
    });

    it('uses plan scope for unscoped strategy_update nodes and explicit scope for targeted nodes', async () => {
      projectGroups[0]?.projects.push({
        ...projectGroups[0].projects[0],
        id: 'project-2',
        name: 'API',
        path: '/repos/api',
        mountName: 'api',
      });
      const activePlan = createPlan({
        id: 'plan-multi',
        slug: 'checkout',
        title: 'checkout',
        conversationId: 'plan-conv',
        status: 'draft',
        projectId: 'project-1',
        projectIds: ['project-1', 'project-2'],
        nodes: [
          {
            id: 'task-web',
            title: 'Build checkout UI',
            description: '',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'feature/checkout/checkout-web',
            branchType: 'feature',
            branchSlug: 'checkout-web',
            projectId: 'project-1',
            projectIds: ['project-1'],
            executionModesByProjectId: { 'project-1': 'git' },
          },
          {
            id: 'task-api',
            title: 'Add checkout endpoint',
            description: '',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'feature/checkout/checkout-api',
            branchType: 'feature',
            branchSlug: 'checkout-api',
            projectId: 'project-2',
            projectIds: ['project-2'],
            executionModesByProjectId: { 'project-2': 'git' },
          },
        ],
        predictedBranches: [],
      });
      architectPlans.set(activePlan.id, activePlan);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Patch the active strategy.',
      });
      updateArchitectPlanMock.mockClear();

      await onToolCall('strategy_update', {
        operations: [
          {
            action: 'update',
            node_id: 'task-api',
            description: 'Updated endpoint scope',
          },
          {
            action: 'add',
            title: 'API telemetry',
            featureSlug: 'api-telemetry',
            projectIds: ['project-2'],
          },
          {
            action: 'add',
            title: 'Checkout docs',
            featureSlug: 'checkout-docs',
          },
        ],
      });

      const lastCall = ((updateArchitectPlanMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
      const updatedNodes = (lastCall.nodes as Array<Record<string, unknown>>) ?? [];
      const predictedBranches = (lastCall.predictedBranches as Array<Record<string, unknown>>) ?? [];

      expect(updatedNodes.find((node) => node.id === 'task-api')).toMatchObject({
        projectId: 'project-2',
        projectIds: ['project-2'],
      });
      expect(updatedNodes.find((node) => node.title === 'API telemetry')).toMatchObject({
        projectId: 'project-2',
        projectIds: ['project-2'],
      });
      expect(updatedNodes.find((node) => node.title === 'Checkout docs')).toMatchObject({
        projectId: 'project-1',
        projectIds: ['project-1', 'project-2'],
      });

      expect(predictedBranches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            projectId: 'project-1',
            name: 'feature/checkout/checkout-web',
            branchSlug: 'checkout-web',
          }),
          expect.objectContaining({
            projectId: 'project-2',
            name: 'feature/checkout/checkout-api',
            branchSlug: 'checkout-api',
          }),
          expect.objectContaining({
            projectId: 'project-2',
            name: 'feature/checkout/api-telemetry',
            branchSlug: 'api-telemetry',
          }),
          expect.objectContaining({
            projectId: 'project-1',
            name: 'feature/checkout/checkout-docs',
            branchSlug: 'checkout-docs',
          }),
          expect.objectContaining({
            projectId: 'project-2',
            name: 'feature/checkout/checkout-docs',
            branchSlug: 'checkout-docs',
          }),
        ]),
      );
      expect(
        predictedBranches.some(
          (branch) =>
            branch.projectId === 'project-1' &&
            branch.branchSlug === 'checkout-api',
        ),
      ).toBe(false);
      expect(
        predictedBranches.some(
          (branch) =>
            branch.projectId === 'project-1' &&
            branch.branchSlug === 'api-telemetry',
        ),
      ).toBe(false);
    });

    it('does not pass label metadata during strategy updates unless explicitly requested', async () => {
      const plan = createPlan({
        id: 'plan-1',
        slug: 'plan-1',
        title: 'plan-1',
        label: 'Checkout refresh',
        conversationId: 'plan-conv',
      });
      architectPlans.set(plan.id, plan);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('plan-conv')],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Update the strategy.',
      });
      updateArchitectPlanMock.mockClear();

      await onToolCall('strategy_update', {
        replace: true,
        nodes: [{ title: 'Implement checkout' }],
      });

      const lastCall = ((updateArchitectPlanMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

      expect('label' in lastCall).toBe(false);
      expect('title' in lastCall).toBe(false);
    });

    it('keeps the active plan and conversation stable during strategy updates with blank sibling drafts', async () => {
      const activePlan = createScenarioPlan('started', {
        id: 'started-plan',
        conversationId: 'plan-conv',
      });
      const blankSibling = createScenarioPlan('renamed_blank', {
        id: 'blank-sibling',
        conversationId: 'blank-conv',
      });
      architectPlans.set(activePlan.id, activePlan);
      architectPlans.set(blankSibling.id, blankSibling);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { targetBranch: 'develop' };

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv'), createConversation('blank-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Update the strategy.',
      });
      updateArchitectPlanMock.mockClear();

      await onToolCall('strategy_update', {
        replace: true,
        nodes: [{ title: 'Implement checkout' }],
      });

      const lastCall = ((updateArchitectPlanMock as unknown as {
        mock: { calls: Array<Array<Record<string, unknown>>> };
      }).mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

      expectArchitectSelection(useChatStore, {
        planId: activePlan.id,
        conversationId: 'plan-conv',
      });
      expect('label' in lastCall).toBe(false);
      expect('title' in lastCall).toBe(false);
      expect(architectPlans.get(blankSibling.id)?.label).toBe(blankSibling.label);
    });

    it('requests one repair attempt for frozen-node conflicts and blocks on the second invalid update', async () => {
      const activePlan = createPlan({
        id: 'started-plan',
        conversationId: 'plan-conv',
        status: 'draft',
        nodes: [
          {
            id: 'task-a',
            title: 'Prepare schema',
            description: '',
            type: 'task',
            status: 'pending',
            dependencies: [],
            assignedBranch: 'feature/prepare-schema',
            branchType: 'feature',
            branchSlug: 'prepare-schema',
            projectId: 'project-1',
            projectIds: ['project-1'],
          },
          {
            id: 'task-b',
            title: 'Build endpoint',
            description: '',
            type: 'task',
            status: 'in-progress',
            dependencies: ['task-a'],
            assignedBranch: 'feature/build-endpoint',
            branchType: 'feature',
            branchSlug: 'build-endpoint',
            projectId: 'project-1',
            projectIds: ['project-1'],
          },
        ],
      });
      architectPlans.set(activePlan.id, activePlan);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop' };
      taskStoreState.tasks = [
        createImplementTask({
          id: 'task-a',
          title: 'Prepare schema',
          status: 'Pending',
          plan_id: activePlan.id,
          assigned_branch: 'feature/prepare-schema',
          branch_name: 'feature/prepare-schema',
        }),
        createImplementTask({
          id: 'task-b',
          title: 'Build endpoint',
          status: 'InProgress',
          plan_id: activePlan.id,
          assigned_branch: 'feature/build-endpoint',
          branch_name: 'feature/build-endpoint',
          dependencies: ['task-a'],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });

      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Update the active strategy.',
      });
      updateArchitectPlanMock.mockClear();

      const firstResult = await onToolCall('strategy_update', {
        replace: true,
        nodes: [
          {
            id: 'task-a',
            title: 'Prepare schema',
            dependencies: [],
            status: 'pending',
          },
          {
            id: 'task-b',
            title: 'Build endpoint',
            description: 'Changed frozen description',
            dependencies: ['task-a'],
            status: 'in-progress',
          },
        ],
      });

      expect(String(firstResult)).toContain('repair_requested');
      expect(appState.strategyMutationPreview).toBeNull();
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();

      const secondResult = await onToolCall('strategy_update', {
        replace: true,
        nodes: [
          {
            id: 'task-a',
            title: 'Prepare schema',
            dependencies: [],
            status: 'pending',
          },
          {
            id: 'task-b',
            title: 'Build endpoint',
            description: 'Changed frozen description',
            dependencies: ['task-a'],
            status: 'in-progress',
          },
        ],
      });

      expect(String(secondResult)).toContain('"action": "blocked"');
      expect(updateArchitectPlanMock).not.toHaveBeenCalled();
      expect(appState.strategyMutationPreview).not.toBeNull();
      expect((appState.strategyMutationPreview as { status: string }).status).toBe('blocked');
    });

    it('launches Architect conversations with the plan explorer internal profile', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      await savePreferenceForTest(
        'promptPlanExplorer',
        'Custom PLAN_EXPLORER prompt for tests.',
      );

      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({ conversationId: 'plan-conv' });
      useChatStore.setState({
        conversations: [createConversation('plan-conv')],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'Structure le plan pour refondre le checkout.',
      });

      expect(streamChatMock).toHaveBeenCalledTimes(1);
      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        internalAgentProfile?: string | null;
        allowedToolIds: string[];
        messages: Array<{ role: string; content: string }>;
      };
      expect(streamOptions.internalAgentProfile).toBe('plan_explorer');
      expect(streamOptions.allowedToolIds).not.toContain('write');
      expect(streamOptions.allowedToolIds).not.toContain('edit');
      expect(streamOptions.allowedToolIds).not.toContain('apply_patch');
      expect(streamOptions.allowedToolIds).not.toContain('mark_source_passage');
      expect(streamOptions.allowedToolIds).not.toContain('read_sources');
      expect(streamOptions.allowedToolIds).not.toContain('edit_source_passage');
      expect(streamOptions.allowedToolIds).toContain('plan_get');
      expect(streamOptions.allowedToolIds).toContain('strategy_update');
      expect(streamOptions.allowedToolIds).toContain('strategy_delete');
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'Custom PLAN_EXPLORER prompt for tests.'
      );
    });

    it('describes a direct-only Architect plan without Git workflow instructions', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({
        conversationId: 'plan-conv',
        nodes: [{
          id: 'direct-node',
          title: 'Edit docs',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
          projectIds: ['project-1'],
          executionModesByProjectId: { 'project-1': 'direct' },
        }],
      });
      useChatStore.setState({
        conversations: [createConversation('plan-conv')],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'Structure cette modification directe.',
      });

      const streamOptions = getLatestStreamOptions<{ messages: Array<{ content: string }> }>();
      expect(String(streamOptions.messages[0]?.content)).toContain('This is a direct-only plan.');
      expect(String(streamOptions.messages[0]?.content)).not.toContain('Git workflow for plans is strict');
    });

    it('removes strategy mutation tools from Architect turns after plan validation', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;

      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({ conversationId: 'plan-conv', status: 'validated' });
      appState.activePlanContext = {
        ...(appState.activePlanContext || { id: 'plan-1', targetBranch: 'develop' }),
        status: 'validated',
      };
      useChatStore.setState({
        conversations: [createConversation('plan-conv')],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'Analyse la stratégie validée.',
      });

      expect(streamChatMock).toHaveBeenCalledTimes(1);
      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        allowedToolIds: string[];
      };
      expect(streamOptions.allowedToolIds).toContain('strategy_get');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_generate');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_update');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_delete');
    });

    it('ignores the legacy guarded autonomy profile instead of importing it', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      localStorage.setItem(
        'macro_architectToolAutonomyProfile',
        JSON.stringify('guarded')
      );

      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({ conversationId: 'plan-conv' });
      useChatStore.setState({
        conversations: [createConversation('plan-conv')],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'Analyse le plan actif.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        allowedToolIds: string[];
      };
      expect(streamOptions.allowedToolIds).toContain('strategy_delete');
    });

    it('keeps Architect action tools available for Copilot in strict mode', async () => {
      providerState.providerConfigs = [
        {
          id: 'copilot',
          name: 'GitHub Copilot',
          providerType: 'copilot',
          isEnabled: true,
          isLocal: false,
          hasStoredApiKey: false,
          apiKeyLoaded: false,
          apiKey: '',
        },
      ];
      providerState.selectedProviderId = 'copilot';
      providerState.selectedModelId = 'claude-haiku-4.5';
      providerState.modelsByProvider = {
        copilot: [{ id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', isEnabled: true }],
      };
      providerState.selectedSupportsNativeToolCalling = () => true;
      await savePreferenceForTest('toolRiskLevel', 'strict');

      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({ conversationId: 'plan-conv' });
      useChatStore.setState({
        conversations: [createConversation('plan-conv')],
        messages: [],
        selectedConversationId: 'plan-conv',
        selectedConversationIdsByMode: { Architect: 'plan-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'plan-conv',
        content: 'Génère la stratégie depuis notre conversation.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        allowedToolIds: string[];
      };
      expect(streamOptions.allowedToolIds).toContain('strategy_generate');
      expect(streamOptions.allowedToolIds).toContain('plan_update');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_delete');
    });

  });
};
