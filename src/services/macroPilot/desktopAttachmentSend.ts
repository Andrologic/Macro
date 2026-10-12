import type { AIModel, ProviderConfig } from '../../types';
import type { ChatSendInput, SendImage } from '../chatSend/contracts';
import { loadScopedTurnConfiguration, resolveScopedModelSelection, type ScopedModelSelection } from '../configurationClient';
import { resolveProjectExecutionContext } from '../projectExecutionContext';
import { providerHasUsableCredentials } from '../providerCredentials';
import type { ContentAttachmentSendReceipt, ContentConversationRef, ContentRequestConversationSendAttachments } from './contentProtocol';
import { reservePilotAction, assertPilotReservationCurrent } from './actionReservations';
import type { DesktopStorePorts } from './desktopStorePorts';
import { stableJson } from './protocol';

export type DesktopAttachmentSendBody = ContentRequestConversationSendAttachments['body'];
export type DesktopAttachmentTarget = { conversationId: string } & (
  { mode: 'Chat'; taskId?: never } | { mode: 'Implement'; taskId: string }
);
export type DesktopAttachmentSendErrorCode = 'unsupported_model' | 'unsupported_type' | 'integrity_failed' |
  'transfer_expired' | 'invalid_reference' | 'stale_revision' | 'conflict' | 'unavailable';
export class DesktopAttachmentSendError extends Error {
  constructor(readonly code: DesktopAttachmentSendErrorCode) { super(code); }
}
function fail(code: DesktopAttachmentSendErrorCode): never { throw new DesktopAttachmentSendError(code); }

/** Unknown model metadata is never evidence of image support. */
export function desktopAttachmentImageSupport(provider: ProviderConfig, model: AIModel | undefined): 'supported' | 'unsupported' | 'unknown' {
  if (!provider.isEnabled || !model || model.provider_id !== provider.id || model.isEnabled === false) return 'unknown';
  if (!model.capabilities) return 'unknown';
  return model.capabilities.includes('vision') ? 'supported' : 'unsupported';
}

export interface DesktopPreparedAttachmentSend {
  persistedUserMessage: NonNullable<ChatSendInput['persistedUserMessage']>;
  images: SendImage[];
  nativeSendReceipt: ContentAttachmentSendReceipt;
}

/** The parent converts wire refs and current authority into Scope. Native
 * implementations validate ownership, finalized batches and durable identity. */
export interface DesktopAttachmentSendNativePorts<Scope> {
  status(scope: Scope, intentId: string): Promise<ContentAttachmentSendReceipt | null>;
  inspectAttachments(scope: Scope, attachmentIds: string[]): Promise<Array<{ id: string; mimeType: string }>>;
  /** Replay verifies the stored content/attachment digest and original revision
   * before returning. Existing receipts allocate nothing and ignore the revision
   * increment caused by their own user-message transaction. */
  prepareSend(scope: Scope, intentId: string, content: string, attachmentIds: string[], expectedRevision: number, executeBefore: string, intentExpiresAt: string): Promise<DesktopPreparedAttachmentSend>;
  /** Atomic message_persisted -> launch_uncertain. Reject every other state. */
  markLaunchUncertain(scope: Scope, intentId: string, userMessageId: string, assistantMessageId: string | null, executeBefore: string): Promise<ContentAttachmentSendReceipt>;
  confirmLaunch(scope: Scope, intentId: string, userMessageId: string, assistantMessageId: string, executeBefore: string): Promise<ContentAttachmentSendReceipt>;
}

export interface DesktopAttachmentSendOptions<Scope> {
  stores: DesktopStorePorts;
  native: DesktopAttachmentSendNativePorts<Scope>;
  /** Resolve the canonical branch-qualified runtime task, never a selected task. */
  resolveTarget(scope: Scope, ref: ContentConversationRef): DesktopAttachmentTarget;
  isConversationArchived(conversationId: string): boolean;
  /** Hydrate native persisted citations and full text into the existing context
   * store. Reject if any referenced text is unavailable to read_file. */
  hydrateContext(conversationId: string): Promise<void>;
  loadConfiguration?: typeof loadScopedTurnConfiguration;
  now?: () => number;
}

/** An adapter may return each fresh native execution deadline. Existing action
 * guards returning void keep the caller's deadline. The intent expiry is fixed. */
export interface DesktopAttachmentSendGuard {
  assertCurrent(): void;
  authorizeBeforeEffect(options?: { revision: 'expected' | 'consumed' }): Promise<string | void>;
}

export interface DesktopAttachmentSend<Scope> {
  send(scope: Scope, body: DesktopAttachmentSendBody, executeBefore: string, guard: DesktopAttachmentSendGuard): Promise<ContentAttachmentSendReceipt>;
  /** Current authority can read an old receipt. This operation cannot launch. */
  status(scope: Scope, ref: ContentConversationRef, intentId: string, guard: DesktopAttachmentSendGuard): Promise<ContentAttachmentSendReceipt | null>;
}

export function createDesktopAttachmentSend<Scope>(options: DesktopAttachmentSendOptions<Scope>): DesktopAttachmentSend<Scope> {
  const { stores, native } = options;
  const now = options.now ?? Date.now;
  const requireReceipt = (receipt: ContentAttachmentSendReceipt, ref: ContentConversationRef, intentId: string) => {
    if (stableJson(receipt.ref) !== stableJson(ref) || receipt.intent_id !== intentId) fail('integrity_failed');
    return receipt;
  };
  const readStatus = async (scope: Scope, ref: ContentConversationRef, intentId: string, guard: DesktopAttachmentSendGuard) => {
    await guard.authorizeBeforeEffect({ revision: 'consumed' });
    const receipt = await native.status(scope, intentId);
    await guard.authorizeBeforeEffect({ revision: 'consumed' });
    return receipt ? requireReceipt(receipt, ref, intentId) : null;
  };
  return {
    status: readStatus,
    send: async (scope, body, executeBefore, guard) => {
      const previous = await readStatus(scope, body.ref, body.intent_id, guard);
      const intentDeadline = Date.parse(body.intent_expires_at);
      let deadline = Math.min(Date.parse(executeBefore), intentDeadline);
      const refreshDeadline = (authorized: string | void) => {
        if (authorized !== undefined) {
          const next = Date.parse(authorized);
          if (!Number.isFinite(next) || next <= now()) fail('unavailable');
          deadline = Math.min(next, intentDeadline);
        }
      };
      // The native replay path compares the digest and original revision before
      // a consumed-revision guard can treat this as the accepted submission.
      let replay: DesktopPreparedAttachmentSend | null = null;
      if (previous) {
        refreshDeadline(await guard.authorizeBeforeEffect({ revision: 'consumed' }));
        replay = await native.prepareSend(scope, body.intent_id, body.content, body.attachment_ids,
          body.expected_revision, Number.isFinite(deadline) ? new Date(deadline).toISOString() : executeBefore, body.intent_expires_at);
      }
      if (replay) {
        const replayReceipt = requireReceipt(replay.nativeSendReceipt, body.ref, body.intent_id);
        if (replayReceipt.state !== 'message_persisted') return replayReceipt;
      }
      const assertDeadline = () => {
        if (!Number.isFinite(deadline) || now() >= deadline) fail('transfer_expired');
      };
      assertDeadline();
      if ((!body.content.trim() && !body.attachment_ids.length) ||
          new Set(body.attachment_ids).size !== body.attachment_ids.length) fail('invalid_reference');
      const target = options.resolveTarget(scope, body.ref);
      const reservation = reservePilotAction({ conversationId: target.conversationId, taskId: target.taskId });
      let consumed = replay !== null;
      let receipt: ContentAttachmentSendReceipt | null = null;
      let expectedTarget: string | undefined;
      let expectedModel: ScopedModelSelection | undefined;
      let expectedProviderRoute: string | undefined;
      const providerRoute = (provider: ProviderConfig) => stableJson({
        id: provider.id, type: provider.providerType, baseUrl: provider.baseUrl, local: provider.isLocal,
      });
      let hasImages = false;
      const captureTarget = () => {
        assertPilotReservationCurrent(reservation);
        if (!Number.isFinite(intentDeadline) || now() >= intentDeadline) fail('transfer_expired');
        if (stableJson(options.resolveTarget(scope, body.ref)) !== stableJson(target)) fail('stale_revision');
        const chat = stores.chat();
        const conversation = chat.conversations.find(item => item.id === target.conversationId);
        if (!conversation || options.isConversationArchived(target.conversationId)) return fail('invalid_reference');
        if (target.mode === 'Chat' ? conversation.scope_mode !== 'Chat' || Boolean(conversation.task_id)
          : conversation.scope_mode !== 'Implement' || conversation.task_id !== target.taskId) fail('invalid_reference');
        const task = target.taskId ? stores.tasks().getTaskById(target.taskId) : undefined;
        if (target.taskId && (!task || task.archived_at || task.draft || task.is_blocked || !['InProgress', 'AwaitingResponse', 'InReview', 'Failed'].includes(task.status))) fail('conflict');
        if (chat.getActiveQuestionnaire(target.conversationId) || chat.getPendingToolApproval(target.conversationId)) fail('conflict');
        const app = stores.app();
        const taskState = stores.tasks();
        const execution = resolveProjectExecutionContext({
          mode: target.mode, conversations: chat.conversations, conversationId: target.conversationId,
          tasks: taskState.tasks, branchWorktrees: taskState.branchWorktrees,
          projects: [...app.standaloneProjects, ...app.projectGroups.flatMap(group => group.projects)],
          projectGroups: app.projectGroups, selectedTaskId: target.taskId ?? null,
          selectedProjectId: null, selectedGroupId: null,
        });
        const identity = stableJson({
          conversation: { mode: conversation.scope_mode, taskId: conversation.task_id, projectId: conversation.project_id,
            groupId: conversation.group_id, providerId: conversation.provider_id, modelId: conversation.model_id,
            reasoningEffort: conversation.reasoning_effort },
          task: task ? { id: task.id, projectId: task.project_id, projectIds: task.project_ids,
            contextProjectIds: task.context_project_ids, branch: task.assigned_branch,
            executionTargets: task.execution_targets } : null,
          execution,
        });
        if (expectedTarget !== undefined && identity !== expectedTarget) fail('stale_revision');
        expectedTarget ??= identity;
        return { conversation, execution };
      };
      const checkModel = async (): Promise<ScopedModelSelection> => {
        const { conversation, execution } = captureTarget();
        const config = target.mode === 'Implement' ? await (options.loadConfiguration ?? loadScopedTurnConfiguration)({
          projectIds: execution.projectIds, focusProjectId: execution.focusedProjectId, mode: target.mode,
        }) : null;
        captureTarget();
        const selected = resolveScopedModelSelection(config, ['implementBuild', 'implement']);
        const selection = selected ?? { providerId: conversation.provider_id ?? '', modelId: conversation.model_id ?? '',
          reasoningEffort: conversation.reasoning_effort ?? null };
        const providers = stores.providers?.();
        const provider = providers?.providerConfigs.find(item => item.id === selection.providerId);
        if (!provider || !provider.isEnabled || providers?.isLoading || !selection.modelId || !providerHasUsableCredentials(provider)) fail('unavailable');
        const route = providerRoute(provider);
        if (expectedProviderRoute !== undefined && route !== expectedProviderRoute) fail('stale_revision');
        expectedProviderRoute ??= route;
        const model = providers?.modelsByProvider[selection.providerId]?.find(item => item.id === selection.modelId);
        if (model?.isEnabled === false) fail('unavailable');
        if (hasImages && desktopAttachmentImageSupport(provider, model) !== 'supported') fail('unsupported_model');
        if (expectedModel && stableJson(expectedModel) !== stableJson(selection)) fail('stale_revision');
        expectedModel ??= selection;
        return selection;
      };
      const beforeEffect = async () => {
        captureTarget();
        await checkModel();
        refreshDeadline(await guard.authorizeBeforeEffect({ revision: consumed ? 'consumed' : 'expected' }));
        await checkModel();
        assertDeadline();
        if (!consumed) guard.assertCurrent();
        captureTarget();
        const providers = stores.providers?.();
        const provider = providers?.providerConfigs.find(item => item.id === expectedModel?.providerId);
        if (!provider || !provider.isEnabled || !providerHasUsableCredentials(provider)) fail('unavailable');
        if (providerRoute(provider) !== expectedProviderRoute) fail('stale_revision');
        if (hasImages) {
          const model = providers?.modelsByProvider[expectedModel!.providerId]?.find(item => item.id === expectedModel?.modelId);
          if (desktopAttachmentImageSupport(provider, model) !== 'supported') fail('unsupported_model');
        }
      };
      try {
        captureTarget();
        const assertIdle = () => {
          const runtime = stores.chat().getConversationRuntime(target.conversationId);
          if (!['idle', 'error'].includes(runtime.phase)) fail('conflict');
        };
        assertIdle();
        await beforeEffect();
        const attachments = await native.inspectAttachments(scope, body.attachment_ids);
        captureTarget();
        if (attachments.length !== body.attachment_ids.length || attachments.some((item, index) => item.id !== body.attachment_ids[index])) fail('integrity_failed');
        hasImages = attachments.some(item => item.mimeType.startsWith('image/'));
        await beforeEffect();
        assertIdle();
        // One native transaction persists text, images, references, citations and receipt.
        const prepared = replay ?? await native.prepareSend(scope, body.intent_id, body.content, body.attachment_ids,
          body.expected_revision, new Date(deadline).toISOString(), body.intent_expires_at);
        consumed = true;
        receipt = requireReceipt(prepared.nativeSendReceipt, body.ref, body.intent_id);
        const saved = prepared.persistedUserMessage;
        if (receipt.state !== 'message_persisted') return receipt;
        if (!saved.turn_id || saved.role !== 'user' || saved.conversation_id !== target.conversationId ||
            saved.id !== receipt.user_message_id || saved.content !== body.content || saved.task_id !== (target.taskId ?? '') ||
            stableJson(receipt.attachment_ids) !== stableJson(body.attachment_ids)) fail('integrity_failed');
        if (receipt.context_state !== 'ready') return receipt;
        const textAttachments = attachments.filter(item => !item.mimeType.startsWith('image/'));
        const textPaths = new Set<string>();
        for (const attachment of textAttachments) {
          const context = saved.context_refs?.find(item => item.id === attachment.id);
          if (context?.kind !== 'file' || !context.path || textPaths.has(context.path)) fail('integrity_failed');
          textPaths.add(context.path);
        }
        const expectedImages = attachments.filter(item => item.mimeType.startsWith('image/'));
        if (prepared.images.length !== expectedImages.length || prepared.images.some((image, index) =>
          image.id !== expectedImages[index].id || image.mimeType !== expectedImages[index].mimeType ||
          !image.dataUrl.startsWith(`data:${image.mimeType};base64,`))) fail('integrity_failed');
        await beforeEffect();
        await options.hydrateContext(target.conversationId);
        await beforeEffect();
        assertIdle();
        const result = await stores.chat().sendMessage({
          conversationId: target.conversationId, taskId: target.taskId, content: saved.content,
          images: prepared.images, contextRefs: saved.context_refs ?? [], hiddenContext: saved.hidden_context ?? undefined,
          submissionTurnId: saved.turn_id, persistedUserMessage: saved,
          pilotTarget: {
            ...(target.mode === 'Chat' ? { mode: 'Chat' as const } : { taskId: target.taskId }),
            actionToken: reservation.token, beforeEffect, expectedModel,
            // Preparation can compact context through the provider. Claim the
            // intent durably before preparation, even before an assistant exists.
            beforeAssistantPrepare: async () => {
              await beforeEffect();
              receipt = requireReceipt(await native.markLaunchUncertain(scope, body.intent_id, saved.id,
                null, new Date(deadline).toISOString()), body.ref, body.intent_id);
              if (receipt.state !== 'launch_uncertain' || receipt.user_message_id !== saved.id) fail('integrity_failed');
            },
            onAssistantStarted: async assistant => {
              await beforeEffect();
              receipt = requireReceipt(await native.confirmLaunch(scope, body.intent_id, saved.id,
                assistant.id, new Date(deadline).toISOString()), body.ref, body.intent_id);
              if (receipt.state !== 'confirmed' || receipt.user_message_id !== saved.id ||
                  receipt.assistant_message_id !== assistant.id) fail('integrity_failed');
            },
          },
        });
        if (result.status !== 'sent' || result.userMessageId !== saved.id || result.turnId !== saved.turn_id) fail('unavailable');
        return receipt;
      } finally { reservation.release(); }
    },
  };
}
