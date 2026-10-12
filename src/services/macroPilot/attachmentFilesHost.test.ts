import { describe, expect, test } from 'bun:test';
import { AttachmentFilesHost, FILE_CAPABILITIES, FILE_LIMITS, type AttachmentFileSource, type FileDescriptor } from './attachmentFilesHost';
import type { ContentConversationFileCapture, ContentConversationFileEntry, ContentDelivery, ContentPage } from './contentProtocol';

const ref = { instance_id: 'desktop-demo', kind: 'conversation' as const, conversation_id: 'conversation-demo' };
const entry = (id: string): ContentConversationFileEntry => ({ file_id: id, display_name: 'exemple.txt', mime_type: 'text/plain', size_bytes: null, sha256: null,
  source: { kind: 'citation', message_id: 'message-demo', artifact_id: null, citation_id: id, citation_scope: 'source' }, content_state: 'available' });
function harness(files: FileDescriptor[] = [{ entry: entry('file-demo'), read: async () => ({ bytes: new TextEncoder().encode('Bonjour\n'), mimeType: 'text/plain' }) }]) {
  let now = Date.parse('2026-10-12T12:00:00Z'), fingerprint = 'observation-demo', reads = 0;
  const source: AttachmentFileSource = { validateTarget: async () => undefined,
    transfer: async () => { throw new Error('not_used'); }, send: async () => { throw new Error('not_used'); },
    catalog: async () => { reads++; return { fingerprint, files }; },
    validateCatalog: async (_ref, expected) => { if (expected !== fingerprint) throw new Error('stale_revision'); } };
  const host = new AttachmentFilesHost(source, () => now); host.enable(FILE_CAPABILITIES);
  const guard = async () => new Date(now + 5000).toISOString();
  const delivery = (operation: string, body: unknown, binding = 'authority-demo', session = 'mobile-demo') => ({ transport_version: '2.0', type: 'delivery', account_id: 'account-demo',
    request_id: crypto.randomUUID(), source_session_id: session, instance_id: ref.instance_id, capabilities: [...FILE_CAPABILITIES], authority_binding: binding,
    expires_at: new Date(now + 60000).toISOString(), request: { contract_version: '2.0', type: 'request', account_id: 'account-demo', request_id: 'request-demo', operation, body } }) as unknown as ContentDelivery;
  const run = (operation: string, body: unknown, binding?: string, session?: string, secrets: string[] = []) => host.handle(delivery(operation, body, binding, session), { revision: 'visible-1', secrets }, guard);
  return { host, run, delivery, guard, advance: (ms: number) => { now += ms; }, change: () => { fingerprint += ':changed'; }, reads: () => reads };
}
async function capture(h: ReturnType<typeof harness>, file = 'file-demo', secrets: string[] = []) {
  await h.run('conversation.files.list', { ref }, undefined, undefined, secrets);
  return await h.run('conversation.file.capture', { ref, file_id: file }, undefined, undefined, secrets) as ContentConversationFileCapture;
}
describe('desktop file captures', () => {
  test('hashes the actual exported bytes and reads raw chunks under the same attestation', async () => {
    const h = harness(); const cap = await capture(h);
    const read = await h.run('conversation.file.read', { ref, file_id: 'file-demo', snapshot_id: cap.snapshot_id, offset_bytes: 0 }) as { data_base64: string; sha256: string; next_offset_bytes: null };
    expect(atob(read.data_base64)).toBe('Bonjour\n');
    expect(read.sha256).toBe(cap.sha256!); expect(read.next_offset_bytes).toBeNull();
    expect(cap.sha256).toBe(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Bonjour\n'))), b => b.toString(16).padStart(2, '0')).join(''));
  });
  test('does not grant access to a capture after authority restoration or from another session', async () => {
    const h = harness(); const cap = await capture(h); const body = { ref, file_id: 'file-demo', snapshot_id: cap.snapshot_id, offset_bytes: 0 };
    await expect(h.run('conversation.file.read', body, 'authority-restored')).rejects.toThrow('snapshot_expired');
    await expect(h.run('conversation.file.read', body, undefined, 'mobile-other')).rejects.toThrow('snapshot_expired');
  });
  test('rejects a hidden capability and a missing authority before touching the source', async () => {
    const h = harness(); h.host.enable([]);
    await expect(h.run('conversation.files.list', { ref })).rejects.toThrow('validation_failed'); expect(h.reads()).toBe(0);
    h.host.enable(FILE_CAPABILITIES);
    const delivery = h.delivery('conversation.files.list', { ref }); delete delivery.authority_binding;
    await expect(h.host.handle(delivery, { revision: 'visible-1', secrets: [] }, h.guard)).rejects.toThrow('validation_failed'); expect(h.reads()).toBe(0);
  });
  test('inspects the whole text before the first read, including secrets after the first chunk', async () => {
    const secret = 'synthetic-credential-demo';
    const h = harness([{ entry: entry('file-demo'), read: async () => ({ bytes: new TextEncoder().encode('a'.repeat(FILE_LIMITS.chunk + 20) + secret), mimeType: 'text/plain' }) }]);
    const cap = await capture(h, 'file-demo', [secret]); expect(cap.content_state).toBe('withheld'); expect(cap.total_bytes).toBeNull(); expect(cap.sha256).toBeNull();
    const read = await h.run('conversation.file.read', { ref, file_id: 'file-demo', snapshot_id: cap.snapshot_id, offset_bytes: 0 }) as { data_base64: null };
    expect(read.data_base64).toBeNull();
  });
  test('inspects full image metadata and withholds a native path after the first fragment', async () => {
    const tail = new TextEncoder().encode('/home/synthetic/private.txt');
    const bytes = new Uint8Array(FILE_LIMITS.chunk + 100); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set(tail, FILE_LIMITS.chunk + 1);
    const h = harness([{ entry: { ...entry('file-demo'), mime_type: 'image/png' }, read: async () => ({ bytes, mimeType: 'image/png' }) }]);
    const cap = await capture(h); expect(cap.content_state).toBe('withheld'); expect(cap.sha256).toBeNull();
  });
  test('does not retain a late file read after a policy invalidation', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const loading = new Promise<void>(resolve => { started = resolve; });
    const h = harness([{ entry: entry('file-demo'), read: async () => { started(); await wait; return { bytes: new TextEncoder().encode('Bonjour'), mimeType: 'text/plain' }; } }]);
    await h.run('conversation.files.list', { ref });
    const pending = h.run('conversation.file.capture', { ref, file_id: 'file-demo' });
    await loading; h.host.clear(); release();
    await expect(pending).rejects.toThrow('snapshot_expired');
    await expect(h.run('conversation.file.capture', { ref, file_id: 'file-demo' })).rejects.toThrow('snapshot_expired');
  });
  test('captures expire absolutely and reads do not extend them', async () => {
    const h = harness(); const cap = await capture(h); h.advance(FILE_LIMITS.captureMs - 1);
    await h.run('conversation.file.read', { ref, file_id: 'file-demo', snapshot_id: cap.snapshot_id, offset_bytes: 0 }); h.advance(1);
    await expect(h.run('conversation.file.read', { ref, file_id: 'file-demo', snapshot_id: cap.snapshot_id, offset_bytes: 0 })).rejects.toThrow('snapshot_expired');
  });
  test('revalidates catalog and expiry before emission after asynchronous transport waits', async () => {
    const h = harness(); const cap = await capture(h); const delivery = h.delivery('conversation.file.capture', { ref, file_id: 'file-demo' }); h.change();
    await expect(h.host.validateEmission(delivery, cap, h.guard)).rejects.toThrow('stale_revision');
    const other = harness(); const later = await capture(other); other.advance(FILE_LIMITS.captureMs);
    await expect(other.host.validateEmission(other.delivery('conversation.file.capture', { ref, file_id: 'file-demo' }), later, other.guard)).rejects.toThrow('snapshot_expired');
  });
  test('compares the source after the final authorization and makes no later authorization call', async () => {
    const h = harness(); const cap = await capture(h);
    const delivery = h.delivery('conversation.file.capture', { ref, file_id: 'file-demo' });
    let calls = 0;
    await expect(h.host.validateEmission(delivery, cap, async () => {
      calls++; if (calls === 1) h.change(); return h.guard();
    })).rejects.toThrow('stale_revision');
    const unchanged = harness(); const fresh = await capture(unchanged); calls = 0;
    await unchanged.host.validateEmission(unchanged.delivery('conversation.file.capture', { ref, file_id: 'file-demo' }), fresh, async () => {
      calls++; return unchanged.guard();
    });
    expect(calls).toBe(1);
  });
  test('never reads a client-provided file identifier without a current catalog', async () => {
    let touched = false;
    const h = harness([{ entry: entry('file-demo'), read: async () => { touched = true; return null; } }]);
    await expect(h.run('conversation.file.capture', { ref, file_id: 'file-demo' })).rejects.toThrow('snapshot_expired'); expect(touched).toBe(false);
  });
  test('reserves the bounded catalog before allocating, then frees expired allocations', async () => {
    const h = harness();
    for (let i = 0; i < Math.floor(FILE_LIMITS.sessionMemory / (32 * 1024 * 1024)) - 1; i++) await h.run('conversation.files.list', { ref });
    const before = h.reads(); await expect(h.run('conversation.files.list', { ref })).rejects.toThrow('resource_limit'); expect(h.reads()).toBe(before);
    h.advance(FILE_LIMITS.captureMs); await h.run('conversation.files.list', { ref }); expect(h.reads()).toBe(before + 1);
  });
  test('paginates a frozen catalog with opaque session-bound cursors', async () => {
    const h = harness(Array.from({ length: 65 }, (_, i) => ({ entry: entry(`file-${i}`), read: async () => null })));
    const first = await h.run('conversation.files.list', { ref }) as { page: ContentPage; items: ContentConversationFileEntry[] };
    const continuation = { snapshot_id: first.page.snapshot_id, cursor: first.page.next_cursor! };
    const second = await h.run('conversation.files.list', { ref, continuation }) as typeof first;
    expect(first.items.length).toBe(64); expect(second.items.map(item => item.file_id)).toEqual(['file-64']); expect(second.page.offset).toBe(64);
    await expect(h.run('conversation.files.list', { ref, continuation }, undefined, 'mobile-other')).rejects.toThrow('snapshot_expired');
  });
});
