import { describe, expect, it } from 'bun:test';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerImplementPolicyScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    appState,
    architectPlans,
    createConversation,
    createDeferred,
    createImplementTask,
    createManualFeatureTask,
    createPlan,
    createTerminalSessionFromChatDto,
    executeWorkspaceToolMock,
    flushAsyncWork,
    getLatestArchitectToolHandler,
    getLatestStreamOptions,
    loadChatStore,
    projectGroups,
    providerState,
    savePreferenceForTest,
    setImplementStoreState,
    startImplementToolConversation,
    streamChatMock,
    taskStoreState,
    terminalCreateSessionFromChatMock,
    terminalRunCommandFromChatMock,
    terminalSessionsFromChat,
    waitForStreamCallCount,
  } = context;

  describe('useChatStore Implement policy and tools', () => {
    it('commits the first Implement reply on an existing awaiting-response thread before the stream completes', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [
        createImplementTask({
          status: 'AwaitingResponse',
          conversation_id: 'implement-conv',
        }),
      ];

      const { streamChat } = await import('../../services/streamingChat');
      (
        streamChat as unknown as {
          mockImplementationOnce: (implementation: () => Promise<never>) => void;
        }
      ).mockImplementationOnce(() => new Promise<never>(() => undefined));

      const { useChatStore } = await loadChatStore();
      setImplementStoreState(useChatStore, {
        conversationId: 'implement-conv',
        taskId: 'task-1',
      });

      const result = await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'J’ai besoin du prochain lot de changements.',
        taskId: 'task-1',
      });

      expect(result.status).toBe('sent');
      expect(taskStoreState.retryTask).toHaveBeenCalledWith('task-1');
      expect(taskStoreState.getTaskById('task-1')).toMatchObject({
        status: 'InProgress',
      });
      expect(
        useChatStore
          .getState()
          .getConversationMessages('implement-conv')
          .map((message: { role: string; content: string }) => ({
            role: message.role,
            content: message.content,
          }))
      ).toEqual([
        { role: 'user', content: 'J’ai besoin du prochain lot de changements.' },
        { role: 'assistant', content: '' },
      ]);
      expect(useChatStore.getState().sendState).toBe('streaming');
      useChatStore.getState().stopStreaming();
    });

    it('launches InReview Implement conversations with the task reviewer profile', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask({ status: 'InReview' })];
      await savePreferenceForTest(
        'promptTaskReviewer',
        'Custom TASK_REVIEWER prompt for tests.',
      );

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Passe une review critique puis corrige ce qui est minimal.',
        taskId: 'task-1',
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(streamChatMock).toHaveBeenCalledTimes(1);
      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        internalAgentProfile?: string | null;
        allowedToolIds: string[];
        messages: Array<{ role: string; content: string }>;
      };
      expect(streamOptions.internalAgentProfile).toBe('task_reviewer');
      expect(streamOptions.allowedToolIds).toContain('apply_patch');
      expect(streamOptions.allowedToolIds).toContain('git_diff');
      expect(streamOptions.allowedToolIds).toContain('terminal_run');
      expect(streamOptions.allowedToolIds).not.toContain('mark_source_passage');
      expect(streamOptions.allowedToolIds).not.toContain('read_sources');
      expect(streamOptions.allowedToolIds).not.toContain('edit_source_passage');
      expect(streamOptions.allowedToolIds).not.toContain('git_commit');
      expect(streamOptions.allowedToolIds).not.toContain('git_merge');
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'Custom TASK_REVIEWER prompt for tests.'
      );
    });

    it('loads the repo auditor prompt override for implement conflict assistance flows', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Implement';
      appState.selectedTaskId = null;
      await savePreferenceForTest(
        'promptRepoAuditor',
        'Custom REPO_AUDITOR prompt for tests.',
      );

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('debug-conv'),
            scope_mode: 'Implement',
            title: 'Repository review',
          },
        ],
        messages: [],
        selectedConversationId: 'debug-conv',
        selectedConversationIdsByMode: { Implement: 'debug-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'debug-conv',
        content: 'Diagnose the git conflict safely.',
        internalAgentProfile: 'repo_auditor',
      });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(streamChatMock).toHaveBeenCalledTimes(1);
      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        internalAgentProfile?: string | null;
        allowedToolIds: string[];
        messages: Array<{ role: string; content: string }>;
      };
      expect(streamOptions.internalAgentProfile).toBe('repo_auditor');
      expect(streamOptions.allowedToolIds).not.toContain('terminal_run');
      expect(streamOptions.allowedToolIds).not.toContain('apply_patch');
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'Custom REPO_AUDITOR prompt for tests.'
      );
    });

    it('rejects Implement sends when task preflight does not move the task into progress', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [createImplementTask({ status: 'Pending' })];
      taskStoreState.startTask.mockImplementationOnce(async () => {
        taskStoreState.lastError = 'Task worktree is not ready yet.';
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'implement-conv',
          content: 'Lance le travail.',
          taskId: 'task-1',
        })
      ).rejects.toThrow('Task worktree is not ready yet.');

      expect(useChatStore.getState().getConversationMessages('implement-conv')).toHaveLength(0);
      expect(useChatStore.getState().lastError).toBe('Task worktree is not ready yet.');
      expect(useChatStore.getState().sendState).toBe('error');
    });

    it('blocks standalone tasks before streaming when repository or branch metadata is missing', async () => {
      appState.mode = 'Implement';
      appState.agentType = 'build';
      appState.selectedTaskId = 'task-1';
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          task_source: 'standalone',
          plan_id: '',
          project_id: 'project-1',
          project_ids: ['project-1'],
          branch_name: '',
          assigned_branch: '',
          execution_targets: [],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Standalone export',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await expect(
        useChatStore.getState().sendMessage({
          conversationId: 'implement-conv',
          content: 'Lance cette tâche indépendante.',
          taskId: 'task-1',
        })
      ).rejects.toThrow('missing its execution target');

      expect(streamChatMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().getConversationMessages('implement-conv')).toHaveLength(0);
    });

    it('creates a general agent terminal for Implement without binding the task worktree', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          execution_targets: [
            {
              projectId: 'project-1',
              branchName: 'feature/implement-checkout',
              worktreeKey: 'task-1-web',
            },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Ouvre un terminal pour travailler sur cette tâche.',
        taskId: 'task-1',
      });

      const onToolCall = getLatestArchitectToolHandler();
      const result = await onToolCall('terminal_create_session', {
        project_id: 'project-1',
        cwd: 'C:/Users/test/Documents',
      });

      expect(terminalCreateSessionFromChatMock).toHaveBeenCalledWith({
        projectId: null,
        cwd: 'C:/Users/test/Documents',
      });

      const parsed = JSON.parse(String(result));
      expect(parsed.cwd).toBe('C:/Users/test/Documents');
      expect(parsed).not.toHaveProperty('project_id');
      expect(parsed).not.toHaveProperty('workspace_path');
    });

    it('challenges git_commit once before allowing the same assistant turn to commit', async () => {
      const { onToolCall } = await startImplementToolConversation(
        'Corrige le code, mais ne commit rien.',
      );

      const firstResult = await onToolCall(
        'git_commit',
        { message: 'fix: update checkout flow' },
        'call-commit-1',
      );

      expect(String(firstResult)).toContain(
        'Do not stage or commit unless the user explicitly asked',
      );
      expect(executeWorkspaceToolMock).not.toHaveBeenCalled();

      const secondResult = await onToolCall(
        'git_commit',
        { message: 'fix: update checkout flow' },
        'call-commit-2',
      );

      expect(secondResult).toBeUndefined();
      expect(executeWorkspaceToolMock).toHaveBeenCalledTimes(1);
      expect(
        (executeWorkspaceToolMock as unknown as { mock: { calls: unknown[][] } })
          .mock.calls[0]?.[0],
      ).toBe('git_commit');
    });

    it('does not recreate checkpoints when deletion wins a completed workspace mutation', async () => {
      context.tauriAvailable = false;
      const mutationFinished = createDeferred<void>();
      executeWorkspaceToolMock.mockImplementationOnce(
        (async (...args: unknown[]) => {
          const executionContext = args[3] as {
            onCodeCheckpoint?: (checkpoint: {
              toolName: string;
              files: unknown[];
            }) => Promise<void>;
          };
          await mutationFinished.promise;
          await executionContext.onCodeCheckpoint?.({
            toolName: 'write',
            files: [
              {
                path: 'src/late.ts',
                realPath: 'C:/repo/src/late.ts',
                status: 'created',
                before: { exists: false, content: null, isBinary: false, size: 0 },
                after: {
                  exists: true,
                  content: 'export const late = true;\n',
                  isBinary: false,
                  size: 25,
                },
              },
            ],
          });
        }) as unknown as () => Promise<undefined>,
      );
      const { useChatStore, onToolCall } = await startImplementToolConversation();

      const toolCall = onToolCall('write', {
        path: 'src/late.ts',
        content: 'export const late = true;\n',
      });
      await Promise.resolve();
      await useChatStore.getState().deleteConversation('implement-conv', {
        mode: 'implement',
      });
      mutationFinished.resolve();
      await toolCall;

      expect(useChatStore.getState().conversations).toEqual([]);
      expect(
        useChatStore.getState().agentCodeCheckpointsByConversationId['implement-conv'],
      ).toBeUndefined();
    });

    it('limits implement plan agent turns to read-only inspection tools', async () => {
      await startImplementToolConversation(
        'Analyse la correction avant de toucher au code.',
        { agentType: 'plan' },
      );

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        messages: Array<{ role: string; content: string }>;
      }>();

      expect(streamOptions.allowedToolIds).toContain('read');
      expect(streamOptions.allowedToolIds).toContain('grep');
      expect(streamOptions.allowedToolIds).toContain('git_diff');
      expect(streamOptions.allowedToolIds).toContain('task_todo_get');
      expect(streamOptions.allowedToolIds).not.toContain('write');
      expect(streamOptions.allowedToolIds).not.toContain('edit');
      expect(streamOptions.allowedToolIds).not.toContain('delete');
      expect(streamOptions.allowedToolIds).not.toContain('apply_patch');
      expect(streamOptions.allowedToolIds).not.toContain('task_todo_update');
      expect(streamOptions.allowedToolIds).not.toContain('git_add');
      expect(streamOptions.allowedToolIds).not.toContain('git_commit');
      expect(streamOptions.allowedToolIds).not.toContain('terminal_run');
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'Plan mode is read-only',
      );
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'end with a concrete implementation plan',
      );
    });

    it('exposes build tools but hides Architect task tools for standalone tasks', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Implement';
      appState.agentType = 'build';
      appState.selectedTaskId = 'task-1';
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          task_source: 'standalone',
          plan_id: '',
          project_id: 'project-1',
          project_ids: ['project-1'],
          execution_targets: [
            {
              projectId: 'project-1',
              executionMode: 'git',
              branchName: 'feature/standalone-export',
              worktreeKey: 'standalone-export-web',
            },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Standalone export',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Implémente cette tâche indépendante.',
        taskId: 'task-1',
      });

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        messages: Array<{ role: string; content: string }>;
      }>();

      expect(streamOptions.allowedToolIds).toContain('terminal_create_session');
      expect(streamOptions.allowedToolIds).toContain('terminal_run');
      expect(streamOptions.allowedToolIds).toContain('write');
      expect(streamOptions.allowedToolIds).toContain('git_status');
      expect(streamOptions.allowedToolIds).not.toContain('task_todo_get');
      expect(streamOptions.allowedToolIds).not.toContain('task_todo_update');
      expect(streamOptions.allowedToolIds).not.toContain('task_artifact_list');
      expect(streamOptions.allowedToolIds).not.toContain('task_artifact_get');
      expect(streamOptions.allowedToolIds).not.toContain('task_artifact_put');
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'This is a standalone implementation task',
      );
      expect(String(streamOptions.messages[0]?.content)).not.toContain('[Task Todos]');
    });

    it('hides Git tools while keeping workspace edits for direct-edit tasks', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Implement';
      appState.agentType = 'build';
      appState.selectedTaskId = 'task-1';
      localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
      Object.assign(projectGroups[0]?.projects[0] ?? {}, {
        directEdit: true,
        gitSetupState: 'not_git',
      });
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          task_source: 'standalone',
          plan_id: '',
          project_id: 'project-1',
          project_ids: ['project-1'],
          execution_targets: [
            {
              projectId: 'project-1',
              executionMode: 'direct',
              branchName: '',
              worktreeKey: 'project-1::direct',
            },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Direct edit',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Modifie ce dossier sans Git.',
        taskId: 'task-1',
      });

      const streamOptions = getLatestStreamOptions<{ allowedToolIds: string[] }>();
      expect(streamOptions.allowedToolIds).toContain('read');
      expect(streamOptions.allowedToolIds).toContain('write');
      expect(streamOptions.allowedToolIds).toContain('edit');
      expect(streamOptions.allowedToolIds).toContain('terminal_run');
      expect(streamOptions.allowedToolIds).not.toContain('git_status');
      expect(streamOptions.allowedToolIds).not.toContain('git_diff');
      expect(streamOptions.allowedToolIds).not.toContain('git_add');
      expect(streamOptions.allowedToolIds).not.toContain('git_commit');
      expect(String(getLatestStreamOptions<{ messages: Array<{ content: string }> }>().messages[0]?.content))
        .toContain('This is a direct-edit task.');
    });

    it('hides Git tools for direct Architect tasks while keeping task tools', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Implement';
      appState.agentType = 'build';
      appState.selectedTaskId = 'task-1';
      localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
      Object.assign(projectGroups[0]?.projects[0] ?? {}, {
        directEdit: true,
        gitSetupState: 'not_git',
      });
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          execution_targets: [{
            projectId: 'project-1',
            executionMode: 'direct',
            branchName: '',
            worktreeKey: 'project-1::direct',
          }],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      setImplementStoreState(useChatStore, {
        conversationId: 'implement-conv',
        taskId: 'task-1',
        title: 'Direct Architect task',
      });
      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Modifie directement la documentation.',
        taskId: 'task-1',
      });

      const streamOptions = getLatestStreamOptions<{ allowedToolIds: string[] }>();
      expect(streamOptions.allowedToolIds).toContain('task_todo_get');
      expect(streamOptions.allowedToolIds).toContain('write');
      expect(streamOptions.allowedToolIds).not.toContain('git_status');
      expect(streamOptions.allowedToolIds).not.toContain('git_diff');
      expect(streamOptions.allowedToolIds).not.toContain('git_add');
      expect(streamOptions.allowedToolIds).not.toContain('git_commit');
    });

    it('keeps Git tools for a mixed task while the direct project is focused', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Implement';
      appState.agentType = 'build';
      appState.selectedProjectId = 'project-1';
      appState.selectedTaskId = 'task-1';
      localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
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
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          project_ids: ['project-1', 'project-2'],
          execution_targets: [
            {
              projectId: 'project-1',
              executionMode: 'direct',
              branchName: '',
              worktreeKey: 'project-1::direct',
            },
            {
              projectId: 'project-2',
              executionMode: 'git',
              branchName: 'feature/mixed-api',
              worktreeKey: 'mixed-api',
            },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      setImplementStoreState(useChatStore, {
        conversationId: 'implement-conv',
        taskId: 'task-1',
        title: 'Mixed Architect task',
      });
      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Traite chaque projet selon son mode.',
        taskId: 'task-1',
      });

      const streamOptions = getLatestStreamOptions<{ allowedToolIds: string[] }>();
      expect(streamOptions.allowedToolIds).toContain('git_status');
      expect(streamOptions.allowedToolIds).toContain('git_diff');
      expect(streamOptions.allowedToolIds).toContain('git_add');
      expect(streamOptions.allowedToolIds).toContain('git_commit');
    });

    it('keeps standalone Plan mode read-only without Architect task tools', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Implement';
      appState.agentType = 'plan';
      appState.selectedTaskId = 'task-1';
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          task_source: 'standalone',
          plan_id: '',
          project_id: 'project-1',
          project_ids: ['project-1'],
          execution_targets: [
            {
              projectId: 'project-1',
              executionMode: 'git',
              branchName: 'feature/standalone-export',
              worktreeKey: 'standalone-export-web',
            },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Standalone export',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Analyse avant de coder.',
        taskId: 'task-1',
      });

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        messages: Array<{ role: string; content: string }>;
      }>();

      expect(streamOptions.allowedToolIds).toContain('read');
      expect(streamOptions.allowedToolIds).toContain('grep');
      expect(streamOptions.allowedToolIds).toContain('git_diff');
      expect(streamOptions.allowedToolIds).not.toContain('terminal_run');
      expect(streamOptions.allowedToolIds).not.toContain('write');
      expect(streamOptions.allowedToolIds).not.toContain('task_todo_get');
      expect(streamOptions.allowedToolIds).not.toContain('task_artifact_list');
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'Plan mode is read-only',
      );
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'This is a standalone implementation task',
      );
    });

    it('rejects legacy Architect task tools that were not exposed for standalone tasks', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Implement';
      appState.agentType = 'build';
      appState.selectedTaskId = 'task-1';
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          task_source: 'standalone',
          plan_id: '',
          project_id: 'project-1',
          project_ids: ['project-1'],
          execution_targets: [
            {
              projectId: 'project-1',
              branchName: 'feature/standalone-export',
              worktreeKey: 'standalone-export-web',
            },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Standalone export',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Implémente cette tâche indépendante.',
        taskId: 'task-1',
      });

      const onToolCall = getLatestArchitectToolHandler();
      const todoResult = await onToolCall('task_todo_get', {});
      const artifactResult = await onToolCall('task_artifact_list', {});

      expect(String(todoResult)).toContain('not available for this turn');
      expect(String(artifactResult)).toContain('not available for this turn');
    });

    it('denies forced mutating tool calls during implement plan agent turns', async () => {
      const { onToolCall } = await startImplementToolConversation(
        'Prépare le plan de correction.',
        { agentType: 'plan' },
      );

      const patchResult = await onToolCall(
        'apply_patch',
        {
          patch_text:
            '*** Begin Patch\n*** Update File: src/App.tsx\n@@\n console.log("x")\n*** End Patch',
        },
        'call-plan-patch',
      );
      const commitResult = await onToolCall(
        'git_commit',
        { message: 'fix: update checkout flow' },
        'call-plan-commit',
      );

      expect(String(patchResult)).toContain('not available for this turn');
      expect(String(commitResult)).toContain('not available for this turn');
      expect(executeWorkspaceToolMock).not.toHaveBeenCalled();
    });

    it('challenges git_add once before allowing the same assistant turn to stage', async () => {
      const { onToolCall } = await startImplementToolConversation(
        'Corrige le code, mais ne stage rien.',
      );

      const firstResult = await onToolCall(
        'git_add',
        { paths: ['src/App.tsx'] },
        'call-add-1',
      );

      expect(String(firstResult)).toContain(
        'Do not stage or commit unless the user explicitly asked',
      );
      expect(executeWorkspaceToolMock).not.toHaveBeenCalled();

      await onToolCall('git_add', { paths: ['src/App.tsx'] }, 'call-add-2');

      expect(executeWorkspaceToolMock).toHaveBeenCalledTimes(1);
      expect(
        (executeWorkspaceToolMock as unknown as { mock: { calls: unknown[][] } })
          .mock.calls[0]?.[0],
      ).toBe('git_add');
    });

    it('resets the git stage/commit challenge for a new assistant turn', async () => {
      const firstStreamCompletion = createDeferred<void>();
      const secondStreamCompletion = createDeferred<void>();
      streamChatMock
        .mockImplementationOnce((async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as {
            onComplete?: (result: {
              visibleContent: string;
              toolTraces: unknown[];
              hiddenContext?: string;
              usage: null;
            }) => void;
          };
          await firstStreamCompletion.promise;
          options.onComplete?.({
            visibleContent: 'Premier tour terminé.',
            toolTraces: [],
            hiddenContext: undefined,
            usage: null,
          });
          return { usage: null };
        }) as unknown as typeof streamChatMock)
        .mockImplementationOnce((async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as {
            onComplete?: (result: {
              visibleContent: string;
              toolTraces: unknown[];
              hiddenContext?: string;
              usage: null;
            }) => void;
          };
          await secondStreamCompletion.promise;
          options.onComplete?.({
            visibleContent: 'Second tour terminé.',
            toolTraces: [],
            hiddenContext: undefined,
            usage: null,
          });
          return { usage: null };
        }) as unknown as typeof streamChatMock);

      const { useChatStore, onToolCall } = await startImplementToolConversation(
        'Tu peux commit après vérification.',
      );

      await onToolCall(
        'git_commit',
        { message: 'fix: update checkout flow' },
        'call-commit-first-challenge',
      );
      await onToolCall(
        'git_commit',
        { message: 'fix: update checkout flow' },
        'call-commit-first-execute',
      );
      expect(executeWorkspaceToolMock).toHaveBeenCalledTimes(1);

      firstStreamCompletion.resolve();
      await flushAsyncWork();
      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Continue.',
        taskId: 'task-1',
      });
      await waitForStreamCallCount(2);

      const nextTurnToolCall = getLatestArchitectToolHandler();
      const nextTurnResult = await nextTurnToolCall(
        'git_commit',
        { message: 'fix: update checkout flow' },
        'call-commit-second-turn',
      );

      expect(String(nextTurnResult)).toContain(
        'Do not stage or commit unless the user explicitly asked',
      );
      expect(executeWorkspaceToolMock).toHaveBeenCalledTimes(1);

      secondStreamCompletion.resolve();
      await flushAsyncWork();
    });

    it('includes explicit anti stage/commit instructions when git tools are exposed', async () => {
      await startImplementToolConversation('Implémente la correction.');

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        messages: Array<{ role: string; content: string }>;
      }>();

      expect(streamOptions.allowedToolIds).toContain('git_add');
      expect(streamOptions.allowedToolIds).toContain('git_commit');
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'Never stage or commit on your own initiative',
      );
    });

    it('reminds build turns to execute the previous plan after a plan turn', async () => {
      streamChatMock
        .mockImplementationOnce((async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as {
            onComplete?: (result: {
              visibleContent: string;
              toolTraces: unknown[];
              hiddenContext?: string;
              usage: null;
            }) => void;
          };
          options.onComplete?.({
            visibleContent: 'Plan: inspecter les fichiers puis patcher.',
            toolTraces: [],
            hiddenContext: undefined,
            usage: null,
          });
          return { usage: null };
        }) as unknown as typeof streamChatMock)
        .mockImplementationOnce((async () => ({ usage: null })) as unknown as typeof streamChatMock);

      const { useChatStore } = await startImplementToolConversation(
        'Fais le plan.',
        { agentType: 'plan' },
      );
      await flushAsyncWork();

      appState.agentType = 'build';
      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Applique maintenant.',
        taskId: 'task-1',
      });
      await waitForStreamCallCount(2);

      const streamOptions = getLatestStreamOptions<{
        messages: Array<{ role: string; content: string }>;
        allowedToolIds: string[];
      }>();

      expect(streamOptions.allowedToolIds).toContain('write');
      expect(streamOptions.allowedToolIds).toContain('git_commit');
      expect(streamOptions.allowedToolIds).toContain('terminal_run');
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'The previous assistant turn used Plan mode',
      );
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'Execute the latest plan unless the user changed direction',
      );
    });

    it('lets implement agents read and update the selected task todos', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      architectPlans.set(
        'plan-1',
        createPlan({
          status: 'in_progress',
          targetBranch: 'develop',
          nodes: [
            {
              id: 'task-1',
              title: 'Implement checkout',
              description: 'Ship the checkout flow.',
              type: 'task',
              status: 'in-progress',
              dependencies: [],
              assignedBranch: 'feature/implement-checkout',
              branchType: 'feature',
              branchSlug: 'implement-checkout',
              projectId: 'project-1',
              projectIds: ['project-1'],
              todos: [
                { id: 'todo-1', title: 'Wire checkout API', status: 'done' },
                { id: 'todo-2', title: 'Update branch checklist', status: 'pending' },
              ],
            },
          ],
        }),
      );
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          plan_storage_branch: 'develop',
          plan_target_branch: 'develop',
          todos: [
            { id: 'todo-1', title: 'Wire checkout API', status: 'done' },
            { id: 'todo-2', title: 'Update branch checklist', status: 'open' as never },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Mets a jour la checklist.',
        taskId: 'task-1',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(String(streamOptions.messages[0]?.content)).toContain('[Task Todos]');
      expect(String(streamOptions.messages[0]?.content)).toContain('Update branch checklist');
      expect(String(streamOptions.messages[0]?.content)).toContain('progress="1/2"');
      expect(String(streamOptions.messages[0]?.content)).toContain('"status":"pending"');
      expect(String(streamOptions.messages[0]?.content)).not.toContain('"status":"open"');

      const onToolCall = getLatestArchitectToolHandler();
      const readResult = await onToolCall('task_todo_get', {});
      expect(String(readResult)).toContain('Update branch checklist');

      const updateResult = await onToolCall('task_todo_update', {
        operations: [
          {
            action: 'set_status',
            todo_id: 'todo-2',
            status: 'done',
          },
        ],
      });

      expect(String(updateResult)).toContain('2/2 todos done');
      expect(architectPlans.get('plan-1')?.nodes[0]?.todos?.[1]).toMatchObject({
        id: 'todo-2',
        status: 'done',
      });
      expect(taskStoreState.refreshFromPlan).toHaveBeenCalled();
    });

    it('reports legacy missing task todos and initializes them with add', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      architectPlans.set(
        'plan-1',
        createPlan({
          status: 'in_progress',
          targetBranch: 'develop',
          nodes: [
            {
              id: 'task-1',
              title: 'Legacy checkout',
              description: 'Ship the checkout flow.',
              type: 'task',
              status: 'in-progress',
              dependencies: [],
              assignedBranch: 'feature/legacy-checkout',
              branchType: 'feature',
              branchSlug: 'legacy-checkout',
              projectId: 'project-1',
              projectIds: ['project-1'],
            },
          ],
        }),
      );
      taskStoreState.tasks = [
        createImplementTask({
          title: 'Legacy checkout',
          status: 'InProgress',
          plan_storage_branch: 'develop',
          plan_target_branch: 'develop',
          todos: undefined,
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Legacy checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Lis la checklist.',
        taskId: 'task-1',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(String(streamOptions.messages[0]?.content)).toContain(
        'has no generated task checklist available'
      );
      expect(String(streamOptions.messages[0]?.content)).not.toContain('implicit:task-1');
      expect(String(streamOptions.messages[0]?.content)).not.toContain('Legacy checkout","description"');

      const onToolCall = getLatestArchitectToolHandler();
      const readResult = await onToolCall('task_todo_get', {});
      expect(String(readResult)).toContain('legacy_missing_todos');
      expect(String(readResult)).toContain('has no generated todos');

      const updateResult = await onToolCall('task_todo_update', {
        operations: [
          {
            action: 'add',
            title: 'Create first real todo',
          },
        ],
      });

      expect(String(updateResult)).toContain('0/1 todos done');
      expect(architectPlans.get('plan-1')?.nodes[0]?.todos).toEqual([
        expect.objectContaining({
          title: 'Create first real todo',
          status: 'pending',
        }),
      ]);
    });

    it('does not promote workspace context for an Implement agent terminal', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      taskStoreState.tasks = [
        createImplementTask({
          status: 'InProgress',
          plan_storage_branch: 'develop',
          plan_target_branch: 'develop',
          project_ids: ['project-1'],
          context_project_ids: ['project-2'],
          execution_targets: [
            {
              projectId: 'project-1',
              branchName: 'feature/implement-checkout',
              worktreeKey: 'task-1-web',
            },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Ouvre un terminal sur le projet API.',
        taskId: 'task-1',
      });

      const onToolCall = getLatestArchitectToolHandler();
      const result = await onToolCall('terminal_create_session', {
        project_id: 'project-2',
        cwd: 'C:/Users/test/Desktop',
      });

      expect(taskStoreState.promoteTaskContextProjects).not.toHaveBeenCalled();
      expect(terminalCreateSessionFromChatMock).toHaveBeenCalledWith({
        projectId: null,
        cwd: 'C:/Users/test/Desktop',
      });
      expect(taskStoreState.getTaskById('task-1')).toMatchObject({
        project_ids: ['project-1'],
        context_project_ids: ['project-2'],
        status: 'InProgress',
      });

      expect(String(result)).not.toContain('[macro_scope_promotion]');
      const parsed = JSON.parse(String(result));
      expect(parsed.cwd).toBe('C:/Users/test/Desktop');
      expect(parsed).not.toHaveProperty('project_id');
      expect(parsed).not.toHaveProperty('workspace_path');
    });

    it('keeps the agent terminal independent from standalone task context', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'manual-task-1';
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      taskStoreState.tasks = [
        createManualFeatureTask({
          draft: false,
          status: 'InProgress',
          project_ids: ['project-1'],
          context_project_ids: ['project-2'],
          assigned_branch: 'feature/quick-export',
          branch_name: 'feature/quick-export',
          execution_targets: [
            {
              projectId: 'project-1',
              branchName: 'feature/quick-export',
              worktreeKey: 'manual-task-1-web',
            },
          ],
        }),
      ];

      const { useChatStore } = await loadChatStore();
      setImplementStoreState(useChatStore, {
        conversationId: 'manual-conv',
        taskId: 'manual-task-1',
        title: 'Manual feature',
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'manual-conv',
        content: 'Ouvre un terminal sur le projet API.',
        taskId: 'manual-task-1',
      });

      taskStoreState.promoteTaskContextProjects.mockClear();
      terminalCreateSessionFromChatMock.mockClear();

      const onToolCall = getLatestArchitectToolHandler();
      const result = await onToolCall('terminal_create_session', {
        project_id: 'project-2',
      });

      expect(taskStoreState.promoteTaskContextProjects).not.toHaveBeenCalled();
      expect(terminalCreateSessionFromChatMock).toHaveBeenCalledWith({
        projectId: null,
        cwd: null,
      });
      const parsed = JSON.parse(String(result));
      expect(parsed).not.toHaveProperty('project_id');
      expect(parsed).not.toHaveProperty('workspace_path');
      expect(useChatStore.getState().lastError).toBeNull();
    });

    it('returns the user denial reason when a pending tool approval is rejected', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      providerState.selectedSupportsNativeToolCalling = () => true;
      taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Lance une commande en terminal.',
        taskId: 'task-1',
      });

      const onToolCall = getLatestArchitectToolHandler();
      const toolCallPromise = onToolCall(
        'terminal_run',
        { command: 'npm test', session_id: 'session-1' },
        'tool-call-1'
      );

      await flushAsyncWork();

      expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolId).toBe(
        'terminal_run'
      );

      useChatStore
        .getState()
        .denyPendingToolApproval('implement-conv', 'Stay inside the workspace only.');

      const deniedResult = await toolCallPromise;
      expect(String(deniedResult)).toBe(
        'Tool terminal_run was denied by the user. User reason: Stay inside the workspace only.'
      );
      expect(deniedResult).toMatchObject({ isError: true, errorKind: 'permission' });
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toBeNull();
    });

    it('requires a fresh approval for every Implement terminal command', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      providerState.selectedSupportsNativeToolCalling = () => true;
      taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Lance une commande en terminal.',
        taskId: 'task-1',
      });
      terminalSessionsFromChat.set(
        'session-1',
        createTerminalSessionFromChatDto({
          sessionId: 'session-1',
          projectId: null,
        }),
      );

      const onToolCall = getLatestArchitectToolHandler();
      const firstToolCall = onToolCall(
        'terminal_run',
        { command: 'npm test', session_id: 'session-1' },
        'tool-call-1'
      );

      await flushAsyncWork();
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toMatchObject({
        toolCallId: 'tool-call-1',
        canApproveForConversation: false,
      });
      useChatStore.getState().approvePendingToolApprovalForConversation('implement-conv');
      await firstToolCall;

      expect(
        useChatStore.getState().conversationApprovalGrantsByConversationId['implement-conv']
      ).toBeUndefined();
      expect(terminalRunCommandFromChatMock).toHaveBeenCalledTimes(1);

      const secondToolCall = onToolCall(
        'terminal_run',
        { command: 'npm test -- --watch=false', session_id: 'session-1' },
        'tool-call-2'
      );

      await flushAsyncWork();

      expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolCallId).toBe(
        'tool-call-2'
      );

      useChatStore.getState().denyPendingToolApproval('implement-conv');
      expect(String(await secondToolCall)).toBe('Tool terminal_run was denied by the user.');
      expect(terminalRunCommandFromChatMock).toHaveBeenCalledTimes(1);
    });

    it('denies the active approval and aborts queued requests when the conversation stream is stopped', async () => {
      appState.mode = 'Implement';
      appState.selectedTaskId = 'task-1';
      providerState.selectedSupportsNativeToolCalling = () => true;
      taskStoreState.tasks = [createImplementTask({ status: 'InProgress' })];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('implement-conv'),
            scope_mode: 'Implement',
            task_id: 'task-1',
            title: 'Task - Implement checkout',
          },
        ],
        messages: [],
        selectedConversationId: 'implement-conv',
        selectedConversationIdsByMode: { Implement: 'implement-conv' },
        isLoading: false,
        isStreaming: false,
        sendState: 'idle',
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'implement-conv',
        content: 'Lance une commande en terminal.',
        taskId: 'task-1',
      });

      const onToolCall = getLatestArchitectToolHandler();
      const toolCallPromise = onToolCall(
        'terminal_run',
        { command: 'npm test', session_id: 'session-1' },
        'tool-call-1'
      );
      const queuedToolCallPromise = onToolCall(
        'terminal_run',
        { command: 'npm test -- --watch=false', session_id: 'session-2' },
        'tool-call-2'
      );

      await flushAsyncWork();
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolCallId).toBe(
        'tool-call-1'
      );

      useChatStore.getState().stopConversationStream('implement-conv');

      expect(String(await toolCallPromise)).toBe('Tool terminal_run was denied by the user.');
      expect(String(await queuedToolCallPromise)).toBe('Tool execution aborted');
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toBeNull();
      expect(terminalRunCommandFromChatMock).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().conversationApprovalGrantsByConversationId['implement-conv']
      ).toBeUndefined();
    });

  });
};
