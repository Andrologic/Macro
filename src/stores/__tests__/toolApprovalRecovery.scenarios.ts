import { describe, expect, it, mock } from 'bun:test';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export const registerToolApprovalRecoveryScenarios = (context: UseChatStoreScenarioContext) => {
  const hasRecovery = () => context.appSettingValues.has('toolApprovalRecovery:v1');
  const prepare = async (recoveryValue?: string) => {
    context.tauriAvailable = true;
    context.appState.mode = 'Chat';
    context.chatSnapshotConversations = [context.createChatSnapshotConversation('recovery-conv', { scope_mode: 'Chat' })];
    const transcript = [{
      id: 'assistant-recovery', conversation_id: 'recovery-conv', role: 'assistant' as const, content: 'Preparing the command.',
      created_at: '2026-09-04T00:00:00.000Z',
      tool_traces_json: JSON.stringify([{ tool_call_id: 'call-recovery', tool_name: 'terminal_run', detail: 'bun test', status: 'pending_approval' }]),
    }];
    context.chatSnapshotMessages = transcript;
    context.appSettingValues.set('toolApprovalRecovery:v1', recoveryValue ?? JSON.stringify({ version: 1, requests: {
      'recovery-conv': { version: 1, conversationId: 'recovery-conv', assistantMessageId: 'assistant-recovery', toolCallId: 'call-recovery' },
    } }));
    const { useChatStore } = await context.loadChatStore();
    await useChatStore.getState().initialize();
    useChatStore.setState({ selectedConversationId: 'recovery-conv' });
    return useChatStore;
  };

  describe('tool approval recovery', () => {
    it.each(['{broken', JSON.stringify({ version: 2, requests: {} })])('preserves unsupported recovery data without blocking chat startup: %s', async (invalid) => {
      const store = await prepare(invalid);
      expect(store.getState().hydrationStatus).toBe('ready');
      expect(store.getState().conversations.some((conversation: { id: string }) => conversation.id === 'recovery-conv')).toBe(true);
      expect(store.getState().toolApprovalRecoveryError).toContain('approvals could not be restored');
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(context.appSettingValues.get('toolApprovalRecovery:v1')).toBe(invalid);
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    });

    it('restores an interrupted request without executing or granting permission', async () => {
      const store = await prepare();
      expect(store.getState().getPendingToolApproval('recovery-conv')).toMatchObject({ recoveryState: 'interrupted', canApproveForConversation: false });
      expect(store.getState().conversationApprovalGrantsByConversationId).toEqual({});
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
      expect(context.streamChatMock).not.toHaveBeenCalled();
      store.getState().denyPendingToolApproval('recovery-conv');
      await context.flushAsyncWork();
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(hasRecovery()).toBe(false);
      expect(context.streamChatMock).not.toHaveBeenCalled();
    });

    it('does not resurrect an approval cancelled while its transcript is loading', async () => {
      const store = await prepare();
      const gate = context.createDeferred();
      context.listMessagesMock.mockImplementationOnce(async () => {
        await gate.promise;
        return context.chatSnapshotMessages;
      });
      const hydration = store.getState().initializeCritical();
      await context.flushAsyncWork();
      store.getState().stopConversationStream('recovery-conv');
      gate.resolve();
      await hydration;
      await context.flushAsyncWork();
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(hasRecovery()).toBe(false);
    });

    it('discards an approval belonging to a completed task during restoration', async () => {
      const store = await prepare();
      context.chatSnapshotConversations = [context.createChatSnapshotConversation('recovery-conv', { scope_mode: 'Implement', task_id: 'completed-task' })];
      context.taskStoreState.tasks = [context.createImplementTask({ id: 'completed-task', status: 'Completed' })];
      await store.getState().initializeCritical();
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(hasRecovery()).toBe(false);
    });

    it('starts one new contextualized turn after explicit resume, without replaying the old tool', async () => {
      const store = await prepare();
      const send = mock(async () => ({ status: 'sent' as const, conversationId: 'recovery-conv', turnId: 'new-turn', userMessageId: 'new-user', assistantMessageId: null }));
      store.setState({ sendMessage: send });
      store.getState().approvePendingToolApprovalOnce('recovery-conv');
      store.getState().approvePendingToolApprovalForConversation('recovery-conv');
      await context.flushAsyncWork();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]).toMatchObject([{ conversationId: 'recovery-conv', contextRefs: [] }]);
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
      expect(hasRecovery()).toBe(false);
    });

    it('keeps a usable recovery action when the new turn is rejected before sending', async () => {
      const store = await prepare();
      store.setState({ sendMessage: mock(async () => { throw new Error('Provider unavailable'); }) });
      store.getState().approvePendingToolApprovalOnce('recovery-conv');
      await context.flushAsyncWork();
      expect(store.getState().getPendingToolApproval('recovery-conv')?.recoveryState).toBe('interrupted');
      expect(hasRecovery()).toBe(true);
      expect(store.getState().lastError).toBe('Provider unavailable');
    });

    it.each(['trace', 'marker'])('keeps recovery durable when %s closure fails, including after reload', async (failure) => {
      const store = await prepare();
      if (failure === 'trace') context.updateMessageMock.mockImplementationOnce(async () => { throw new Error('Trace unavailable'); });
      else context.dbDeleteAppSettingMock.mockImplementationOnce(async () => { throw new Error('Marker unavailable'); });
      store.getState().denyPendingToolApproval('recovery-conv');
      await context.flushAsyncWork();
      expect(store.getState().getPendingToolApproval('recovery-conv')?.recoveryState).toBe('interrupted');
      expect(hasRecovery()).toBe(true);
      if (failure === 'marker') context.chatSnapshotMessages[0].tool_traces_json = JSON.stringify([{ tool_call_id: 'call-recovery', tool_name: 'terminal_run', status: 'denied' }]);
      await store.getState().initializeCritical();
      expect(store.getState().getPendingToolApproval('recovery-conv')?.recoveryState).toBe('interrupted');
      store.getState().denyPendingToolApproval('recovery-conv');
      await context.flushAsyncWork();
      expect(hasRecovery()).toBe(false);
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    });

    it('keeps the marker and action while durable trace closure is in flight', async () => {
      const store = await prepare();
      const gate = context.createDeferred();
      context.updateMessageMock.mockImplementationOnce(async () => { await gate.promise; });
      store.getState().denyPendingToolApproval('recovery-conv');
      await context.flushAsyncWork();
      expect(hasRecovery()).toBe(true);
      expect(store.getState().getPendingToolApproval('recovery-conv')?.recoveryState).toBe('interrupted');
      gate.resolve();
      await context.flushAsyncWork();
      expect(hasRecovery()).toBe(false);
    });

    it('clears interrupted requests when archived and does not restore them on unarchive', async () => {
      const store = await prepare();
      const { useConversationArchiveStore } = await import('../useConversationArchiveStore');
      useConversationArchiveStore.getState().replaceArchivedConversationIds(['recovery-conv']);
      await context.flushAsyncWork();
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(hasRecovery()).toBe(false);
      expect(store.getState().getConversationMessages('recovery-conv')[0].tool_traces?.[0].status).toBe('denied');
      useConversationArchiveStore.getState().replaceArchivedConversationIds([]);
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(context.streamChatMock).not.toHaveBeenCalled();
    });

    it.each(['missing', 'exception'])('retains a recovery action when current project policy is %s', async (failure) => {
      context.scopedTurnConfigurationForTest = {
        projectIds: ['project-1'], focusProjectId: 'project-1', riskLevel: 'balanced', maxTurns: null,
        models: {}, builtInTools: {}, modeTools: {}, allowedMcpServerIds: [], mcpServers: {},
      };
      const { useChatStore, onToolCall } = await context.startImplementToolConversation();
      context.tauriAvailable = true;
      const pending = onToolCall('terminal_run', { command: 'bun test', session_id: 'session-1' }, 'unverifiable-policy');
      await context.flushAsyncWork();
      if (failure === 'missing') context.scopedTurnConfigurationForTest = null;
      else Object.defineProperty(context.scopedTurnConfigurationForTest!, 'riskLevel', { get() { throw new Error('Configuration unavailable'); } });
      useChatStore.getState().approvePendingToolApprovalOnce('implement-conv');
      await expect(pending).rejects.toThrow(failure === 'missing' ? 'could not be verified' : 'Configuration unavailable');
      expect(hasRecovery()).toBe(true);
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.recoveryState).toBe('interrupted');
      expect(useChatStore.getState().conversationApprovalGrantsByConversationId).toEqual({});
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
      useChatStore.getState().denyPendingToolApproval('implement-conv');
      await context.flushAsyncWork();
      expect(hasRecovery()).toBe(false);
    });

    it.each(['opaque-root', 'same-conversation', 'root-extension'])('preserves %s data while accepting and closing a fresh request', async (kind) => {
      const { useChatStore, onToolCall } = await context.startImplementToolConversation();
      context.tauriAvailable = true;
      const opaque = { version: 2, conversationId: 'implement-conv', payload: 'preserve exactly' };
      const original = kind === 'opaque-root' ? '{unreadable' : JSON.stringify({ version: 1,
        extra: 'unknown root field', requests: kind === 'same-conversation' ? { 'implement-conv': opaque } : {},
      });
      context.appSettingValues.set('toolApprovalRecovery:v1', original);
      const pending = onToolCall('terminal_run', { command: 'bun test', session_id: 'session-1' }, 'new-request');
      await context.flushAsyncWork();
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolCallId).toBe('new-request');
      useChatStore.getState().denyPendingToolApproval('implement-conv');
      await pending;
      const saved = JSON.parse(context.appSettingValues.get('toolApprovalRecovery:v1')!);
      expect(saved.requests).toEqual({});
      if (kind === 'opaque-root') expect(saved.preservedData).toEqual([{ valueJson: original }]);
      else {
        expect(saved.extra).toBe('unknown root field');
        if (kind === 'same-conversation') expect(saved.preservedData).toEqual([{ conversationId: 'implement-conv', value: opaque }]);
      }
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    });

    it('preserves marker extensions when abandoning directly and reports preserved data on reload', async () => {
      const original = { version: 1, conversationId: 'recovery-conv', assistantMessageId: 'assistant-recovery', toolCallId: 'call-recovery', extension: { keep: true } };
      const store = await prepare(JSON.stringify({ version: 1, requests: { 'recovery-conv': original } }));
      store.getState().denyPendingToolApproval('recovery-conv');
      await context.flushAsyncWork();
      const saved = JSON.parse(context.appSettingValues.get('toolApprovalRecovery:v1')!);
      expect(saved.requests).toEqual({});
      expect(saved.preservedData).toEqual([{ conversationId: 'recovery-conv', value: original }]);
      await store.getState().initializeCritical();
      expect(store.getState().toolApprovalRecoveryError).toContain('approvals could not be restored');
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
    });

    it('acknowledges a recovery warning without deleting the preserved data', async () => {
      const store = await prepare('{broken');
      store.setState({ lastError: 'Independent provider error' });
      store.getState().dismissToolApprovalRecoveryError();
      expect(store.getState().toolApprovalRecoveryError).toBeNull();
      expect(store.getState().lastError).toBe('Independent provider error');
      expect(context.appSettingValues.get('toolApprovalRecovery:v1')).toBe('{broken');
    });

    it.each([true, false])('retires old waiters during reinitialization and admits a fresh request, restored=%s', async (restore) => {
      const { useChatStore, onToolCall } = await context.startImplementToolConversation();
      context.tauriAvailable = true;
      let oldSettled = false;
      const oldCall = onToolCall('terminal_run', { command: 'old command', session_id: 'session-1' }, 'old-waiter').then((result) => {
        oldSettled = true;
        return result;
      });
      await context.flushAsyncWork();
      const oldApproval = useChatStore.getState().getPendingToolApproval('implement-conv')!;
      expect(oldApproval.toolCallId).toBe('old-waiter');
      context.chatSnapshotConversations = [context.createChatSnapshotConversation('implement-conv', { scope_mode: 'Implement', task_id: 'task-1' })];
      context.chatSnapshotMessages = [{
        id: oldApproval.assistantMessageId, conversation_id: 'implement-conv', role: 'assistant', content: 'Waiting',
        created_at: '2026-09-04T00:00:00Z',
        tool_traces_json: JSON.stringify([{ tool_call_id: 'old-waiter', tool_name: 'terminal_run', status: 'pending_approval' }]),
      }];
      if (!restore) context.appSettingValues.set('toolApprovalRecovery:v1', '{broken');
      await useChatStore.getState().initializeCritical();
      await context.flushAsyncWork();
      expect(oldSettled).toBe(true);
      await oldCall;
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
      if (restore) {
        expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.recoveryState).toBe('interrupted');
        expect(hasRecovery()).toBe(true);
        useChatStore.getState().denyPendingToolApproval('implement-conv');
        await context.flushAsyncWork();
      } else expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toBeNull();
      useChatStore.setState({ selectedConversationId: 'implement-conv' });
      await useChatStore.getState().sendMessage({ conversationId: 'implement-conv', taskId: 'task-1', content: 'Start fresh' });
      const newCall = context.getLatestArchitectToolHandler()('terminal_run', { command: 'fresh command', session_id: 'session-1' }, 'new-waiter');
      await context.flushAsyncWork();
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolCallId).toBe('new-waiter');
      useChatStore.getState().denyPendingToolApproval('implement-conv');
      await newCall;
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    });

    it('drains an approval publication already in flight before hydrating', async () => {
      const { useChatStore, onToolCall } = await context.startImplementToolConversation();
      context.tauriAvailable = true;
      const gate = context.createDeferred();
      context.chatSnapshotConversations = [context.createChatSnapshotConversation('implement-conv', { scope_mode: 'Implement', task_id: 'task-1' })];
      context.updateMessageMock.mockImplementationOnce(async (id, content, options) => {
        await gate.promise;
        context.chatSnapshotMessages = [{ id: id!, conversation_id: 'implement-conv', role: 'assistant', content: content!, created_at: '2026-09-04T00:00:00Z', tool_traces_json: JSON.stringify(options?.toolTraces) }];
      });
      const oldCall = onToolCall('terminal_run', { command: 'old command', session_id: 'session-1' }, 'publishing-request');
      await context.flushAsyncWork();
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toBeNull();
      let ready = false;
      const hydration = useChatStore.getState().initializeCritical().then(() => { ready = true; });
      await context.flushAsyncWork();
      expect(ready).toBe(false);
      gate.resolve();
      await hydration;
      await oldCall;
      expect(useChatStore.getState().hydrationStatus).toBe('ready');
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toMatchObject({ toolCallId: 'publishing-request', recoveryState: 'interrupted' });
      expect(hasRecovery()).toBe(true);
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
      useChatStore.getState().denyPendingToolApproval('implement-conv');
      await context.flushAsyncWork();
    });

    it('persists identifiers before showing approval and removes them before executing', async () => {
      const { useChatStore, onToolCall } = await context.startImplementToolConversation();
      context.tauriAvailable = true;
      const pending = onToolCall('terminal_run', { command: 'secret-value', session_id: 'session-1' }, 'saved-call');
      await context.flushAsyncWork();
      const saved = context.appSettingValues.get('toolApprovalRecovery:v1');
      expect(saved).toContain('saved-call');
      expect(saved).not.toContain('secret-value');
      expect(saved).not.toContain('session-1');
      useChatStore.getState().denyPendingToolApproval('implement-conv');
      await pending;
      expect(hasRecovery()).toBe(false);
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    });

    it('retains future and malformed entries inside a v1 registry during hydration', async () => {
      const opaque = JSON.stringify({ version: 1, requests: {
        future: { version: 2, conversationId: 'future' },
        malformed: { version: 1 },
      } });
      const store = await prepare(opaque);
      expect(store.getState().hydrationStatus).toBe('ready');
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(context.appSettingValues.get('toolApprovalRecovery:v1')).toBe(opaque);
    });

    it('keeps chat available when stale marker cleanup fails', async () => {
      const store = await prepare();
      context.chatSnapshotMessages = [];
      context.dbDeleteAppSettingMock.mockImplementationOnce(async () => { throw new Error('Database cleanup failed'); });
      await store.getState().initializeCritical();
      expect(store.getState().hydrationStatus).toBe('ready');
      expect(store.getState().conversations.length).toBe(1);
      expect(store.getState().toolApprovalRecoveryError).toBe('Database cleanup failed');
      expect(hasRecovery()).toBe(true);
    });

    it('closes the durable pending trace when initial marker creation fails', async () => {
      const { useChatStore, onToolCall } = await context.startImplementToolConversation();
      context.tauriAvailable = true;
      context.dbSetAppSettingMock.mockImplementationOnce(async () => { throw new Error('Marker write failed'); });
      await expect(onToolCall('terminal_run', { command: 'bun test', session_id: 'session-1' }, 'failed-marker')).rejects.toThrow('Marker write failed');
      const updates = context.updateMessageMock.mock.calls;
      expect(updates.flatMap((call) => call[2]?.toolTraces ?? [])).toContainEqual(expect.objectContaining({ tool_call_id: 'failed-marker', status: 'pending_approval' }));
      expect(updates.at(-1)?.[2]?.toolTraces).toContainEqual(expect.objectContaining({ tool_call_id: 'failed-marker', status: 'denied' }));
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')).toBeNull();
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    });

    it.each(['riskLevel', 'builtInTools', 'modeTools'])('revalidates scoped project %s after approval', async (field) => {
      context.scopedTurnConfigurationForTest = {
        projectIds: ['project-1'], focusProjectId: 'project-1', riskLevel: 'balanced', maxTurns: null,
        models: {}, builtInTools: {}, modeTools: {}, allowedMcpServerIds: [], mcpServers: {},
      };
      const { useChatStore, onToolCall } = await context.startImplementToolConversation();
      const pending = onToolCall('terminal_run', { command: 'bun test', session_id: 'session-1' }, 'scoped-policy');
      await context.flushAsyncWork();
      expect(useChatStore.getState().getPendingToolApproval('implement-conv')).not.toBeNull();
      context.scopedTurnConfigurationForTest = { ...context.scopedTurnConfigurationForTest!, [field]: field === 'riskLevel' ? 'strict' : { terminal_run: false } };
      useChatStore.getState().approvePendingToolApprovalOnce('implement-conv');
      expect(String(await pending)).toContain('policy or workspace changed');
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    });

    it.each([false, true])('uses current scoped MCP availability and lease after approval, disabled=%s', async (disabled) => {
      const { services } = await import('../../services');
      const originalConnect = services.mcpRuntimeConnect;
      const originalCatalog = services.mcpRuntimeRefreshCatalog;
      const originalCall = services.mcpRuntimeCallTool;
      let generation = 1;
      const call = mock(async () => ({ content: 'current MCP result', isError: false }));
      services.mcpRuntimeConnect = mock(async (selector) => ({
        key: { serverId: selector.serverId, projectId: null, projectIds: selector.projectIds, configGeneration: generation },
        status: 'ready' as const, updatedAt: '2026-09-04T00:00:00Z',
      }));
      services.mcpRuntimeRefreshCatalog = mock(async (key) => ({ key, tools: [{ id: 'mcp__project_docs__search', serverId: 'project_docs', name: 'search', enabled: true }] }));
      services.mcpRuntimeCallTool = call;
      context.scopedTurnConfigurationForTest = {
        projectIds: ['project-1'], focusProjectId: 'project-1', riskLevel: 'balanced', maxTurns: null,
        models: {}, builtInTools: {}, modeTools: {}, allowedMcpServerIds: ['project_docs'],
        mcpServers: { project_docs: { enabled: true, name: 'Project docs', transport: { type: 'stdio', command: 'project-docs' } } },
      };
      try {
        const { useChatStore, onToolCall } = await context.startImplementToolConversation();
        const pending = onToolCall('mcp__project_docs__search', { query: 'current workspace' }, 'mcp-approval');
        await context.flushAsyncWork();
        expect(useChatStore.getState().getPendingToolApproval('implement-conv')?.toolCallId).toBe('mcp-approval');
        generation = 2;
        if (disabled) context.scopedTurnConfigurationForTest = { ...context.scopedTurnConfigurationForTest!, allowedMcpServerIds: [], mcpServers: {} };
        useChatStore.getState().approvePendingToolApprovalOnce('implement-conv');
        if (disabled) {
          expect(String(await pending)).toContain('policy or workspace changed');
          expect(call).not.toHaveBeenCalled();
        } else {
          expect(String(await pending)).toBe('current MCP result');
          expect(call).toHaveBeenCalledTimes(1);
          expect(call.mock.calls[0]).toMatchObject([{ key: { configGeneration: 2 } }]);
        }
      } finally {
        services.mcpRuntimeConnect = originalConnect;
        services.mcpRuntimeRefreshCatalog = originalCatalog;
        services.mcpRuntimeCallTool = originalCall;
      }
    });

    it('rejects approval when tool policy changes while the request is pending', async () => {
      const { useChatStore, onToolCall } = await context.startImplementToolConversation();
      const pending = onToolCall('terminal_run', { command: 'bun test', session_id: 'session-1' }, 'changing-policy');
      await context.flushAsyncWork();
      await context.savePreferenceForTest('toolRiskLevel', 'strict');
      useChatStore.getState().approvePendingToolApprovalOnce('implement-conv');
      expect(String(await pending)).toContain('policy or workspace changed');
      expect(context.terminalRunCommandFromChatMock).not.toHaveBeenCalled();
    });

    it('deletes the recovery marker with the conversation', async () => {
      const store = await prepare();
      await store.getState().deleteConversation('recovery-conv');
      await context.flushAsyncWork();
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(hasRecovery()).toBe(false);
    });

    it('invalidates a restored request when the conversation is stopped', async () => {
      const store = await prepare();
      store.getState().stopConversationStream('recovery-conv');
      await context.flushAsyncWork();
      expect(store.getState().getPendingToolApproval('recovery-conv')).toBeNull();
      expect(hasRecovery()).toBe(false);
    });
  });
};
