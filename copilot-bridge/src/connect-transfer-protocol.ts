import { IDENTITIES } from '../../contracts/macro-pilot/v2/transfer-transit/identities.generated.mjs';
import { validatePortableHeader, validatePortableDescriptor, type PortableHeader, type PortableDescriptor } from '../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import { PORTABLE_SOURCE_LIMITS, type RawHistoryField } from '../../src/services/ai/portableChatHistory';
import { parseStoredJsonStrict } from '../../contracts/macro-pilot/v2/strict-json.mjs';
import { ensure, hash, keys, integer, handle, safe, sum, controlBytes } from './connect-transfer-values';

export type Facts = Record<string, any>;
export type WorkKind = 'normalize' | 'import' | 'prepare' | 'recover';
export const PROJECTION_KINDS = ['message', 'citation', 'image', 'archive-retrieval', 'reference-message', 'prepared-message', 'effect-draft', 'request-metadata'] as const;
export const HANDLES = { normalize: ['source', 'policy', 'sink'], import: ['staging', 'policy', 'sink'],
  prepare: ['archive', 'policy', 'target', 'draft'], recover: ['archive', 'policy', 'selector', 'sink'] } as const;
export interface Start { op: 0; kind: WorkKind; handles: Record<string, string>; child_units: string; detection_units: string; native_units: string }
export interface FieldSlice { ordinal: number; bytes: number; sha256: string }
type D = string;
type ReadCursor = { ordinal: D; offset: D };
type ImportedResult = { records: D; fragments: D; bytes: D; manifest: string };
type ProjectionKind = typeof PROJECTION_KINDS[number];
type Call = { call: D; handle: D };
export type TransferRequest = Call & (
  | { op: 1; kind: 'root' | 'field' | 'detection' | 'target' | 'relation'; cursor: null | { ordinal: D } | { from: D; kind: D; position: D } }
  | { op: 2; ordinal: D; offset: D; max_bytes: D }
  | { op: 3; stage: 'begin'; descriptor: PortableDescriptor }
  | { op: 3; stage: 'header'; header: PortableHeader }
  | { op: 3; stage: 'end'; result: ImportedResult }
  | { op: 4; header: PortableHeader; offset: D; bytes: D; sha256: string }
  | { op: 5; cursor: ReadCursor | null; limit: D }
  | { op: 6; stage: 'begin' | 'end'; kind: ProjectionKind; total: D }
  | { op: 6; stage: 'item'; kind: ProjectionKind; index: D; upper_json_bytes: D; units: D }
  | { op: 6; stage: 'encoded'; kind: ProjectionKind; bytes: D; sha256: string }
  | { op: 7; kind: 'normalized'; result: { records: D; bytes: D; manifest: string; policy_handle: D } }
  | { op: 7; kind: 'imported'; result: ImportedResult }
  | { op: 7; kind: 'prepared_ts'; result: { draft_handle: D; archive_manifest: string; storage_revision: D; mapping_sha256: string; target_handle: D; reference: 'local' | 'synthetic' } }
  | { op: 7; kind: 'recovered'; result: { ordinal: D; bytes: D; sha256: string } }
);
const oneOf = (value: unknown, set: readonly unknown[]) => ensure(set.includes(value));
const nullable = (value: unknown, validate: (value: any) => void) => { if (value !== null) validate(value); };
const count = (value: unknown) => { ensure(typeof value === 'number'); safe(value); };
const uuid = (value: unknown) => ensure(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value));
const cursor = (value: any) => { keys(value, ['ordinal', 'offset']); integer(value.ordinal); integer(value.offset); };
export function fieldSlice(value: any): void { keys(value, ['ordinal', 'bytes', 'sha256']); count(value.ordinal); count(value.bytes); hash(value.sha256); }
export function rawField(value: any): asserts value is RawHistoryField {
  keys(value, ['ordinal', 'row', 'family', 'tag', 'sql_type', 'bytes', 'sha256']);
  for (const name of ['ordinal', 'row', 'family', 'tag', 'bytes']) count(value[name]);
  oneOf(value.sql_type, [0, 1, 2, 3]); hash(value.sha256);
}
export function validateHello(value: any): void {
  keys(value, ['version', 'portable_contract_sha256', 'preparation_set_sha256']);
  ensure(value.version === 'macro-connect-transfer-1'); hash(value.portable_contract_sha256); hash(value.preparation_set_sha256);
}
export function validateStart(value: any): asserts value is Start {
  keys(value, ['op', 'kind', 'handles', 'child_units', 'detection_units', 'native_units']); ensure(value.op === 0);
  ensure(Object.hasOwn(HANDLES, value.kind)); keys(value.handles, HANDLES[value.kind as WorkKind]);
  const all = Object.values(value.handles); for (const h of all) handle(h); ensure(new Set(all).size === all.length);
  ensure(integer(value.child_units) > 0 && integer(value.detection_units) > 0 && integer(value.native_units) > 0);
  sum(integer(value.child_units), integer(value.detection_units), integer(value.native_units));
}
export function validateRequest(r: Facts, policyHandle: string): void {
  ensure(r && typeof r === 'object'); handle(r.call); handle(r.handle);
  switch (r.op) {
    case 1:
      keys(r, ['op', 'call', 'handle', 'kind', 'cursor']); oneOf(r.kind, ['root', 'field', 'relation', 'detection', 'target']);
      if (r.kind === 'root') ensure(r.cursor === null);
      else if (r.kind === 'relation') nullable(r.cursor, v => { keys(v, ['from', 'kind', 'position']); integer(v.from); integer(v.kind); integer(v.position); });
      else nullable(r.cursor, v => { keys(v, ['ordinal']); integer(v.ordinal); });
      break;
    case 2:
      keys(r, ['op', 'call', 'handle', 'ordinal', 'offset', 'max_bytes']); integer(r.ordinal); integer(r.offset);
      ensure(integer(r.max_bytes) > 0 && integer(r.max_bytes) <= 65_536); break;
    case 3:
      if (r.stage === 'begin') { keys(r, ['op', 'call', 'handle', 'stage', 'descriptor']); validatePortableDescriptor(r.descriptor, IDENTITIES.content_contract_sha256); }
      else if (r.stage === 'header') { keys(r, ['op', 'call', 'handle', 'stage', 'header']); validatePortableHeader(r.header); }
      else { keys(r, ['op', 'call', 'handle', 'stage', 'result']); ensure(r.stage === 'end'); imported(r.result); }
      break;
    case 4:
      keys(r, ['op', 'call', 'handle', 'header', 'offset', 'bytes', 'sha256']); validatePortableHeader(r.header);
      integer(r.offset); ensure(integer(r.bytes) <= 4093); hash(r.sha256); break;
    case 5:
      keys(r, ['op', 'call', 'handle', 'cursor', 'limit']); nullable(r.cursor, cursor); ensure(integer(r.limit) >= 1 && integer(r.limit) <= 32); break;
    case 6:
      oneOf(r.kind, PROJECTION_KINDS);
      if (r.stage === 'item') { keys(r, ['op', 'call', 'handle', 'stage', 'kind', 'index', 'upper_json_bytes', 'units']); integer(r.index); integer(r.upper_json_bytes); integer(r.units); }
      else if (r.stage === 'encoded') { keys(r, ['op', 'call', 'handle', 'stage', 'kind', 'bytes', 'sha256']); integer(r.bytes); hash(r.sha256); }
      else { keys(r, ['op', 'call', 'handle', 'stage', 'kind', 'total']); oneOf(r.stage, ['begin', 'end']); integer(r.total); }
      break;
    case 7:
      keys(r, ['op', 'call', 'handle', 'kind', 'result']);
      if (r.kind === 'normalized') {
        keys(r.result, ['records', 'bytes', 'manifest', 'policy_handle']); integer(r.result.records); integer(r.result.bytes); hash(r.result.manifest); handle(r.result.policy_handle); ensure(r.result.policy_handle === policyHandle);
      } else if (r.kind === 'imported') imported(r.result);
      else if (r.kind === 'prepared_ts') {
        keys(r.result, ['draft_handle', 'archive_manifest', 'storage_revision', 'mapping_sha256', 'target_handle', 'reference']);
        handle(r.result.draft_handle); hash(r.result.archive_manifest); integer(r.result.storage_revision); hash(r.result.mapping_sha256); handle(r.result.target_handle); oneOf(r.result.reference, ['local', 'synthetic']);
      } else { ensure(r.kind === 'recovered'); keys(r.result, ['ordinal', 'bytes', 'sha256']); integer(r.result.ordinal); integer(r.result.bytes); hash(r.result.sha256); }
      break;
    default: ensure(false);
  }
}
function imported(value: any): void {
  keys(value, ['records', 'fragments', 'bytes', 'manifest']); integer(value.records); integer(value.fragments); integer(value.bytes); hash(value.manifest);
}
function descriptorRoot(value: Facts): void {
  switch (value.kind) {
    case 'source':
      keys(value, ['kind', 'manifest', 'limits', 'rows', 'fields', 'relations']); hash(value.manifest);
      ensure(Array.isArray(value.limits) && value.limits.length === PORTABLE_SOURCE_LIMITS.length && PORTABLE_SOURCE_LIMITS.every(limit => value.limits.includes(limit)) && new Set(value.limits).size === value.limits.length);
      integer(value.rows); integer(value.fields); integer(value.relations); break;
    case 'staging':
      keys(value, ['kind', 'bytes', 'sha256', 'descriptor']); integer(value.bytes); hash(value.sha256); validatePortableDescriptor(value.descriptor, IDENTITIES.content_contract_sha256); break;
    case 'archive':
      keys(value, ['kind', 'binding', 'profile', 'records', 'storage_revision', 'mapping_sha256']);
      keys(value.binding, ['version', 'importKey', 'manifest']); ensure(value.binding.version === 1); hash(value.binding.importKey); hash(value.binding.manifest);
      ensure(value.profile === 'portable_chat_history_v1'); ensure(integer(value.records) > 0); integer(value.storage_revision); hash(value.mapping_sha256); break;
    case 'detection':
      keys(value, ['kind', 'count', 'bytes', 'revision']); integer(value.count); integer(value.bytes); fieldSlice(value.revision); break;
    case 'selector':
      keys(value, ['kind', 'ordinal', 'uuid']); integer(value.ordinal); nullable(value.uuid, uuid); break;
    case 'target': validateTarget(value); break;
    default: ensure(false);
  }
}
export function validateTarget(value: Facts): void {
  keys(value, ['kind', 'provider_type', 'fields', 'footprint', 'risk', 'max_turns', 'budget_policy']);
  ensure(value.kind === 'target'); oneOf(value.provider_type, ['chatgpt', 'openai']);
  keys(value.fields, ['conversationId', 'providerId', 'modelId', 'baseUrl', 'modePrompt', 'reasoningEffort', 'currentCheckpoint', 'contextWarning']);
  for (const name of ['conversationId', 'providerId', 'modelId', 'baseUrl', 'modePrompt']) fieldSlice(value.fields[name]);
  for (const name of ['reasoningEffort', 'currentCheckpoint', 'contextWarning']) nullable(value.fields[name], fieldSlice);
  keys(value.footprint, ['modelContextWindowTokens', 'inputLimitTokens', 'outputLimitTokens', 'contextLimitSource', 'isContextLimitAuthoritative', 'contextLimitConfidence']);
  ensure(typeof value.footprint.modelContextWindowTokens === 'number' && safe(value.footprint.modelContextWindowTokens) > 0);
  nullable(value.footprint.inputLimitTokens, count); nullable(value.footprint.outputLimitTokens, count);
  oneOf(value.footprint.contextLimitSource, ['model_metadata', 'provider_metadata', 'user_override', 'models_dev', 'provider_overflow_error', 'macro_fallback']);
  oneOf(value.footprint.contextLimitConfidence, ['verified', 'configured', 'catalog', 'learned', 'fallback']); ensure(typeof value.footprint.isContextLimitAuthoritative === 'boolean');
  oneOf(value.risk, ['strict', 'balanced', 'yolo']); ensure(integer(value.max_turns) > 0);
  keys(value.budget_policy, ['auto', 'prune', 'reservedTokens', 'preserveRecentTokens', 'hardStopRatio']);
  for (const name of ['auto', 'prune']) ensure(typeof value.budget_policy[name] === 'boolean');
  for (const name of ['reservedTokens', 'preserveRecentTokens']) nullable(value.budget_policy[name], count);
  ensure(Number.isFinite(value.budget_policy.hardStopRatio) && value.budget_policy.hardStopRatio > 0);
}
export function validateResponse(r: Facts, expected: Facts): void {
  ensure(r.op === expected.op && r.call === expected.call && Number.isInteger(r.status) && r.status >= 0 && r.status <= 8);
  if (r.status !== 0) { keys(r, ['op', 'call', 'status']); return; }
  keys(r, ['op', 'call', 'status', 'result']); const v = r.result;
  switch (r.op) {
    case 1:
      keys(v, ['value', 'next']);
      if (v.value === null) { ensure(v.next === null && expected.kind !== 'root'); break; }
      if (expected.kind === 'root') { descriptorRoot(v.value); ensure(v.next === null); }
      else if (expected.kind === 'field') rawField(v.value);
      else if (expected.kind === 'relation') { keys(v.value, ['from', 'kind', 'position', 'to', 'status']); for (const key of ['from', 'kind', 'position']) count(v.value[key]); nullable(v.value.to, count); oneOf(v.value.status, [0, 1, 2]); }
      else fieldSlice(v.value);
      if (v.next !== null) {
        if (expected.kind === 'relation') { keys(v.next, ['from', 'kind', 'position']); for (const key of ['from', 'kind', 'position']) integer(v.next[key]); }
        else { keys(v.next, ['ordinal']); integer(v.next.ordinal); }
      }
      break;
    case 2: keys(v, ['bytes', 'sha256', 'next']); integer(v.bytes); hash(v.sha256); nullable(v.next, integer); ensure(integer(v.bytes) <= integer(expected.max_bytes)); break;
    case 3: keys(v, ['stage']); ensure(v.stage === expected.stage); break;
    case 4:
      if (v.kind === 'export') keys(v, ['kind', 'ordinal', 'next_offset']);
      else { ensure(v.kind === 'storage'); keys(v, ['kind', 'ordinal', 'next_offset', 'received_bytes', 'revision']); integer(v.received_bytes); integer(v.revision); }
      integer(v.ordinal); integer(v.next_offset); break;
    case 5:
      if (v.stage === 'fragment') { keys(v, ['stage', 'record', 'offset', 'bytes', 'targetUuid']); validatePortableHeader(v.record); integer(v.offset); ensure(integer(v.bytes) <= 4093); nullable(v.targetUuid, uuid); }
      else { keys(v, ['stage', 'next']); ensure(v.stage === 'end'); nullable(v.next, cursor); } break;
    case 6:
      if (expected.stage === 'item') { keys(v, ['stage', 'kind', 'index']); ensure(v.index === expected.index); }
      else { keys(v, ['stage', 'kind', 'total']); ensure(v.total === expected.total); }
      ensure(v.stage === expected.stage && v.kind === expected.kind); break;
    case 7: keys(v, ['kind']); ensure(v.kind === expected.kind); break;
    default: ensure(false);
  }
}
export interface Grant { units: number; call: bigint; arena: bigint; limit: number; kind: number; direction: number }
export function grantBytes(grant: Grant): Uint8Array {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(safe(grant.units))); view.setBigUint64(8, grant.call); view.setBigUint64(16, grant.arena);
  view.setUint32(24, grant.limit); view.setUint8(28, grant.kind); view.setUint8(29, grant.direction); return bytes;
}
export function validateGrant(bytes: Uint8Array): Grant {
  ensure(bytes.length === 32); const v = new DataView(bytes.buffer, bytes.byteOffset, 32);
  const units = v.getBigUint64(0); ensure(units <= 9_007_199_254_740_991n, 1);
  const grant = { units: Number(units), call: v.getBigUint64(8), arena: v.getBigUint64(16), limit: v.getUint32(24), kind: v.getUint8(28), direction: v.getUint8(29) };
  ensure(v.getUint16(30) === 0 && grant.arena > 0n);
  if (grant.kind === 3) ensure(grant.direction === 0 && grant.limit === 0 && grant.call === 0n);
  else if (grant.kind === 1) ensure(grant.direction === 1 && grant.limit === 4096 && grant.call > 0n);
  else ensure(grant.kind === 2 && [1, 2].includes(grant.direction) && grant.limit > 0 && grant.limit <= 65_536 && grant.call > 0n);
  return grant;
}
export const decodeControl = (bytes: Uint8Array): Facts => {
  ensure(bytes.length <= 4096, 1);
  return parseStoredJsonStrict(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as Facts;
};
export const encodeControl = controlBytes;
