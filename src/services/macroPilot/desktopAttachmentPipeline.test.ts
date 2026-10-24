import { expect, test } from 'bun:test';
import { desktopAttachmentFiles, type DesktopAttachmentNativePorts } from './desktopAttachmentFiles';
import type { ConversationCaptures } from './conversationCaptures';
import type { DesktopStorePorts } from './desktopStorePorts';
import type { ContentConversationRef, ContentDelivery } from './contentProtocol';
import type { PilotPreparedSend, PilotSendReceipt } from '../tauriIpc';
import { chatSendFixture } from '../../test-utils/chatSendFixture';
import { sendMessage } from '../chatSend/sendMessage';
import { pilotTaskId } from './taskIdentity';
import type { ChatSendInput } from '../chatSend/contracts';

for (const mode of ['Chat', 'Implement'] as const) for (const resume of [false, true]) {
  test(`${mode} sends native text and image DTOs through the adapter${resume ? ' after persisted-message recovery' : ''}`, async () => {
    const fixture = chatSendFixture(mode); fixture.task.draft = false;
    const ref: ContentConversationRef = mode === 'Chat'
      ? { kind: 'conversation', instance_id: 'instance-demo', conversation_id: 'conversation-1' }
      : { kind: 'implement', instance_id: 'instance-demo', workspace_id: 'workspace-demo', task_id: pilotTaskId('task-1'), conversation_id: 'conversation-1' };
    const scope = { accountId: 'account-demo', sessionId: 'mobile-demo', instanceId: ref.instance_id, authorityBinding: 'authority-demo' };
    const conversation = { id: ref.conversation_id, scope_mode: mode, task_id: mode === 'Chat' ? null : 'task-1', project_id: null,
      provider_id: 'provider-1', model_id: 'model-1', reasoning_effort: 'high' };
    const task = { id: 'task-1', conversation_id: conversation.id, status: 'InProgress', task_source: 'manual', draft: false,
      project_id: '', archived_at: null, is_blocked: false, execution_targets: [] };
    let receipt: PilotSendReceipt | null = null, userCreations = 0, inspections = 0, failHydration = resume;
    let sent: ChatSendInput | undefined;
    const context = 'Première ligne accentuée\nDernière ligne complète.\n';
    const paths = [{ id: 'text-demo', kind: 'file' as const, title: 'exemple.txt', path: 'attachment://text-demo' }];
    const prepared = (): PilotPreparedSend => ({
      receipt: receipt!, message: { portable_history: null, id: 'native-user', conversation_id: ref.conversation_id, turn_id: 'native-turn', role: 'user',
        content: 'Lis les pièces jointes', created_at: '2026-10-12T00:00:00Z', token_count: null, tool_traces_json: null,
        hidden_context: null, provider_input_items_json: null, provider_turn_state_json: null, context_refs_json: JSON.stringify(paths),
        completion_reason: null, generation_attempts_json: null },
      contextRefs: [{ id: 'text-demo', title: 'exemple.txt', content: context, sizeBytes: new TextEncoder().encode(context).length }],
      citations: [{ id: 'text-demo', conversation_id: ref.conversation_id, message_id: 'native-user', type: 'file', scope: 'context',
        source: 'pilot_attachment', title: 'exemple.txt', content: context, path: 'attachment://text-demo' }] as PilotPreparedSend['citations'],
      images: [{ attachmentId: 'image-demo', fileName: 'exemple.png', mimeType: 'image/png', readyDataURL: 'data:image/png;base64,AQID' }],
    });
    const nativePorts = {
      pilotFilesAuthorize: async () => undefined,
      pilotFilesSendRead: async () => { if (!receipt) throw new Error('not_found'); return receipt; },
      pilotFilesInspectAttachments: async () => {
        inspections++; if (receipt) throw new Error('not_found');
        return [{ attachmentId: 'image-demo', mimeType: 'image/png' }, { attachmentId: 'text-demo', mimeType: 'text/plain' }];
      },
      pilotFilesPrepareSend: async (input: Parameters<DesktopAttachmentNativePorts['pilotFilesPrepareSend']>[0]) => {
        if (!receipt) { userCreations++; receipt = { ref: input.scope.ref, sendIntentId: input.sendIntentId, messageId: 'native-user',
          turnId: 'native-turn', state: 'message_persisted', revision: 1, attachmentIds: input.attachmentIds,
          assistantMessageId: null, contextState: 'ready' }; }
        return prepared();
      },
      pilotFilesSendMark: async (input: Parameters<DesktopAttachmentNativePorts['pilotFilesSendMark']>[0]) => {
        receipt = { ...receipt!, state: input.state, assistantMessageId: input.assistantMessageId, revision: receipt!.revision + 1 };
        return receipt;
      },
    } as unknown as DesktopAttachmentNativePorts;
    const chat = { conversations: [conversation], getConversationRuntime: () => fixture.runtimes.get(ref.conversation_id) ?? { phase: 'idle' },
      getActiveQuestionnaire: () => null, getPendingToolApproval: () => null,
      sendMessage: async (input: ChatSendInput) => {
        sent = input; fixture.snapshot.conversationTaskId = conversation.task_id;
        fixture.ports.preparation.authorizePilotEffect = async () => { await input.pilotTarget?.beforeEffect?.(); };
        fixture.ports.messages.saveImages = () => undefined;
        fixture.ports.messages.onAssistantStarted = input.pilotTarget?.onAssistantStarted;
        return sendMessage(input, fixture.snapshot, fixture.ports);
      } };
    const ports = { chat: () => chat, tasks: () => ({ tasks: mode === 'Chat' ? [] : [task], getTaskById: () => task, branchWorktrees: {} }),
      app: () => ({ standaloneProjects: [], projectGroups: [] }), archives: () => ({ archivedConversationIds: new Set() }),
      providers: () => ({ providerConfigs: fixture.snapshot.provider.providerConfigs, isLoading: false,
        modelsByProvider: { 'provider-1': [{ id: 'model-1', provider_id: 'provider-1', capabilities: ['vision'] }] } }),
      citations: () => ({ hydrateConversationCitations: async () => { if (failHydration) throw new Error('synthetic context unavailable'); },
        ensureConversationCitationContentsLoaded: async () => prepared().citations }),
    } as unknown as DesktopStorePorts;
    const source = desktopAttachmentFiles({ nativePorts, instanceId: ref.instance_id, workspaceId: 'workspace-demo', ports,
      conversations: {} as ConversationCaptures, signal: new AbortController().signal, validateSendTarget: async () => undefined });
    const delivery = { request: { operation: 'conversation.send.attachments', body: { ref, intent_id: 'send-demo',
      intent_expires_at: new Date(Date.now() + 600000).toISOString(), expected_revision: 1, content: 'Lis les pièces jointes',
      attachment_ids: ['image-demo', 'text-demo'] } } } as unknown as ContentDelivery;
    const guard = async () => new Date(Date.now() + 5000).toISOString();
    if (resume) {
      await expect(source.send(delivery, scope, guard)).rejects.toThrow('synthetic context unavailable');
      expect((receipt as PilotSendReceipt | null)?.state).toBe('message_persisted'); failHydration = false;
    }
    expect((await source.send(delivery, scope, guard)).state).toBe('confirmed');
    expect(userCreations).toBe(1); expect(inspections).toBe(1);
    expect(sent?.contextRefs).toEqual(paths);
    expect(sent?.images?.[0]).toMatchObject({ id: 'image-demo', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQID' });
    expect(fixture.ports.stream.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.createMessage.mock.calls.filter(call => call[1] === 'user')).toHaveLength(0);
    await source.dispose?.();
  });
}
