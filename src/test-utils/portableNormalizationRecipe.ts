/** Private-file bridges used only by the explicit synthetic native/Bun recipe.
 * Indexes contain offsets and headers, never cached full history values. */
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildProviderInputItemsFromContent } from '../services/ai/responsesCodec';
import { fixture } from '../services/ai/portableHistoryFixtures.testSupport';
import { portableDigest, type RawHistoryField, type RawHistoryRow, type SealedHistorySource, type PortableRecord } from '../services/ai/portableChatHistory';
import type { PortableArchivePort, PortableArchiveFragment, PortableArchiveBinding } from '../services/ai/portableHistoryArchive';
import { PortableWorkBudget } from '../services/ai/portableHistoryInspection';
import type { ChatMessage } from '../types';
import { mapDbMessageToChatMessage } from '../services/chatDbMappers';
import type { DbMessage } from '../services/tauriIpc';

export const PORTABLE_FACTS = ['PROVIDER_ONLY_FACT', 'HIDDEN_ONLY_FACT', 'CITATION_FACT', 'ASSET_TEXT_FACT', 'ASSET_FIRST_FACT'];
export const OMITTED_FACT = 'OMITTED_ARCHIVE_FACT=violet-73';
export const SOURCE_SUMMARY = 'SOURCE_CHECKPOINT_HISTORY';
export const TARGET_SUMMARY = 'TARGET_CHECKPOINT_HISTORY';
// Same synthetic 1px grayscale fixture as attachmentImagePolicy.test.ts, with valid CRCs.
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGOoBwAAgQCA05RTSgAAAABJRU5ErkJggg==';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export async function makeNormalizationSeed(provider: 'codex' | 'macro-ai') {
  const prefix = OMITTED_FACT + '\n';
  const count = 4_900_000 - Buffer.byteLength(prefix);
  const long = prefix + 'é🙂'.repeat(Math.floor(count / 6)) + 'x'.repeat(count % 6);
  const f = await fixture(provider, messages => {
    messages[0][4] = long;
    messages.splice(1, 0, ...Array.from({ length: 298 }, (_, i) => [`u${String(i + 1).padStart(3, '0')}`, 's', `turn-${i + 1}`, 'user', `Synthetic recoverable history ${i}: ${'ordinary fact '.repeat(40)}`, '', null, null, null, null, null, '[]', null, null]));
    messages[298][9] = JSON.stringify(buildProviderInputItemsFromContent('user', [{ type: 'text', text: String(messages[298][4]) }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }]));
    for (const [i, message] of messages.entries()) message[5] = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
  });
  await f.appendRow(6, ['used-citation', 's', 'u', 'source_passage', 'source', 'synthetic', 'Used evidence', 'USED_CITATION_FACT', 'USED_CITATION_FACT', null, null, null, null, null, 'used', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  const owner = 'u298';
  const text = Buffer.from('ASSET_TEXT_FACT\né🙂\n');
  const image = Buffer.from(PNG, 'base64');
  await f.appendRow(6, ['text-asset', 's', owner, 'file', 'context', 'pilot_attachment', 'synthetic.txt', null, text.toString('utf8'), null, null, 'attachment://text-asset', null, BigInt(text.length), null, null, 't', 't']);
  await f.appendRow(8, ['text-asset', owner, 'synthetic.txt', 'text/plain', BigInt(text.length), await portableDigest(text), text]);
  const firstText = Buffer.from('ASSET_FIRST_FACT\n');
  await f.appendRow(6, ['z-first-text', 's', owner, 'file', 'context', 'pilot_attachment', 'first.txt', null, firstText.toString('utf8'), null, null, 'attachment://z-first-text', null, BigInt(firstText.length), null, null, 't', 't']);
  await f.appendRow(8, ['z-first-text', owner, 'first.txt', 'text/plain', BigInt(firstText.length), await portableDigest(firstText), firstText]);
  await f.appendRow(8, ['image-asset', owner, 'synthetic.png', 'image/png', BigInt(image.length), await portableDigest(image), image]);
  await f.appendRow(9, [owner, 'turn-298', 'confirmed', 1n, '["image-asset","z-first-text","text-asset"]', 'a', 'ready']);
  const messages: ChatMessage[] = f.rows.filter(row => row.family === 1).map(row => {
    const keys = ['id','conversation_id','turn_id','role','content','created_at','token_count','tool_traces_json','hidden_context','provider_input_items_json','provider_turn_state_json','context_refs_json','completion_reason','generation_attempts_json'];
    const value = Object.fromEntries(row.fields.map(field => [keys[field.tag], field.sql_type === 0 ? null : decoder.decode(f.data.get(field.ordinal))]));
    return mapDbMessageToChatMessage(value as unknown as DbMessage, new Map());
  });
  return { fixture: f, messages, longBytes: Buffer.byteLength(long) };
}
export const CHECKPOINT_COLUMNS = ['conversation_id','up_to_message_id','summary_text','tool_digest_json','used_source_passage_ids_json','interesting_source_passage_ids_json','estimated_tokens_before','estimated_tokens_after','fingerprint','version','pruned_tool_context_message_ids_json','reserved_tokens','footprint_before_json','footprint_after_json','degraded_reason','compaction_kind','compaction_pass','summary_format_version','summary_source','policy_version','fingerprint_inputs_json','source_hashes_json','model_context_window_tokens','provider_id','model_id','checkpoint_health','last_trigger','created_at','updated_at'];
export async function writeNormalizationSeed(root: string, provider: string, seed: Awaited<ReturnType<typeof makeNormalizationSeed>>, checkpoint: Record<string, unknown>) {
  await seed.fixture.appendRow(5, CHECKPOINT_COLUMNS.map(key => {
    const value = checkpoint[key]; return value === null || value === undefined ? null : typeof value === 'number' ? BigInt(value) : value;
  }));
  const rows = seed.fixture.rows.map(row => ({ family: row.family, fields: row.fields.map(field => ({ sql_type: field.sql_type, data: Buffer.from(seed.fixture.data.get(field.ordinal)!).toString('base64') })) }));
  await writeFile(join(root, `seed-${provider}.json`), JSON.stringify(rows), { mode: 0o600 });
}
async function* lines(path: string, start?: number, end?: number) {
  const stream = createReadStream(path, { highWaterMark: 8192, start, ...(end === undefined ? {} : { end: end - 1 }) });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      let position = 0;
      while (position < chunk.length) {
        const newline = chunk.indexOf(10, position), stop = newline < 0 ? chunk.length : newline;
        const segment = chunk.subarray(position, stop);
        // Reject before concatenation. highWaterMark alone does not bound the
        // complete line retained by readline when an artifact is malformed.
        if (pending.length + segment.length + 1 > 8192) throw new Error('fixture_frame_too_large');
        pending = Buffer.concat([pending, segment]);
        if (newline < 0) break;
        yield decoder.decode(pending); pending = Buffer.alloc(0); position = newline + 1;
      }
    }
    if (pending.length) throw new Error('incomplete_fixture_frame');
  } finally { stream.destroy(); }
}

const hex = (value: number[]) => Buffer.from(value).toString('hex');
export async function readNativeSourceSpool(path: string, budget: PortableWorkBudget) {
  const bytes = (await stat(path)).size;
  const release = budget.reserve(bytes * 8 + 4096);
  const fields = new Map<number, RawHistoryField & { start: number; end: number }>();
  const rows = new Map<number, RawHistoryRow>();
  const relations: { from: number; kind: number; position: number; to: number | null; status: number }[] = [];
  let offset = 0, manifest = '', limits: string[] = [], maxLine = 0;
  try {
    for await (const line of lines(path)) {
      const length = Buffer.byteLength(line) + 1; maxLine = Math.max(maxLine, length);
      const value = JSON.parse(line);
      if (value.kind === 'capture') { if (manifest) throw new Error('duplicate_capture'); manifest = value.manifest; limits = value.limits; }
      else if (value.kind === 'relation') relations.push(value.relation);
      else if (value.kind === 'fragment') {
        const field: RawHistoryField = { ...value.field, sha256: hex(value.field.sha256) };
        const previous = fields.get(field.ordinal);
        if (!previous) {
          fields.set(field.ordinal, { ...field, start: offset, end: offset + length });
          let row = rows.get(field.row); if (!row) { row = { row: field.row, family: field.family, fields: [] }; rows.set(field.row, row); } row.fields.push(field);
        } else { if (JSON.stringify({ ...previous, start: undefined, end: undefined }) !== JSON.stringify(field)) throw new Error('inconsistent_field'); previous.end = offset + length; }
      } else throw new Error('invalid_fixture_frame');
      offset += length;
    }
    const source: SealedHistorySource = { manifest, limits, async *rows() { yield* [...rows.values()].sort((a,b) => a.row-b.row); }, async *relations() { yield* relations; }, async *read(field) {
      const indexed = fields.get(field.ordinal); if (!indexed) throw new Error('missing_field'); let offset = 0;
      for await (const line of lines(path, indexed.start, indexed.end)) {
        const value = JSON.parse(line); if (value.field.ordinal !== field.ordinal || value.offset !== offset) throw new Error('invalid_offset');
        const bytes = Buffer.from(value.data, 'base64'); if (bytes.length > 4093 || await portableDigest(bytes) !== value.fragment_sha256) throw new Error('integrity_failed');
        offset += bytes.length; yield bytes;
      }
      if (offset !== field.bytes) throw new Error('integrity_failed');
    } };
    return { source, dispose: release, stats: { spoolBytes: bytes, fields: fields.size, rows: rows.size, relations: relations.length, maxLineBytes: maxLine } };
  } catch (error) { release(); throw error; }
}
export async function readNativeTargetSpool(path: string, budget: PortableWorkBudget) {
  const fileBytes = (await stat(path)).size, release = budget.reserve(fileBytes * 8 + 4096);
  const index: { ordinal: number; offset: number; start: number; end: number }[] = [];
  let binding: PortableArchiveBinding | undefined, records = 0, offset = 0, maxLine = 0;
  try {
    for await (const line of lines(path)) {
      const length = Buffer.byteLength(line) + 1, value = JSON.parse(line); maxLine = Math.max(maxLine, length);
      if (value.kind === 'archive') { if (binding || value.profile !== 'portable_chat_history_v1') throw new Error('invalid_profile'); binding = value.binding; records = value.records; }
      else if (value.kind === 'fragment') index.push({ ordinal: value.header.ordinal, offset: value.offset, start: offset, end: offset + length });
      else throw new Error('invalid_fixture_frame'); offset += length;
    }
    if (!binding) throw new Error('missing_binding');
    const port: PortableArchivePort = { binding, profile: 'portable_chat_history_v1', records, async read(cursor, limit) {
      const position = cursor ? index.findIndex(value => value.ordinal === cursor.ordinal && value.offset === cursor.offset) : 0;
      if (position < 0) throw new Error('invalid_cursor');
      const page = index.slice(position, position + limit), fragments: PortableArchiveFragment[] = [];
      if (page.length) for await (const line of lines(path, page[0].start, page.at(-1)!.end)) {
        const value: { header: PortableRecord; offset: number; data: string; targetUuid: string | null } = JSON.parse(line);
        fragments.push({ record: value.header, offset: value.offset, bytes: Buffer.from(value.data, 'base64'), targetUuid: value.targetUuid });
      }
      const after = index[position + page.length];
      return { fragments, next: after ? { ordinal: after.ordinal, offset: after.offset } : null };
    } };
    return { port, dispose: release, stats: { spoolBytes: fileBytes, fragments: index.length, maxLineBytes: maxLine } };
  } catch (error) { release(); throw error; }
}
