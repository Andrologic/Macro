import type {
  ContentAttachmentSendReceipt, ContentAttachmentTransferReceipt, ContentConversationFileCapture,
  ContentConversationFileEntry, ContentConversationFileChunk, ContentConversationRef,
  ContentDelivery, ContentPage,
} from './contentProtocol';
import { inspectAttachmentImage } from './attachmentImagePolicy';
import { controlledText, type TextPolicy } from './conversationText';
import { stableJson } from './protocol';

export const FILE_CAPABILITIES = ['attachment-transfer-1', 'conversation-attachments-1', 'conversation-files-1'] as const;
export const FILE_OPERATIONS = new Set([
  'attachment.begin', 'attachment.chunk', 'attachment.status', 'attachment.finalize', 'attachment.abort',
  'conversation.send.attachments', 'conversation.send.status', 'conversation.files.list', 'conversation.file.capture', 'conversation.file.read',
]);
export const FILE_LIMITS = { file: 2 * 1024 * 1024, chunk: 64 * 1024, captureMs: 5 * 60 * 1000,
  instanceMemory: 128 * 1024 * 1024, sessionMemory: 96 * 1024 * 1024, instanceCaptures: 64, sessionCaptures: 32, catalog: 2000, page: 64 } as const;
export function fileCapability(operation: string): typeof FILE_CAPABILITIES[number] | null {
  if (operation.startsWith('attachment.')) return 'attachment-transfer-1';
  if (operation === 'conversation.send.attachments' || operation === 'conversation.send.status') return 'conversation-attachments-1';
  if (operation === 'conversation.files.list' || operation === 'conversation.file.capture' || operation === 'conversation.file.read') return 'conversation-files-1';
  return null;
}
export interface FileScope { accountId: string; sessionId: string; instanceId: string; authorityBinding: string }
export interface FileEffectGuard { (): Promise<string> }
export interface FileDescriptor {
  entry: ContentConversationFileEntry;
  allocationBytes?: number;
  /** Reads only this attested resource. No caller-provided filesystem path. */
  read(): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}
export interface FileCatalog { fingerprint: string; files: FileDescriptor[] }
export interface AttachmentFileSource {
  available?(): boolean;
  validateTarget(ref: ContentConversationRef): Promise<void>;
  transfer(delivery: ContentDelivery, scope: FileScope, beforeEffect: FileEffectGuard): Promise<ContentAttachmentTransferReceipt>;
  send(delivery: ContentDelivery, scope: FileScope, beforeEffect: FileEffectGuard): Promise<ContentAttachmentSendReceipt>;
  catalog(ref: ContentConversationRef, scope: FileScope, beforeEffect: FileEffectGuard): Promise<FileCatalog>;
  /** Metadata-only comparison with the observation that attested the resource. */
  validateCatalog(ref: ContentConversationRef, fingerprint: string, scope: FileScope, beforeEffect: FileEffectGuard): Promise<void>;
  dispose?(): Promise<void>;
}
interface RecordBase { binding: string; session: string; ref: ContentConversationRef; expires: number; reserved: number; fingerprint: string }
interface CatalogRecord extends RecordBase { kind: 'catalog'; files: FileDescriptor[]; page: Omit<ContentPage, 'offset' | 'next_cursor'>; cursors: Map<string, number> }
interface CaptureRecord extends RecordBase { kind: 'file'; capture: ContentConversationFileCapture; bytes: Uint8Array | null }
const fail = (code: string): never => { throw new Error(code); };
const encode = (bytes: Uint8Array): string => {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
}
function controlledName(name: string, policy: TextPolicy): string {
  const exported = controlledText(name, policy, 480);
  return /^[^/\\]{1,120}$/u.test(name) && ![...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && exported.content_state === 'complete' ? name : 'Fichier masqué';
}
function inspect(bytes: Uint8Array, mime: string, policy: TextPolicy): ContentConversationFileCapture['content_state'] {
  if (bytes.length > FILE_LIMITS.file) return 'too_large';
  if (mime.startsWith('image/')) {
    const magic = String.fromCharCode(...bytes.subarray(0, 12));
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).join(',') === '137,80,78,71,13,10,26,10' :
      mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      mime === 'image/gif' ? magic.startsWith('GIF87a') || magic.startsWith('GIF89a') :
      mime === 'image/webp' ? magic.startsWith('RIFF') && magic.slice(8) === 'WEBP' : false;
    if (!valid) return 'unsupported';
    // Inspect the complete binary representation too: image comments and metadata
    // may contain a native path or a credential after the first fragment.
    const inspection = { ...policy, inspectionBytes: FILE_LIMITS.file * 4 };
    const decoded = new TextDecoder().decode(bytes);
    let latin = ''; for (let i = 0; i < bytes.length; i += 8192) latin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return controlledText(decoded, inspection, FILE_LIMITS.file * 4).content_state === 'complete' &&
      controlledText(latin, inspection, FILE_LIMITS.file * 4).content_state === 'complete' ? inspectAttachmentImage(bytes, mime) : 'withheld';
  }
  if (!mime.startsWith('text/') && !['application/json', 'application/xml', 'application/x-ndjson', 'application/javascript', 'application/yaml', 'application/x-yaml'].includes(mime)) return 'unsupported';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) return 'unsupported';
    return controlledText(text, { ...policy, inspectionBytes: FILE_LIMITS.file }, FILE_LIMITS.file).content_state === 'complete' ? 'available' : 'withheld';
  } catch { return 'unsupported'; }
}

/** Desktop-only bounded captures. Transport guards remain fresh at every effect
 * and emission; a different authority incarnation cannot read an old capture. */
export class AttachmentFilesHost {
  private records = new Map<string, CatalogRecord | CaptureRecord>();
  private reserved = new Map<string, { session: string; bytes: number }>();
  private enabled = new Set<string>();
  private disposed = false;
  private epoch = 0;
  constructor(private readonly source: AttachmentFileSource, private readonly now = Date.now) {}
  available(): boolean { return !this.disposed && (this.source.available?.() ?? true); }
  enable(capabilities: readonly string[]): void { this.enabled = new Set(this.available() ? capabilities : []); if (!this.enabled.has('conversation-files-1')) this.clear(); }
  clear(): void { this.epoch++; this.records.clear(); this.reserved.clear(); }
  private check(): void { if (this.disposed) fail('unavailable'); }
  private sweep(): void { for (const [id, record] of this.records) if (record.expires <= this.now()) this.records.delete(id); }
  private binding(scope: FileScope, ref: ContentConversationRef): string { return stableJson([scope, ref]); }
  private reserve(session: string, bytes: number, replacement?: string): string {
    this.sweep();
    const allocations = [...this.records.values()].map(r => ({ session: r.session, bytes: r.reserved })).concat([...this.reserved.entries()].filter(([id]) => id !== replacement).map(([, value]) => value));
    if (allocations.length >= FILE_LIMITS.instanceCaptures || allocations.filter(r => r.session === session).length >= FILE_LIMITS.sessionCaptures ||
      allocations.reduce((sum, r) => sum + r.bytes, bytes) > FILE_LIMITS.instanceMemory ||
      allocations.filter(r => r.session === session).reduce((sum, r) => sum + r.bytes, bytes) > FILE_LIMITS.sessionMemory) fail('resource_limit');
    const token = replacement ?? crypto.randomUUID(); this.reserved.set(token, { session, bytes }); return token;
  }
  private async validateCatalog(ref: ContentConversationRef, fingerprint: string, scope: FileScope, guard: FileEffectGuard): Promise<void> {
    const token = this.reserve(scope.sessionId, 32 * 1024 * 1024);
    try { await this.source.validateCatalog(ref, fingerprint, scope, guard); }
    finally { this.reserved.delete(token); }
  }
  private scope(delivery: ContentDelivery): FileScope {
    const capability = fileCapability(delivery.request.operation);
    if (!capability || !delivery.capabilities?.includes(capability) || !this.enabled.has(capability) || !delivery.authority_binding) fail('validation_failed');
    return { accountId: delivery.account_id, sessionId: delivery.source_session_id, instanceId: delivery.instance_id, authorityBinding: delivery.authority_binding! };
  }
  private record(scope: FileScope, ref: ContentConversationRef, id: string): CatalogRecord | CaptureRecord {
    this.sweep(); const record = this.records.get(id);
    if (!record || record.binding !== this.binding(scope, ref)) fail('snapshot_expired');
    return record!;
  }
  private async guard(ref: ContentConversationRef, beforeEffect: FileEffectGuard): Promise<string> {
    this.check(); const deadline = await beforeEffect(); this.check();
    await this.source.validateTarget(ref); this.check();
    if (Date.parse(deadline) <= this.now()) fail('unavailable'); return deadline;
  }
  async handle(delivery: ContentDelivery, policy: TextPolicy, beforeEffect: FileEffectGuard): Promise<unknown> {
    const scope = this.scope(delivery); this.check();
    const epoch = this.epoch;
    const checkEpoch = () => { this.check(); if (epoch !== this.epoch) fail('snapshot_expired'); };
    const request = delivery.request;
    if (!FILE_OPERATIONS.has(request.operation)) return fail('validation_failed');
    const ref = (request.body as { ref: ContentConversationRef }).ref;
    const guarded = async () => { checkEpoch(); const deadline = await this.guard(ref, beforeEffect); checkEpoch(); return deadline; };
    await guarded();
    if (request.operation.startsWith('attachment.')) return this.source.transfer(delivery, scope, guarded);
    if (request.operation === 'conversation.send.attachments' || request.operation === 'conversation.send.status') return this.source.send(delivery, scope, guarded);
    if (request.operation === 'conversation.files.list') {
      const continuation = request.body.continuation;
      let id: string, record: CatalogRecord, offset = 0;
      if (continuation) {
        id = continuation.snapshot_id; const current = this.record(scope, ref, id);
        if (current.kind !== 'catalog' || !current.cursors.has(continuation.cursor)) return fail('snapshot_expired');
        record = current; offset = current.cursors.get(continuation.cursor)!;
        await this.validateCatalog(ref, record.fingerprint, scope, guarded); await guarded();
      } else {
        // Reserve the catalog and its independent metadata validation before allocation.
        const token = this.reserve(scope.sessionId, 64 * 1024 * 1024);
        try {
          const catalog = await this.source.catalog(ref, scope, guarded); this.check();
          if (catalog.files.length > FILE_LIMITS.catalog || new Set(catalog.files.map(file => file.entry.file_id)).size !== catalog.files.length) return fail('resource_limit');
          await guarded(); await this.source.validateCatalog(ref, catalog.fingerprint, scope, guarded); await guarded();
          id = crypto.randomUUID(); const observed = this.now();
          record = { kind: 'catalog', binding: this.binding(scope, ref), session: scope.sessionId, ref, expires: observed + FILE_LIMITS.captureMs,
            reserved: 32 * 1024 * 1024, fingerprint: catalog.fingerprint,
            files: catalog.files.map(file => ({ ...file, entry: { ...file.entry, display_name: controlledName(file.entry.display_name, policy) } })), cursors: new Map(),
            page: { snapshot_id: id, revision: 1, observed_at: new Date(observed).toISOString(), expires_at: new Date(observed + FILE_LIMITS.captureMs).toISOString(), export_policy_revision: 'visible-1', total: catalog.files.length } };
          checkEpoch(); this.records.set(id, record);
        } finally { this.reserved.delete(token); }
      }
      const items = record.files.slice(offset, offset + FILE_LIMITS.page).map(file => file.entry);
      const next = offset + items.length;
      let cursor: string | null = null;
      if (next < record.files.length) {
        cursor = [...record.cursors].find(([, value]) => value === next)?.[0] ?? crypto.randomUUID(); record.cursors.set(cursor, next);
      }
      if (record.expires <= this.now()) return fail('snapshot_expired');
      return { page: { ...record.page, offset, next_cursor: cursor }, items };
    }
    if (request.operation === 'conversation.file.capture') {
      // IDs can only be selected from a currently attested, session-bound catalog.
      const catalog = [...this.records.values()].find(record => record.kind === 'catalog' && record.binding === this.binding(scope, ref) && record.expires > this.now() && record.files.some(file => file.entry.file_id === request.body.file_id));
      if (!catalog || catalog.kind !== 'catalog') return fail('snapshot_expired');
      const file = catalog.files.find(file => file.entry.file_id === request.body.file_id)!;
      const token = this.reserve(scope.sessionId, 2048);
      try {
        await this.validateCatalog(ref, catalog.fingerprint, scope, guarded); await guarded();
        let state = file.entry.content_state;
        let bytes: Uint8Array | null = null, mime: string | null = file.entry.mime_type;
        if (state === 'available') {
          // Reserve source representations only while they are being read and
          // inspected; metadata validation has its own independent reservation.
          this.reserve(scope.sessionId, file.allocationBytes ?? FILE_LIMITS.file * 12, token);
          let loaded = await file.read(); await guarded();
          if (!loaded) state = 'unavailable';
          else { mime = loaded.mimeType; state = inspect(loaded.bytes, loaded.mimeType, policy); if (state === 'available') bytes = loaded.bytes; }
          loaded = null;
          this.reserve(scope.sessionId, bytes ? FILE_LIMITS.file * 3 : 2048, token);
          await this.validateCatalog(ref, catalog.fingerprint, scope, guarded); await guarded();
        }
        const sha = bytes ? await digest(bytes) : null; await guarded();
        const observed = this.now(), id = crypto.randomUUID();
        const capture: ContentConversationFileCapture = { ref, file_id: request.body.file_id, snapshot_id: id,
          observed_at: new Date(observed).toISOString(), expires_at: new Date(observed + FILE_LIMITS.captureMs).toISOString(), export_policy_revision: 'visible-1',
          content_state: state, mime_type: state === 'available' ? mime : null, total_bytes: bytes?.length ?? null, sha256: sha };
        checkEpoch(); this.records.set(id, { kind: 'file', binding: this.binding(scope, ref), session: scope.sessionId, ref, expires: observed + FILE_LIMITS.captureMs,
          reserved: bytes ? FILE_LIMITS.file * 3 : 2048, fingerprint: catalog.fingerprint, capture, bytes });
        return capture;
      } finally { this.reserved.delete(token); }
    }
    if (request.operation === 'conversation.file.read') {
      const record = this.record(scope, ref, request.body.snapshot_id);
      if (record.kind !== 'file' || record.capture.file_id !== request.body.file_id) return fail('snapshot_expired');
      await this.validateCatalog(ref, record.fingerprint, scope, guarded); await guarded();
      if (record.expires <= this.now()) return fail('snapshot_expired');
      const offset = request.body.offset_bytes;
      if (record.bytes && offset > record.bytes.length) return fail('validation_failed');
      const chunk = record.bytes?.subarray(offset, offset + FILE_LIMITS.chunk) ?? null;
      const result: ContentConversationFileChunk = { ref, file_id: request.body.file_id, snapshot_id: request.body.snapshot_id, content_state: record.capture.content_state,
        offset_bytes: offset, total_bytes: record.bytes?.length ?? null, data_base64: chunk ? encode(chunk) : null, sha256: record.capture.sha256,
        next_offset_bytes: record.bytes && offset + (chunk?.length ?? 0) < record.bytes.length ? offset + chunk!.length : null };
      return result;
    }
    return fail('validation_failed');
  }
  async validateEmission(delivery: ContentDelivery, result: unknown, beforeEffect: FileEffectGuard): Promise<void> {
    const scope = this.scope(delivery), ref = (delivery.request.body as { ref: ContentConversationRef }).ref;
    let deadline = 0;
    const guarded = async () => { const value = await this.guard(ref, beforeEffect); deadline = Date.parse(value); return value; };
    await guarded();
    if (result && typeof result === 'object' && 'snapshot_id' in result && typeof result.snapshot_id === 'string') {
      const record = this.record(scope, ref, result.snapshot_id);
      await this.validateCatalog(ref, record.fingerprint, scope, guarded);
      if (deadline <= this.now()) fail('unavailable');
      this.record(scope, ref, result.snapshot_id);
    } else if (result && typeof result === 'object' && 'page' in result) {
      const page = result.page as ContentPage;
      const record = this.record(scope, ref, page.snapshot_id);
      await this.validateCatalog(ref, record.fingerprint, scope, guarded);
      if (deadline <= this.now()) fail('unavailable');
      this.record(scope, ref, page.snapshot_id);
    }
  }
  async dispose(): Promise<void> { this.disposed = true; this.clear(); await this.source.dispose?.(); }
}
