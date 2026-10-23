import { vocabulary, assertPortableUnicode, validatePortableProviderShape, validatePortableTypedResult } from '../../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
/** Closed recognition of stored codec values. This never builds a replay item. */
import { isRecord } from './jsonValues';
import { buildAssistantProviderInputItemsFromTurn, buildProviderInputItemsFromContent } from './responsesCodec';
import { CHAT_COMPLETION_PROVIDER_ITEM_TYPE } from './chatCompletionsCodec';

export type HistoricalProviderPart =
  | { kind: 'final' | 'reflection' | 'display' | 'user_data'; text: string; path: (string | number)[] }
  | { kind: 'image'; url: string; path: (string | number)[] }
  | { kind: 'call'; id: string; name: string; arguments: string; path: (string | number)[] }
  | { kind: 'result'; id: string; text: string; name?: string; path: (string | number)[] }
  | { kind: 'excluded'; reason: 'opaque_continuation' | 'local_identifier'; path: (string | number)[] };

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('unknown_required_shape');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('unknown_required_shape');
  assertPortableUnicode(value);
  return value;
}
function complete(item: Record<string, unknown>): void {
  if (item.status !== undefined && item.status !== 'completed') throw new Error('incomplete_result');
}
function resultText(item: Record<string, unknown>, output: string): string {
  validatePortableTypedResult(item.macro_tool_result, output);
  return output;
}

export function recognizePortableProviderItems(value: unknown): HistoricalProviderPart[] {
  validatePortableProviderShape(value);
  if (!Array.isArray(value)) throw new Error('unknown_required_shape');
  const parts: HistoricalProviderPart[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) throw new Error('unknown_required_shape');
    const path = [index] as (string | number)[];
    const addText = (kind: 'final' | 'reflection' | 'display' | 'user_data', content: unknown, suffix: (string | number)[]) =>
      parts.push({ kind, text: text(content), path: [...path, ...suffix] });
    if (raw.type === 'message') {
      const item = object(raw, vocabulary.providerKeys.responsesMessage); complete(item);
      if (!['user', 'assistant'].includes(String(item.role)) || (item.channel !== undefined && item.channel !== 'final') || !Array.isArray(item.content)) throw new Error('unknown_required_shape');
      for (const [position, rawPart] of item.content.entries()) {
        if (item.role === 'user' && isRecord(rawPart) && rawPart.type === 'input_image') {
          const image = object(rawPart, vocabulary.providerKeys.responsesImage);
          const url = text(image.image_url);
          buildProviderInputItemsFromContent('user', [{ type: 'image_url', image_url: { url } }]);
          parts.push({ kind: 'image', url, path: [...path, 'content', position, 'image_url'] }); continue;
        }
        const part = object(rawPart, vocabulary.providerKeys.responsesText);
        if (part.type !== (item.role === 'user' ? 'input_text' : 'output_text') || (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length)) || (part.logprobs !== undefined && (!Array.isArray(part.logprobs) || part.logprobs.length))) throw new Error('unknown_required_shape');
        // Use the same text-bearing envelope as the producer; no UI text fallback.
        const produced = buildAssistantProviderInputItemsFromTurn(text(part.text), []);
        if (!produced.length && part.text !== '') throw new Error('unknown_required_shape');
        addText(item.role === 'user' ? 'user_data' : 'final', part.text, ['content', position, 'text']);
      }
    } else if (raw.type === 'reasoning') {
      const item = object(raw, vocabulary.providerKeys.responsesReasoning); complete(item);
      if (!Array.isArray(item.summary)) throw new Error('unknown_required_shape');
      for (const [position, rawSummary] of item.summary.entries()) {
        const summary = object(rawSummary, vocabulary.providerKeys.responsesSummary);
        if (summary.type !== 'summary_text') throw new Error('unknown_required_shape');
        addText('reflection', summary.text, ['summary', position, 'text']);
      }
      if (item.encrypted_content !== undefined) {
        if (typeof item.encrypted_content !== 'string') throw new Error('unknown_required_shape');
        parts.push({ kind: 'excluded', reason: 'opaque_continuation', path: [...path, 'encrypted_content'] });
      }
    } else if (raw.type === 'function_call') {
      const item = object(raw, vocabulary.providerKeys.responsesCall); complete(item);
      parts.push({ kind: 'call', id: text(item.call_id), name: text(item.name), arguments: text(item.arguments), path });
    } else if (raw.type === 'function_call_output') {
      const item = object(raw, vocabulary.providerKeys.responsesResult);
      parts.push({ kind: 'result', id: text(item.call_id), text: resultText(item, text(item.output)), path });
    } else if (raw.type === CHAT_COMPLETION_PROVIDER_ITEM_TYPE) {
      const item = object(raw, vocabulary.providerKeys.macroMessage);
      if (item.role === 'tool') {
        if (item.tool_calls !== undefined || item.reasoning_content !== undefined || item.reasoning_details !== undefined || item.visible_content !== undefined) throw new Error('unknown_required_shape');
        parts.push({ kind: 'result', id: text(item.tool_call_id), text: resultText(item, text(item.content)), ...(item.tool_name === undefined ? {} : { name: text(item.tool_name) }), path });
      } else if (item.role === 'assistant') {
        if (item.tool_call_id !== undefined || item.macro_tool_result !== undefined) throw new Error('unknown_required_shape');
        addText('final', item.content, ['content']);
        if (item.tool_name !== undefined) text(item.tool_name);
        if (item.visible_content !== undefined) addText('display', item.visible_content, ['visible_content']);
        if (item.reasoning_content !== undefined) addText('reflection', item.reasoning_content, ['reasoning_content']);
        if (item.reasoning_details !== undefined && (!Array.isArray(item.reasoning_details) || item.reasoning_details.length)) throw new Error('unknown_required_reasoning');
        if (item.tool_calls !== undefined) {
          if (!Array.isArray(item.tool_calls)) throw new Error('unknown_required_shape');
          for (const [position, rawCall] of item.tool_calls.entries()) {
            const call = object(rawCall, vocabulary.providerKeys.macroCall);
            const fn = object(call.function, vocabulary.providerKeys.function);
            if (call.type !== 'function') throw new Error('unknown_required_shape');
            parts.push({ kind: 'call', id: text(call.id), name: text(fn.name), arguments: text(fn.arguments), path: [...path, 'tool_calls', position] });
          }
        }
      } else throw new Error('unknown_required_shape');
    } else throw new Error('unknown_required_shape');
    // Do not retain IDs, opaque bytes, their lengths or isolated fingerprints.
    if ('id' in raw && typeof raw.id !== 'string') throw new Error('unknown_required_shape');
    if ('id' in raw) parts.push({ kind: 'excluded', reason: 'local_identifier', path: [...path, 'id'] });
  }
  return parts;
}
