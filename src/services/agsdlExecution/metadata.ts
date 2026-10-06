import type { ExactJsonText, SourceRevision } from './contracts';
import { at, decode, fail } from './exact';

/** Runtime guards for transport metadata. They never coerce values or authenticate callers. */
export function metadataObject(value: unknown, pointer: string, code = 'UNSUPPORTED'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code, pointer, 'Expected a plain metadata object.');
  return Object.fromEntries(Object.entries(value));
}
export function metadataText(value: unknown, pointer: string, code = 'UNSUPPORTED'): string {
  if (typeof value !== 'string') return fail(code, pointer, 'Expected primitive text metadata.');
  return value;
}
export function metadataIdentity(value: unknown, pointer: string, code = 'UNSUPPORTED'): string {
  const identity = metadataText(value, pointer, code);
  if (!identity.trim()) return fail(code, pointer, 'Metadata identity must be nonempty.');
  return identity;
}
export function metadataArray(value: unknown, pointer: string): unknown[] {
  if (!Array.isArray(value)) return fail('UNSUPPORTED', pointer, 'Expected a metadata array.');
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return fail('UNSUPPORTED', `${pointer}/${index}`, 'Metadata array contains an absent entry.');
  return value;
}
export function metadataJson(value: unknown, pointer: string): ExactJsonText {
  const json = metadataText(value, pointer);
  try { decode(json); } catch { return fail('UNSUPPORTED', pointer, 'Expected validated exact JSON metadata.'); }
  return json as ExactJsonText;
}
/** MCP schema DTOs are ordinary native JSON, distinct from authored AgSDL values. */
export function captureNativeJson(value: unknown, pointer: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return metadataArray(value, pointer).map((item, index) => captureNativeJson(item, `${pointer}/${index}`));
  const object = metadataObject(value, pointer);
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, captureNativeJson(child, at(pointer, key))]));
}
/** Copy only the complete validated source DTO, synchronously before any digest await. */
export function captureSourceRevision(value: unknown): SourceRevision {
  const source = metadataObject(value, '/source', 'CORRELATION');
  const owner = metadataObject(source.owner, '/source/owner', 'CORRELATION');
  const capturedOwner = {
    projectId: metadataIdentity(owner.projectId, '/source/owner/projectId', 'CORRELATION'),
    planId: metadataIdentity(owner.planId, '/source/owner/planId', 'CORRELATION'),
    branch: metadataIdentity(owner.branch, '/source/owner/branch', 'CORRELATION'),
  };
  const revision = metadataText(source.revision, '/source/revision', 'CORRELATION');
  if (!/^(0|[1-9][0-9]*)$/.test(revision)) return fail('CORRELATION', '/source/revision', 'Source revision must be a canonical decimal string.');
  const sourceSha256 = metadataText(source.sourceSha256, '/source/sourceSha256', 'CORRELATION');
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) return fail('CORRELATION', '/source/sourceSha256', 'Source SHA must be a canonical lowercase hexadecimal string.');
  return { owner: capturedOwner, revision, sourceSha256: sourceSha256 as SourceRevision['sourceSha256'] };
}
