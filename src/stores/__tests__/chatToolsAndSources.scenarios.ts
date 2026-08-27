import { describe, expect, it, mock } from 'bun:test';
import type {
  ChatMessage,
  ContextReference,
  SkillManifest,
  WorkspaceFileReference,
} from '../../types';
import type { Citation } from '../useCitationsStore';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerChatToolsAndSourcesScenarios = (
  context: UseChatStoreScenarioContext,
) => {
  const {
    appState,
    createCitationId,
    createConversation,
    createIdleChatStoreState,
    createSkillManifest,
    createTerminalSessionFromChatDto,
    ensureCitationContentLoadedMock,
    fetchWebPageMock,
    flushAsyncWork,
    fsReadFileWithOptionsMock,
    getLatestArchitectToolHandler,
    getLatestStreamOptions,
    getToolModePolicyMock,
    installSkillActivationMock,
    loadChatStore,
    providerState,
    savePreferenceForTest,
    streamChatMock,
    terminalCreateSessionFromChatMock,
    terminalRunCommandFromChatMock,
    terminalSessionsFromChat,
    toolsStoreState,
    webSearchMock,
  } = context;

  describe('useChatStore Chat tools and sources', () => {
    it('uses the backend tool policy in Chat mode and keeps question available when enabled', async () => {
      context.tauriAvailable = true;
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      getToolModePolicyMock.mockResolvedValueOnce({
        allowed_tool_ids: ['question', 'read_file', 'web_search'],
        enforce_macro_only_writes: false,
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Pose-moi des questions pour cadrer le besoin.',
      });

      expect(getToolModePolicyMock).toHaveBeenCalledWith('Chat');
      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        allowedToolIds: string[];
      };
      expect(streamOptions.allowedToolIds).toContain('question');
    });

    it('freezes the focused project model selection for the complete turn', async () => {
      appState.mode = 'Chat';
      providerState.providerConfigs.push({
        id: 'project-provider',
        name: 'Project provider',
        providerType: 'openai',
        isEnabled: true,
        isLocal: true,
        hasStoredApiKey: false,
        apiKeyLoaded: true,
        apiKey: '',
      });
      providerState.modelsByProvider['project-provider'] = [
        { id: 'project-model', name: 'Project model', isEnabled: true },
      ];
      context.scopedTurnConfigurationForTest = {
        projectIds: ['project-1'],
        focusProjectId: 'project-1',
        riskLevel: 'balanced',
        maxTurns: 6,
        builtInTools: {},
        modeTools: {},
        allowedMcpServerIds: [],
        mcpServers: {},
        models: {
          chat: {
            providerId: 'project-provider',
            modelId: 'project-model',
            reasoningEffort: 'high',
          },
        },
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [{
          ...createConversation('chat-project-model'),
          scope_mode: 'Chat',
        }],
        messages: [],
        selectedConversationId: 'chat-project-model',
        selectedConversationIdsByMode: { Chat: 'chat-project-model' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-project-model',
        content: 'Use the project model.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        providerId: string;
        modelId: string;
        reasoningEffort: string | null;
        maxTurns: number;
      };
      expect(streamOptions).toMatchObject({
        providerId: 'project-provider',
        modelId: 'project-model',
        reasoningEffort: 'high',
        maxTurns: 6,
      });
    });

    it('exposes terminal tools to unscoped Chat turns', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv'),
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Inspecte mon environnement.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as { allowedToolIds: string[] };
      expect(streamOptions.allowedToolIds).toEqual(
        expect.arrayContaining([
          'terminal_create_session',
          'terminal_run',
          'terminal_read',
          'terminal_kill',
        ]),
      );
    });

    it('creates a general Chat terminal without binding it to the attached workspace', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv'),
            scope_mode: 'Chat',
            task_id: null,
            group_id: 'group-1',
            project_id: 'project-1',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Inspecte le projet avec le terminal.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as { allowedToolIds: string[] };
      expect(streamOptions.allowedToolIds).toEqual(
        expect.arrayContaining([
          'terminal_create_session',
          'terminal_run',
          'terminal_read',
          'terminal_kill',
        ]),
      );

      const result = await getLatestArchitectToolHandler()('terminal_create_session', {
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

    it('rejects manual project terminal sessions from the agent terminal tool', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      terminalSessionsFromChat.set(
        'manual-project-session',
        createTerminalSessionFromChatDto({
          sessionId: 'manual-project-session',
          projectId: 'project-1',
        }),
      );
      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv'),
            scope_mode: 'Chat',
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Lis le terminal manuel.',
      });

      const result = await getLatestArchitectToolHandler()('terminal_read', {
        session_id: 'manual-project-session',
      });

      expect(String(result)).toContain('belongs to the manual project terminal');
    });

    it('requires a fresh approval for every Chat terminal command even in YOLO', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      localStorage.setItem('macro_toolRiskLevel', JSON.stringify('yolo'));
      terminalSessionsFromChat.set(
        'session-general',
        createTerminalSessionFromChatDto({
          sessionId: 'session-general',
          projectId: null,
        }),
      );
      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            ...createConversation('chat-conv'),
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
          },
        ],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Lance deux commandes.',
      });

      const onToolCall = getLatestArchitectToolHandler();
      const firstCommand = onToolCall(
        'terminal_run',
        { session_id: 'session-general', command: 'pwd' },
        'chat-terminal-1',
      );
      await flushAsyncWork();

      expect(useChatStore.getState().getPendingToolApproval('chat-conv')).toMatchObject({
        toolCallId: 'chat-terminal-1',
        canApproveForConversation: false,
      });
      useChatStore.getState().approvePendingToolApprovalForConversation('chat-conv');
      await firstCommand;

      expect(
        useChatStore.getState().conversationApprovalGrantsByConversationId['chat-conv'],
      ).toBeUndefined();
      expect(terminalRunCommandFromChatMock).toHaveBeenCalledTimes(1);

      const secondCommand = onToolCall(
        'terminal_run',
        { session_id: 'session-general', command: 'pwd' },
        'chat-terminal-2',
      );
      await flushAsyncWork();

      expect(useChatStore.getState().getPendingToolApproval('chat-conv')?.toolCallId).toBe(
        'chat-terminal-2',
      );
      useChatStore.getState().denyPendingToolApproval('chat-conv');
      expect(String(await secondCommand)).toBe('Tool terminal_run was denied by the user.');
      expect(terminalRunCommandFromChatMock).toHaveBeenCalledTimes(1);
    });

    it('passes enabled discovered MCP tools through Chat mode streaming options', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      toolsStoreState.getEnabledMCPToolIds = () => ['mcp__github__list_issues'];
      toolsStoreState.getEnabledMCPTools = () => [
        {
          id: 'mcp__github__list_issues',
          serverId: 'github',
          name: 'list_issues',
          description: 'List issues',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [createConversation('chat-conv')],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Use GitHub context.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        allowedToolIds: string[];
        mcpTools?: Array<{ id: string }>;
      };
      expect(streamOptions.allowedToolIds).toContain('mcp__github__list_issues');
      expect(streamOptions.mcpTools?.map((tool) => tool.id)).toEqual([
        'mcp__github__list_issues',
      ]);
    });

    it('adds a guided retry when the user explicitly asks to use the question tool', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content:
          "Pose-moi des questions pour choisir ma couleur préférée, utilise l'outil Question.",
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        guidedToolRetry?: {
          requiredToolNames: string[];
          retrySystemPrompt: string;
        };
      };
      expect(streamOptions.guidedToolRetry?.requiredToolNames).toEqual(['question']);
      expect(streamOptions.guidedToolRetry?.retrySystemPrompt).toContain(
        'explicitly asked you to use the question tool',
      );
    });

    it('does not force the question tool retry when question is disabled in chat tools', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      toolsStoreState.getEnabledChatToolIds = () => ['read_file', 'web_search', 'web_fetch'];

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content:
          "Pose-moi des questions pour choisir ma couleur préférée, utilise l'outil Question.",
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        guidedToolRetry?: {
          requiredToolNames: string[];
        };
        allowedToolIds: string[];
      };
      expect(streamOptions.allowedToolIds).not.toContain('question');
      expect(streamOptions.guidedToolRetry).toBeUndefined();
    });

    it('reads the full attached file content through the chat read_file tool', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      context.citationRecords.push({
        id: 'context-file',
        type: 'file',
        scope: 'context',
        source: 'notes.md',
        title: 'notes.md',
        snippet: 'Short preview',
        content: 'Short preview plus the full attached file body.',
        path: 'notes.md',
        messageId: 'manual-file',
        conversationId: 'chat-conv',
        timestamp: '2026-03-19T00:00:00.000Z',
      });

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Lis le fichier attache.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
      };
      const result = await streamOptions.onToolCall?.('read_file', { file: 'notes.md' }, 'call-read');

      expect(String(result)).toContain('FILE: notes.md');
      expect(String(result)).toContain('full attached file body');
    });

    it('persists slash-tagged file refs and reads their workspace content lazily', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = 'group-1';
      appState.selectedProjectId = 'project-1';
      const fileRef: WorkspaceFileReference = {
        id: 'file:project-1:src/App.tsx',
        path: 'src/App.tsx',
        relativePath: 'src/App.tsx',
        projectId: 'project-1',
        projectName: 'Web',
        language: 'typescript',
        sizeBytes: 120,
        modified: '2026-03-19T00:00:00.000Z',
        isFocused: true,
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: 'group-1',
            project_id: 'project-1',
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [{
          id: fileRef.id,
          kind: 'file',
          title: fileRef.path,
          data: fileRef,
        } satisfies ContextReference],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Regarde [file: src/App.tsx] avant de répondre.',
      });

      const userMessage = useChatStore
        .getState()
        .messages.find((message: ChatMessage) => message.role === 'user');
      expect(userMessage?.context_refs).toEqual([
        expect.objectContaining({
          kind: 'file',
          title: 'src/App.tsx',
          path: 'src/App.tsx',
          relativePath: 'src/App.tsx',
          projectId: 'project-1',
          projectName: 'Web',
        }),
      ]);

      const lightweightCitation = context.citationRecords.find(
        (citation) =>
          citation.type === 'file' &&
          citation.scope === 'context' &&
          citation.path === 'src/App.tsx',
      );
      expect(lightweightCitation).toBeDefined();
      expect(lightweightCitation?.content).toBeUndefined();
      expect(lightweightCitation?.snippet).toBeUndefined();

      const streamOptions = getLatestStreamOptions<{
        messages: Array<{ role: string; content: unknown }>;
        fileToolContext?: Array<{ path?: string; content?: string; snippet?: string }>;
        onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
      }>();
      expect(JSON.stringify(streamOptions.messages)).toContain(
        'Content: not preloaded. Use read_file with this exact path before analyzing file contents.',
      );
      expect(streamOptions.fileToolContext).toContainEqual(
        expect.objectContaining({
          path: 'src/App.tsx',
          content: undefined,
          snippet: undefined,
        }),
      );

      const result = await streamOptions.onToolCall?.(
        'read_file',
        { file: 'src/App.tsx' },
        'call-read-file-ref',
      );

      const readArgs = fsReadFileWithOptionsMock.mock.calls[0]?.[0];
      expect(readArgs).toEqual(expect.objectContaining({
        path: 'src/App.tsx',
        allowOutsideWorkspace: false,
      }));
      expect(readArgs?.workspacePath).toContain('/repos/web');
      expect(String(result)).toContain('FILE: src/App.tsx');
      expect(String(result)).toContain('SOURCE: WORKSPACE');
      expect(String(result)).toContain('Workspace file body from disk.');
    });

    it('persists source composer refs and injects the full passage', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      const sourceCitation: Citation = {
        id: 'source-ref-1',
        type: 'source_passage',
        scope: 'source',
        source: 'Research notes',
        title: 'Retention insight',
        snippet: 'Short retained excerpt.',
        content: 'Full retained source passage with the detail the model needs.',
        messageId: 'assistant-source',
        conversationId: 'chat-conv',
        timestamp: '2026-03-19T00:00:00.000Z',
        url: 'https://example.com/source',
        kind: 'interesting',
        reason: 'Useful for the next answer',
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState(createIdleChatStoreState({
        conversations: [createConversation('chat-conv', '')],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        composerContextRefs: [{
          id: sourceCitation.id,
          kind: 'source',
          title: sourceCitation.title,
          subtitle: sourceCitation.source,
          data: sourceCitation,
        } satisfies ContextReference],
      }));

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Utilise cette source.',
      });

      const userMessage = useChatStore
        .getState()
        .messages.find((message: ChatMessage) => message.role === 'user');
      expect(userMessage?.context_refs).toEqual([
        expect.objectContaining({
          id: 'source-ref-1',
          kind: 'source',
          title: 'Retention insight',
          subtitle: 'Research notes',
          snippet: 'Full retained source passage with the detail the model needs.',
          sourceLabel: 'Research notes',
          url: 'https://example.com/source',
        }),
      ]);

      const streamOptions = getLatestStreamOptions<{
        messages: Array<{ role: string; content: unknown }>;
      }>();
      const requestContent = String(streamOptions.messages.at(-1)?.content ?? '');
      expect(requestContent).toContain('[source: Retention insight]');
      expect(requestContent).toContain(
        'Passage: Full retained source passage with the detail the model needs.',
      );
      expect(requestContent).toContain('Source: Research notes');
      expect(requestContent).toContain('URL: https://example.com/source');
    });

    it('preloads explicit skill mentions and keeps the compact enabled skill catalog', async () => {
      context.tauriAvailable = true;
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;

      const { useChatStore } = await loadChatStore();
      const { useSkillsStore } = await import('../useSkillsStore');
      const skill: SkillManifest = {
        id: 'project:project-1:agents:docs:aaa111',
        name: 'docs',
        description: 'Use the local documentation style.',
        rootPath: '/repos/web/.agents/skills/docs',
        skillFilePath: '/repos/web/.agents/skills/docs/SKILL.md',
        source: {
          kind: 'project',
          namespace: 'agents',
          projectId: 'project-1',
          projectName: 'Web',
          rootPath: '/repos/web',
          skillRootPath: '/repos/web/.agents/skills',
        },
        resources: [{ path: 'references/style.md', kind: 'reference', sizeBytes: 120 }],
        scripts: [{ path: 'scripts/check.sh', kind: 'script', sizeBytes: 80 }],
        contentHash: 'sha256:test-skill-content',
        validationErrors: [],
        isValid: true,
      };
      useSkillsStore.setState({
        skills: [skill],
        settingsBySkillId: {
          [skill.id]: { enabled: true, scriptsEnabled: false },
        },
      });
      installSkillActivationMock(useSkillsStore);
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Utilise $docs pour cette réponse. FULL BODY SHOULD NOT BE IN CATALOG',
      });

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        skillToolIds: string[];
        runnableSkillToolIds: string[];
        messages: Array<{ role: string; content: unknown }>;
      }>();
      const serializedMessages = JSON.stringify(streamOptions.messages);
      expect(streamOptions.allowedToolIds).toContain('skill_activate');
      expect(streamOptions.allowedToolIds).toContain('skill_read_resource');
      expect(streamOptions.allowedToolIds).not.toContain('skill_run_script');
      expect(serializedMessages).toContain('Available Macro skills');
      expect(serializedMessages).toContain('id=project:project-1:agents:docs:aaa111');
      expect(serializedMessages).toContain('<skill_content name=\\"docs\\"');
      expect(serializedMessages).toContain('The user explicitly referenced these enabled skills');
      expect(serializedMessages).toContain('# Instructions');
    });

    it('keeps locked skill tools available even when hidden from chat toolbox settings', async () => {
      context.tauriAvailable = true;
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      toolsStoreState.getEnabledChatToolIds = () => ['read_file', 'web_search', 'web_fetch'];

      const { useChatStore } = await loadChatStore();
      const { useSkillsStore } = await import('../useSkillsStore');
      const skill: SkillManifest = {
        id: 'global:agents:test-skill:aaa111',
        name: 'test-skill',
        description: 'Skill de test pour vérifier l’activation dans Macro.',
        contentHash: 'sha256:test-skill-content',
        rootPath: '/Users/test/.agents/skills/test-skill',
        skillFilePath: '/Users/test/.agents/skills/test-skill/SKILL.md',
        source: {
          kind: 'global',
          namespace: 'agents',
          projectId: null,
          projectName: null,
          rootPath: '/Users/test/.agents/skills',
          skillRootPath: '/Users/test/.agents/skills',
        },
        resources: [],
        scripts: [{ path: 'scripts/check.sh', kind: 'script', sizeBytes: 80 }],
        validationErrors: [],
        isValid: true,
      };
      useSkillsStore.setState({
        skills: [skill],
        settingsBySkillId: {
          [skill.id]: {
            enabled: true,
            scriptsEnabled: true,
            trust: {
              contentHash: skill.contentHash!,
              grantedAt: '2026-08-20T12:00:00.000Z',
              grantedBy: 'user',
            },
          },
        },
      });
      installSkillActivationMock(useSkillsStore);
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Utilise $test-skill et lance son check.sh.',
      });

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        skillToolIds: string[];
        runnableSkillToolIds: string[];
        messages: Array<{ role: string; content: unknown }>;
      }>();
      const serializedMessages = JSON.stringify(streamOptions.messages);

      expect(streamOptions.allowedToolIds).toContain('skill_activate');
      expect(streamOptions.allowedToolIds).toContain('skill_read_resource');
      expect(streamOptions.allowedToolIds).toContain('skill_run_script');
      expect(streamOptions.skillToolIds).toEqual([skill.id]);
      expect(streamOptions.runnableSkillToolIds).toEqual([skill.id]);
      expect(serializedMessages).toContain('Available Macro skills');
      expect(serializedMessages).toContain('id=global:agents:test-skill:aaa111');
      expect(serializedMessages).toContain('<skill_content name=\\"test-skill\\"');
      expect(serializedMessages).toContain('call skill_activate with the exact id');
      expect(serializedMessages).toContain('The user explicitly referenced these enabled skills');
    });

    it('preloads only explicit skills without native tool calling', async () => {
      providerState.selectedSupportsNativeToolCalling = () => false;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      const skill = createSkillManifest();

      const { useChatStore } = await loadChatStore();
      const { useSkillsStore } = await import('../useSkillsStore');
      useSkillsStore.setState({
        skills: [skill],
        settingsBySkillId: {
          [skill.id]: { enabled: true, scriptsEnabled: false },
        },
      });
      installSkillActivationMock(useSkillsStore);
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [{
          id: skill.id,
          kind: 'skill',
          title: skill.name,
          data: skill,
        }],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Utilise $test-skill.',
      });

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        skillToolIds: string[];
        runnableSkillToolIds: string[];
        messages: Array<{ role: string; content: unknown }>;
      }>();
      const serializedMessages = JSON.stringify(streamOptions.messages);

      expect(streamOptions.allowedToolIds).toEqual([]);
      expect(serializedMessages).not.toContain('Available Macro skills');
      expect(serializedMessages).not.toContain('Activation: call skill_activate');
      expect(serializedMessages).toContain('Skill ID: global:agents:test-skill:aaa111');
      expect(serializedMessages).toContain('<skill_content name=\\"test-skill\\"');
      expect(serializedMessages).toContain('# Instructions');
    });

    it('keeps skill read tools but blocks skill scripts in strict risk mode', async () => {
      context.tauriAvailable = true;
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      await savePreferenceForTest('toolRiskLevel', 'strict');
      const skill = createSkillManifest();

      const { useChatStore } = await loadChatStore();
      const { useSkillsStore } = await import('../useSkillsStore');
      useSkillsStore.setState({
        skills: [skill],
        settingsBySkillId: {
          [skill.id]: {
            enabled: true,
            scriptsEnabled: true,
            trust: {
              contentHash: skill.contentHash!,
              grantedAt: '2026-08-20T12:00:00.000Z',
              grantedBy: 'user',
            },
          },
        },
      });
      installSkillActivationMock(useSkillsStore);
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Utilise $test-skill.',
      });

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        skillToolIds: string[];
        runnableSkillToolIds: string[];
        messages: Array<{ role: string; content: unknown }>;
      }>();
      const serializedMessages = JSON.stringify(streamOptions.messages);

      expect(streamOptions.allowedToolIds).toContain('skill_activate');
      expect(streamOptions.allowedToolIds).toContain('skill_read_resource');
      expect(streamOptions.allowedToolIds).not.toContain('skill_run_script');
      expect(streamOptions.skillToolIds).toEqual([skill.id]);
      expect(streamOptions.runnableSkillToolIds).toEqual([]);
      expect(serializedMessages).toContain('Available Macro skills');
    });

    it('routes skill tool calls through the skills store', async () => {
      context.tauriAvailable = true;
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      await savePreferenceForTest('toolRiskLevel', 'yolo');

      const { useChatStore } = await loadChatStore();
      const { useSkillsStore } = await import('../useSkillsStore');
      const skill = createSkillManifest({
        id: 'project:project-1:docs',
        name: 'docs',
        source: {
          kind: 'project',
          namespace: 'agents',
          projectId: 'project-1',
          projectName: 'Web',
          rootPath: '/repos/web',
          skillRootPath: '/repos/web/.agents/skills',
        },
      });
      const activateSkill = mock(async (_skillId: string, _conversationId?: string) => 'activated docs');
      const readSkillResource = mock(async (_skillId: string, _path: string) => 'resource content');
      const runSkillScriptResult = mock(async (_request: unknown, _snapshot?: unknown) => ({
        skillId: skill.id,
        scriptPath: 'scripts/check.sh',
        stdout: 'script result',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
      }));
      useSkillsStore.setState({
        skills: [skill],
        settingsBySkillId: {
          [skill.id]: {
            enabled: true,
            scriptsEnabled: true,
            trust: {
              contentHash: skill.contentHash!,
              grantedAt: '2026-08-20T12:00:00.000Z',
              grantedBy: 'user',
            },
          },
        },
        activateSkill,
        readSkillResource,
        runSkillScriptResult,
      });
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Use the docs skill.',
      });

      const streamOptions = getLatestStreamOptions<{
        allowedToolIds: string[];
        onToolCall?: (
          toolName: string,
          args: Record<string, unknown>,
          toolCallId?: string,
        ) => Promise<unknown>;
      }>();
      expect(streamOptions.allowedToolIds).toContain('skill_activate');
      expect(streamOptions.onToolCall).toBeDefined();
      if (!streamOptions.onToolCall) {
        throw new Error('Expected skill tool handler');
      }

      await expect(streamOptions.onToolCall(
        'skill_activate',
        { skill_id: 'project:project-1:docs' },
        'call-activate',
      )).resolves.toBe('activated docs');
      await expect(streamOptions.onToolCall(
        'skill_read_resource',
        { skill_id: 'project:project-1:docs', path: 'references/style.md' },
        'call-resource',
      )).resolves.toBe('resource content');
      const scriptResult = await streamOptions.onToolCall(
        'skill_run_script',
        {
          skill_id: 'project:project-1:docs',
          script_path: 'scripts/check.sh',
          args: ['--check'],
          timeout_ms: 1_000,
          allow_workspace: true,
        },
        'call-script',
      );
      expect(String(scriptResult)).toContain('script result');

      expect(activateSkill).toHaveBeenCalledWith('project:project-1:docs', 'chat-conv');
      expect(readSkillResource).toHaveBeenCalledWith(
        'project:project-1:docs',
        'references/style.md',
      );
      expect(runSkillScriptResult.mock.calls[0]?.[0]).toEqual({
        skillId: 'project:project-1:docs',
        scriptPath: 'scripts/check.sh',
        args: ['--check'],
        timeoutMs: 1_000,
        allowWorkspace: true,
      });
      expect(runSkillScriptResult.mock.calls[0]?.[1]).toMatchObject({
        conversationId: 'chat-conv',
        skills: {
          [skill.id]: {
            enabled: true,
            scriptsEnabled: true,
            hasScripts: true,
          },
        },
      });
    });

    it('persists, reads, updates, reclassifies, and deletes chat source passages', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      await savePreferenceForTest('toolRiskLevel', 'yolo');

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Garde les sources importantes.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
      };

      context.citationRecords.push({
        id: createCitationId(),
        type: 'file',
        scope: 'context',
        source: 'notes.md',
        title: 'notes.md',
        snippet: 'Macro keeps source passages in the chat conversation.',
        content: 'Macro keeps source passages in the chat conversation.',
        messageId: 'context-message',
        conversationId: 'chat-conv',
        timestamp: new Date().toISOString(),
        path: 'notes.md',
      });

      const markResult = await streamOptions.onToolCall?.(
        'mark_source_passage',
        {
          title: 'Important fact',
          passage: 'Macro keeps source passages in the chat conversation.',
          kind: 'used',
          source: 'notes.md',
        },
        'call-source',
      );
      const citationId = context.citationRecords.find((citation) => citation.scope === 'source')?.id;
      expect(String(markResult)).toContain('Source passage marked successfully');
      expect(citationId).toBeTruthy();

      const readResult = await streamOptions.onToolCall?.('read_sources', {}, 'call-read-sources');
      expect(String(readResult)).toContain(String(citationId));
      expect(String(readResult)).toContain('Macro keeps source passages');

      await streamOptions.onToolCall?.(
        'edit_source_passage',
        {
          citation_id: citationId,
          action: 'update',
          title: 'Updated fact',
          passage: 'Updated source passage.',
        },
        'call-update-source',
      );
      expect(context.citationRecords.find((citation) => citation.id === citationId)?.title).toBe('Updated fact');

      await streamOptions.onToolCall?.(
        'edit_source_passage',
        {
          citation_id: citationId,
          action: 'reclassify',
          kind: 'interesting',
        },
        'call-reclassify-source',
      );
      expect(context.citationRecords.find((citation) => citation.id === citationId)?.kind).toBe('interesting');

      await streamOptions.onToolCall?.(
        'edit_source_passage',
        {
          citation_id: citationId,
          action: 'delete',
        },
        'call-delete-source',
      );
      expect(context.citationRecords.some((citation) => citation.id === citationId)).toBe(false);
    });

    it('rejects chat source passages that are absent from read source content', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      await savePreferenceForTest('toolRiskLevel', 'yolo');

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Garde les sources importantes.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
      };

      const markResult = await streamOptions.onToolCall?.(
        'mark_source_passage',
        {
          title: 'Unsupported fact',
          passage: 'This passage was never present in a read source.',
          kind: 'used',
          source: 'missing.md',
        },
        'call-source',
      );

      expect(String(markResult)).toBe(
        'Error executing tool mark_source_passage: passage is not present in any read source content.',
      );
      expect(context.citationRecords.some((citation) => citation.scope === 'source')).toBe(false);
    });

    it('marks chat source passages from context snippets without loading full content', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      await savePreferenceForTest('toolRiskLevel', 'yolo');

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Garde les sources importantes.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
      };

      context.citationRecords.push(
        {
          id: 'context-snippet',
          type: 'file',
          scope: 'context',
          source: 'notes.md',
          title: 'notes.md',
          snippet: 'Snippet provenance is enough for this passage.',
          messageId: 'context-message',
          conversationId: 'chat-conv',
          timestamp: '2026-03-19T00:00:00.000Z',
          path: 'notes.md',
        },
        {
          id: 'context-extra',
          type: 'file',
          scope: 'context',
          source: 'other.md',
          title: 'other.md',
          snippet: 'Other snippet',
          messageId: 'context-message',
          conversationId: 'chat-conv',
          timestamp: '2026-03-19T00:00:01.000Z',
          path: 'other.md',
        },
      );
      ensureCitationContentLoadedMock.mockClear();

      const markResult = await streamOptions.onToolCall?.(
        'mark_source_passage',
        {
          title: 'Snippet fact',
          passage: 'provenance is enough',
          kind: 'used',
          source: 'notes.md',
        },
        'call-source-snippet',
      );

      expect(String(markResult)).toContain('Source passage marked successfully');
      expect(ensureCitationContentLoadedMock).not.toHaveBeenCalled();
    });

    it('stops loading context citations after the first lazy source passage match', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      await savePreferenceForTest('toolRiskLevel', 'yolo');

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Garde les sources importantes.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
      };

      context.citationRecords.push(
        {
          id: 'context-first',
          type: 'file',
          scope: 'context',
          source: 'first.md',
          title: 'first.md',
          snippet: 'Light preview only',
          messageId: 'context-message',
          conversationId: 'chat-conv',
          timestamp: '2026-03-19T00:00:00.000Z',
          path: 'first.md',
        },
        {
          id: 'context-second',
          type: 'file',
          scope: 'context',
          source: 'second.md',
          title: 'second.md',
          snippet: 'Another preview only',
          messageId: 'context-message',
          conversationId: 'chat-conv',
          timestamp: '2026-03-19T00:00:01.000Z',
          path: 'second.md',
        },
      );
      ensureCitationContentLoadedMock.mockClear();
      ensureCitationContentLoadedMock.mockImplementation(async (id: string) => {
        const citation = context.citationRecords.find((candidate) => candidate.id === id) ?? null;
        if (!citation) return null;
        if (id === 'context-first') {
          citation.content = 'The full body contains the durable passage.';
        }
        return citation;
      });

      const markResult = await streamOptions.onToolCall?.(
        'mark_source_passage',
        {
          title: 'Lazy fact',
          passage: 'durable passage',
          kind: 'used',
          source: 'first.md',
        },
        'call-source-lazy',
      );

      expect(String(markResult)).toContain('Source passage marked successfully');
      expect(ensureCitationContentLoadedMock).toHaveBeenCalledTimes(1);
      expect(ensureCitationContentLoadedMock).toHaveBeenCalledWith('context-first');
    });

    it('limits chat source reads before loading source passage content', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      await savePreferenceForTest('toolRiskLevel', 'yolo');

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Relis les sources.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
      };

      context.citationRecords.push(
        {
          id: 'source-new',
          type: 'source_passage',
          scope: 'source',
          source: 'new.md',
          title: 'Newest source',
          snippet: 'Newest preview',
          messageId: 'assistant-new',
          conversationId: 'chat-conv',
          timestamp: '2026-03-19T00:02:00.000Z',
          kind: 'used',
        },
        {
          id: 'source-old',
          type: 'source_passage',
          scope: 'source',
          source: 'old.md',
          title: 'Old source',
          snippet: 'Old preview',
          messageId: 'assistant-old',
          conversationId: 'chat-conv',
          timestamp: '2026-03-19T00:01:00.000Z',
          kind: 'used',
        },
      );
      ensureCitationContentLoadedMock.mockClear();
      ensureCitationContentLoadedMock.mockImplementation(async (id: string) => {
        const citation = context.citationRecords.find((candidate) => candidate.id === id) ?? null;
        if (citation) {
          citation.content = `Full content for ${citation.title}`;
        }
        return citation;
      });

      const readResult = await streamOptions.onToolCall?.(
        'read_sources',
        { limit: 1 },
        'call-read-limited-sources',
      );

      expect(ensureCitationContentLoadedMock).toHaveBeenCalledTimes(1);
      expect(ensureCitationContentLoadedMock).toHaveBeenCalledWith('source-new');
      expect(String(readResult)).toContain('source-new');
      expect(String(readResult)).not.toContain('source-old');
    });

    it('executes chat web search and fetch tools through the app handler', async () => {
      providerState.selectedSupportsNativeToolCalling = () => true;
      appState.mode = 'Chat';
      appState.selectedGroupId = null;
      appState.selectedProjectId = null;
      await savePreferenceForTest('toolRiskLevel', 'yolo');
      context.streamingWebSearchConfig = {
        enableWebSearch: true,
        enableWebFetch: true,
        webSearchOptions: {
          provider: 'tavily',
          tavilyApiKey: 'tvly-test',
          braveApiKey: '',
          maxResults: 5,
        },
      };

      const { useChatStore } = await loadChatStore();
      useChatStore.setState({
        conversations: [
          {
            id: 'chat-conv',
            title: 'Conversation chat-conv',
            description: '',
            scope_mode: 'Chat',
            task_id: null,
            group_id: null,
            project_id: null,
            last_message: '',
            message_count: 0,
            updated_at: '2026-03-19T00:00:00.000Z',
            is_unread: false,
          },
        ],
        messages: [],
        selectedConversationId: 'chat-conv',
        selectedConversationIdsByMode: { Chat: 'chat-conv' },
        isLoading: false,
        isStreaming: false,
        lastError: null,
        abortController: null,
        messageImagesByMessageId: {},
        composerContextRefs: [],
      });

      await useChatStore.getState().sendMessage({
        conversationId: 'chat-conv',
        content: 'Cherche puis ouvre une page.',
      });

      const streamOptions = ((streamChatMock as unknown as {
        mock: { calls: Array<Array<unknown>> };
      }).mock.calls[0]?.[0] ?? null) as {
        onToolCall?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => Promise<unknown>;
      };

      const searchResult = await streamOptions.onToolCall?.(
        'web_search',
        { query: 'Macro chat sources' },
        'call-web-search',
      );
      expect(webSearchMock).toHaveBeenCalledWith(
        'Macro chat sources',
        context.streamingWebSearchConfig.webSearchOptions,
      );
      expect(String(searchResult)).toContain('Search Result');
      expect(context.citationRecords.some((citation) => citation.url === 'https://example.com/search-result')).toBe(true);

      const fetchResult = await streamOptions.onToolCall?.(
        'web_fetch',
        { url: 'https://example.com/page' },
        'call-web-fetch',
      );
      expect(fetchWebPageMock).toHaveBeenCalledWith('https://example.com/page');
      expect(String(fetchResult)).toContain('Fetched full page content');
      expect(context.citationRecords.some((citation) => citation.content === 'Fetched full page content.')).toBe(true);

      const markResult = await streamOptions.onToolCall?.(
        'mark_source_passage',
        {
          title: 'Fetched page',
          passage: 'Fetched full page content.',
          kind: 'used',
          url: 'https://example.com/page',
        },
        'call-mark-web-source',
      );
      expect(String(markResult)).toContain('Source passage marked successfully');
      expect(
        context.citationRecords.some(
          (citation) =>
            citation.scope === 'source' &&
            citation.title === 'Fetched page' &&
            citation.snippet === 'Fetched full page content.',
        ),
      ).toBe(true);
    });

  });
};
