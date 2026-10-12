import { isBrowserRuntimeBridgeEnabled } from '../tauriRuntimeBridge';
import * as ipc from '../tauriIpc';
import { mapDbMessageToChatMessage } from '../chatDbMappers';
import { readArchitectPlanSnapshot, getGitFlowBaseBranch, resolveTargetBranch } from '../architectPlanService';
import { listVisibleTaskArtifacts, readVisibleTaskArtifactContent, taskArtifactContentHash } from '../architectPlanArtifactService';
import { getTaskBusinessId, toTaskRuntimeId } from '../durableIdentity';
import type { ConversationCaptures } from './conversationCaptures';
import type { ContentConversationRef, ContentAttachmentTransferReceipt, ContentAttachmentSendReceipt } from './contentProtocol';
import { validateContentFileBytes } from './contentProtocol';
import { FILE_LIMITS, type AttachmentFileSource, type FileCatalog, type FileDescriptor, type FileEffectGuard, type FileScope } from './attachmentFilesHost';
import { createDesktopAttachmentSend, type DesktopAttachmentTarget } from './desktopAttachmentSend';
import type { DesktopStorePorts } from './desktopStorePorts';
import { desktopPilotTasks } from './desktopTaskCatalog';
import { findPilotTask, pilotTaskId } from './taskIdentity';
import { stableJson } from './protocol';
const fail = (code: string): never => { throw new Error(code); };
const normalizedError = (error: unknown): never => {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  throw new Error(({ expired: 'transfer_expired', offset_conflict: 'conflict', intent_conflict: 'conflict', quota_exceeded: 'resource_limit', chunk_hash_mismatch: 'integrity_failed', file_hash_mismatch: 'integrity_failed', scope_mismatch: 'not_found' } as Record<string, string>)[code] ?? code);
};
async function native<T>(work: () => Promise<T>): Promise<T> { try { return await work(); } catch (error) { return normalizedError(error); } }
const fingerprint = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
const decode = (encoded: string): Uint8Array => { const binary = atob(encoded); if (btoa(binary) !== encoded) return fail('integrity_failed'); return Uint8Array.from(binary, char => char.charCodeAt(0)); };
export type DesktopAttachmentNativePorts = Pick<typeof ipc, 'pilotFilesAuthorize' | 'pilotFilesSendRead' | 'pilotFilesInspectAttachments' | 'pilotFilesPrepareSend' | 'pilotFilesSendMark' | 'pilotFilesList' | 'pilotFilesRead' | 'pilotFilesBegin' | 'pilotFilesChunk' | 'pilotFilesStatus' | 'pilotFilesFinalize' | 'pilotFilesAbort' | 'getMessage'>;
export interface DesktopAttachmentFileOptions { nativePorts?: DesktopAttachmentNativePorts; instanceId: string; workspaceId: string; ports: DesktopStorePorts; conversations: ConversationCaptures; signal: AbortSignal; validateSendTarget(ref: ContentConversationRef, revision: number): Promise<void> }

/** Adapts exact local resource identities to portable refs. Paths stay within
 * existing task artifact services and never enter a wire resource or file ID. */
export function desktopAttachmentFiles(options: DesktopAttachmentFileOptions): AttachmentFileSource {
  const { ports, instanceId, workspaceId, signal, conversations } = options;
  const fileIpc = options.nativePorts ?? ipc;
  const activeScopes = new Map<string, { scope: ipc.PilotFileScope; deadline: string }>();
  const targets = new Map<string, ContentConversationRef>();
  const nativeReceipts = new Map<string, ipc.PilotSendReceipt>();
  const beforeSends = new Map<string, FileEffectGuard>();
  const contextIds = new Map<string, string[]>();
  const check = () => { if (signal.aborted) fail('unavailable'); };
  const resolveTarget = (_scope: ipc.PilotFileScope, ref: ContentConversationRef): DesktopAttachmentTarget => {
    check();
    if (ref.instance_id !== instanceId || ref.kind === 'implement' && ref.workspace_id !== workspaceId) return fail('not_found');
    const conversation = ports.chat().conversations.find(c => c.id === ref.conversation_id);
    if (!conversation) return fail('not_found');
    if (ref.kind === 'conversation') {
      if (conversation.scope_mode !== 'Chat' || conversation.task_id) return fail('not_found');
      return { conversationId: conversation.id, mode: 'Chat' };
    }
    const task = findPilotTask(desktopPilotTasks(ports), ref.task_id);
    if (!task || conversation.scope_mode !== 'Implement' || conversation.task_id !== task.id || task.conversation_id !== conversation.id) return fail('not_found');
    return { conversationId: conversation.id, mode: 'Implement', taskId: task.id };
  };
  const scopeFor = (scope: FileScope, ref: ContentConversationRef): ipc.PilotFileScope => {
    const target = resolveTarget({} as ipc.PilotFileScope, ref);
    const conversation = ports.chat().conversations.find(c => c.id === target.conversationId)!;
    return { ...scope, ref: { conversationId: target.conversationId, conversationKind: target.mode === 'Chat' ? 'chat' : 'implement',
      workspaceId: ref.kind === 'implement' ? workspaceId : null, projectId: conversation.project_id ?? null, taskId: target.taskId ?? null } };
  };
  const authorized = async (scope: FileScope, ref: ContentConversationRef, beforeEffect: FileEffectGuard) => {
    const executeBefore = await beforeEffect(); check();
    const local = scopeFor(scope, ref);
    await native(() => fileIpc.pilotFilesAuthorize({ scope: local, executeBefore, active: true })); check();
    if (activeScopes.size >= 4096 && !activeScopes.has(stableJson([scope.accountId, scope.sessionId, scope.instanceId]))) return fail('resource_limit');
    activeScopes.set(stableJson([scope.accountId, scope.sessionId, scope.instanceId]), { scope: local, deadline: executeBefore });
    return { scope: local, executeBefore };
  };
  const sendReceipt = (receipt: ipc.PilotSendReceipt, ref: ContentConversationRef): ContentAttachmentSendReceipt => ({
    ref, intent_id: receipt.sendIntentId, state: receipt.state, user_message_id: receipt.messageId, assistant_message_id: receipt.assistantMessageId,
    attachment_ids: receipt.attachmentIds, context_state: receipt.contextState,
  });
  const receiptKey = (scope: ipc.PilotFileScope, intent: string) => stableJson([scope.accountId, scope.sessionId, scope.instanceId, scope.ref, intent]);
  const refFor = (scope: ipc.PilotFileScope) => targets.get(stableJson(scope)) ?? fail('not_found');
  const sender = createDesktopAttachmentSend<ipc.PilotFileScope>({ stores: ports, resolveTarget,
    isConversationArchived: id => (ports.archives?.().archivedConversationIds.has(id) ?? true),
    hydrateContext: async id => {
      const store = ports.citations?.() ?? fail('unavailable');
      await store.hydrateConversationCitations(id, { throwOnError: true }); check();
      const ids = contextIds.get(id) ?? [];
      const citations = await (ports.citations?.() ?? fail('unavailable')).ensureConversationCitationContentsLoaded(id, citation => ids.includes(citation.id)); check();
      if (ids.some(id => !citations.some(citation => citation.id === id && typeof citation.content === 'string'))) fail('content_unavailable');
    },
    native: {
      status: async (scope, intentId) => {
        const guard = beforeSends.get(stableJson(scope)) ?? fail('unavailable'); const executeBefore = await guard(); check();
        try {
          const receipt = await native(() => fileIpc.pilotFilesSendRead({ scope, executeBefore, sendIntentId: intentId })); check();
          nativeReceipts.set(receiptKey(scope, intentId), receipt); return sendReceipt(receipt, refFor(scope));
        } catch (error) { if (error instanceof Error && error.message === 'not_found') return null; throw error; }
      },
      inspectAttachments: async (scope, attachmentIds) => {
        const executeBefore = await (beforeSends.get(stableJson(scope)) ?? fail('unavailable'))(); check();
        const result = await native(() => fileIpc.pilotFilesInspectAttachments({ scope, executeBefore, attachmentIds })); check();
        return result.map(item => ({ id: item.attachmentId, mimeType: item.mimeType }));
      },
      prepareSend: async (scope, intentId, content, attachmentIds, expectedRevision, executeBefore, intentExpiresAt) => {
        const deadline = await (beforeSends.get(stableJson(scope)) ?? fail('unavailable'))(); check();
        const result = await native(() => fileIpc.pilotFilesPrepareSend({ scope, sendIntentId: intentId, content, attachmentIds,
          expectedRevision, executeBefore: new Date(Math.min(Date.parse(deadline), Date.parse(executeBefore))).toISOString(), intentExpiresAt })); check();
        nativeReceipts.set(receiptKey(scope, intentId), result.receipt);
        contextIds.set(scope.ref.conversationId, result.citations.map(citation => citation.id));
        const conversation = ports.chat().conversations.find(c => c.id === scope.ref.conversationId) ?? fail('not_found');
        return { persistedUserMessage: { ...mapDbMessageToChatMessage(result.message, new Map([[conversation.id, conversation]])), content: result.message.content },
          images: result.images.map(image => ({ id: image.attachmentId, mimeType: image.mimeType, dataUrl: image.readyDataURL, createdAt: result.message.created_at })),
          nativeSendReceipt: sendReceipt(result.receipt, refFor(scope)) };
      },
      markLaunchUncertain: async (scope, intentId, userMessageId, _assistant, executeBefore) => {
        const receipt = nativeReceipts.get(receiptKey(scope, intentId)) ?? fail('not_found');
        const current = await native(() => fileIpc.pilotFilesSendMark({ scope, executeBefore, sendIntentId: intentId,
          expectedRevision: receipt.revision, userMessageId, assistantMessageId: null, state: 'launch_uncertain' })); check();
        nativeReceipts.set(receiptKey(scope, intentId), current); return sendReceipt(current, refFor(scope));
      },
      confirmLaunch: async (scope, intentId, userMessageId, assistantMessageId, executeBefore) => {
        const receipt = nativeReceipts.get(receiptKey(scope, intentId)) ?? fail('not_found');
        const current = await native(() => fileIpc.pilotFilesSendMark({ scope, executeBefore, sendIntentId: intentId,
          expectedRevision: receipt.revision, userMessageId, assistantMessageId, state: 'confirmed' })); check();
        nativeReceipts.set(receiptKey(scope, intentId), current); return sendReceipt(current, refFor(scope));
      },
    } });
  const catalog = async (ref: ContentConversationRef, scope: FileScope, beforeEffect: FileEffectGuard): Promise<FileCatalog> => {
    const guard = await authorized(scope, ref, beforeEffect);
    const metadata = await native(() => fileIpc.pilotFilesList(guard)); check();
    const files: FileDescriptor[] = metadata.map(item => ({
      entry: { file_id: item.sourceId, display_name: item.fileName, mime_type: item.mimeType, size_bytes: item.totalBytes, sha256: null,
        content_state: item.contentState, source: { kind: item.sourceKind, message_id: pilotTaskId(item.messageId), artifact_id: null,
          citation_id: item.citationId ? pilotTaskId(item.citationId) : null, citation_scope: item.citationScope } },
      read: async () => {
        if (item.contentState !== 'available') return null;
        const bytes = new Uint8Array(item.totalBytes); let offset = 0;
        while (true) {
          const current = await authorized(scope, ref, beforeEffect);
          const chunk = await native(() => fileIpc.pilotFilesRead({ ...current, sourceId: item.sourceId, offsetBytes: offset })); check();
          if (stableJson(chunk.source) !== stableJson(item) || chunk.offsetBytes !== offset) return fail('stale_revision');
          const raw = decode(chunk.dataBase64);
          if (raw.length > FILE_LIMITS.chunk || offset + raw.length > bytes.length || raw.length === 0 && chunk.nextOffsetBytes !== null) return fail('integrity_failed');
          bytes.set(raw, offset); offset += raw.length;
          if (chunk.nextOffsetBytes === null) { if (offset !== bytes.length) return fail('integrity_failed'); break; }
          if (chunk.nextOffsetBytes !== offset) return fail('integrity_failed');
        }
        if (!await validateContentFileBytes({ content_state: 'available', total_bytes: bytes.length, sha256: item.sha256 }, bytes)) return fail('integrity_failed');
        return { bytes, mimeType: item.mimeType };
      },
    }));
    const artifactMetadata: unknown[] = [];
    if (ref.kind === 'implement') {
      const task = findPilotTask(desktopPilotTasks(ports), ref.task_id) ?? fail('not_found');
      if (task.plan_id && ['architect', 'plan_finalization'].includes(task.task_source)) {
        await beforeEffect(); check();
        const branchName = resolveTargetBranch(task.plan_storage_branch || task.plan_target_branch || getGitFlowBaseBranch());
        const plan = await readArchitectPlanSnapshot(branchName, task.plan_id); await beforeEffect(); check();
        if (!plan || plan.status === 'deleted') return fail('content_unavailable');
        const nodeIds = new Map(plan.nodes.map(node => [toTaskRuntimeId({ branchName, planId: plan.id, nodeId: node.id }), node.id]));
        const artifactTask = { ...task, id: getTaskBusinessId(task), dependencies: task.dependencies.map(id => nodeIds.get(id) ?? id) };
        const target = { branchName, plan, task: artifactTask, existingMetadataOnly: true };
        const artifacts = await listVisibleTaskArtifacts({ ...target, includeOwn: true, includeInherited: true }); await beforeEffect(); check();
        if (artifacts.length + files.length > FILE_LIMITS.catalog) return fail('resource_limit');
        artifactMetadata.push([task, artifacts]);
        for (const artifact of artifacts) files.push({
          entry: { file_id: pilotTaskId(`artifact/${stableJson([ref, artifact.id])}`), display_name: artifact.title,
            mime_type: artifact.contentType === 'json' ? 'application/json' : artifact.contentType === 'markdown' ? 'text/markdown' : 'text/plain', size_bytes: null, sha256: null,
            source: { kind: 'task_artifact', message_id: null, artifact_id: pilotTaskId(`artifact/${artifact.id}`), citation_id: null, citation_scope: null }, content_state: 'available' },
          allocationBytes: 32 * 1024 * 1024,
          read: async () => {
            await beforeEffect(); check();
            const current = await readVisibleTaskArtifactContent({ ...target, artifactId: artifact.id }); await beforeEffect(); check();
            if (taskArtifactContentHash(current.content) !== artifact.contentHash || current.artifact.contentHash !== artifact.contentHash) return fail('stale_revision');
            return { bytes: new TextEncoder().encode(current.content), mimeType: artifact.contentType === 'json' ? 'application/json' : artifact.contentType === 'markdown' ? 'text/markdown' : 'text/plain' };
          },
        });
      }
    }
    // Existing desktop images retain their native message association. A missing
    // cache gives no attestation and does not create a downloadable resource.
    const localImageMetadata: unknown[] = [];
    const messages = ports.chat().messagesByConversationId[ref.conversation_id] ?? [];
    for (const message of messages) if (message.role === 'user') {
      for (const image of ports.chat().getMessageImages(message.id)) {
        if (metadata.some(item => item.messageId === message.id && item.sourceKind === 'message_image')) continue;
        if (files.length >= FILE_LIMITS.catalog) return fail('resource_limit');
        const id = pilotTaskId(`message-image/${stableJson([ref, message.id, image.id])}`);
        const imageId = image.id, messageId = message.id, mimeType = image.mimeType;
        if (image.dataUrl.length > Math.ceil(FILE_LIMITS.file / 3) * 4 + 64) {
          localImageMetadata.push([messageId, imageId, mimeType, image.dataUrl.length, 'too_large']);
          files.push({ entry: { file_id: id, display_name: 'Image', mime_type: mimeType, size_bytes: null, sha256: null,
            content_state: 'too_large', source: { kind: 'message_image', message_id: pilotTaskId(messageId), artifact_id: null, citation_id: null, citation_scope: null } },
            read: async () => null });
          continue;
        }
        const imageDigest = await fingerprint(image.dataUrl); await beforeEffect(); check();
        localImageMetadata.push([messageId, imageId, mimeType, imageDigest]);
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
        const size = match ? match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0) : null;
        files.push({ entry: { file_id: id, display_name: 'Image', mime_type: image.mimeType, size_bytes: size, sha256: null,
          content_state: !match ? 'unsupported' : size! > FILE_LIMITS.file ? 'too_large' : 'available',
          source: { kind: 'message_image', message_id: pilotTaskId(message.id), artifact_id: null, citation_id: null, citation_scope: null } },
          read: async () => {
            await beforeEffect(); check();
            const stored = await fileIpc.getMessage(messageId); await beforeEffect(); check();
            const current = ports.chat().getMessageImages(messageId).find(candidate => candidate.id === imageId);
            if (!stored || stored.conversation_id !== ref.conversation_id || stored.role !== 'user' || !current || await fingerprint(current.dataUrl) !== imageDigest) return fail('stale_revision');
            const selected = current ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(current.dataUrl) : null;
            return selected ? { bytes: decode(selected[2]), mimeType: selected[1] } : null;
          } });
      }
    }
    return { fingerprint: await fingerprint([metadata, artifactMetadata, localImageMetadata]), files };
  };
  return {
    available: () => typeof window !== 'undefined' && !isBrowserRuntimeBridgeEnabled() && typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === 'function',
    validateTarget: async ref => { check(); const current = await conversations.refreshCatalogMetadata(true); check(); if (!current.refs.some(candidate => stableJson(candidate) === stableJson(ref))) fail('not_found'); },
    transfer: async (delivery, scope, beforeEffect) => {
      const request = delivery.request, ref = (request.body as { ref: ContentConversationRef }).ref;
      const guard = await authorized(scope, ref, beforeEffect);
      let receipt: ipc.PilotFileReceipt;
      if (request.operation === 'attachment.begin') receipt = await native(() => fileIpc.pilotFilesBegin({ ...guard, intentId: request.body.intent_id, batchId: request.body.batch_id,
        intentExpiresAt: request.body.intent_expires_at, fileName: request.body.file_name, mimeType: request.body.mime_type, totalBytes: request.body.total_bytes, sha256: request.body.sha256 }));
      else if (request.operation === 'attachment.chunk') receipt = await native(() => fileIpc.pilotFilesChunk({ ...guard, transferId: request.body.transfer_id, offsetBytes: request.body.offset_bytes, dataBase64: request.body.data_base64, sha256: request.body.sha256 }));
      else if (request.operation === 'attachment.status') receipt = await native(() => fileIpc.pilotFilesStatus({ ...guard, transferId: request.body.transfer_id }));
      else if (request.operation === 'attachment.finalize') receipt = await native(() => fileIpc.pilotFilesFinalize({ ...guard, transferId: request.body.transfer_id }));
      else if (request.operation === 'attachment.abort') receipt = await native(() => fileIpc.pilotFilesAbort({ ...guard, transferId: request.body.transfer_id }));
      else return fail('validation_failed');
      check();
      const result: ContentAttachmentTransferReceipt = { ref, intent_id: receipt.intentId, batch_id: receipt.batchId, transfer_id: receipt.transferId, attachment_id: receipt.attachmentId,
        state: receipt.state, received_bytes: receipt.receivedBytes, total_bytes: receipt.totalBytes, sha256: receipt.sha256, observed_at: receipt.observedAt, expires_at: receipt.expiresAt };
      return result;
    },
    send: async (delivery, scope, beforeEffect) => {
      const request = delivery.request;
      if (request.operation !== 'conversation.send.attachments' && request.operation !== 'conversation.send.status') return fail('validation_failed');
      const ref = request.body.ref, local = (await authorized(scope, ref, beforeEffect)).scope;
      targets.set(stableJson(local), ref); beforeSends.set(stableJson(local), beforeEffect);
      const guard = { assertCurrent: check, authorizeBeforeEffect: async (guardOptions?: { revision: 'expected' | 'consumed' }) => {
        if (request.operation === 'conversation.send.attachments' && guardOptions?.revision === 'expected') await options.validateSendTarget(ref, request.body.expected_revision);
        const authorization = await authorized(scope, ref, beforeEffect);
        if (request.operation === 'conversation.send.attachments' && guardOptions?.revision === 'expected') await options.validateSendTarget(ref, request.body.expected_revision);
        check(); return authorization.executeBefore;
      } };
      try {
        if (request.operation === 'conversation.send.status') return await sender.status(local, ref, request.body.intent_id, guard) ?? fail('not_found');
        return await sender.send(local, request.body, await beforeEffect(), guard);
      } finally { contextIds.delete(ref.conversation_id); targets.delete(stableJson(local)); beforeSends.delete(stableJson(local)); nativeReceipts.clear(); }
    },
    catalog,
    validateCatalog: async (ref, fingerprint, scope, beforeEffect) => { if ((await catalog(ref, scope, beforeEffect)).fingerprint !== fingerprint) fail('stale_revision'); },
    dispose: async () => {
      for (const { scope, deadline } of activeScopes.values()) await fileIpc.pilotFilesAuthorize({ scope, executeBefore: deadline, active: false }).catch(() => undefined);
      activeScopes.clear(); targets.clear(); beforeSends.clear(); contextIds.clear(); nativeReceipts.clear();
    },
  };
}
