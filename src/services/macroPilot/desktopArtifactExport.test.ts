import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { useAppStore } from '../../stores/useAppStore';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../../test-utils/tauriRuntime';
import { getPlanArtifactContentPath, getPlanArtifactIndexPath, taskArtifactContentHash } from '../architectPlanArtifactService';
import { toTaskRuntimeId } from '../durableIdentity';
import type { ArchitectPlanRecord } from '../architectPlanService';
import { desktopAttachmentFiles, type DesktopAttachmentNativePorts } from './desktopAttachmentFiles';
import { AttachmentFilesHost, FILE_CAPABILITIES } from './attachmentFilesHost';
import type { ContentConversationFileCapture, ContentConversationFileEntry, ContentConversationRef, ContentDelivery } from './contentProtocol';
import type { DesktopStorePorts } from './desktopStorePorts';
import type { ConversationCaptures } from './conversationCaptures';
import { pilotTaskId } from './taskIdentity';

const branchName = 'feature/artifact-export';
const planId = 'plan-demo';
const taskId = toTaskRuntimeId({ branchName, planId, nodeId: 'child' });
const ref: ContentConversationRef = { kind: 'implement', instance_id: 'instance-demo', workspace_id: 'workspace-demo', conversation_id: 'conversation-demo', task_id: pilotTaskId(taskId) };
const contentPath = getPlanArtifactContentPath(branchName, planId, 'child', 'result', 'text');
const indexPath = getPlanArtifactIndexPath(branchName, planId);
const planPath = `branches/${branchName}/plans/${planId}/plan.json`;
const original = 'audit-2b7a8c568e923c6dc256';
const changed = 'audit-ee22858f3f5118aaaf53';
const files = new Map<string, string>();
const reads: string[] = [];
const guard = async () => new Date(Date.now() + 5000).toISOString();
const delivery = (operation: string, body: unknown) => ({ account_id: 'account-demo', instance_id: ref.instance_id, source_session_id: 'mobile-demo', authority_binding: 'binding-demo', capabilities: [...FILE_CAPABILITIES], request: { operation, body } }) as ContentDelivery;

function harness() {
  const task = { id: taskId, node_id: 'child', plan_id: planId, task_source: 'architect', plan_storage_branch: branchName, dependencies: [], conversation_id: ref.conversation_id };
  const ports = { chat: () => ({ conversations: [{ id: ref.conversation_id, scope_mode: 'Implement', task_id: taskId, project_id: 'project-demo' }], messagesByConversationId: {}, getMessageImages: () => [] }), tasks: () => ({ tasks: [task] }), app: () => useAppStore.getState() } as unknown as DesktopStorePorts;
  const source = desktopAttachmentFiles({ instanceId: ref.instance_id, workspaceId: 'workspace-demo', ports, signal: new AbortController().signal,
    conversations: { refreshCatalogMetadata: async () => ({ refs: [ref] }) } as unknown as ConversationCaptures,
    nativePorts: { pilotFilesAuthorize: async () => undefined, pilotFilesList: async () => [] } as unknown as DesktopAttachmentNativePorts, validateSendTarget: async () => undefined });
  source.available = () => true;
  const host = new AttachmentFilesHost(source); host.enable(FILE_CAPABILITIES);
  const run = (operation: string, body: unknown) => host.handle(delivery(operation, body), { revision: 'policy-demo', secrets: [] }, guard);
  return { host, source, run };
}

beforeEach(() => {
  files.clear(); reads.length = 0;
  useAppStore.setState({ standaloneProjects: [{ id: 'project-demo', name: 'Project', mountName: 'project-demo', path: '/synthetic/project-demo', created_at: '', status: 'active', gitSetupState: 'ready', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] } }], projectGroups: [], selectedProjectId: null, selectedGroupId: null });
  const plan: ArchitectPlanRecord = { id: planId, slug: 'plan-demo', title: 'Plan', description: '', status: 'draft', targetBranch: branchName, projectIds: ['project-demo'], createdAt: '2026-01-01', updatedAt: '2026-01-01', nodes: [{ id: 'child', title: 'Child', type: 'task', status: 'pending', dependencies: [], projectIds: ['project-demo'] }], predictedBranches: [] };
  files.set(planPath, JSON.stringify(plan));
  files.set(indexPath, JSON.stringify({ schemaVersion: 1, planId, updatedAt: '2026-01-01', artifacts: [{ id: 'result', planId, taskId: 'child', path: contentPath, contentType: 'text', contentHash: taskArtifactContentHash(original), title: 'Result', summary: '', kind: 'note', createdAt: '2026-01-01', updatedAt: '2026-01-01', createdBy: 'agent' }] }));
  files.set(contentPath, original);
  installTauriRuntimeMock(mock(async (command, payload) => {
    if (command === 'workspace_get_active_root') throw new Error('No workspace fallback.');
    const path = String(payload?.path ?? '');
    if (command === 'fs_exists') return files.has(path);
    if (command === 'fs_read_file') {
      expect(payload?.allowOutsideWorkspace).toBe(false);
      reads.push(path);
      const content = files.get(path); if (content === undefined) throw new Error('Missing file.');
      return { content, revision: 'unchanged-native-revision' };
    }
    throw new Error(`Unexpected command: ${command}`);
  }));
});
afterEach(() => { removeTauriRuntimeMock(); useAppStore.setState({ standaloneProjects: [], projectGroups: [] }); });

test('exports actual artifact bytes through bounded plan reader, adapter and host', async () => {
  const h = harness();
  const listing = await h.run('conversation.files.list', { ref }) as { items: ContentConversationFileEntry[] };
  expect(listing.items).toHaveLength(1); expect(listing.items[0]!.source.kind).toBe('task_artifact');
  expect(JSON.stringify(listing)).not.toContain('/synthetic');
  const fileId = listing.items[0]!.file_id;
  const capture = await h.run('conversation.file.capture', { ref, file_id: fileId }) as ContentConversationFileCapture;
  expect(capture.content_state).toBe('available');
  expect(capture.sha256).toBe(new Bun.CryptoHasher('sha256').update(original).digest('hex'));
  await h.host.validateEmission(delivery('conversation.file.capture', { ref, file_id: fileId }), capture, guard);
  const result = await h.run('conversation.file.read', { ref, file_id: fileId, snapshot_id: capture.snapshot_id, offset_bytes: 0 }) as { data_base64: string };
  expect(atob(result.data_base64)).toBe(original);
  expect(reads).toContain(planPath); expect(reads).toContain(indexPath); expect(reads).toContain(contentPath);
  await h.host.dispose();
});

test('rejects an actual source change even when its workflow contentHash is identical', async () => {
  expect(taskArtifactContentHash(changed)).toBe(taskArtifactContentHash(original));
  const h = harness(); const listing = await h.run('conversation.files.list', { ref }) as { items: ContentConversationFileEntry[] };
  const fileId = listing.items[0]!.file_id;
  const capture = await h.run('conversation.file.capture', { ref, file_id: fileId }) as ContentConversationFileCapture;
  files.set(contentPath, changed);
  await expect(h.host.validateEmission(delivery('conversation.file.capture', { ref, file_id: fileId }), capture, guard)).rejects.toThrow('stale_revision');
  await expect(h.run('conversation.file.read', { ref, file_id: fileId, snapshot_id: capture.snapshot_id, offset_bytes: 0 })).rejects.toThrow('stale_revision');
  await h.host.dispose();
});

test('rejects oversized plan metadata before parsing an artifact index', async () => {
  files.set(planPath, ' '.repeat(1024 * 1024 + 1));
  const h = harness(); await expect(h.run('conversation.files.list', { ref })).rejects.toThrow();
  expect(reads).not.toContain(indexPath); expect(reads).not.toContain(contentPath);
  await h.host.dispose();
});
