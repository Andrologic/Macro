import type { ContextRefKind } from '../../types';

/** Stable references stay readable in exported plain text. Legacy markers still load. */
export const COMPOSER_REFERENCE_PATTERN = /\[(skill|file|source|plan-node|predicted-branch|agsdl):\s*([^\]]+)\](?:\(macro-context:\/\/([^/]+)\/([^)]*)\))?/gi;

export function referenceText(kind: ContextRefKind, id: string, title: string): string {
  return `[${kind}: ${title.replaceAll(']', '］') }](macro-context://${kind}/${encodeURIComponent(id).replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16)}`)})`;
}

export function referenceId(match: RegExpExecArray): string | undefined {
  if (!match[4] || match[3] !== match[1].toLowerCase()) return undefined;
  try { return decodeURIComponent(match[4]); } catch { return undefined; }
}

/** Stable markers never fall back to a similarly named reference. */
export function resolveReference<T extends { kind: ContextRefKind; id: string; title: string }>(
  match: RegExpExecArray, refs: readonly T[] = [],
): T | undefined {
  const kind = match[1].toLowerCase();
  const id = referenceId(match);
  if (match[3] !== undefined) {
    return id === undefined ? undefined : refs.find(ref => ref.kind === kind && ref.id === id);
  }
  const title = match[2].trim();
  const candidates = refs.filter(ref => ref.kind === kind && (ref.title === title || ref.id === title));
  return candidates.length === 1 ? candidates[0] : undefined;
}
