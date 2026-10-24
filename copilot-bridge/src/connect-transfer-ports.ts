import { portableDigest, type RawHistoryField, type RawHistoryRow, type SealedHistorySource, type PortableRecord } from '../../src/services/ai/portableChatHistory';
import type { PortableArchivePort, PortableArchiveFragment } from '../../src/services/ai/portableHistoryArchive';
import { PortableWorkBudget, withAdmittedPortableText } from '../../src/services/ai/portableHistoryInspection';
import { vocabulary } from '../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import { secretForms } from '../../src/services/macroPilot/secretForms';
import type { TextPolicy } from '../../src/services/macroPilot/conversationText';
import { parseStoredJsonStrict } from '../../contracts/macro-pilot/v2/strict-json.mjs';
import { TransferClient } from './connect-transfer-client';
import { integer, decimal, ensure, sum, mul, CONTROL_RESERVE, secretQuote, measureValue, withEncodedValue } from './connect-transfer-values';
import { encodeControl, type Facts, type FieldSlice } from './connect-transfer-protocol';
import { Frame } from './connect-codec-framing';

const ROW_RESERVE = 8192 + Math.max(...vocabulary.families.map(family => family.columns.length)) * 4096;
export class TransferPorts {
  readonly budget: PortableWorkBudget;
  private readonly releases: (() => void)[] = [];
  private snapshot: TextPolicy | undefined;
  private detectionRoot: Facts | undefined;
  constructor(readonly client: TransferClient) { this.budget = client.budget; }
  dispose(): void { this.snapshot = undefined; this.detectionRoot = undefined; for (const release of this.releases.splice(0).reverse()) release(); }
  keep(units: number): void { this.releases.push(this.budget.reserve(units)); }
  async descriptor(h: string, kind: string, cursor: Facts | null = null): Promise<Facts> {
    return this.client.simple({ op: 1, handle: h, kind, cursor });
  }
  async root(name: string): Promise<Facts> {
    const h = this.client.start.handles[name]; ensure(h);
    this.keep(CONTROL_RESERVE); // Before a returned root escapes its control scope.
    const result = await this.descriptor(h, 'root'); return result.value;
  }
  async *read(h: string, field: FieldSlice, maximum = 4093): AsyncGenerator<Uint8Array> {
    let offset = 0;
    while (offset < field.bytes) {
      const release = this.budget.reserve(sum(512, mul(Math.min(maximum, field.bytes - offset), 2)));
      let bytes: Uint8Array | undefined;
      try {
        bytes = await this.client.call({ op: 2, handle: h, ordinal: decimal(field.ordinal), offset: decimal(offset), max_bytes: decimal(Math.min(maximum, field.bytes - offset)) }, async (request, response) => {
          const length = integer(response.bytes);
          ensure(length > 0 && length <= field.bytes - offset && (response.next === null ? offset + length === field.bytes : integer(response.next) === offset + length), 2);
          const value = new Uint8Array(length); let position = 0;
          await this.client.receiveBytes(request.call, length, async page => { value.set(page, position); position += page.length; });
          ensure(await portableDigest(value) === response.sha256, 2); return value;
        });
        yield bytes; offset += bytes.length;
      } finally { bytes = undefined; release(); }
    }
  }
  async load(h: string, field: FieldSlice): Promise<Uint8Array> {
    const bytes = new Uint8Array(field.bytes); let offset = 0;
    for await (const page of this.read(h, field, 65_536)) { bytes.set(page, offset); offset += page.length; }
    ensure(offset === bytes.length && await portableDigest(bytes) === field.sha256, 2); return bytes;
  }
  async text(h: string, field: FieldSlice, json = false): Promise<any> {
    let value: unknown;
    await withAdmittedPortableText(field.bytes, () => this.load(h, field), this.budget, json, async text => {
      this.keep(sum(512, mul(field.bytes, json ? 256 : 2)));
      value = json ? parseStoredJsonStrict(text) : text;
    });
    return value;
  }
  async detection(): Promise<void> {
    const root = await this.root('policy'); ensure(root.kind === 'detection');
    const count = integer(root.count), bytes = integer(root.bytes);
    const quote = sum(secretQuote(bytes, count), 512, mul(root.revision.bytes, 8));
    ensure(quote <= integer(this.client.start.detection_units), 1);
    this.releases.push(this.client.detectionBudget.reserve(quote)); // Before array construction, UTF-8/JSON/URI/base64 expansions.
    const revision = await this.readDetectionText(root.revision);
    const values: string[] = [], ordinals = new Set<number>(); let total = 0, cursor: Facts | null = null;
    do {
      const result = await this.descriptor(this.client.start.handles.policy, 'detection', cursor);
      if (!result.value) { ensure(values.length === count && total === bytes, 2); break; }
      ensure(values.length < count && !ordinals.has(result.value.ordinal), 2); ordinals.add(result.value.ordinal);
      if (result.next) ensure(integer(result.next.ordinal) > result.value.ordinal, 2);
      total = sum(total, result.value.bytes); ensure(total <= bytes, 2);
      values.push(await this.readDetectionText(result.value)); cursor = result.next;
    } while (cursor);
    ensure(values.length === count && total === bytes, 2);
    const forms = secretForms(values);
    this.snapshot = { revision, secrets: forms }; this.detectionRoot = root;
    values.length = 0;
  }
  private async readDetectionText(field: FieldSlice): Promise<string> {
    // The full expansion lease already owns raw, decode and digest copies.
    const bytes = await this.load(this.client.start.handles.policy, field);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  readonly policy = async (): Promise<TextPolicy> => {
    ensure(this.snapshot && this.detectionRoot);
    const current = (await this.descriptor(this.client.start.handles.policy, 'root')).value;
    ensure(JSON.stringify(current) === JSON.stringify(this.detectionRoot), 3);
    return this.snapshot;
  };
  async source(): Promise<SealedHistorySource> {
    const root = await this.root('source'); ensure(root.kind === 'source'); const h = this.client.start.handles.source;
    const descriptor = this.descriptor.bind(this), read = this.read.bind(this), { budget } = this;
    return { manifest: root.manifest, limits: root.limits,
      async *rows() {
        let cursor: Facts | null = null, expected = 0, rowCount = 0;
        let row: RawHistoryRow | undefined, release: (() => void) | undefined;
        try {
          do {
            const result = await descriptor(h, 'field', cursor);
            const field = result.value as RawHistoryField | null;
            if (!field) break;
            ensure(expected < integer(root.fields) && field.ordinal === expected++, 2);
            if (!row || row.row !== field.row) {
              if (row) { yield row; row = undefined; release!(); }
              release = budget.reserve(ROW_RESERVE);
              ensure(rowCount < integer(root.rows) && field.row === rowCount++, 2); row = { row: field.row, family: field.family, fields: [] };
            }
            ensure(field.family === row.family && row.fields.length < vocabulary.families[field.family]?.columns.length, 2);
            row.fields.push(field); cursor = result.next;
            if (cursor) ensure(integer(cursor.ordinal) === expected, 2);
          } while (cursor);
          if (row) yield row;
          ensure(expected === integer(root.fields) && rowCount === integer(root.rows), 2);
        } finally { row = undefined; release?.(); }
      },
      async *relations() {
        let cursor: Facts | null = null, count = 0;
        do {
          const release = budget.reserve(4096);
          try {
            const result = await descriptor(h, 'relation', cursor);
            if (!result.value) break;
            ensure(count < integer(root.relations), 2);
            if (result.next) {
              const a = [result.value.from, result.value.kind, result.value.position], b = [integer(result.next.from), integer(result.next.kind), integer(result.next.position)];
              ensure(b[0] > a[0] || b[0] === a[0] && (b[1] > a[1] || b[1] === a[1] && b[2] > a[2]), 2);
            }
            yield result.value; count++; cursor = result.next;
          } finally { release(); }
        } while (cursor);
        ensure(count === integer(root.relations), 2);
      },
      read(field) { return read(h, field); },
    };
  }
  async append(header: PortableRecord, bytes: Uint8Array): Promise<void> {
    const h = this.client.start.handles.sink;
    for (let offset = 0; offset < bytes.length || offset === 0; offset += 4093) {
      const page = bytes.subarray(offset, Math.min(bytes.length, offset + 4093));
      await this.client.call({ op: 4, handle: h, header, offset: decimal(offset), bytes: decimal(page.length), sha256: await portableDigest(page) }, async (_request, response) => {
        ensure(integer(response.ordinal) === header.ordinal && integer(response.next_offset) === offset + page.length, 2);
        ensure(response.kind === (this.client.start.kind === 'normalize' ? 'export' : 'storage'), 2);
      }, request => this.client.sendBytes(request.call, page));
      if (!bytes.length) break;
    }
  }
  async archive(): Promise<{ port: PortableArchivePort; root: Facts }> {
    const root = await this.root('archive'); ensure(root.kind === 'archive');
    const port: PortableArchivePort = { binding: root.binding, profile: root.profile, records: integer(root.records),
      read: async (cursor, limit) => {
        const release = this.budget.reserve(mul(limit, 4093 * 2 + 8192));
        try {
          return await this.client.call({ op: 5, handle: this.client.start.handles.archive,
            cursor: cursor ? { ordinal: decimal(cursor.ordinal), offset: decimal(cursor.offset) } : null, limit: '1' }, async (request, first) => {
            const fragments: PortableArchiveFragment[] = []; let response = first;
            while (response.stage === 'fragment') {
              ensure(fragments.length < 1, 2);
              const bytes = new Uint8Array(integer(response.bytes)); let offset = 0;
              await this.client.receiveBytes(request.call, bytes.length, async page => { bytes.set(page, offset); offset += page.length; });
              fragments.push({ record: response.record, offset: integer(response.offset), bytes, targetUuid: response.targetUuid });
              response = await this.client.response(request);
            }
            if (cursor && response.next) ensure(integer(response.next.ordinal) > cursor.ordinal || integer(response.next.ordinal) === cursor.ordinal && integer(response.next.offset) > cursor.offset, 2);
            return { fragments, next: response.next ? { ordinal: integer(response.next.ordinal), offset: integer(response.next.offset) } : null };
          });
        } finally { release(); }
      } };
    return { port, root };
  }
  async collection(h: string, kind: string, values: readonly unknown[]): Promise<void> {
    await this.client.simple({ op: 6, handle: h, stage: 'begin', kind, total: decimal(values.length) });
    for (let index = 0; index < values.length; index++) {
      const value = values[index], size = measureValue(value);
      await withEncodedValue(value, this.budget, bytes => this.client.call({ op: 6, handle: h, stage: 'item', kind,
        index: decimal(index), upper_json_bytes: decimal(size.jsonBytes), units: decimal(sum(size.units, size.jsonBytes)) }, async () => {}, async request => {
        const releaseHash = this.budget.reserve(bytes.length);
        try {
        const sha256 = await portableDigest(bytes);
        await this.client.sendBytes(request.call, bytes, async () => {
          await this.client.writer.send(Frame.BEGIN, this.client.job, 0n, 0,
            encodeControl({ op: 6, call: request.call, handle: h, stage: 'encoded', kind, bytes: decimal(bytes.length), sha256 }));
        });
        } finally { releaseHash(); }
      }));
    }
    await this.client.simple({ op: 6, handle: h, stage: 'end', kind, total: decimal(values.length) });
  }
}
