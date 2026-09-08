import type { DbMessage } from '../tauriIpc';
import { buildAssistantMessagePresentation, buildUserMessagePresentation } from '../chatDbMappers';

export interface TextPolicy { revision: string; secrets: readonly string[]; inspectionBytes?: number }
export type ExportText = { content_state: 'complete' | 'excerpt'; text: string } |
  { content_state: 'withheld' | 'pending'; reason: 'unsafe_content' | 'unknown_provenance' | 'generating' };
const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;
const unsafe = /file:\/\/|\/(?:Users|home|private|var|tmp|opt|etc|root|Volumes)\/|[A-Za-z]:\\|gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----/i;
export function controlledText(text: string, policy: TextPolicy): ExportText {
  if (utf8Bytes(text) > (policy.inspectionBytes ?? 1024 * 1024) || unsafe.test(text) ||
      policy.secrets.some(secret => secret.length > 0 && text.includes(secret)) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
    return { content_state: 'withheld', reason: 'unsafe_content' };
  }
  let bytes = 0; let result = '';
  for (const char of text) { const size = utf8Bytes(char); if (bytes + size > 16384) break; bytes += size; result += char; }
  return { content_state: result.length === text.length ? 'complete' : 'excerpt', text: result };
}

/** Recognizes only Macro's legacy prefix grammar: <think>reasoning</think> final.
 * Unknown, nested, repeated, open, or malformed markers fail closed. */
export function legacyFinalText(content: string): string | null {
  const value = content.trim();
  if (!value.startsWith('<think>')) return null;
  const end = value.indexOf('</think>', 7);
  if (end < 0) return null;
  const reasoning = value.slice(7, end); const final = value.slice(end + 8).trim();
  if (/[<>]/.test(reasoning) || hasReasoningMarker(final)) return null;
  return final;
}

function hasReasoningMarker(text: string): boolean {
  const names = ['think', 'analysis', 'reasoning', 'final'];
  for (let start = text.indexOf('<'); start >= 0; start = text.indexOf('<', start + 1)) {
    const end = text.indexOf('>', start + 1);
    const token = text.slice(start + 1, end < 0 ? undefined : end).trim().replace(/^\/\s*/, '').toLowerCase();
    if (token.startsWith('|') || names.some(name => token.startsWith(name) || (end < 0 && name.startsWith(token)))) return true;
  }
  return false;
}

function providerFinalText(message: DbMessage): string | null {
  if (!message.provider_turn_state_json) return null;
  try {
    const state: unknown = JSON.parse(message.provider_turn_state_json);
    if (!state || typeof state !== 'object' || !('provider' in state) || state.provider !== 'chatgpt' || !('output_items' in state) || !Array.isArray(state.output_items)) return null;
    const texts: string[] = [];
    for (const item of state.output_items) {
      if (item?.type !== 'message') continue;
      if (item.role !== 'assistant' || (item.channel !== undefined && item.channel !== 'final') || item.status !== 'completed' || !Array.isArray(item.content)) return null;
      for (const part of item.content) {
        if (part?.type !== 'output_text' || typeof part.text !== 'string') return null;
        texts.push(part.text);
      }
    }
    const final = texts.join('');
    // State is evidence only when it agrees with persisted display content.
    return texts.length && (message.content.trim() === final.trim() || legacyFinalText(message.content) === final.trim()) ? final : null;
  } catch { return null; }
}
export function messageText(message: DbMessage, generating: boolean, policy: TextPolicy): ExportText {
  if (message.role === 'assistant' && generating) return { content_state: 'pending', reason: 'generating' };
  if (message.role === 'user') {
    const whole = controlledText(message.content, policy);
    if (whole.content_state === 'withheld') return whole;
    return controlledText(buildUserMessagePresentation(message.content).content, policy);
  }
  // Inspect before parsing and excerpting, including a secret crossing a page boundary.
  const whole = controlledText(message.content, policy);
  if (whole.content_state === 'withheld') return whole;
  const proven = providerFinalText(message);
  const final = proven === null ? legacyFinalText(message.content) :
    proven.trim().startsWith('<think>') ? legacyFinalText(proven) :
    hasReasoningMarker(proven) ? null : proven;
  if (final === null) return { content_state: 'withheld', reason: 'unknown_provenance' };
  return controlledText(buildAssistantMessagePresentation(final).content, policy);
}
export function completion(reason: string | null | undefined): 'complete' | 'incomplete' | 'unknown' {
  if (['completed', 'length_recovered', 'incomplete_recovered'].includes(reason ?? '')) return 'complete';
  if (['length', 'incomplete', 'tool_turn_limit'].includes(reason ?? '')) return 'incomplete';
  return 'unknown';
}
