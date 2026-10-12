import { expect, test } from 'bun:test';
import { desktopAttachmentFiles, type DesktopAttachmentNativePorts } from './desktopAttachmentFiles';
import type { ConversationCaptures } from './conversationCaptures';
import type { DesktopStorePorts } from './desktopStorePorts';
import type { ContentConversationRef, ContentDelivery } from './contentProtocol';
import { FILE_CAPABILITIES } from './attachmentFilesHost';
import { pilotTaskId } from './taskIdentity';
const bytes = new TextEncoder().encode('Contenu réel de la citation\n');
const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
function harness(implement = false) {
  const taskId = 'task:v1:develop:plan%3Ademo:child';
  const ref: ContentConversationRef = implement ? { kind: 'implement', instance_id: 'instance-demo', workspace_id: 'workspace-demo', task_id: pilotTaskId(taskId), conversation_id: 'conversation-demo' }
    : { kind: 'conversation', instance_id: 'instance-demo', conversation_id: 'conversation-demo' };
  const scope = { accountId: 'account-demo', sessionId: 'mobile-demo', instanceId: ref.instance_id, authorityBinding: 'authority-demo' };
  const scopes: unknown[] = [], reads: number[] = [], effects: string[] = [];
  let mimeType = 'text/plain', authority = scope.authorityBinding, fingerprint = sha;
  const metadata = () => [{ sourceId: 'source-demo', sourceKind: 'citation', citationId: 'citation-demo', citationScope: 'source', contentState: 'available', messageId: 'message-demo', fileName: 'exemple.txt', mimeType, totalBytes: bytes.length, sha256: fingerprint }];
  const nativePorts = {
    pilotFilesAuthorize: async (input: { scope: unknown; active: boolean }) => { scopes.push(input.scope); effects.push(input.active ? 'authorize' : 'retire'); },
    pilotFilesList: async () => metadata(),
    pilotFilesRead: async (input: { sourceId: string; offsetBytes: number }) => { reads.push(input.offsetBytes); expect(input.sourceId).toBe('source-demo'); return { source: metadata()[0], offsetBytes: 0, dataBase64: btoa(String.fromCharCode(...bytes)), nextOffsetBytes: null }; },
    pilotFilesBegin: async (input: { scope: unknown; intentId: string; batchId: string; totalBytes: number }) => { scopes.push(input.scope); return { intentId: input.intentId, batchId: input.batchId, transferId: 'transfer-demo', attachmentId: null, state: 'receiving', totalBytes: input.totalBytes, receivedBytes: 0, sha256: sha, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString() }; },
  } as unknown as DesktopAttachmentNativePorts;
  const conversation = { id: ref.conversation_id, scope_mode: implement ? 'Implement' : 'Chat', task_id: implement ? taskId : null, project_id: 'project-demo' };
  const task = { id: taskId, conversation_id: conversation.id, project_id: 'project-demo', task_source: 'manual' };
  const ports = { chat: () => ({ conversations: [conversation], messagesByConversationId: {}, getMessageImages: () => [] }), tasks: () => ({ tasks: [task] }), app: () => ({ standaloneProjects: [], projectGroups: [] }) } as unknown as DesktopStorePorts;
  const captures = { refreshCatalogMetadata: async () => ({ refs: [ref] }) } as unknown as ConversationCaptures;
  const source = desktopAttachmentFiles({ instanceId: ref.instance_id, workspaceId: 'workspace-demo', ports, conversations: captures,
    signal: new AbortController().signal, nativePorts, validateSendTarget: async () => undefined });
  const guard = async () => new Date(Date.now() + 5000).toISOString();
  const delivery = (operation: string, body: unknown) => ({ transport_version: '2.0', type: 'delivery', account_id: scope.accountId, instance_id: scope.instanceId,
    source_session_id: scope.sessionId, authority_binding: authority, capabilities: [...FILE_CAPABILITIES], expires_at: new Date(Date.now() + 60000).toISOString(), request_id: 'request-demo',
    request: { contract_version: '2.0', type: 'request', account_id: scope.accountId, request_id: 'request-demo', operation, body } }) as unknown as ContentDelivery;
  return { source, ref, scope, guard, scopes, reads, effects, delivery, changeDigest: () => { fingerprint = '0'.repeat(64); }, type: (type: string) => { mimeType = type; } };
}
test('maps a branch-qualified Implement task and keeps workspace distinct from project', async () => {
  const h = harness(true);
  const result = await h.source.transfer(h.delivery('attachment.begin', { ref: h.ref, intent_id: 'intent-demo', batch_id: 'batch-demo', intent_expires_at: new Date(Date.now() + 10000).toISOString(), file_name: 'exemple.txt', mime_type: 'text/plain', total_bytes: bytes.length, sha256: sha }), h.scope, h.guard);
  expect(result.ref).toEqual(h.ref);
  expect(h.scopes.at(-1)).toMatchObject({ ...h.scope, ref: { conversationId: h.ref.conversation_id, conversationKind: 'implement', workspaceId: 'workspace-demo', projectId: 'project-demo', taskId: 'task:v1:develop:plan%3Ademo:child' } });
});
test('exports the full source citation bytes with source provenance and verifies their digest', async () => {
  const h = harness(); const catalog = await h.source.catalog(h.ref, h.scope, h.guard);
  expect(catalog.files[0].entry.source).toMatchObject({ kind: 'citation', citation_scope: 'source', citation_id: 'citation-demo', message_id: 'message-demo' });
  expect(catalog.files[0].entry.sha256).toBeNull();
  expect((await catalog.files[0].read())?.bytes).toEqual(bytes); expect(h.reads).toEqual([0]);
  h.changeDigest(); await expect(h.source.validateCatalog(h.ref, catalog.fingerprint, h.scope, h.guard)).rejects.toThrow('stale_revision');
});
test('refuses byte corruption before an export can become a file capture', async () => {
  const h = harness(); h.changeDigest(); const catalog = await h.source.catalog(h.ref, h.scope, h.guard);
  await expect(catalog.files[0].read()).rejects.toThrow('integrity_failed');
});
test('retirement clears native authority without deleting local message sources', async () => {
  const h = harness(); await h.source.catalog(h.ref, h.scope, h.guard); await h.source.dispose?.();
  expect(h.effects.at(-1)).toBe('retire'); expect(h.reads).toHaveLength(0);
});
