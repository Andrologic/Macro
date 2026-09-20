import { chatSendFixture as fixture } from "../../test-utils/chatSendFixture";
import { describe, expect, it } from 'bun:test';
import type { ChatPersistenceIpc } from '../chatPersistenceService';
import { sendMessage } from './sendMessage';
import { createChatTurnRuntime } from '../chatTurnRuntime';
import { EMPTY_CONVERSATION_RUNTIME } from '../../domains/chat/runtimeState';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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

  for (const invalidation of ['abort', 'owner'] as const) {
    it(`keeps the first draft message but skips launch after ${invalidation} during saveUser`, async () => {
      const f = fixture('Implement'); const original = f.createMessage.getMockImplementation()!;
      f.createMessage.mockImplementation(async (...args) => {
        const message = await original(...args);
        if (invalidation === 'abort') f.stop();
        else f.runtimes.set('conversation-1', { phase: 'preparing', sessionId: 'replacement', turnId: 'replacement' });
        return message;
      });
      expect(await f.run()).toEqual({ status: 'sent', conversationId: 'conversation-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: null });
      expect(f.published.map((message) => message.role)).toEqual(['user']);
      expect(f.ports.tasks.beginLaunch).not.toHaveBeenCalled();
      expect(f.ports.tasks.finalizeDraft).not.toHaveBeenCalled();
      expect(f.ports.tasks.rollbackDraft).not.toHaveBeenCalled();
      expect(f.ports.tasks.assertReady).not.toHaveBeenCalled();
      expect(f.ports.stream.start).not.toHaveBeenCalled();
    });
  }

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

  for (const phase of ['bind', 'sync'] as const) {
    it(`keeps the published Architect message and skips later metadata effects when ${phase} is stopped`, async () => {
      const f = fixture('Architect');
      const entered = deferred();
      const release = deferred();
      if (phase === 'bind') {
        f.ports.preparation.bindArchitectConversation = async () => {
          entered.resolve(); await release.promise; return true;
        };
      } else {
        f.ports.preparation.syncArchitectMetadata = async () => {
          entered.resolve(); await release.promise;
        };
      }
      const sending = f.run();
      await entered.promise;
      f.stop();
      release.resolve();
      expect(await sending).toEqual({ status: 'sent', conversationId: 'conversation-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: null });
      expect(f.published.map((message) => message.role)).toEqual(['user']);
      expect(f.ports.preparation.generateMetadata).not.toHaveBeenCalled();
      expect(f.ports.stream.prepare).not.toHaveBeenCalled();
      if (phase === 'bind') expect(f.ports.preparation.syncArchitectMetadata).not.toHaveBeenCalled();
    });
  }

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

it('a stale assistant write failure must not revert the successor task', async () => {
  const f = fixture('Implement');
  const owner = createChatTurnRuntime({ state: {
    read: id => f.runtimes.get(id) ?? EMPTY_CONVERSATION_RUNTIME,
    project: (id, state) => { if (state) f.runtimes.set(id, state); else f.runtimes.delete(id); },
    isDeleted: () => false,
  }, cancelTransport: () => {}, settled: () => {} });
  f.ports.owner = owner;
  f.ports.preparation.assertCanSend = id => owner.assertCanSend(id, { available: true, hasUnsavedResponse: false });
  let session = 0, turn = 0;
  f.ports.preparation.createSessionId = () => `session-${++session}`;
  f.ports.preparation.createTurnId = () => `turn-${++turn}`;
  const oldWrite = deferred<Awaited<ReturnType<ChatPersistenceIpc['createMessage']>>>();
  const original = f.createMessage.getMockImplementation()!;
  let assistantWrites = 0;
  f.createMessage.mockImplementation((...args) => args[1] === 'assistant' && ++assistantWrites === 1 ? oldWrite.promise : original(...args));
  f.ports.stream.start = request => {
    owner.claimStream({ conversationId: request.conversationId, sessionId: request.sessionId,
      turnId: request.assistantMessage.turn_id!, assistantMessageId: request.assistantMessage.id }, request.abortController!);
  };
  const oldSend = f.run();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.task.draft).toBe(false);
  expect(assistantWrites).toBe(1);
  owner.stop('conversation-1');
  const successor = await f.run();
  expect(successor.status).toBe('sent');
  expect(owner.read('conversation-1')).toMatchObject({ phase: 'streaming', sessionId: 'session-2' });
  oldWrite.reject(new Error('late disk failure'));
  await oldSend;
  expect(f.ports.tasks.rollbackDraft).not.toHaveBeenCalled();
  expect(f.task.draft).toBe(false);
});
