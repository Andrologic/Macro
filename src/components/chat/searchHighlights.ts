import { normalizeLocalSearchText } from '../../services/localModeSearch';

export const splitSearchHighlights = (text: string, query: string): Array<{ text: string; matched: boolean }> => {
  const terms = query.trim().split(/\s+/)
    .map((term) => normalizeLocalSearchText(term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')))
    .filter(Boolean).slice(0, 8);
  if (!terms.length) return [{ text, matched: false }];
  // Map normalized offsets back to the original text, preserving accents and emoji.
  let normalized = '';
  let offset = 0;
  const positions: Array<{ start: number; end: number }> = [];
  for (const character of text) {
    const folded = normalizeLocalSearchText(character);
    const end = offset + character.length;
    for (let i = 0; i < folded.length; i++) positions.push({ start: offset, end });
    if (!folded && positions.length) positions[positions.length - 1].end = end;
    normalized += folded;
    offset = end;
  }
  const pattern = new RegExp(terms.sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu');
  const parts: Array<{ text: string; matched: boolean }> = [];
  let cursor = 0;
  for (const match of normalized.matchAll(pattern)) {
    const start = positions[match.index].start;
    const end = positions[match.index + match[0].length - 1].end;
    if (start < cursor) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), matched: false });
    parts.push({ text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), matched: false });
  return parts;
};
