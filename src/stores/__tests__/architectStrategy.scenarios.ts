import { describe, expect, it } from 'bun:test';
import { createExample } from '../../services/agsdl/examples';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerArchitectStrategyScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    activateArchitectPlanForTest,
    appState,
    architectPlans,
    createConversation,
    createPlan,
    getLatestStreamOptions,
    loadChatStore,
    providerState,
    projectGroups,
    savePreferenceForTest,
    sendArchitectMessageAndGetToolHandler,
    setArchitectStoreState,
    streamChatMock,
    updateArchitectPlanMock,
  } = context;

  describe('useChatStore Architect AgSDL and policy', () => {
    it('routes revisioned AgSDL reads and updates to the calling draft without changing plan metadata', async () => {
      const originalSource = createExample('feature');
      const nextSource = createExample('hotfix');
      const plan = createPlan({
        id: 'agsdl-draft',
        conversationId: 'plan-conv',
        agsdl: { source: originalSource, annexes: {}, revision: 1 },
      });
      const sibling = createPlan({ id: 'agsdl-sibling', conversationId: 'sibling-conv' });
      architectPlans.set(plan.id, plan);
      architectPlans.set(sibling.id, sibling);
      appState.activeArchitectPlanId = plan.id;
      appState.activePlanContext = { id: plan.id, targetBranch: 'develop', status: 'draft' };

      const { useAgsdlStore } = await import('../useAgsdlStore');
      useAgsdlStore.setState({ sessions: {} });
      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });
      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Read and update this AgSDL process.',
      });
      const allowedToolIds = getLatestStreamOptions<{ allowedToolIds: string[] }>().allowedToolIds;
      expect(allowedToolIds).toContain('agsdl_get');
      expect(allowedToolIds).toContain('agsdl_update');
      expect(allowedToolIds).not.toContain('strategy_generate');
      expect(allowedToolIds).not.toContain('strategy_get');

      const target = { plan_id: plan.id, target_branch: 'develop' };
      const read = JSON.parse(String(await onToolCall('agsdl_get', target)));
      expect(read.source).toBe(originalSource);
      expect(read.macro_models).toEqual([
        { providerId: 'provider-1', name: 'Test provider', models: [{ modelId: 'model-1', name: 'Model 1' }] },
      ]);
      const result = JSON.parse(String(await onToolCall('agsdl_update', {
        ...target,
        expected_revision: read.revision,
        source: nextSource,
      })));
      expect(result.persisted_revision).toBe(2);
      expect(architectPlans.get(plan.id)?.agsdl?.source).toBe(nextSource);
      expect(architectPlans.get(plan.id)?.label).toBe(plan.label);
      expect(architectPlans.get(sibling.id)).toEqual(sibling);
      expect(appState.activeArchitectPlanId).toBe(plan.id);
      expect(useChatStore.getState().selectedConversationId).toBe('plan-conv');
      expect(updateArchitectPlanMock).toHaveBeenCalledWith(expect.objectContaining({
        branchName: 'develop',
        planId: plan.id,
        expectedAgsdlRevision: 1,
        agsdl: expect.objectContaining({ source: nextSource }),
      }));
      expect(updateArchitectPlanMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('label');
    });

    it('rejects an AgSDL read for a plan owned by another conversation', async () => {
      const activePlan = createPlan({ id: 'agsdl-active', conversationId: 'plan-conv' });
      const foreignPlan = createPlan({ id: 'agsdl-foreign', conversationId: 'foreign-conv' });
      architectPlans.set(activePlan.id, activePlan);
      architectPlans.set(foreignPlan.id, foreignPlan);
      appState.activeArchitectPlanId = activePlan.id;
      appState.activePlanContext = { id: activePlan.id, targetBranch: 'develop', status: 'draft' };
      const { useChatStore } = await loadChatStore();
      setArchitectStoreState(useChatStore, {
        conversations: [createConversation('plan-conv')],
      });
      const onToolCall = await sendArchitectMessageAndGetToolHandler(useChatStore, {
        conversationId: 'plan-conv',
        content: 'Read a plan document.',
      });
      await expect(onToolCall('agsdl_get', {
        plan_id: foreignPlan.id,
        target_branch: 'develop',
      })).rejects.toThrow('calling plan conversation');
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
      expect(streamOptions.allowedToolIds).toContain('agsdl_get');
      expect(streamOptions.allowedToolIds).toContain('agsdl_update');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_update');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_delete');
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

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        messages: Array<{ content: string }>;
      }>();
      expect(String(streamOptions.messages[0]?.content)).toContain('This is a direct-only plan.');
      expect(String(streamOptions.messages[0]?.content)).not.toContain('Git workflow for plans is strict');
      expect(streamOptions.allowedToolIds).not.toContain('git_status');
      expect(streamOptions.allowedToolIds).not.toContain('git_diff');
    });

    it('uses the selected project mode before a direct Architect plan has nodes', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      Object.assign(projectGroups[0]?.projects[0] ?? {}, {
        directEdit: true,
        gitSetupState: 'not_git',
      });
      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({ conversationId: 'plan-conv', nodes: [] });
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
        content: 'Prépare un processus AgSDL direct.',
      });

      const streamOptions = getLatestStreamOptions<{ messages: Array<{ content: string }> }>();
      expect(String(streamOptions.messages[0]?.content)).toContain('This is a direct-only plan.');
      expect(String(streamOptions.messages[0]?.content)).not.toContain('Git workflow for plans is strict');
    });

    it('filters Git tools from an empty persisted direct plan after the project gains Git', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({
        conversationId: 'plan-conv',
        nodes: [],
        executionModesByProjectId: { 'project-1': 'direct' },
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
        content: 'Continue ce plan direct.',
      });

      const streamOptions = getLatestStreamOptions<{ allowedToolIds: string[] }>();
      expect(streamOptions.allowedToolIds).not.toContain('git_status');
      expect(streamOptions.allowedToolIds).not.toContain('git_diff');
    });

    it('keeps Git read tools for a mixed Architect plan while the direct project is focused', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      Object.assign(projectGroups[0]?.projects[0] ?? {}, {
        directEdit: true,
        gitSetupState: 'not_git',
      });
      projectGroups[0]?.projects.push({
        id: 'project-2',
        name: 'API',
        path: '/repos/api',
        mountName: 'api',
        created_at: '2026-03-19T00:00:00.000Z',
        status: 'active',
        gitSetupState: 'ready',
        directEdit: false,
        metadata: {
          description: '',
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      });
      const { useChatStore } = await loadChatStore();
      activateArchitectPlanForTest({
        conversationId: 'plan-conv',
        projectIds: ['project-1', 'project-2'],
        nodes: [{
          id: 'mixed-node',
          title: 'Update both projects',
          type: 'task',
          status: 'pending',
          dependencies: [],
          projectId: 'project-1',
          projectIds: ['project-1', 'project-2'],
          executionModesByProjectId: {
            'project-1': 'direct',
            'project-2': 'git',
          },
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
        content: 'Prépare les changements des deux projets.',
      });

      const streamOptions = getLatestStreamOptions<{ allowedToolIds: string[] }>();
      expect(streamOptions.allowedToolIds).toContain('git_status');
      expect(streamOptions.allowedToolIds).toContain('git_diff');
    });

    it('keeps AgSDL readable but removes its editor tool after plan validation', async () => {
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
        content: 'Analyse le processus validé.',
      });

      expect(streamChatMock).toHaveBeenCalledTimes(1);
      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        allowedToolIds: string[];
      };
      expect(streamOptions.allowedToolIds).toContain('agsdl_get');
      expect(streamOptions.allowedToolIds).not.toContain('agsdl_update');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_generate');
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
      expect(streamOptions.allowedToolIds).toContain('agsdl_update');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_delete');
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
        content: 'Conçois le processus AgSDL depuis notre conversation.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        allowedToolIds: string[];
      };
      expect(streamOptions.allowedToolIds).toContain('agsdl_get');
      expect(streamOptions.allowedToolIds).toContain('agsdl_update');
      expect(streamOptions.allowedToolIds).toContain('plan_update');
      expect(streamOptions.allowedToolIds).not.toContain('strategy_delete');
    });

  });
};
