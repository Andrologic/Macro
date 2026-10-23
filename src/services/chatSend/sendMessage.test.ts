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
  it('pins a deferred model while loading current policies and credentials', async () => {
    const f = fixture();
    f.snapshot.modelSelectionCaptured = true;
    f.snapshot.provider.providerConfigs[0].isLocal = false;
    f.ports.configuration.selectScoped = () => ({ providerId: 'changed', modelId: 'changed', reasoningEffort: null });
    await sendMessage({ ...f.input, submissionTurnId: 'accepted-turn' }, f.snapshot, f.ports);
    expect(f.createMessage.mock.calls[0]?.[3]?.turnId).toBe('accepted-turn');
    expect(f.ports.configuration.load).toHaveBeenCalled();
    expect(f.ports.configuration.resolveApiKey).toHaveBeenCalledWith('provider-1');
    expect(f.ports.stream.prepare).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'provider-1', modelId: 'model-1' }));
  });

  it('acknowledges durable user persistence even if assistant preparation fails', async () => {
    const f = fixture();
    let accepted = '';
    f.ports.messages.onUserPersisted = message => { accepted = message.turn_id!; };
    f.ports.stream.prepare = async () => { throw new Error('preparation failure'); };
    await expect(sendMessage({ ...f.input, submissionTurnId: 'accepted-turn' }, f.snapshot, f.ports)).rejects.toMatchObject({ message: 'preparation failure' });
    expect(accepted).toBe('accepted-turn');
    expect(f.createMessage.mock.calls.filter(call => call[1] === 'user')).toHaveLength(1);
  });

  it('retains a saved message when preparation fails and resumes it without another user write', async () => {
    const f = fixture();
    const prepare = f.ports.stream.prepare;
    f.ports.stream.prepare = async () => { throw new Error('preparation failure'); };
    await expect(f.run()).rejects.toMatchObject({ message: 'preparation failure' });
    const saved = f.published.find(message => message.role === 'user')!;
    f.ports.stream.prepare = prepare;
    f.runtimes.clear();
    const result = await sendMessage({ ...f.input, submissionTurnId: saved.turn_id!, persistedUserMessage: saved }, f.snapshot, f.ports);
    expect(result.assistantMessageId).not.toBeNull();
    expect(f.createMessage.mock.calls.filter(call => call[1] === 'user')).toHaveLength(1);
    expect(f.ports.stream.start).toHaveBeenCalledTimes(1);
  });

  it('reuses the durable message identity for images when resuming after preparation failure', async () => {
    const f = fixture();
    const image = { id: 'qa-image', createdAt: '2026-10-04T00:00:00Z', dataUrl: 'data:image/png;base64,cWE=', mimeType: 'image/png' };
    const savedImageIds: string[] = [];
    f.ports.messages.saveImages = id => { savedImageIds.push(id); };
    const original = f.createMessage.getMockImplementation()!;
    f.createMessage.mockImplementation(async (...args) => {
      const message = await original(...args);
      return { ...message, id: args[3]?.id ?? message.id };
    });
    const prepare = f.ports.stream.prepare;
    f.ports.stream.prepare = async () => { throw new Error('preparation failure'); };
    await expect(sendMessage({ ...f.input, images: [image] }, f.snapshot, f.ports)).rejects.toMatchObject({ message: 'preparation failure' });
    const saved = f.published.find(message => message.role === 'user')!;
    f.ports.stream.prepare = prepare;
    f.runtimes.clear();
    await sendMessage({ ...f.input, images: [image], submissionTurnId: saved.turn_id!, persistedUserMessage: saved }, f.snapshot, f.ports);
    expect(savedImageIds).toEqual([saved.id, saved.id]);
    expect(f.createMessage.mock.calls.filter(call => call[1] === 'user')).toHaveLength(1);
    expect(f.ports.stream.start).toHaveBeenCalledTimes(1);
  });

  it('retains recovery when a handoff observer stops the turn before the assistant starts', async () => {
    const f = fixture();
    let acknowledged = false;
    f.ports.messages.beforeAssistantStart = () => f.stop();
    f.ports.messages.onAssistantStarted = () => { acknowledged = true; };
    expect((await f.run()).assistantMessageId).toBeNull();
    expect(f.ports.stream.start).not.toHaveBeenCalled();
    expect(acknowledged).toBe(false);
  });

  it('does not start an assistant when the durable handoff marker cannot be saved', async () => {
    const f = fixture();
    f.ports.messages.beforeAssistantStart = () => { throw new Error('handoff storage unavailable'); };
    await expect(f.run()).rejects.toMatchObject({ message: 'handoff storage unavailable' });
    expect(f.ports.stream.start).not.toHaveBeenCalled();
    expect(f.createMessage.mock.calls.filter(call => call[1] === 'user')).toHaveLength(1);
  });

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

  it('returns cancelled before persistence when configuration outlives its send lease', async () => {
    const f = fixture('Implement');
    const started = deferred();
    const configuration = deferred<null>();
    const timeline: string[] = [];
    f.ports.projection.timeline = phase => { timeline.push(phase); };
    f.ports.configuration.load = async () => { started.resolve(); return configuration.promise; };
    const sending = f.run();
    await started.promise;
    const original = f.runtimes.get('conversation-1')!;
    f.runtimes.set('conversation-1', { ...original, sessionId: 'successor' });
    configuration.resolve(null);
    expect((await sending).status).toBe('cancelled');
    expect(timeline).toEqual(['send_requested', 'messages_ready']);
    expect(f.ports.tasks.assertReady).not.toHaveBeenCalled();
    expect(f.ports.projection.launchError).not.toHaveBeenCalled();
    expect(f.createMessage).not.toHaveBeenCalled();
    expect(f.ports.stream.start).not.toHaveBeenCalled();
  });

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

  it('persists resolved conversation passages from the captured composer snapshot', async () => {
    const f = fixture();
    f.snapshot.composerContextRefs = [{
      id: 'source-conv', conversationId: 'source-conv', kind: 'conversation',
      title: 'Earlier discussion', snippet: '[message_id=source-msg] Review every release.',
      sourceUpdatedAt: '2026-09-28T12:00:00Z',
    }];
    await sendMessage(f.input, f.snapshot, f.ports);
    expect(f.createMessage.mock.calls[0]?.[3]?.contextRefs).toEqual(f.snapshot.composerContextRefs);
    expect(f.ports.projection.publishUser).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      contextRefs: f.snapshot.composerContextRefs, clearComposerRevision: 3,
    }));
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

const image = { id: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQID', createdAt: '2026-10-02T00:00:00Z' };
for (const mode of ['Chat', 'Implement'] as const) {
  it(`${mode} image failure occurs before durable text, acknowledgement and launch`, async () => {
    const f = fixture(mode);
    f.ports.messages.saveImages = () => { throw new Error('quota'); };
    await expect(sendMessage({ ...f.input, images: [image] }, f.snapshot, f.ports)).rejects.toMatchObject({ message: 'quota' });
    expect(f.createMessage).not.toHaveBeenCalled();
    expect(f.ports.projection.publishUser).not.toHaveBeenCalled();
    expect(f.ports.stream.start).not.toHaveBeenCalled();
    expect(f.ports.tasks.finalizeDraft).not.toHaveBeenCalled();
  });
}
it('checks image persistence before text and does not write images again after text is durable', async () => {
  const f = fixture();
  let imageId = '';
  const original = f.createMessage.getMockImplementation()!;
  f.ports.messages.saveImages = id => {
    expect(f.createMessage).not.toHaveBeenCalled();
    imageId = id;
  };
  f.createMessage.mockImplementation(async (...args) => {
    if (args[1] === 'user') expect(args[3]?.id).toBe(imageId);
    const saved = await original(...args);
    // Storage becomes unavailable after the text commit. There must be no
    // fallible image write in publication or before starting the provider.
    f.ports.messages.saveImages = () => { throw new Error('late quota'); };
    return saved;
  });
  expect((await sendMessage({ ...f.input, images: [image] }, f.snapshot, f.ports)).status).toBe('sent');
  expect(imageId).not.toBe('');
  expect(f.ports.stream.start).toHaveBeenCalledTimes(1);
});
it('stop during image saving keeps the draft unaccepted and starts no text write', async () => {
  const f = fixture();
  f.ports.messages.saveImages = () => f.stop();
  expect((await sendMessage({ ...f.input, images: [image] }, f.snapshot, f.ports)).status).toBe('cancelled');
  expect(f.createMessage).not.toHaveBeenCalled();
  expect(f.ports.projection.publishUser).not.toHaveBeenCalled();
  expect(f.ports.stream.start).not.toHaveBeenCalled();
});

it('stop after saving image and text acknowledges that message without a second write or provider start', async () => {
  const f = fixture();
  const original = f.createMessage.getMockImplementation()!;
  let imageId = '';
  f.ports.messages.saveImages = id => { imageId = id; };
  f.createMessage.mockImplementation(async (...args) => {
    const message = await original(...args);
    f.stop();
    return message;
  });
  const result = await sendMessage({ ...f.input, images: [image] }, f.snapshot, f.ports);
  expect(imageId).not.toBe('');
  expect(result).toMatchObject({ status: 'sent', assistantMessageId: null });
  expect(f.createMessage).toHaveBeenCalledTimes(1);
  expect(f.ports.projection.publishUser).toHaveBeenCalledTimes(1);
  expect(f.ports.stream.start).not.toHaveBeenCalled();
});


describe('Pilot attachment durable launch guards', () => {
  it('awaits a preparation marker before any provider preparation', async () => {
    const f = fixture();
    const marker = deferred();
    f.ports.preparation.authorizePilotEffect = async () => {};
    const sending = sendMessage({ ...f.input, pilotTarget: { mode: 'Chat', actionToken: Symbol(),
      beforeAssistantPrepare: () => marker.promise } }, f.snapshot, f.ports);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(f.ports.stream.prepare).not.toHaveBeenCalled();
    marker.resolve();
    await sending;
    expect(f.ports.stream.prepare).toHaveBeenCalledTimes(1);
  });

  it('rechecks asynchronous authorization before starting a prepared assistant', async () => {
    const f = fixture();
    let afterMarker = false;
    f.ports.messages.beforeAssistantStart = async () => { afterMarker = true; };
    f.ports.preparation.authorizePilotEffect = async () => { if (afterMarker) f.stop(); };
    const result = await sendMessage({ ...f.input, pilotTarget: { mode: 'Chat', actionToken: Symbol() } }, f.snapshot, f.ports);
    expect(result.assistantMessageId).toBeNull();
    expect(f.ports.stream.start).not.toHaveBeenCalled();
  });

  it('rejects a different scoped model before user persistence', async () => {
    const f = fixture('Implement');
    f.ports.preparation.authorizePilotEffect = async () => {};
    f.ports.configuration.selectScoped = () => ({ providerId: 'provider-1', modelId: 'changed-model', reasoningEffort: 'high' });
    await expect(sendMessage({ ...f.input, pilotTarget: { taskId: 'task-1', actionToken: Symbol(),
      expectedModel: { providerId: 'provider-1', modelId: 'model-1', reasoningEffort: 'high' } } }, f.snapshot, f.ports))
      .rejects.toMatchObject({ message: 'The model changed before sending.' });
    expect(f.createMessage).not.toHaveBeenCalled();
  });
});

it('hands a questionnaire to the admitted turn only after the human answer is durable', async () => {
  const f = fixture('Chat');
  const context = { handle: 'new-parent', runtime: 'browser' };
  const receipt = { operationId: 'question', runtime: 'browser', revision: 0,
    identity: { conversationId: f.input.conversationId, kind: 'question' as const, id: 'question-message' } };
  const entered = deferred();
  const handoff = deferred();
  f.ports.admission.begin = async () => ({ kind: 'globalChat', context });
  f.ports.admission.closePreparation = async () => {};
  f.ports.admission.handoffQuestion = async (actual, conversation, response, captured) => {
    expect(actual).toEqual(context);
    expect(conversation).toBe(f.input.conversationId);
    expect(response).toBeTruthy();
    expect(captured).toEqual(receipt);
    expect(f.createMessage.mock.calls.filter(call => call[1] === 'user')).toHaveLength(1);
    entered.resolve();
    await handoff.promise;
  };
  const sending = sendMessage({ ...f.input, questionIntent: receipt }, f.snapshot, f.ports);
  await entered.promise;
  expect(f.ports.stream.start).not.toHaveBeenCalled();
  handoff.resolve();
  await sending;
  expect(f.ports.stream.start).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.createMessage.mock.calls)).not.toContain('new-parent');
});

it('retains a questionnaire handoff failure without starting the provider', async () => {
  const f = fixture('Chat');
  const receipt = { operationId: 'question', runtime: 'browser', revision: 0,
    identity: { conversationId: f.input.conversationId, kind: 'question' as const, id: 'question-message' } };
  f.ports.admission.begin = async () => ({ kind: 'globalChat', context: { handle: 'parent', runtime: 'browser' } });
  f.ports.admission.closePreparation = async () => {};
  f.ports.admission.handoffQuestion = async () => { throw new Error('Question receipt unavailable'); };
  await expect(sendMessage({ ...f.input, questionIntent: receipt }, f.snapshot, f.ports)).rejects.toMatchObject({ message: 'Question receipt unavailable' });
  expect(f.ports.stream.start).not.toHaveBeenCalled();
});

it('keeps metadata under the captured parent even when main preparation fails', async () => {
  const f = fixture();
  const metadata = deferred<void>();
  const started = deferred<void>();
  const context = { handle: 'metadata-parent', runtime: 'browser' };
  f.ports.admission.begin = async () => ({ kind: 'globalChat', context });
  f.ports.admission.closePreparation = async (received) => { expect(received).toEqual(context); f.events.push('closed'); };
  f.ports.preparation.generateMetadata = async params => {
    expect(params.providerAdmission).toEqual({ kind: 'globalChat', context });
    expect(params.signal).toBeInstanceOf(AbortSignal);
    started.resolve();
    await metadata.promise;
  };
  f.ports.stream.prepare = async () => { throw new Error('Synthetic main preparation failure'); };
  const sending = f.run().then(() => null, error => error);
  await started.promise;
  await Promise.resolve();
  expect(f.events).not.toContain('closed');
  metadata.resolve();
  expect(await sending).toMatchObject({ message: 'Synthetic main preparation failure' });
  expect(f.events).toContain('closed');
});
