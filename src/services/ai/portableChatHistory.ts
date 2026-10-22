/** Internal E profile. These values are historical data, never F admission. */
import { buildAssistantMessagePresentation, buildUserMessagePresentation } from '../chatDbMappers';
import { createCompactionTextFingerprint, buildSourceHashes, validateArchivedCompactionEvidence } from '../contextCompaction';
import type { Citation } from '../../types/citation';
import { parseStoredJsonStrict, isRecord } from './jsonValues';
import { withAdmittedPortableText, PortableWorkBudget, samePortablePolicy } from './portableHistoryInspection';
import { recognizePortableProviderItems } from './portableProviderHistory';
import { buildChatGptVisibleTurnContent } from './responsesCodec';
import { buildToolContextBlock } from './toolPresentation';
import { projectFinalProvenance } from '../macroPilot/assistantProvenance';
import { inspectWholeText, type TextPolicy } from '../macroPilot/conversationText';
import { inspectAttachmentContent } from '../macroPilot/attachmentFilesHost';

export interface RawHistoryField {
  ordinal: number; row: number; family: number; tag: number;
  sql_type: 0 | 1 | 2 | 3; bytes: number; sha256: string;
}
export interface RawHistoryRow { family: number; row: number; fields: RawHistoryField[] }
/** Adapter over a sealed capture. No ordinary conversation query or fallback. */
export interface SealedHistorySource {
  manifest: string;
  limits: readonly string[];
  rows(): AsyncIterable<RawHistoryRow>;
  relations(): AsyncIterable<{ from: number; kind: number; position: number; to: number | null; status: number }>;
  read(field: RawHistoryField): AsyncIterable<Uint8Array>;
}
export type PortableEntry =
  | { kind: 'message'; role: 'user' | 'assistant' }
  | { kind: 'historical_text'; purpose: 'portable_metadata' | 'original_text' | 'historical_data' }
  | { kind: 'citation' }
  | { kind: 'asset'; mime: 'text_plain' | 'image_png' | 'image_jpeg' | 'image_webp' }
  | { kind: 'association'; from: number; to: number; position: number; relation: 'data_for_message' | 'asset_for_message' | 'citation_for_message' };
export interface PortableRecord { ordinal: number; entry: PortableEntry; bytes: number; sha256: string; origin?: number }
export interface PortableSink {
  /** Must consume the bytes before resolving; no retained JS field cache. */
  append(header: PortableRecord, bytes: Uint8Array): Promise<void>;
}
export type PortableClassification = 'retained_original' | 'redundant_representation' | 'excluded_local_metadata';
export interface PortableMetadata {
  version: 1;
  normalizer: 'macro-portable-history-1';
  policy: string;
  source: { ordinal: number; row: number; family: number; tag: number; sqlType: 0 | 1 | 2 | 3; path?: (string | number)[] };
  classification: PortableClassification;
  reason: string;
  meaning?: 'original' | 'message' | 'data' | 'reflection' | 'citation' | 'asset' | 'checkpoint';
  message?: string;
  timestamp?: string;
  sourceLimits?: readonly string[];
  remainingLimits?: readonly string[];
  retained?: number;
  captureManifest?: string;
  sourceHash?: string;
  sourceBytes?: number;
}
const encoder = new TextEncoder();
export async function portableDigest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
}
const fail = (code: string): never => { throw new Error(code); };
const str = (value: unknown): string => typeof value === 'string' ? value : fail('unknown_required_shape');
function inspect(value: unknown, policy: TextPolicy): void {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (!inspectWholeText(current, { ...policy, inspectionBytes: encoder.encode(current).length })) fail('unsafe_content');
    } else if (current && typeof current === 'object') {
      for (const [key, nested] of Object.entries(current)) { stack.push(key); stack.push(nested); }
    }
  }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) return fail('unknown_required_shape');
  return value;
}
/** Strict inverse for legacy hidden-only output. Ambiguous delimiters refuse.
 * Structured provider results need not use this inverse: they remain separate. */
export function recognizeHiddenHistory(value: string): string[] {
  const results: string[] = [];
  let remaining = value;
  while (remaining) {
    const lineEnd = remaining.indexOf('>\n');
    if (!remaining.startsWith('<tool_context ') || lineEnd < 0) fail('unknown_hidden_shape');
    const attributes = remaining.slice(14, lineEnd);
    const match = /^tool_call_id="([^"<>]*)" tool="([^"<>]*)"(?: detail="([^"<>]*)")?$/.exec(attributes);
    if (!match) fail('unknown_hidden_shape');
    const end = remaining.indexOf('\n</tool_context>', lineEnd + 2);
    if (end < 0) fail('incomplete_result');
    const result = remaining.slice(lineEnd + 2, end);
    if (result.includes('<tool_context') || result.includes('</tool_context>')) fail('ambiguous_hidden_shape');
    const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const block = buildToolContextBlock(unescape(match![1]), unescape(match![2]), match![3] === undefined ? undefined : unescape(match![3]), result);
    const consumed = end + '\n</tool_context>'.length;
    if (block !== remaining.slice(0, consumed)) fail('unknown_hidden_shape');
    results.push(block!);
    remaining = remaining.slice(consumed);
    if (remaining) { if (!remaining.startsWith('\n\n')) fail('unknown_hidden_shape'); remaining = remaining.slice(2); if (!remaining) fail('unknown_hidden_shape'); }
  }
  return results;
}

export async function normalizePortableChatHistory(
  source: SealedHistorySource,
  policy: () => Promise<TextPolicy>,
  budget: PortableWorkBudget,
  sink: PortableSink,
): Promise<{ records: number; bytes: number; manifest: string; policy: string; costs: { sourceLoads: number; sourcePayloadBytes: number; sourceChunks: number; maxSourceChunkBytes: number; maxAssembledFieldBytes: number; textDecodes: number; jsonFieldInspections: number; fieldAndEmissionDigestInputCopyBytes: number } }> {
  const currentPolicy = await policy();
  const releasePolicy = budget.reserve(512 + currentPolicy.secrets.reduce((sum, secret) => sum + secret.length * 4 + 32, 0));
  const initial = { ...currentPolicy, secrets: [...currentPolicy.secrets] };
  if (!/^[a-f0-9]{64}$/.test(source.manifest)) { releasePolicy(); fail('integrity_failed'); }
  let ordinal = 0, retainedBytes = 0;
  const costs = { sourceLoads: 0, sourcePayloadBytes: 0, sourceChunks: 0, maxSourceChunkBytes: 0, maxAssembledFieldBytes: 0, textDecodes: 0, jsonFieldInspections: 0, fieldAndEmissionDigestInputCopyBytes: 0 };
  const digest = (bytes: Uint8Array) => { costs.fieldAndEmissionDigestInputCopyBytes += bytes.length; return portableDigest(bytes); };
  const manifest: string[] = [];
  const controls: (() => void)[] = [releasePolicy];
  const messageIds = new Set<string>(), citationIds = new Set<string>(), requiredCitations = new Set<string>();
  const calls = new Map<string, string>(), results = new Map<string, string>();
  const messages = new Map<string, number>();
  const messageRoles = new Map<string, string>();
  const assets = new Map<string, number>();
  const pendingRelations: { message: string; target: number; relation: 'data_for_message' | 'asset_for_message' | 'citation_for_message'; sourceRow?: number }[] = [];
  const receipts = new Map<string, string>();
  const evidence: { id: string; role: string; contentHash: string; providerInputHash: string }[] = [];
  const citationEvidence: Record<string, string> = Object.create(null);
  let checkpoint: { boundary: string; fingerprint: string; inputs: unknown } | null = null;
  const rowIds = new Set<number>();
  // Only admitted control metadata may survive a field scope. No payload cache.
  const keep = (bytes: number) => controls.push(budget.reserve(bytes));
  const emit = async (entry: PortableEntry, bytes: Uint8Array, origin?: number): Promise<number> => {
    const header: PortableRecord = { ordinal: ordinal++, entry, bytes: bytes.length, sha256: await digest(bytes), ...(origin === undefined ? {} : { origin }) };
    const encoded = JSON.stringify(header); keep(1024 + encoded.length * 8);
    manifest.push(encoded); retainedBytes += bytes.length;
    await sink.append(header, bytes);
    return header.ordinal;
  };
  const metadata = async (field: RawHistoryField, classification: PortableClassification, reason: string, extra: Partial<PortableMetadata> = {}) => {
    const value: PortableMetadata = { version: 1, normalizer: 'macro-portable-history-1', policy: initial.revision,
      source: { ordinal: field.ordinal, row: field.row, family: field.family, tag: field.tag, sqlType: field.sql_type }, classification, reason, ...extra };
    // Excluded data never contributes a value hash, length, or isolated digest.
    if (classification === 'excluded_local_metadata') { delete value.sourceBytes; delete value.sourceHash; }
    inspect(value, initial);
    return emit({ kind: 'historical_text', purpose: 'portable_metadata' }, encoder.encode(JSON.stringify(value)));
  };
  const content = async (field: RawHistoryField, text: string, meaning: NonNullable<PortableMetadata['meaning']>, entry: PortableEntry, extra: Partial<PortableMetadata> = {}) => {
    inspect(text, initial);
    const origin = await metadata(field, 'retained_original', 'recognized_history', { meaning, ...extra });
    return emit(entry, encoder.encode(text), origin);
  };
  const load = async (field: RawHistoryField): Promise<Uint8Array> => {
    costs.sourceLoads++; costs.sourcePayloadBytes += field.bytes; costs.maxAssembledFieldBytes = Math.max(costs.maxAssembledFieldBytes, field.bytes);
    const bytes = new Uint8Array(field.bytes); let offset = 0;
    for await (const chunk of source.read(field)) {
      costs.sourceChunks++; costs.maxSourceChunkBytes = Math.max(costs.maxSourceChunkBytes, chunk.length);
      if (offset + chunk.length > bytes.length) fail('integrity_failed');
      bytes.set(chunk, offset); offset += chunk.length;
    }
    if (offset !== bytes.length || await digest(bytes) !== field.sha256) fail('integrity_failed');
    return bytes;
  };
  const read = async (field: RawHistoryField, json: boolean, use: (text: string) => Promise<void>) => {
    if (field.sql_type === 0) { if (field.bytes !== 0) fail('integrity_failed'); return; }
    if (field.sql_type !== 2) fail('source_type_invalid');
    costs.textDecodes++; if (json) costs.jsonFieldInspections++;
    await withAdmittedPortableText(field.bytes, () => load(field), budget, json, use);
  };
  const integer = async (field: RawHistoryField) => {
    if (field.sql_type !== 1 || field.bytes !== 8) fail('source_type_invalid');
    const release = budget.reserve(512);
    try {
      const raw = await load(field);
      const value = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigInt64(0, true).toString();
      await content(field, value, 'original', { kind: 'historical_text', purpose: 'original_text' }, { sourceBytes: 8, sourceHash: field.sha256 });
    } finally { release(); }
  };
  const small = async (row: RawHistoryRow, tag: number): Promise<string | null> => {
    const field = row.fields.find(f => f.tag === tag); if (!field) fail('missing_field');
    let value: string | null = null;
    await read(field!, false, async text => { inspect(text, initial); keep(256 + text.length * 2); value = text; });
    return value;
  };
  try {
    let first: RawHistoryField | undefined;
    for await (const row of source.rows()) { first = row.fields[0]; break; }
    if (!first || first.family !== 0 || first.tag !== 0) fail('missing_source_identity');
    await metadata(first!, 'excluded_local_metadata', 'capture_provenance_only', { captureManifest: source.manifest, sourceLimits: source.limits, remainingLimits: ['not_F_admission', 'runtime_intentions_unattested', 'not_provider_session_resumption', 'recognized_shapes_only'] });
    // Provenance is read first, from the same immutable capture, not a live DB.
    for await (const row of source.rows()) if (row.family === 2) {
      const key = await small(row, 0); const value = await small(row, 1);
      if (!key?.startsWith('chat:assistant-visible-provenance:v1:') || value === null) fail('unknown_provenance');
      closed(parseStoredJsonStrict(value!), ['version', 'source', 'fingerprint', 'start', 'end']); receipts.set(key!.slice('chat:assistant-visible-provenance:v1:'.length), value!);
    }
    for await (const row of source.rows()) {
      const count = [15, 14, 2, 5, 4, 29, 18, 4, 7, 7][row.family];
      if (rowIds.has(row.row) || row.fields.length !== count || row.fields.some((f, index) => f.family !== row.family || f.row !== row.row || f.tag !== index || !Number.isSafeInteger(f.ordinal) || f.ordinal < 0 || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || ![0, 1, 2, 3].includes(f.sql_type) || !/^[a-f0-9]{64}$/.test(f.sha256))) fail('integrity_failed');
      rowIds.add(row.row); keep(64);
      const contentHash = createCompactionTextFingerprint(), providerHash = createCompactionTextFingerprint();
      let providerSeen = false;
      const citationParts: Record<string, string> = {};
      const citationFields = { 0: 'id', 5: 'source', 6: 'title', 7: 'snippet', 8: 'content', 11: 'path', 14: 'kind' } as Record<number, string>;
      const rowReleases: (() => void)[] = [];
      if (row.family === 6) for (const field of row.fields) if (citationFields[field.tag] && field.sql_type === 2) { const release = budget.reserve(256 + field.bytes * 4); rowReleases.push(release); controls.push(release); }
      let checkpointBoundary = '', checkpointFingerprint = '', checkpointInputs: unknown = null;
      let id: string | null = null, role: string | null = null, timestamp: string | null = null;
      const finalHashes = new Set<string>(), reflectionHashes = new Set<string>(), displayHashes = new Set<string>();
      const representations = new Map<string, number>();
      if (row.family === 1) {
        id = await small(row, 0); role = await small(row, 3); timestamp = await small(row, 5);
        if (!id || !['user', 'assistant'].includes(role!)) fail('unsupported_role');
        messageRoles.set(id!, role!); keep(64);
        if (messageIds.has(id!)) fail('integrity_failed'); keep(256 + id!.length * 2); messageIds.add(id!); contentHash.update(role! + ':');
      }
      if (row.family === 8 && messageRoles.get((await small(row, 1)) ?? '') !== 'user') fail('unsupported_assistant_asset');
      // Provider values precede visible content to establish its attribution.
      const fields = [...row.fields].sort((a, b) => {
        const order = (f: RawHistoryField) => row.family === 1 && [9, 10].includes(f.tag) ? -2 + f.tag / 100 : f.tag;
        return order(a) - order(b);
      });
      for (const field of fields) {
        if (field.sql_type === 0) { await metadata(field, 'excluded_local_metadata', 'sql_null'); continue; }
        if (row.family === 1 && [9, 10].includes(field.tag)) {
          await read(field, true, async raw => {
            let decoded = parseStoredJsonStrict(raw);
            if (field.tag === 9) { providerHash.update(JSON.stringify(decoded)); providerSeen = true; }
            if (field.tag === 10) {
              const state = closed(decoded, ['provider', 'response_id', 'output_items']);
              if (state.provider !== 'chatgpt' || (state.response_id !== undefined && typeof state.response_id !== 'string')) fail('unknown_required_shape');
              decoded = state.output_items;
              await metadata(field, 'excluded_local_metadata', 'local_provider_continuation');
            }
            for (const part of recognizePortableProviderItems(decoded)) {
              const sourceRef = { ordinal: field.ordinal, row: field.row, family: field.family, tag: field.tag, sqlType: field.sql_type, path: part.path };
              if (part.kind === 'excluded') { await metadata(field, 'excluded_local_metadata', part.reason, { source: sourceRef }); continue; }
              if ((['final', 'reflection', 'display'].includes(part.kind) && role !== 'assistant') || (['user_data', 'image'].includes(part.kind) && role !== 'user')) fail('contradictory_provenance');
              if (part.kind === 'image') {
                const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.url);
                if (!match) fail('required_external_context');
                const binary = atob(match![2]); if (btoa(binary) !== match![2]) fail('invalid_asset');
                const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
                if (inspectAttachmentContent(bytes, match![1], initial) !== 'available') fail('unsafe_asset');
                const mime = { 'image/png': 'image_png', 'image/jpeg': 'image_jpeg', 'image/webp': 'image_webp' }[match![1]] as 'image_png' | 'image_jpeg' | 'image_webp';
                const origin = await metadata(field, 'retained_original', 'inline_owned_image', { source: sourceRef, meaning: 'asset', message: id! });
                const target = await emit({ kind: 'asset', mime }, bytes, origin);
                assets.set(JSON.stringify([id, match![1], await portableDigest(bytes)]), target); keep(256);
                pendingRelations.push({ message: id!, target, relation: 'asset_for_message' }); keep(128); continue;
              }
              inspect(part, initial);
              if (part.kind === 'final' || part.kind === 'reflection' || part.kind === 'display' || part.kind === 'user_data') {
                const hash = await portableDigest(encoder.encode(part.text));
                if (part.kind !== 'user_data') (part.kind === 'final' ? finalHashes : part.kind === 'reflection' ? reflectionHashes : displayHashes).add(hash);
                const previous = representations.get(`${part.kind}:${hash}`);
                if (previous !== undefined) { await metadata(field, 'redundant_representation', 'recognized_identical_text', { source: sourceRef, retained: previous }); continue; }
                if (part.text) {
                  const target = await content(field, part.text, part.kind === 'reflection' ? 'reflection' : 'data', { kind: 'historical_text', purpose: 'historical_data' }, { message: id!, source: sourceRef });
                  pendingRelations.push({ message: id!, target, relation: 'data_for_message' }); keep(128);
                  representations.set(`${part.kind}:${hash}`, target); keep(128);
                }
              } else if (part.kind === 'call') {
                const hash = await portableDigest(encoder.encode(JSON.stringify([part.name, part.arguments])));
                inspect(parseStoredJsonStrict(part.arguments), initial);
                if (calls.has(part.id) && calls.get(part.id) !== hash) fail('contradictory_result');
                keep(256 + part.id.length * 2); calls.set(part.id, hash);
                const target = await content(field, JSON.stringify({ tool: part.name, arguments_json: part.arguments }), 'data', { kind: 'historical_text', purpose: 'historical_data' }, { message: id!, source: sourceRef });
                pendingRelations.push({ message: id!, target, relation: 'data_for_message' }); keep(128);
              } else if (part.kind === 'result') {
                const hash = await portableDigest(encoder.encode(part.text));
                if (results.has(part.id) && results.get(part.id) !== hash) fail('contradictory_result');
                keep(256 + part.id.length * 2); results.set(part.id, hash);
                const target = await content(field, part.text, 'data', { kind: 'historical_text', purpose: 'historical_data' }, { message: id!, source: sourceRef });
                pendingRelations.push({ message: id!, target, relation: 'data_for_message' }); keep(128);
              }
            }
          });
        } else if (row.family === 1 && field.tag === 4) {
          await read(field, false, async raw => {
            inspect(raw, initial);
            // Checkpoints fingerprint the actual DB mapper's presentation,
            // including user whitespace normalization. The raw value is still
            // stored verbatim below and remains recoverable.
            const presentation = role === 'user' ? buildUserMessagePresentation(raw).content : buildAssistantMessagePresentation(raw).content;
            contentHash.update(presentation); contentHash.update('\n');
            if (displayHashes.size && !displayHashes.has(await portableDigest(encoder.encode(raw)))) fail('contradictory_provenance');
            let projected = raw;
            if (role === 'assistant' && raw) {
              projected = await projectFinalProvenance(id!, raw, receipts.get(id!) ?? null) ?? fail('unknown_provenance');
              if (!finalHashes.has(await portableDigest(encoder.encode(projected)))) fail('contradictory_provenance');
              if (raw !== projected) {
                const close = raw.indexOf('</think>');
                if (!raw.startsWith('<think>') || close < 7) fail('unknown_required_reasoning');
                const reflection = raw.slice(7, close);
                if (!reflectionHashes.has(await portableDigest(encoder.encode(reflection))) || buildChatGptVisibleTurnContent(projected, reflection) !== raw) fail('contradictory_provenance');
              }
            }
            const original = await content(field, raw, 'original', { kind: 'historical_text', purpose: 'original_text' }, { message: id!, sourceHash: field.sha256, sourceBytes: field.bytes });
            pendingRelations.push({ message: id!, target: original, relation: 'data_for_message' }); keep(128);
            const target = await content(field, projected, 'message', { kind: 'message', role: role as 'user' | 'assistant' }, { message: id!, timestamp: timestamp! });
            messages.set(id!, target); keep(128);
          });
        } else if (row.family === 1 && field.tag === 8) {
          await read(field, false, async raw => {
            contentHash.update(raw);
            for (const block of recognizeHiddenHistory(raw)) {
              const target = await content(field, block, 'data', { kind: 'historical_text', purpose: 'historical_data' }, { message: id! });
              pendingRelations.push({ message: id!, target, relation: 'data_for_message' }); keep(128);
            }
          });
        } else if (row.family === 1 && field.tag === 11) {
          await read(field, true, async raw => {
            const refs = parseStoredJsonStrict(raw); if (!Array.isArray(refs)) fail('unknown_required_shape');
            for (const value of refs as unknown[]) {
              const ref = closed(value, ['id', 'kind', 'title', 'snippet', 'sourceLabel', 'url', 'contentHash']);
              if (ref.kind !== 'source') fail('required_external_context');
              inspect(ref, initial); const citation = str(ref.id); keep(256 + citation.length * 2); requiredCitations.add(citation);
            }
            const original = await content(field, raw, 'original', { kind: 'historical_text', purpose: 'original_text' }, { message: id! });
            pendingRelations.push({ message: id!, target: original, relation: 'data_for_message' }); keep(128);
          });
        } else if (row.family === 2 && field.tag === 1) {
          const key = await small(row, 0), message = key!.slice('chat:assistant-visible-provenance:v1:'.length);
          await read(field, true, async raw => {
            closed(parseStoredJsonStrict(raw), ['version', 'source', 'fingerprint', 'start', 'end']);
            const target = await content(field, raw, 'original', { kind: 'historical_text', purpose: 'original_text' }, { message, sourceHash: field.sha256, sourceBytes: field.bytes });
            pendingRelations.push({ message, target, relation: 'data_for_message' }); keep(128);
          });
        } else if (row.family === 6) {
          const citationId = id ?? await small(row, 0); id = citationId;
          if (field.tag === 0) { if (citationIds.has(id!)) fail('integrity_failed'); citationIds.add(id!); }
          if (field.sql_type === 2) await read(field, false, async raw => {
            if (citationFields[field.tag]) citationParts[citationFields[field.tag]] = raw;
            if (field.tag === 11 && raw && !raw.startsWith('attachment://')) fail('required_external_context');
            const message = await small(row, 2);
            const target = await content(field, raw, 'citation', { kind: 'citation' }, messages.has(message!) ? { message: message! } : {});
            if (messages.has(message!)) { pendingRelations.push({ message: message!, target, relation: 'citation_for_message' }); keep(128); }
          });
          else await integer(field);
        } else if (row.family === 8 && [2, 3].includes(field.tag)) {
          const message = await small(row, 1);
          await read(field, false, async raw => {
            const target = await content(field, raw, 'original', { kind: 'historical_text', purpose: 'original_text' }, { message: message! });
            pendingRelations.push({ message: message!, target, relation: 'data_for_message' }); keep(128);
          });
        } else if (row.family === 8 && field.tag === 4) await integer(field);
        else if (row.family === 8 && field.tag === 6) {
          const owner = await small(row, 1), mime = await small(row, 3);
          const mimes: Record<string, Extract<PortableEntry, { kind: 'asset' }>['mime']> = { 'text/plain': 'text_plain', 'image/png': 'image_png', 'image/jpeg': 'image_jpeg', 'image/webp': 'image_webp' };
          if (!mime || !mimes[mime]) fail('unsupported_asset');
          const release = budget.reserve(512 + field.bytes * 16);
          try {
            const bytes = await load(field);
            if (inspectAttachmentContent(bytes, mime!, initial) !== 'available') fail('unsafe_asset');
            const previous = assets.get(JSON.stringify([owner, mime, field.sha256]));
            if (previous !== undefined) {
              await metadata(field, 'redundant_representation', 'identical_owned_asset', { retained: previous });
              const link = pendingRelations.find(link => link.target === previous && link.relation === 'asset_for_message');
              if (!link || link.sourceRow !== undefined) fail('ambiguous_asset'); link!.sourceRow = row.row;
            } else {
            const origin = await metadata(field, 'retained_original', 'owned_asset', { meaning: 'asset', message: owner!, sourceBytes: field.bytes, sourceHash: field.sha256 });
            const target = await emit({ kind: 'asset', mime: mimes[mime!] }, bytes, origin);
            pendingRelations.push({ message: owner!, target, relation: 'asset_for_message', sourceRow: row.row }); keep(128);
            }
          } finally { release(); }
        } else if (row.family === 5) {
          if (field.sql_type === 2) await read(field, /json/.test(checkpointColumns[field.tag] ?? ''), async raw => {
            const decoded = /json/.test(checkpointColumns[field.tag] ?? '') ? parseStoredJsonStrict(raw) : undefined;
            if (field.tag === 1) checkpointBoundary = raw;
            if (field.tag === 8) checkpointFingerprint = raw;
            if (field.tag === 20) { keep(256 + field.bytes * 256); checkpointInputs = decoded; }
            // These captured hashes may commit excluded continuation bytes.
            // Use them only locally for source verification, never inventory them.
            if ([8, 20, 21].includes(field.tag)) await metadata(field, 'excluded_local_metadata', 'private_checkpoint_binding');
            else await content(field, raw, 'checkpoint', { kind: 'historical_text', purpose: 'historical_data' });
          });
          else await integer(field);
        } else if (row.family === 7 && field.tag === 1) {
          await read(field, true, async raw => {
            const refs = parseStoredJsonStrict(raw); if (!Array.isArray(refs)) fail('unknown_required_shape');
            for (const value of refs as unknown[]) {
              const ref = closed(value, ['id', 'kind', 'title', 'snippet', 'sourceLabel', 'url', 'contentHash']);
              if (ref.kind !== 'source') fail('required_external_context');
              inspect(ref, initial); const citation = str(ref.id); keep(256 + citation.length * 2); requiredCitations.add(citation);
            }
            await content(field, raw, 'original', { kind: 'historical_text', purpose: 'original_text' });
          });
        } else if (row.family === 0 && [1, 2].includes(field.tag)) {
          await read(field, false, async raw => { await content(field, raw, 'original', { kind: 'historical_text', purpose: 'original_text' }); });
        } else if (row.family === 0 && [4, 5, 6].includes(field.tag)) fail('required_external_context');
        else if (row.family === 0 && field.tag === 3) await read(field, false, async raw => { if (raw !== 'Chat') fail('unsupported_scope'); await metadata(field, 'excluded_local_metadata', 'global_chat_scope'); });
        else {
          // Known raw families are fixed by the native allowlist. Operational
          // state is inventoried, never restored as permissions or intentions.
          if (row.family < 0 || row.family > 9) fail('unknown_required_shape');
          if (row.family === 1 && field.tag === 12) await read(field, false, async raw => { if (raw === 'provider_error') fail('incomplete_result'); });
          if (row.family === 1 && field.tag === 13) await read(field, true, async raw => {
            const value = parseStoredJsonStrict(raw);
            if (!Array.isArray(value) || value.length) fail('unclassified_generation_attempt');
          });
          if (row.family === 1 && field.tag === 7) await read(field, true, async raw => {
            const traces = parseStoredJsonStrict(raw);
            if (!Array.isArray(traces)) fail('unknown_required_shape');
            for (const rawTrace of traces as unknown[]) {
              const trace = closed(rawTrace, ['tool_call_id', 'tool_name', 'detail', 'status', 'visible_offset', 'execution_mode', 'batch_id', 'order', 'started_at_ms', 'completed_at_ms', 'recovery_state']);
              if (trace.status !== 'done' || !calls.has(str(trace.tool_call_id)) || !results.has(str(trace.tool_call_id))) fail('incomplete_result');
            }
          });
          await metadata(field, 'excluded_local_metadata', 'local_operational_metadata');
        }
      }
      if (row.family === 1) {
        if (!providerSeen) providerHash.update('[]');
        evidence.push({ id: id!, role: role!, contentHash: contentHash.finish(), providerInputHash: providerHash.finish() }); keep(256 + id!.length * 2);
      }
      if (row.family === 6) Object.assign(citationEvidence, buildSourceHashes([citationParts as unknown as Citation], [citationParts.id]));
      if (row.family === 5) {
        if (checkpoint) fail('ambiguous_checkpoint');
        checkpoint = { boundary: checkpointBoundary, fingerprint: checkpointFingerprint, inputs: checkpointInputs };
      }
      for (const release of rowReleases) release();
    }
    if (checkpoint) {
      const boundary = evidence.findIndex(item => item.id === checkpoint!.boundary);
      if (boundary < 0 || !validateArchivedCompactionEvidence(checkpoint.fingerprint, checkpoint.inputs, evidence.slice(0, boundary + 1), citationEvidence)) fail('checkpoint_source_missing');
    }
    const assetOrder = new Map<number, number>();
    for await (const relation of source.relations()) {
      if (!rowIds.has(relation.from) || relation.kind < 0 || relation.kind > 13 || relation.status === 2 || (relation.status === 0 && (relation.to === null || !rowIds.has(relation.to))) || (relation.status === 1 && ![6, 12].includes(relation.kind))) fail('required_relation_missing');
      if (relation.kind === 13) { if (relation.to === null || assetOrder.has(relation.to)) fail('required_relation_missing'); assetOrder.set(relation.to!, relation.position); keep(64); }
    }
    for (const citation of requiredCitations) if (!citationIds.has(citation)) fail('required_external_context');
    for (const call of calls.keys()) if (!results.has(call)) fail('incomplete_result');
    for (const result of results.keys()) if (!calls.has(result)) fail('incomplete_result');
    const positions = new Map<string, number>();
    for (const link of pendingRelations) {
      const from = messages.get(link.message); if (from === undefined) fail('missing_message');
      const position = link.sourceRow === undefined ? (positions.get(link.message) ?? 0) : assetOrder.get(link.sourceRow);
      if (position === undefined) fail('required_relation_missing');
      positions.set(link.message, position! + 1);
      await emit({ kind: 'association', from: from!, to: link.target, position: position!, relation: link.relation }, new Uint8Array());
    }
    if (!samePortablePolicy(await policy(), initial)) fail('policy_changed');
    return { records: ordinal, bytes: retainedBytes, manifest: await portableDigest(encoder.encode(JSON.stringify([source.manifest, initial.revision, manifest]))), policy: initial.revision, costs };
  } finally { for (const release of controls.reverse()) release(); }
}
const checkpointColumns = ['conversation_id', 'up_to_message_id', 'summary_text', 'tool_digest_json', 'used_source_passage_ids_json', 'interesting_source_passage_ids_json', 'estimated_tokens_before', 'estimated_tokens_after', 'fingerprint', 'version', 'pruned_tool_context_message_ids_json', 'reserved_tokens', 'footprint_before_json', 'footprint_after_json', 'degraded_reason', 'compaction_kind', 'compaction_pass', 'summary_format_version', 'summary_source', 'policy_version', 'fingerprint_inputs_json', 'source_hashes_json', 'model_context_window_tokens', 'provider_id', 'model_id', 'checkpoint_health', 'last_trigger', 'created_at', 'updated_at'];

/** Caller keeps the destination inactive and aborts its receiving attempt on any
 * error. Only a matching second pass may be handed to sealStorage afterwards. */
export async function normalizePortableChatHistoryTwoPass(source: SealedHistorySource, policy: () => Promise<TextPolicy>, budget: PortableWorkBudget, sink: PortableSink) {
  const current = await policy();
  const release = budget.reserve(512 + current.secrets.reduce((sum, secret) => sum + secret.length * 4 + 32, 0));
  const expected = { ...current, secrets: [...current.secrets] };
  const checked = async () => { const value = await policy(); if (!samePortablePolicy(expected, value)) fail('policy_changed'); return value; };
  try {
    const first = await normalizePortableChatHistory(source, checked, budget, { append: async () => {} });
    const second = await normalizePortableChatHistory(source, checked, budget, sink);
    if (JSON.stringify(first) !== JSON.stringify(second)) fail('normalization_changed');
    await checked(); return second;
  } finally { release(); }
}
