import { describe, expect, it, mock } from 'bun:test';
import type { ChatMessage, ConversationRuntimeState } from '../../types';
import type { ChatPersistenceIpc } from '../chatPersistenceService';
import type { ChatSendPorts, ChatSendSnapshot, SendTask } from './contracts';
import { sendMessage } from './sendMessage';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(mode: ChatSendSnapshot['mode'] = 'Chat') {
  const events: string[] = [];
  const runtimes = new Map<string, ConversationRuntimeState>();
  const sessions = new Map<string, string>();
  const deleted = new Set<string>();
  const published: ChatMessage[] = [];
  const task: SendTask = { task_source: 'standalone', standalone_kind: 'manual_feature', draft: true };
  let launch: { sessionId: string; taskId: string } | undefined;
  let serial = 0;
  const snapshot: ChatSendSnapshot = {
    mode, agentType: mode === 'Implement' ? 'build' : null,
    conversationTaskId: mode === 'Implement' ? 'task-1' : null, selectedTaskId: '',
    composerContextRefs: [], composerRevision: 3,
    architectPlan: mode === 'Architect' ? { planId: 'plan-1', targetBranch: 'develop' } : undefined,
    executionContext: {
      groupId: null, groupName: null, projectIds: ['project-1'], actionableProjectIds: ['project-1'],
      contextProjectIds: [], projectMounts: [], focusedProjectId: 'project-1', virtualRootEnabled: false,
      workspacePathsByProjectId: {}, defaultWorkspacePath: null, projectId: 'project-1',
      projectName: 'Project', taskId: null, branchName: null, workspacePath: null,
    },
    provider: {
      selectedProviderId: 'provider-1', selectedModelId: 'model-1', selectedReasoningEffort: 'high', isLoading: false,
      providerConfigs: [{ id: 'provider-1', name: 'Provider', providerType: 'openai', baseUrl: 'https://example.invalid', hasStoredApiKey: false, isLocal: true, isEnabled: true }],
    },
  };
  const createMessage = mock<ChatPersistenceIpc['createMessage']>(async (id, role, content, options) => {
    events.push(`save:${role}:${id}`);
    return {
      id: `${role}-${++serial}`, conversation_id: id, turn_id: options?.turnId ?? null,
      role, content, created_at: '2026-01-01T00:00:00Z', token_count: null,
      tool_traces_json: null, hidden_context: options?.hiddenContext ?? null,
      provider_input_items_json: options?.providerInputItems ? JSON.stringify(options.providerInputItems) : null,
      provider_turn_state_json: null,
    };
  });
  const deleteAfter = mock(async () => { events.push('delete-after'); });
  // Other persistence operations are outside this use case; fail if accidentally called.
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected persistence operation'); };
  const ports: ChatSendPorts<SendTask, { taskId: string }, { prepared: true }> = {
    owner: {
      read: (id) => runtimes.get(id) ?? { phase: 'idle', sessionId: null },
      set: (id, runtime) => { if (runtime) runtimes.set(id, runtime); else runtimes.delete(id); },
      update: (id, session, updater) => {
        const runtime = runtimes.get(id);
        if (runtime?.sessionId !== session) return false;
        ports.owner.set(id, updater(runtime)); return true;
      },
      latestSession: (id) => sessions.get(id), rememberSession: (id, session) => { sessions.set(id, session); },
      forgetSession: (id) => { sessions.delete(id); },
      transfer: (previous, next, session) => {
        if (sessions.get(previous) !== session || sessions.has(next) || deleted.has(next)) return false;
        sessions.delete(previous); sessions.set(next, session); return true;
      },
    },
    messages: {
      persistence: { isTauriAvailable: () => true, ipc: {
        createMessage, deleteMessagesAfter: deleteAfter, getChatBootstrapSnapshot: unexpected,
        listConversations: unexpected, listMessages: unexpected, updateMessage: unexpected,
        renameConversation: unexpected, deleteConversation: unexpected, deleteConversations: unexpected,
        deleteConversationTurn: unexpected,
      } },
      ensureLoaded: mock(async () => {}), list: (id) => published.filter((message) => message.conversation_id === id),
      hasInterruptedApproval: () => false, clearApprovalRecovery: mock(async () => {}),
    },
    preparation: {
      assertCanSend: () => { if (runtimes.has('conversation-1')) throw new Error('Already running'); },
      isDeleted: (id) => deleted.has(id), createSessionId: () => 'session-1', createTurnId: () => 'turn-1',
      hasPendingArchitectConversation: () => false, materializeArchitectConversation: mock(async (id) => id),
      bindArchitectConversation: mock(async () => true), syncArchitectMetadata: mock(async () => {}),
      generateMetadata: mock(async () => { events.push('metadata'); }),
    },
    configuration: {
      load: mock(async () => null), selectScoped: () => null, hasAuthSession: () => false,
      resolveApiKey: mock(async () => 'secret'), supportsNativeToolCalling: () => true,
    },
    tasks: {
      read: () => task,
      finalizeDraft: mock(async () => { events.push('finalize'); task.draft = false; return { taskId: 'task-1' }; }),
      assertReady: mock(async () => task), assertExecutionContextReady: () => {},
      rollbackDraft: mock(async () => { events.push('rollback'); task.draft = true; }),
      beginLaunch: (params) => { events.push('launch'); launch = params; },
      setLaunchStep: (_id, _session, step) => { events.push(step); },
      completeLaunch: mock(() => { events.push('complete'); }), readLaunch: () => launch,
      failLaunch: mock(() => { events.push('fail'); }),
    },
    projection: {
      persistSelection: mock(() => {}),
      publishUser: mock((message) => { events.push('publish:user'); published.push(message); }),
      publishAssistant: mock((message) => { events.push('publish:assistant'); published.push(message); }),
      clearSecurity: mock(() => {}), approvalRecoveryError: mock(() => {}),
      launchError: mock(() => ({ applied: true })), sendError: mock(() => {}), timeline: () => {},
    },
    stream: {
      prepare: mock(async () => { events.push('prepare'); return { prepared: true as const }; }),
      start: mock(() => { events.push('start'); }),
    },
  };
  const input = { conversationId: 'conversation-1', content: 'Build the feature' };
  const run = () => sendMessage(input, snapshot, ports);
  const stop = () => runtimes.get('conversation-1')?.abortController?.abort();
  return { input, snapshot, ports, run, stop, events, sessions, runtimes, published, deleted, task, createMessage, deleteAfter };
}

describe('sendMessage use case without UI stores', () => {
  it('persists the captured turn and starts with its scoped configuration and context', async () => {
    const f = fixture();
    const scoped = { providerId: 'scoped', modelId: 'scoped-model', reasoningEffort: null } as const;
    f.snapshot.provider.providerConfigs.push({ ...f.snapshot.provider.providerConfigs[0], id: 'scoped', isLocal: false });
    f.ports.configuration.selectScoped = () => scoped;
    const result = await f.run();
    expect(result).toEqual({ status: 'sent', conversationId: 'conversation-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'assistant-2' });
    expect(f.ports.configuration.resolveApiKey).toHaveBeenCalledWith('scoped');
    expect(f.ports.stream.prepare).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'scoped', modelId: 'scoped-model', reasoningEffort: null, executionContext: f.snapshot.executionContext }));
    expect(f.events).toEqual(['save:user:conversation-1', 'publish:user', 'metadata', 'prepare', 'save:assistant:conversation-1', 'publish:assistant', 'start']);
  });

  for (const invalidation of ['abort', 'session', 'turn', 'controller', 'delete'] as const) {
    it(`fences ${invalidation} while loading messages before any persistence`, async () => {
      const f = fixture(); const loading = deferred();
      f.ports.messages.ensureLoaded = () => loading.promise;
      const sending = f.run();
      const runtime = f.runtimes.get('conversation-1')!;
      if (invalidation === 'abort') f.stop();
      if (invalidation === 'session') runtime.sessionId = 'replacement';
      if (invalidation === 'turn') runtime.turnId = 'replacement';
      if (invalidation === 'controller') runtime.abortController = new AbortController();
      if (invalidation === 'delete') f.deleted.add('conversation-1');
      loading.resolve();
      expect((await sending).status).toBe('cancelled');
      expect(f.createMessage).not.toHaveBeenCalled();
      expect(f.ports.stream.start).not.toHaveBeenCalled();
    });
  }

  it('returns sent and publishes the saved user message when stopped during persistence', async () => {
    const f = fixture(); const original = f.createMessage.getMockImplementation()!;
    f.createMessage.mockImplementation(async (...args) => { const message = await original(...args); f.stop(); return message; });
    expect(await f.run()).toEqual({ status: 'sent', conversationId: 'conversation-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: null });
    expect(f.published.map((message) => message.role)).toEqual(['user']);
    expect(f.ports.stream.prepare).not.toHaveBeenCalled();
  });

  for (const replacement of [false, true]) {
    it(`cleans an orphan placeholder only if its session remains latest: replacement=${replacement}`, async () => {
      const f = fixture(); const original = f.createMessage.getMockImplementation()!;
      f.createMessage.mockImplementation(async (...args) => {
        const message = await original(...args);
        if (args[1] === 'assistant') { f.stop(); if (replacement) f.sessions.set('conversation-1', 'new-session'); }
        return message;
      });
      expect((await f.run()).assistantMessageId).toBeNull();
      expect(f.deleteAfter).toHaveBeenCalledTimes(replacement ? 0 : 1);
      expect(f.ports.stream.start).not.toHaveBeenCalled();
    });
  }

  it('publishes the first Implement draft message before finalizing and rolls back launch failure', async () => {
    const f = fixture('Implement');
    f.ports.stream.prepare = async () => { throw new Error('Compaction failed'); };
    await expect(f.run()).rejects.toMatchObject({ message: 'Compaction failed' });
    expect(f.events).toEqual(['save:user:conversation-1', 'publish:user', 'launch', 'finalize', 'starting_agent', 'rollback', 'fail']);
    expect(f.ports.tasks.failLaunch).toHaveBeenCalledWith(expect.objectContaining({ canRetry: true }));
    expect(f.ports.preparation.generateMetadata).not.toHaveBeenCalled();
  });

  it('completes a draft launch without publishing twice or regenerating its metadata', async () => {
    const f = fixture('Implement');
    await f.run();
    expect(f.ports.projection.publishUser).toHaveBeenCalledTimes(1);
    expect(f.ports.tasks.completeLaunch).toHaveBeenCalledWith('conversation-1', 'session-1');
    expect(f.ports.preparation.generateMetadata).not.toHaveBeenCalled();
  });

  it('materializes Architect, transfers ownership and binds before metadata generation', async () => {
    const f = fixture('Architect');
    f.ports.preparation.hasPendingArchitectConversation = () => true;
    f.ports.preparation.materializeArchitectConversation = async () => 'materialized';
    expect((await f.run()).conversationId).toBe('materialized');
    expect(f.runtimes.has('conversation-1')).toBe(false);
    expect(f.sessions.get('materialized')).toBe('session-1');
    expect(f.ports.preparation.bindArchitectConversation).toHaveBeenCalledWith({ architectPlan: f.snapshot.architectPlan, conversationId: 'materialized' });
    expect(f.ports.preparation.syncArchitectMetadata).toHaveBeenCalledWith({ branchName: 'develop', planId: 'plan-1', conversationId: 'materialized', reason: 'metadata_prefix' });
  });

  it('does not overwrite a newer Architect owner after materialization', async () => {
    const f = fixture('Architect');
    f.ports.preparation.hasPendingArchitectConversation = () => true;
    f.ports.preparation.materializeArchitectConversation = async () => 'materialized';
    f.sessions.set('materialized', 'newer');
    f.runtimes.set('materialized', { phase: 'streaming', sessionId: 'newer' });
    expect((await f.run()).status).toBe('cancelled');
    expect(f.runtimes.has('conversation-1')).toBe(false);
    expect(f.runtimes.get('materialized')?.sessionId).toBe('newer');
    expect(f.createMessage).not.toHaveBeenCalled();
  });

  it('continues launch but skips metadata when Architect binding fails', async () => {
    const f = fixture('Architect'); f.ports.preparation.bindArchitectConversation = async () => false;
    expect((await f.run()).status).toBe('sent');
    expect(f.ports.preparation.syncArchitectMetadata).not.toHaveBeenCalled();
    expect(f.ports.preparation.generateMetadata).not.toHaveBeenCalled();
  });

  it('reports interrupted approval cleanup errors while continuing the new turn', async () => {
    const f = fixture(); f.ports.messages.hasInterruptedApproval = () => true;
    f.ports.messages.clearApprovalRecovery = async () => { throw new Error('Recovery write failed'); };
    expect((await f.run()).status).toBe('sent');
    expect(f.ports.projection.approvalRecoveryError).toHaveBeenCalledWith('Recovery write failed');
    expect(f.ports.projection.clearSecurity).toHaveBeenCalledWith('conversation-1');
  });

  it('keeps explicit context references separate from composer revision clearing', async () => {
    const f = fixture();
    await sendMessage({ ...f.input, contextRefs: [], hiddenContext: 'hidden', providerInputItems: [{ item: 1 }] }, f.snapshot, f.ports);
    expect(f.ports.projection.publishUser).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contextRefs: [], clearComposerRevision: undefined }));
    expect(f.createMessage).toHaveBeenCalledWith('conversation-1', 'user', expect.any(String), expect.objectContaining({ hiddenContext: 'hidden', providerInputItems: [{ item: 1 }], turnId: 'turn-1' }));
  });

  it('normalizes persistence failures without launching an assistant', async () => {
    const f = fixture(); f.createMessage.mockRejectedValue(new Error('Disk full'));
    await expect(f.run()).rejects.toMatchObject({ message: 'Failed to save the message before sending: Disk full' });
    expect(f.ports.stream.start).not.toHaveBeenCalled();
    expect(f.published).toHaveLength(0);
  });

  it('propagates launch errors even when a newer session rejects their projection', async () => {
    const f = fixture(); f.ports.stream.prepare = async () => { throw new Error('Provider failed'); };
    f.ports.projection.launchError = () => ({ applied: false });
    await expect(f.run()).rejects.toMatchObject({ message: 'Provider failed' });
  });

  it('returns cancelled for stale preparation errors', async () => {
    const f = fixture(); f.ports.configuration.load = async () => { throw new Error('Stale settings'); };
    f.ports.projection.launchError = () => ({ applied: false });
    expect((await f.run()).status).toBe('cancelled');
  });

  it('keeps the captured provider when the UI changes during hydration', async () => {
    const f = fixture();
    const selected = { ...f.snapshot.provider, providerConfigs: [...f.snapshot.provider.providerConfigs] };
    f.snapshot.provider = { ...selected, providerConfigs: selected.providerConfigs.map((config) => ({ ...config })) };
    const hydration = deferred(); f.ports.messages.ensureLoaded = () => hydration.promise;
    const sending = f.run();
    selected.selectedModelId = 'new-model';
    selected.providerConfigs[0] = { ...selected.providerConfigs[0], isEnabled: false };
    hydration.resolve();
    expect((await sending).status).toBe('sent');
    expect(f.ports.stream.start).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'model-1' }), { prepared: true });
  });

  it('fences cancellation during remote credential resolution', async () => {
    const f = fixture(); f.snapshot.provider.providerConfigs[0].isLocal = false;
    f.ports.configuration.resolveApiKey = async () => { f.stop(); return 'secret'; };
    expect((await f.run()).status).toBe('cancelled');
    expect(f.createMessage).not.toHaveBeenCalled();
  });

  it('stops after draft finalization if its turn was cancelled', async () => {
    const f = fixture('Implement');
    f.ports.tasks.finalizeDraft = async () => { f.stop(); return { taskId: 'task-1' }; };
    expect((await f.run()).status).toBe('cancelled');
    expect(f.ports.tasks.assertReady).not.toHaveBeenCalled();
    expect(f.published.map((message) => message.role)).toEqual(['user']);
    expect(f.ports.stream.start).not.toHaveBeenCalled();
  });

  it('keeps the user message when preparation is superseded before an assistant is created', async () => {
    const f = fixture();
    f.ports.stream.prepare = async () => {
      f.runtimes.set('conversation-1', { phase: 'preparing', sessionId: 'new', turnId: 'new' });
      return { prepared: true };
    };
    expect(await f.run()).toEqual({ status: 'sent', conversationId: 'conversation-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: null });
    expect(f.createMessage).toHaveBeenCalledTimes(1);
    expect(f.ports.stream.start).not.toHaveBeenCalled();
  });

  it('reports provider loading and missing Architect plan before persisting any message', async () => {
    const loading = fixture(); loading.snapshot.provider.isLoading = true;
    await expect(loading.run()).rejects.toMatchObject({ message: 'Provider settings are still loading.' });
    expect(loading.createMessage).not.toHaveBeenCalled();
    const architect = fixture('Architect'); architect.snapshot.architectPlan = undefined;
    await expect(architect.run()).rejects.toMatchObject({ message: 'Select a plan before sending an Architect message.' });
    expect(architect.createMessage).not.toHaveBeenCalled();
  });

  it('rolls back a finalized draft if assistant persistence fails', async () => {
    const f = fixture('Implement'); const original = f.createMessage.getMockImplementation()!;
    f.createMessage.mockImplementation(async (...args) => {
      if (args[1] === 'assistant') throw new Error('Assistant write failed');
      return original(...args);
    });
    await expect(f.run()).rejects.toMatchObject({ message: 'Failed to create the assistant message before streaming: Assistant write failed' });
    expect(f.ports.tasks.rollbackDraft).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(f.ports.stream.start).not.toHaveBeenCalled();
    expect(f.published.map((message) => message.role)).toEqual(['user']);
  });

  it('rejects unavailable conversations without claiming ownership', async () => {
    const f = fixture(); f.ports.preparation.assertCanSend = () => { throw new Error('Conversation deleted'); };
    await expect(f.run()).rejects.toMatchObject({ message: 'Conversation deleted' });
    expect(f.sessions.size).toBe(0);
    expect(f.ports.projection.sendError).toHaveBeenCalledWith('Conversation deleted');
    expect(f.createMessage).not.toHaveBeenCalled();
  });

});
