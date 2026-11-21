import { validatePortableMetadata, validatePortableHeader, validatePortableOriginLink, validatePortableRedundancy } from '../../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import type { ChatMessage } from '../../types';
import type { Citation } from '../../types/citation';
import type { TextPolicy } from '../macroPilot/conversationText';
import { parseStoredJsonStrict } from './jsonValues';
import { PortableWorkBudget, samePortablePolicy } from './portableHistoryInspection';
import { PORTABLE_SOURCE_LIMITS, portableDigest, portableRetainedJsonKind, inspectPortableRecordContent, type PortableMetadata, type PortableRecord } from './portableChatHistory';

export interface PortableArchiveBinding { version: 1; importKey: string; manifest: string }
export interface PortableArchiveFragment { record: PortableRecord; offset: number; bytes: Uint8Array; targetUuid: string | null }
export interface PortableArchivePage { fragments: PortableArchiveFragment[]; next: { ordinal: number; offset: number } | null }
/** Internal adapter over one authorized sealed E import; no cross-import read. */
export interface PortableArchivePort {
  binding: PortableArchiveBinding;
  profile: 'portable_chat_history_v1';
  records: number;
  read(cursor: { ordinal: number; offset: number } | null, limit: number): Promise<PortableArchivePage>;
}
export interface PortableProjection {
  binding: PortableArchiveBinding;
  messages: ChatMessage[];
  citations: Citation[];
  images: Record<string, { id: string; mimeType: string; dataUrl: string; createdAt: string }[]>;
}
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = (code: string): never => { throw new Error(code); };
function metadata(value: unknown): PortableMetadata { return validatePortableMetadata(value); }
const assetMime = { text_plain: 'text/plain', image_png: 'image/png', image_jpeg: 'image/jpeg', image_webp: 'image/webp' } as const;
const keyFor = (entry: PortableMetadata) => `${entry.source.family}:${entry.source.row}`;

/** Only the already validated, closed PortableMetadata graph is measured here.
 * Objects: 256; property slots: 64; strings (including keys): 64 + 2/code unit;
 * scalars: 16; arrays: 128 + 16/slot. The extra 512 owns the Map entry and lease.
 * Measurement scratch remains inside withRecord's generic 256/input-byte scope. */
function retainedMetadataUnits(value: PortableMetadata): number {
  const graph = (entry: unknown): number => {
    if (typeof entry === 'string') return 64 + entry.length * 2;
    if (entry === null || typeof entry !== 'object') return 16;
    if (Array.isArray(entry)) return 128 + entry.reduce((total, item) => total + 16 + graph(item), 0);
    return 256 + Object.entries(entry).reduce((total, [key, nested]) => total + 64 + 64 + key.length * 2 + graph(nested), 0);
  };
  return 512 + graph(value);
}

/** Ephemeral admitted metadata index. Payloads remain in native E storage.
 * Projection deliberately materializes O(N) and is valid only inside its scope. */
export class PortableHistoryArchive {
  private headers: PortableRecord[] = [];
  private uuids: (string | null)[] = [];
  private origins = new Map<number, PortableMetadata>();
  private releases: (() => void)[] = [];
  private opened = false;
  private policySnapshot: TextPolicy | null = null;
  constructor(private readonly port: PortableArchivePort, private readonly policy: () => Promise<TextPolicy>, private readonly budget: PortableWorkBudget) {}
  private keep(bytes: number): void { this.releases.push(this.budget.reserve(bytes)); }
  dispose(): void { this.headers = []; this.uuids = []; this.origins.clear(); this.opened = false; this.policySnapshot = null; for (const release of this.releases.splice(0)) release(); }
  private async page(cursor: { ordinal: number; offset: number } | null, consumePage: (page: PortableArchivePage) => Promise<void>): Promise<void> {
    const release = this.budget.reserve(32 * (4093 * 8 + 8192));
    try {
      const page = await this.port.read(cursor, 32);
      if (!page.fragments.length || page.fragments.length > 32 || page.fragments.some(fragment => fragment.bytes.length > 4093)) fail('resource_limit');
      await consumePage(page);
    } finally { release(); }
  }
  async open(): Promise<void> {
    this.dispose();
    if (this.port.profile !== 'portable_chat_history_v1' || this.port.binding.version !== 1 || !/^[a-f0-9]{64}$/.test(this.port.binding.manifest) || !Number.isSafeInteger(this.port.records) || this.port.records < 1) fail('invalid_profile');
    let cursor: { ordinal: number; offset: number } | null = null, current = -1, offset = 0;
    try {
      do {
        let next: { ordinal: number; offset: number } | null = null;
        await this.page(cursor, async page => {
          if (!page.fragments.length) fail('integrity_failed');
          for (const fragment of page.fragments) {
            const record = validatePortableHeader(fragment.record);
            if (record.ordinal !== current) {
              if (current >= 0 && offset !== this.headers[current].bytes) fail('integrity_failed');
              if (record.ordinal !== current + 1 || fragment.offset !== 0 || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) fail('integrity_failed');
              current++; offset = 0;
              this.keep(512 + JSON.stringify(record).length * 8);
              this.headers.push(record); this.uuids.push(fragment.targetUuid);
              if (record.entry.kind !== 'association' && (typeof fragment.targetUuid !== 'string' || !/^[a-f0-9-]{36}$/.test(fragment.targetUuid))) fail('integrity_failed');
            } else if (JSON.stringify(record) !== JSON.stringify(this.headers[current]) || fragment.targetUuid !== this.uuids[current]) fail('integrity_failed');
            if (fragment.offset !== offset || offset + fragment.bytes.length > record.bytes || (!fragment.bytes.length && record.bytes !== 0)) fail('integrity_failed');
            offset += fragment.bytes.length;
          }
          next = page.next;
          if (next && (next.ordinal !== current || next.offset !== offset) && (next.ordinal !== current + 1 || next.offset !== 0)) fail('invalid_cursor');
        });
        cursor = next;
      } while (cursor);
      if (this.headers.length !== this.port.records || offset !== this.headers[current].bytes) fail('integrity_failed');
      const observedPolicy = await this.policy();
      this.keep(512 + observedPolicy.secrets.reduce((sum, value) => sum + value.length * 4 + 32, 0));
      const policy = { ...observedPolicy, secrets: [...observedPolicy.secrets] }; this.policySnapshot = policy;
      for (const header of this.headers) if (header.entry.kind === 'historical_text' && header.entry.purpose === 'portable_metadata') {
        await this.withRecord(header.ordinal, async bytes => {
          const parsed = metadata(parseStoredJsonStrict(decoder.decode(bytes)));
          if (parsed.policy !== policy.revision) fail('policy_changed');
          this.keep(retainedMetadataUnits(parsed)); this.origins.set(header.ordinal, parsed);
        });
      }
      const roots = [...this.origins.values()].filter(origin => origin.captureManifest !== undefined);
      if (roots.length !== 1 || !roots[0].sourceLimits || PORTABLE_SOURCE_LIMITS.some(limit => !roots[0].sourceLimits!.includes(limit)) || !roots[0].remainingLimits?.includes('not_F_admission') || roots[0].reason !== 'capture_provenance_only' || roots[0].source.family !== 0 || roots[0].source.tag !== 0) fail('missing_source_identity');
      for (const [declarationOrdinal, origin] of this.origins) if (origin.classification === 'redundant_representation') {
        const target = this.headers[origin.retained!];
        validatePortableRedundancy(origin, target, target?.origin === undefined ? undefined : this.origins.get(target.origin), declarationOrdinal);
      }
      for (const header of this.headers) {
        if (header.entry.kind === 'association') {
          const { from, to, position, relation } = header.entry;
          if (![from, to, position].every(n => Number.isSafeInteger(n) && n >= 0) || this.headers[from]?.entry.kind !== 'message' ||
              (relation === 'asset_for_message' ? this.headers[to]?.entry.kind !== 'asset' : relation === 'citation_for_message' ? this.headers[to]?.entry.kind !== 'citation' : this.headers[to]?.entry.kind !== 'historical_text')) fail('invalid_association');
        } else if (!(header.entry.kind === 'historical_text' && header.entry.purpose === 'portable_metadata')) {
          if (header.origin === undefined || header.origin >= header.ordinal) fail('invalid_origin');
          validatePortableOriginLink(header, this.origins.get(header.origin!));
        }
      }
      if (!samePortablePolicy(await this.policy(), policy)) fail('policy_changed');
      const messageRecords = new Map<string, number>();
      for (const header of this.headers) if (header.entry.kind === 'message') {
        const origin = this.origins.get(header.origin!)!;
        if (!origin.message || messageRecords.has(origin.message)) fail('invalid_portable_metadata'); messageRecords.set(origin.message!, header.ordinal);
      }
      for (const header of this.headers) if (header.origin !== undefined && header.entry.kind !== 'message') {
        const origin = this.origins.get(header.origin)!;
        if (!origin.message) continue;
        const from = messageRecords.get(origin.message);
        if (from === undefined || !this.headers.some(link => link.entry.kind === 'association' && link.entry.from === from && link.entry.to === header.ordinal)) fail('required_association_missing');
      }
      this.opened = true;
    } catch (error) { this.dispose(); throw error; }
  }
  /** Returned bytes cannot outlive consume. Pages and assembly stay admitted. */
  async withRecord(ordinal: number, consume: (bytes: Uint8Array, uuid: string | null) => Promise<void>): Promise<void> {
    const header = this.headers[ordinal]; if (!header) fail('missing_record');
    const isMetadata = header.entry.kind === 'historical_text' && header.entry.purpose === 'portable_metadata';
    const origin = header.origin === undefined ? undefined : this.origins.get(header.origin);
    // Non-JSON 16x units include raw/UTF-16, decoded formatter attributes,
    // and complete image UTF-8/Latin-1 inspection views before any callback.
    const release = this.budget.reserve(512 + header.bytes * (isMetadata || portableRetainedJsonKind(origin) ? 256 : 16));
    try {
      const bytes = new Uint8Array(header.bytes); let offset = 0, done = false;
      do {
        await this.page({ ordinal, offset }, async page => {
          for (const fragment of page.fragments) {
            if (done) break;
            if (fragment.record.ordinal !== ordinal || fragment.offset !== offset || JSON.stringify(fragment.record) !== JSON.stringify(header) || fragment.targetUuid !== this.uuids[ordinal]) fail('integrity_failed');
            if (offset + fragment.bytes.length > bytes.length) fail('integrity_failed');
            bytes.set(fragment.bytes, offset); offset += fragment.bytes.length;
            done = offset === bytes.length;
          }
          if (!done && (!page.next || page.next.ordinal !== ordinal || page.next.offset !== offset)) fail('incomplete_page');
        });
      } while (!done);
      if (await portableDigest(bytes) !== header.sha256) fail('integrity_failed');
      const policy = await this.policy();
      if (this.policySnapshot && !samePortablePolicy(policy, this.policySnapshot)) fail('policy_changed');
      inspectPortableRecordContent(header, bytes, origin, policy);
      await consume(bytes, this.uuids[ordinal]);
    } finally { release(); }
  }
  async withUuid(uuid: string, consume: (bytes: Uint8Array, ordinal: number) => Promise<void>): Promise<void> {
    if (!this.opened) fail('archive_not_open');
    const ordinal = this.uuids.indexOf(uuid); if (ordinal < 0) fail('missing_record');
    await this.withRecord(ordinal, bytes => consume(bytes, ordinal));
  }
  async withProjection(consume: (projection: PortableProjection) => Promise<void>): Promise<void> {
    if (!this.opened) fail('archive_not_open');
    const policy = await this.policy();
    if ([...this.origins.values()].some(origin => origin.policy !== policy.revision)) fail('policy_changed');
    const selected = this.headers.filter(header => header.entry.kind === 'message' || header.entry.kind === 'citation' || header.entry.kind === 'asset' ||
      (header.origin !== undefined && ['data', 'checkpoint'].includes(this.origins.get(header.origin)!.meaning ?? '')));
    // Includes per-message display provenance and the final ordinal map.
    const release = this.budget.reserve(4096 + selected.reduce((total, header) => total + header.bytes * 16 + 4096, 0));
    try {
      let messages: ChatMessage[] = [];
      const citations: Citation[] = [], images: PortableProjection['images'] = Object.create(null);
      const owners = new Map<string, ChatMessage>(), additional: { origin: PortableMetadata; ordinal: number; text: string; uuid: string }[] = [];
      const citationRows = new Map<string, { fields: Map<number, string>; uuid: string; message: string }>();
      const binding = { ...this.port.binding };
      for (const header of selected) await this.withRecord(header.ordinal, async (bytes, uuid) => {
        const origin = this.origins.get(header.origin!)!;
        if (header.entry.kind === 'message') {
          if (origin.meaning !== 'message' || !origin.message || !origin.timestamp || owners.has(origin.message)) fail('invalid_portable_metadata');
          const message: ChatMessage = { id: uuid!, task_id: '', conversation_id: binding.importKey, role: header.entry.role, content: decoder.decode(bytes), timestamp: origin.timestamp!, portable_history: { ...binding, sourceOrdinal: String(header.ordinal), displayDate: origin.timestamp!, inheritedFrom: null } };
          owners.set(origin.message!, message); messages.push(message);
        } else if (header.entry.kind === 'citation') {
          const key = keyFor(origin); let row = citationRows.get(key);
          if (!row) { row = { fields: new Map(), uuid: uuid!, message: origin.message ?? '' }; citationRows.set(key, row); }
          if (row.fields.has(origin.source.tag)) fail('invalid_portable_metadata'); row.fields.set(origin.source.tag, decoder.decode(bytes));
        } else if (header.entry.kind !== 'asset') additional.push({ origin, ordinal: header.ordinal, text: decoder.decode(bytes), uuid: uuid! });
      });
      const associations = this.headers.filter(header => header.entry.kind === 'association').sort((left, right) => {
        if (left.entry.kind !== 'association' || right.entry.kind !== 'association') return 0;
        return left.entry.from - right.entry.from || left.entry.relation.localeCompare(right.entry.relation) || left.entry.position - right.entry.position || left.ordinal - right.ordinal;
      });
      const attached = new Set<number>();
      for (const header of associations) {
        if (header.entry.kind !== 'association') continue;
        const { from, to, relation } = header.entry;
        const owner = messages.find(message => message.id === this.uuids[from]); if (!owner) fail('missing_message');
        const target = this.headers[to];
        if (relation === 'asset_for_message') {
          if (attached.has(to)) fail('invalid_association'); attached.add(to);
          await this.withRecord(to, async (bytes, uuid) => {
            if (target.entry.kind !== 'asset') fail('invalid_association');
            const mime = assetMime[(target.entry as Extract<PortableRecord['entry'], { kind: 'asset' }>).mime];
            if (mime === 'text/plain') additional.push({ origin: this.origins.get(target.origin!)!, ordinal: to, text: decoder.decode(bytes), uuid: uuid! });
            else {
              let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
              const dataUrl = `data:${mime};base64,${btoa(binary)}`;
              if (!(images[owner!.id] ??= []).some(image => image.dataUrl === dataUrl)) images[owner!.id].push({ id: uuid!, mimeType: mime, dataUrl, createdAt: owner!.timestamp });
            }
          });
        } else if (relation === 'data_for_message') {
          if (['reflection', 'original'].includes(this.origins.get(target.origin!)?.meaning ?? '')) { attached.add(to); continue; }
          const item = additional.find(value => value.ordinal === to);
          if (!item || owners.get(item.origin.message ?? '')?.id !== owner!.id) fail('invalid_association'); attached.add(to);
        } else attached.add(to);
      }
      for (const header of selected) if (header.entry.kind === 'asset' && !attached.has(header.ordinal)) fail('required_asset_missing');
      for (const header of selected) if (header.entry.kind === 'citation' && this.origins.get(header.origin!)?.message && !attached.has(header.ordinal)) fail('required_association_missing');
      const additions = new Map<ChatMessage | null, ChatMessage[]>();
      for (const item of additional) {
        if (item.origin.message && !attached.has(item.ordinal)) fail('required_association_missing');
        const owner = item.origin.message ? owners.get(item.origin.message) : null;
        if (item.origin.message && !owner) fail('missing_message');
        const message: ChatMessage = { id: item.uuid, task_id: '', conversation_id: binding.importKey, role: 'user',
          content: `[Historical archive data; record ${item.ordinal}; ${item.origin.meaning}]\n${item.text}`,
          timestamp: owner?.timestamp ?? '1970-01-01T00:00:00.000Z', portable_history: { ...binding, sourceOrdinal: String(item.ordinal), displayDate: owner?.timestamp ?? null, inheritedFrom: owner?.id ?? null } };
        const group = additions.get(owner ?? null) ?? []; group.push(message); additions.set(owner ?? null, group);
      }
      const ordered = messages.flatMap(message => [message, ...(additions.get(message) ?? [])]);
      messages = ordered.concat(additions.get(null) ?? []);
      for (const row of citationRows.values()) {
        const f = row.fields;
        if (!f.has(0) || !f.has(6) || (!f.has(7) && !f.has(8))) fail('required_citation_missing');
        const type = f.get(3), scope = f.get(4), kind = f.get(14);
        if (!['web', 'file', 'document', 'source_passage'].includes(type ?? '') || !['context', 'source'].includes(scope ?? '') || (kind !== undefined && !['interesting', 'used'].includes(kind))) fail('required_citation_missing');
        citations.push({ id: row.uuid, conversationId: binding.importKey, messageId: owners.get(row.message)?.id ?? row.uuid, type: type as Citation['type'], scope: scope as Citation['scope'], ...(kind === undefined ? {} : { kind: kind as Citation['kind'] }), source: f.get(5) ?? 'archive', title: f.get(6)!, snippet: f.get(7), content: f.get(8), timestamp: owners.get(row.message)?.timestamp ?? messages[0]?.timestamp ?? '1970-01-01T00:00:00.000Z' });
        const owner = owners.get(row.message);
        messages.push({ id: `${row.uuid}:data`, task_id: '', conversation_id: binding.importKey, role: 'user', content: `[Historical archive citation ${row.uuid}]\n${f.get(6)}\n${f.get(7) ?? ''}\n${f.get(8) ?? ''}`, timestamp: owner?.timestamp ?? '1970-01-01T00:00:00.000Z', portable_history: { ...binding, sourceOrdinal: String(this.uuids.indexOf(row.uuid)), displayDate: owner?.timestamp ?? null, inheritedFrom: owner?.id ?? null } });
      }
      // Projection order is archive/association order. Source timestamps remain
      // in original metadata; derived timestamps prevent the ordinary store's
      // chronological sort from moving adjacent historical data or checkpoints.
      const ordinals = new Map(messages.map((message, index) => [message.id, String(index)]));
      messages.forEach((message, index) => {
        message.timestamp = new Date(index).toISOString();
        const origin = message.portable_history!;
        origin.ordinal = String(index);
        if (origin.inheritedFrom) origin.inheritedFrom = ordinals.get(origin.inheritedFrom) ?? null;
      });
      if (!samePortablePolicy(await this.policy(), policy)) fail('policy_changed');
      await consume({ binding, messages, citations, images });
      if (!samePortablePolicy(await this.policy(), policy)) fail('policy_changed');
    } finally { release(); }
  }
}
