import { describe, expect, it, mock } from 'bun:test';
import type { AIModel, ChatMessage, Conversation } from '../../types';
import { chatSendFixture } from '../../test-utils/chatSendFixture';
import { sendMessage } from '../chatSend/sendMessage';
import type { ChatSendInput, SendImage } from '../chatSend/contracts';
import type { ContentAttachmentSendReceipt, ContentConversationRef } from './contentProtocol';
import { createDesktopAttachmentSend, desktopAttachmentImageSupport, type DesktopAttachmentSendNativePorts, type DesktopAttachmentSendOptions, type DesktopAttachmentSendBody, type DesktopAttachmentTarget } from './desktopAttachmentSend';
import type { DesktopStorePorts } from './desktopStorePorts';

const date = '2026-10-12T00:00:00Z';
const ref: ContentConversationRef = { instance_id: 'instance-fixture', kind: 'conversation', conversation_id: 'conversation-1' };
const image: SendImage = { id: 'attachment-image', mimeType: 'image/png', createdAt: date, dataUrl: 'data:image/png;base64,AQID' };

function fixture(mode: 'Chat' | 'Implement' = 'Chat') {
  const f = chatSendFixture(mode);
  f.task.draft = false;
  const events: string[] = [];
  const target: DesktopAttachmentTarget = mode === 'Chat' ? { mode, conversationId: 'conversation-1' }
    : { mode, conversationId: 'conversation-1', taskId: 'branch-qualified:task-1' };
  const conversation: Conversation = {
    id: 'conversation-1', scope_mode: mode, task_id: target.taskId ?? null, title: 'Synthetic conversation',
    project_id: null, provider_id: 'provider-1', model_id: 'model-1', reasoning_effort: 'high',
    last_message: '', message_count: 0, updated_at: date, is_unread: false,
  };
  const model: AIModel = { id: 'model-1', provider_id: 'provider-1', name: 'Synthetic image model', capabilities: ['vision'], isEnabled: true };
  const provider = f.snapshot.provider.providerConfigs[0];
  const providers = { providerConfigs: [provider], modelsByProvider: { 'provider-1': [model] }, isLoading: false };
  let archived = false;
  let revoked = false;
  let receipt: ContentAttachmentSendReceipt | null = null;
  let acceptedDigest: string | undefined;
  const body: DesktopAttachmentSendBody = {
    ref, intent_id: 'intent-fixture', intent_expires_at: '2026-10-12T00:10:00Z', expected_revision: 7,
    content: '', attachment_ids: ['attachment-image', 'attachment-text'],
  };
  const refs = [{ id: 'attachment-text', kind: 'file' as const, title: 'fixture.txt', path: 'attachment://fixture/fixture.txt' }];
  const saved: ChatMessage = {
    id: 'native-user', conversation_id: 'conversation-1', turn_id: 'native-turn', role: 'user',
    content: '', context_refs: refs, timestamp: date, task_id: target.taskId ?? '',
  };
  type Native = DesktopAttachmentSendNativePorts<{ authority: string }>;
  const native = {
    status: mock<Native['status']>(async () => receipt && structuredClone(receipt)),
    inspectAttachments: mock<Native['inspectAttachments']>(async () => [{ id: 'attachment-image', mimeType: 'image/png' }, { id: 'attachment-text', mimeType: 'text/plain' }]),
    prepareSend: mock<Native['prepareSend']>(async (_scope, _intent, content, ids, revision, _deadline, intentExpiresAt) => {
      const digest = JSON.stringify([content, ids, revision, intentExpiresAt]);
      if (receipt) {
        if (acceptedDigest !== digest) throw new Error('integrity_failed');
        return { persistedUserMessage: saved, images: [image], nativeSendReceipt: structuredClone(receipt) };
      }
      acceptedDigest = digest;
      events.push('native-persist');
      receipt = { ref, intent_id: body.intent_id, state: 'message_persisted', user_message_id: saved.id,
        assistant_message_id: null, attachment_ids: body.attachment_ids, context_state: 'ready' };
      return { persistedUserMessage: saved, images: [image], nativeSendReceipt: structuredClone(receipt) };
    }),
    markLaunchUncertain: mock<Native['markLaunchUncertain']>(async (_scope, _intent, _user, assistant) => {
      if (receipt?.state !== 'message_persisted') throw new Error('conflict');
      events.push('native-uncertain');
      receipt = { ...receipt, state: 'launch_uncertain', assistant_message_id: assistant };
      return structuredClone(receipt);
    }),
    confirmLaunch: mock<Native['confirmLaunch']>(async (_scope, _intent, _user, assistant) => {
      events.push('native-confirmed');
      receipt = { ...receipt!, state: 'confirmed', assistant_message_id: assistant };
      return structuredClone(receipt);
    }),
  };
  let sendInput: ChatSendInput | undefined;
  const chat = {
    conversations: [conversation], getConversationRuntime: () => f.runtimes.get('conversation-1') ?? { phase: 'idle' },
    getActiveQuestionnaire: () => null, getPendingToolApproval: () => null,
    sendMessage: mock(async (input: ChatSendInput) => {
      events.push('store-send');
      sendInput = input;
      f.snapshot.conversationTaskId = target.taskId ?? null;
      f.ports.preparation.authorizePilotEffect = async () => { await input.pilotTarget?.beforeEffect?.(); };
      f.ports.messages.beforeAssistantStart = input.pilotTarget?.beforeAssistantStart;
      f.ports.messages.onAssistantStarted = input.pilotTarget?.onAssistantStarted;
      f.ports.messages.saveImages = (id, images) => { events.push(`images:${id}:${images.length}`); };
      return sendMessage(input, f.snapshot, f.ports);
    }),
  };
  const task = { id: target.taskId, status: 'InProgress', project_id: '', draft: false, archived_at: null, execution_targets: [], is_blocked: false };
  const stores = {
    chat: () => chat, providers: () => providers,
    app: () => ({ standaloneProjects: [], projectGroups: [] }),
    tasks: () => ({ tasks: mode === 'Implement' ? [task] : [], getTaskById: (id: string) => id === task.id ? task : undefined, branchWorktrees: {} }),
  } as unknown as DesktopStorePorts;
  const options: DesktopAttachmentSendOptions<{ authority: string }> = {
    stores, native, resolveTarget: () => target, now: () => Date.parse(date),
    isConversationArchived: () => archived,
    hydrateContext: mock(async () => { events.push('hydrate-citations'); }),
    loadConfiguration: mock(async () => null),
  };
  const guard = {
    assertCurrent: () => { if (revoked) throw new Error('forbidden'); },
    authorizeBeforeEffect: mock(async () => { if (revoked) throw new Error('forbidden'); }),
  };
  const scope = { authority: 'current-authority' };
  const service = () => createDesktopAttachmentSend(options);
  return { f, body, saved, model, provider, providers, conversation, task, target, chat, native, options, guard, scope, events,
    service, send: () => service().send(scope, body, body.intent_expires_at, guard),
    receipt: () => receipt, setReceipt: (value: ContentAttachmentSendReceipt) => { receipt = value; },
    input: () => sendInput, archive: () => { archived = true; }, revoke: () => { revoked = true; } };
}

describe('desktop attachment send bridge', () => {
  for (const mode of ['Chat', 'Implement'] as const) {
    it(`${mode} reuses native identity, images and persisted file references`, async () => {
      const f = fixture(mode);
      const result = await f.send();
      expect(result.state).toBe('confirmed');
      expect(f.input()).toMatchObject({ submissionTurnId: 'native-turn', persistedUserMessage: f.saved,
        images: [image], contextRefs: f.saved.context_refs, content: '' });
      expect(f.f.createMessage.mock.calls.filter(call => call[1] === 'user')).toHaveLength(0);
      expect(f.f.ports.stream.prepare).toHaveBeenCalledWith(expect.objectContaining({ replyToMessageId: 'native-user', modeAtSend: mode }));
      expect(f.events).toEqual(['native-persist', 'hydrate-citations', 'store-send', 'images:native-user:1', 'native-uncertain', 'native-confirmed']);
      expect(f.f.events.indexOf('prepare')).toBeGreaterThan(-1);
      expect(f.native.markLaunchUncertain.mock.calls[0]?.[3]).toBeNull();
      if (mode === 'Implement') expect(f.input()?.pilotTarget).toMatchObject({ taskId: 'branch-qualified:task-1' });
    });
  }

  for (const capabilities of [undefined, [], ['text']] as const) {
    it(`rejects missing or text-only image capabilities before native persistence: ${String(capabilities)}`, async () => {
      const f = fixture();
      f.model.capabilities = capabilities ? [...capabilities] : undefined;
      await expect(f.send()).rejects.toMatchObject({ code: 'unsupported_model' });
      expect(f.native.prepareSend).not.toHaveBeenCalled();
      expect(f.chat.sendMessage).not.toHaveBeenCalled();
    });
  }

  it('allows text attachments with an unknown model and hydrates native context first', async () => {
    const f = fixture();
    f.model.capabilities = undefined;
    f.body.attachment_ids = ['attachment-text'];
    f.body.content = 'Read the attached text';
    f.saved.content = f.body.content;
    f.native.inspectAttachments = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['inspectAttachments']>(async () => [{ id: 'attachment-text', mimeType: 'text/plain' }]);
    const prepare = f.native.prepareSend;
    f.native.prepareSend = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['prepareSend']>(async (...args) => ({ ...await prepare(...args), images: [] }));
    expect((await f.send()).state).toBe('confirmed');
    expect(f.events.indexOf('hydrate-citations')).toBeLessThan(f.events.indexOf('store-send'));
  });

  it('refuses a capability from a model belonging to another provider', () => {
    const f = fixture();
    expect(desktopAttachmentImageSupport(f.provider, { ...f.model, provider_id: 'other-provider' })).toBe('unknown');
  });

  for (const state of ['launch_uncertain', 'confirmed'] as const) {
    it(`returns ${state} after a service restart without another message or launch`, async () => {
      const f = fixture();
      const prepared = await f.native.prepareSend(f.scope, f.body.intent_id, '', f.body.attachment_ids, 7, f.body.intent_expires_at, f.body.intent_expires_at);
      f.setReceipt({ ...prepared.nativeSendReceipt, state });
      f.native.prepareSend.mockClear();
      f.options.now = () => Date.parse('2026-10-13T00:00:00Z');
      f.model.capabilities = undefined;
      f.archive();
      expect((await f.send()).state).toBe(state);
      expect(f.native.prepareSend).toHaveBeenCalledTimes(1);
      expect(f.chat.sendMessage).not.toHaveBeenCalled();
      expect(f.native.markLaunchUncertain).not.toHaveBeenCalled();
    });
  }

  it('resumes after a lost prepare ACK without allocating another user message', async () => {
    const f = fixture();
    const prepare = f.native.prepareSend;
    f.native.prepareSend = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['prepareSend']>(async (...args) => { const prepared = await prepare(...args); if (!f.native.prepareSend.mock.calls.slice(0, -1).length) throw new Error('lost prepare ACK'); return prepared; });
    await expect(f.send()).rejects.toThrow('lost prepare ACK');
    expect((await f.send()).state).toBe('confirmed');
    expect(f.native.prepareSend).toHaveBeenCalledTimes(2);
    expect(f.f.ports.stream.start).toHaveBeenCalledTimes(1);
    expect(f.events.filter(event => event === 'native-persist')).toHaveLength(1);
  });

  it('does not prepare or launch when the durable uncertain marker fails', async () => {
    const f = fixture();
    f.native.markLaunchUncertain = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['markLaunchUncertain']>(async () => { throw new Error('marker unavailable'); });
    await expect(f.send()).rejects.toMatchObject({ message: 'marker unavailable' });
    expect(f.f.ports.stream.prepare).not.toHaveBeenCalled();
    expect(f.f.ports.stream.start).not.toHaveBeenCalled();
    f.native.markLaunchUncertain = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['markLaunchUncertain']>(async (_scope, _intent, _user, assistant) => {
      const receipt = { ...f.receipt()!, state: 'launch_uncertain' as const, assistant_message_id: assistant };
      f.setReceipt(receipt); return receipt;
    });
    f.f.runtimes.clear();
    expect((await f.send()).state).toBe('confirmed');
  });

  it('resumes a persisted message after full citation loading fails, without creating another user', async () => {
    const f = fixture();
    f.options.hydrateContext = mock(async () => { throw new Error('synthetic citation body unavailable'); });
    await expect(f.send()).rejects.toThrow('synthetic citation body unavailable');
    expect(f.receipt()?.state).toBe('message_persisted');
    expect(f.native.markLaunchUncertain).not.toHaveBeenCalled();
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
    f.options.hydrateContext = mock(async () => {});
    f.native.inspectAttachments = mock(async () => { throw new Error('finalized staging rows no longer exist'); });
    expect((await f.send()).state).toBe('confirmed');
    expect(f.native.inspectAttachments).not.toHaveBeenCalled();
    expect(f.events.filter(event => event === 'native-persist')).toHaveLength(1);
    expect(f.f.ports.stream.start).toHaveBeenCalledTimes(1);
  });

  it('keeps uncertain status after lost marker ACK and never retries launch', async () => {
    const f = fixture();
    const mark = f.native.markLaunchUncertain;
    f.native.markLaunchUncertain = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['markLaunchUncertain']>(async (...args) => { await mark(...args); throw new Error('lost marker ACK'); });
    await expect(f.send()).rejects.toMatchObject({ message: 'lost marker ACK' });
    expect((await f.send()).state).toBe('launch_uncertain');
    expect(f.f.ports.stream.prepare).not.toHaveBeenCalled();
  });

  it('keeps one launch when confirmation ACK is lost', async () => {
    const f = fixture();
    const confirm = f.native.confirmLaunch;
    f.native.confirmLaunch = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['confirmLaunch']>(async (...args) => { await confirm(...args); throw new Error('lost confirmation ACK'); });
    await expect(f.send()).rejects.toMatchObject({ message: 'lost confirmation ACK' });
    expect((await f.send()).state).toBe('confirmed');
    expect(f.f.ports.stream.start).toHaveBeenCalledTimes(1);
    expect(f.f.createMessage.mock.calls.filter(call => call[1] === 'user')).toHaveLength(0);
  });

  for (const mutation of ['archive', 'revoke', 'model', 'vision', 'branch'] as const) {
    it(`guards ${mutation} after citation hydration before preparation`, async () => {
      const f = fixture(mutation === 'branch' ? 'Implement' : 'Chat');
      f.options.hydrateContext = mock(async () => {
        if (mutation === 'archive') f.archive();
        if (mutation === 'revoke') f.revoke();
        if (mutation === 'model') f.conversation.model_id = 'changed-model';
        if (mutation === 'vision') f.model.capabilities = [];
        if (mutation === 'branch') f.task.execution_targets = [{ projectId: 'changed-project' }] as never;
      });
      await expect(f.send()).rejects.toThrow();
      expect(f.f.ports.stream.prepare).not.toHaveBeenCalled();
      expect(f.f.ports.stream.start).not.toHaveBeenCalled();
    });
  }




  it('uses the configured Implement model as vision evidence before native persistence', async () => {
    const f = fixture('Implement');
    f.providers.modelsByProvider['provider-1'].push({ ...f.model, id: 'configured-text-model', capabilities: ['tools'] });
    f.options.loadConfiguration = mock(async () => ({
      projectIds: [], focusProjectId: null, riskLevel: 'balanced' as const, maxTurns: null,
      models: { implementBuild: { providerId: 'provider-1', modelId: 'configured-text-model', reasoningEffort: null } },
      builtInTools: {}, modeTools: {}, allowedMcpServerIds: [], mcpServers: {},
    }));
    await expect(f.send()).rejects.toMatchObject({ code: 'unsupported_model' });
    expect(f.native.inspectAttachments).toHaveBeenCalledTimes(1);
    expect(f.native.prepareSend).not.toHaveBeenCalled();
    expect(f.native.markLaunchUncertain).not.toHaveBeenCalled();
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a scoped Implement model changed during authorization before allocating', async () => {
    const f = fixture('Implement');
    let configuredModel = 'model-1';
    f.providers.modelsByProvider['provider-1'].push({ ...f.model, id: 'changed-vision-model' });
    f.options.loadConfiguration = mock(async () => ({
      projectIds: [], focusProjectId: null, riskLevel: 'balanced' as const, maxTurns: null,
      models: { implementBuild: { providerId: 'provider-1', modelId: configuredModel, reasoningEffort: 'high' as const } },
      builtInTools: {}, modeTools: {}, allowedMcpServerIds: [], mcpServers: {},
    }));
    f.guard.authorizeBeforeEffect = mock(async () => {
      if (f.native.inspectAttachments.mock.calls.length) configuredModel = 'changed-vision-model';
    });
    await expect(f.send()).rejects.toMatchObject({ code: 'stale_revision' });
    expect(f.native.prepareSend).not.toHaveBeenCalled();
    expect(f.native.markLaunchUncertain).not.toHaveBeenCalled();
  });

  it('rejects a changed provider endpoint before native allocation', async () => {
    const f = fixture();
    f.guard.authorizeBeforeEffect = mock(async () => {
      if (f.native.inspectAttachments.mock.calls.length) f.provider.baseUrl = 'https://changed.example.invalid';
    });
    await expect(f.send()).rejects.toMatchObject({ code: 'stale_revision' });
    expect(f.native.prepareSend).not.toHaveBeenCalled();
  });

  it('rejects native images returned in a different order than attachment_ids', async () => {
    const f = fixture();
    f.body.attachment_ids = ['attachment-image', 'second-image', 'attachment-text'];
    f.native.inspectAttachments = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['inspectAttachments']>(async () => [
      { id: 'attachment-image', mimeType: 'image/png' }, { id: 'second-image', mimeType: 'image/png' },
      { id: 'attachment-text', mimeType: 'text/plain' },
    ]);
    const prepare = f.native.prepareSend;
    f.native.prepareSend = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['prepareSend']>(async (...args) => ({
      ...await prepare(...args), images: [{ ...image, id: 'second-image' }, image],
    }));
    await expect(f.send()).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects native text references without a unique read_file path', async () => {
    const f = fixture();
    f.saved.context_refs = [{ id: 'attachment-text', kind: 'source', title: 'fixture.txt' }];
    await expect(f.send()).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
  });

  it('does not allocate or claim a launch when Implement changes branches during authorization', async () => {
    const f = fixture('Implement');
    f.guard.authorizeBeforeEffect = mock(async () => {
      if (f.native.inspectAttachments.mock.calls.length) f.task.execution_targets = [{ projectId: 'other-project' }] as never;
    });
    await expect(f.send()).rejects.toMatchObject({ code: 'stale_revision' });
    expect(f.native.prepareSend).not.toHaveBeenCalled();
    expect(f.native.markLaunchUncertain).not.toHaveBeenCalled();
  });

  it('rejects missing or reordered native images before claiming a launch', async () => {
    const f = fixture();
    const prepare = f.native.prepareSend;
    f.native.prepareSend = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['prepareSend']>(async (...args) => ({ ...await prepare(...args), images: [] }));
    await expect(f.send()).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
    expect(f.native.markLaunchUncertain).not.toHaveBeenCalled();
  });

  it('releases the reservation after refusal so the valid request can proceed', async () => {
    const f = fixture();
    f.model.capabilities = [];
    await expect(f.send()).rejects.toMatchObject({ code: 'unsupported_model' });
    f.model.capabilities = ['vision'];
    expect((await f.send()).state).toBe('confirmed');
  });

  it('rejects expiry before native inspection or persistence', async () => {
    const f = fixture();
    f.options.now = () => Date.parse(f.body.intent_expires_at);
    await expect(f.send()).rejects.toMatchObject({ code: 'transfer_expired' });
    expect(f.native.inspectAttachments).not.toHaveBeenCalled();
    expect(f.native.prepareSend).not.toHaveBeenCalled();
  });


  for (const state of ['message_persisted', 'launch_uncertain', 'confirmed'] as const) {
    for (const changed of ['content', 'attachments', 'revision', 'expiry'] as const) {
      it(`rejects a changed ${changed} digest when replaying ${state}`, async () => {
        const f = fixture();
        const prepared = await f.native.prepareSend(f.scope, f.body.intent_id, '', f.body.attachment_ids, 7, f.body.intent_expires_at, f.body.intent_expires_at);
        f.setReceipt({ ...prepared.nativeSendReceipt, state });
        if (changed === 'content') f.body.content = 'Changed request';
        if (changed === 'attachments') f.body.attachment_ids = ['attachment-text'];
        if (changed === 'revision') f.body.expected_revision = 8;
        if (changed === 'expiry') f.body.intent_expires_at = '2026-10-12T00:11:00Z';
        await expect(f.send()).rejects.toThrow('integrity_failed');
        expect(f.chat.sendMessage).not.toHaveBeenCalled();
        expect(f.native.markLaunchUncertain).not.toHaveBeenCalled();
      });
    }
  }

  it('resumes a persisted message using its original revision before the consumed guard', async () => {
    const f = fixture();
    await f.native.prepareSend(f.scope, f.body.intent_id, '', f.body.attachment_ids, 7, f.body.intent_expires_at, f.body.intent_expires_at);
    f.guard.authorizeBeforeEffect = mock(async (request?: { revision: 'expected' | 'consumed' }) => {
      if (request?.revision === 'expected') throw new Error('false stale revision');
    });
    expect((await f.send()).state).toBe('confirmed');
    expect(f.events.filter(event => event === 'native-persist')).toHaveLength(1);
    expect(f.f.ports.stream.start).toHaveBeenCalledTimes(1);
  });


  it('renews native execution deadlines without extending the fixed send expiry', async () => {
    const f = fixture();
    let clock = Date.parse(date);
    f.options.now = () => clock;
    const inspect = f.native.inspectAttachments;
    f.native.inspectAttachments = mock<DesktopAttachmentSendNativePorts<{ authority: string }>['inspectAttachments']>(async (...args) => {
      const result = await inspect(...args); clock += 20_000; return result;
    });
    const guard = { assertCurrent: () => {}, authorizeBeforeEffect: async () => new Date(clock + 10_000).toISOString() };
    const initial = new Date(clock + 10_000).toISOString();
    expect((await f.service().send(f.scope, f.body, initial, guard)).state).toBe('confirmed');
    expect(f.native.prepareSend.mock.calls[0]?.[5]).toBe('2026-10-12T00:00:30.000Z');
    expect(f.native.prepareSend.mock.calls[0]?.[6]).toBe(f.body.intent_expires_at);
  });

  it('does not compare a stale initial revision when reading existing receipt metadata', async () => {
    const f = fixture();
    const prepared = await f.native.prepareSend(f.scope, f.body.intent_id, '', f.body.attachment_ids, 7, f.body.intent_expires_at, f.body.intent_expires_at);
    const guard = { assertCurrent: () => { throw new Error('stale initial snapshot'); }, authorizeBeforeEffect: async () => {} };
    expect(await f.service().status(f.scope, ref, f.body.intent_id, guard)).toEqual(prepared.nativeSendReceipt);
  });

  it('reads old receipt metadata with new authority without inspecting or sending', async () => {
    const f = fixture();
    const prepared = await f.native.prepareSend(f.scope, f.body.intent_id, '', f.body.attachment_ids, 7, f.body.intent_expires_at, f.body.intent_expires_at);
    f.archive();
    const current = { authority: 'new-authority' };
    expect(await f.service().status(current, ref, f.body.intent_id, f.guard)).toEqual(prepared.nativeSendReceipt);
    expect(f.native.status).toHaveBeenLastCalledWith(current, f.body.intent_id);
    expect(f.native.inspectAttachments).not.toHaveBeenCalled();
    expect(f.chat.sendMessage).not.toHaveBeenCalled();
  });
});
