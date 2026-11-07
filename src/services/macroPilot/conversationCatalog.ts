import type { Conversation, ConversationCatalogPage, ConversationCatalogToken } from '../../types/generated/ipc';

export const CATALOG_PAGE_BYTES = 4 * 1024 * 1024;
export const sameCatalogToken = (a: ConversationCatalogToken, b: ConversationCatalogToken): boolean =>
  a.version === b.version && a.generation === b.generation && a.incarnation === b.incarnation && a.revision === b.revision;
const invalid = (): never => { throw new Error('unavailable'); };
export function catalogDecimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) return invalid();
  return BigInt(value);
}
export function catalogToken(value: ConversationCatalogToken): ConversationCatalogToken {
  if (!value || value.version !== 1 || typeof value.generation !== 'string' || !/^[0-9a-f]{32}$/.test(value.generation) ||
    typeof value.incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(value.incarnation)) return invalid();
  catalogDecimal(value.revision);
  return Object.freeze({ version: 1, generation: value.generation, incarnation: value.incarnation, revision: value.revision });
}
const textFields = ['id', 'title', 'description', 'scope_mode', 'task_id', 'group_id', 'project_id', 'provider_id', 'model_id', 'reasoning_effort', 'created_at', 'updated_at', 'last_message'] as const;
const required = new Set<string>(['id', 'title', 'scope_mode', 'created_at', 'updated_at']);
function validText(value: string): boolean {
  // Native strings are valid UTF-8. Do not silently replace an invalid surrogate
  // from a broken transport before checking SQLite's BINARY order.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
/** UTF-8 BINARY order equals scalar-value order for well-formed strings. JS <
 * compares UTF-16 units instead, reversing e.g. U+E000 and U+10000. */
export function binaryCompare(a: string, b: string): number {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!, y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1; j += y > 0xffff ? 2 : 1;
  }
  return i === a.length ? j === b.length ? 0 : -1 : 1;
}
export function checkCatalogPage(page: ConversationCatalogPage, expected: ConversationCatalogToken | undefined,
  after: string | null, total: bigint | undefined, seen: bigint): { token: ConversationCatalogToken; total: bigint } {
  if (!page || !Array.isArray(page.items) || page.items.length > 100 || !Number.isSafeInteger(page.admission_estimate_bytes) ||
    page.admission_estimate_bytes < 0 || page.admission_estimate_bytes > CATALOG_PAGE_BYTES) return invalid();
  const token = catalogToken(page.token);
  if (expected && !sameCatalogToken(token, expected)) return invalid();
  if (after === null) total = catalogDecimal(page.total_raw);
  else if (page.total_raw !== undefined || total === undefined) return invalid();
  let previous = after;
  for (const row of page.items) {
    if (!row || typeof row !== 'object') return invalid();
    for (const field of textFields) {
      const value = row[field];
      if (value === null && !required.has(field)) continue;
      if (typeof value !== 'string' || !validText(value)) return invalid();
    }
    if (!Number.isInteger(row.message_count) || row.message_count < -2147483648 || row.message_count > 2147483647 || typeof row.is_pinned !== 'boolean') return invalid();
    if (previous !== null && binaryCompare(previous, row.id) >= 0) return invalid();
    previous = row.id;
  }
  const count = seen + BigInt(page.items.length);
  if (count > total!) return invalid();
  if (page.next_after !== null) {
    if (!page.items.length || !page.next_after || page.next_after.id !== previous || count >= total!) return invalid();
  } else if (count !== total!) return invalid();
  return { token, total: total! };
}
export function ownCatalogRow(row: Conversation): Conversation {
  return Object.freeze({ id: row.id, title: row.title, description: row.description, scope_mode: row.scope_mode,
    task_id: row.task_id, group_id: row.group_id, project_id: row.project_id, provider_id: row.provider_id,
    model_id: row.model_id, reasoning_effort: row.reasoning_effort, created_at: row.created_at, updated_at: row.updated_at,
    last_message: row.last_message, message_count: row.message_count, is_pinned: row.is_pinned });
}
