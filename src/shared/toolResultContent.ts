import type { McpResultBlock } from '../types/generated/ipc/McpResultBlock';

export type ToolResultBlock = McpResultBlock;
export interface TypedToolResult {
  version: 1;
  blocks: ToolResultBlock[];
  isError: boolean;
}
export const MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024;
const utf8Size = (text: string) => new TextEncoder().encode(text).length;
const unavailable = (reason: string): ToolResultBlock => ({ type: 'unavailable', reason });

/** Validate persisted/remote data again at the codec boundary. No URI is dereferenced. */
export function normalizeToolResultBlocks(value: unknown): ToolResultBlock[] {
  if (!Array.isArray(value)) return [unavailable('Invalid MCP content blocks.')];
  let remaining = MAX_TOOL_RESULT_BYTES;
  const blocks = value.slice(0, 64).map((item): ToolResultBlock => {
    if (!item || typeof item !== 'object') return unavailable('Invalid MCP content block.');
    if (item.type === 'text' && typeof item.text === 'string') {
      const size = utf8Size(item.text);
      if (size > remaining) return unavailable('MCP result exceeds the 8 MiB content limit; text omitted.');
      remaining -= size;
      return { type: 'text', text: item.text };
    }
    if (item.type === 'unavailable' && typeof item.reason === 'string') {
      return unavailable(item.reason.slice(0, 256));
    }
    if (item.type !== 'image' && item.type !== 'audio') return unavailable('Unsupported MCP content type; no resource was fetched.');
    const mimes = item.type === 'image' ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] : ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm'];
    if (typeof item.data !== 'string' || !mimes.includes(item.mimeType)) return unavailable('Invalid MCP media MIME type or data.');
    if (item.data.length > remaining) return unavailable('MCP result exceeds the 8 MiB content limit; media omitted.');
    if (!item.data.length || item.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(item.data) || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) return unavailable('Invalid MCP base64 data; media omitted.');
    try {
      if (btoa(atob(item.data)) !== item.data) return unavailable('Invalid MCP base64 data; media omitted.');
    } catch { return unavailable('Invalid MCP base64 data; media omitted.'); }
    remaining -= item.data.length;
    return { type: item.type, mimeType: item.mimeType, data: item.data };
  });
  if (value.length > 64) blocks.push(unavailable('MCP result exceeds the 64 block limit; remaining blocks omitted.'));
  return blocks;
}

export function readTypedToolResult(item: unknown): TypedToolResult | undefined {
  if (!item || typeof item !== 'object' || !('macro_tool_result' in item)) return undefined;
  const value = item.macro_tool_result;
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('blocks' in value)) return undefined;
  const blocks = normalizeToolResultBlocks(value.blocks);
  return { version: 1, blocks, isError: ('isError' in value && value.isError === true) || blocks.some(block => block.type === 'unavailable') };
}

export function projectToolResultText(blocks: ToolResultBlock[], transport = 'this transport'): string {
  return blocks.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'unavailable') return `[MCP content unavailable: ${block.reason}]`;
    return `[MCP ${block.type} ${block.mimeType} retained in history but not sent as media by ${transport}; the model cannot inspect its ${block.type === 'image' ? 'pixels' : 'sound'} here.]`;
  }).join('\n');
}

export const typedToolResult = (blocks: ToolResultBlock[] | undefined, isError = false): TypedToolResult | undefined =>
  blocks ? { version: 1, blocks: normalizeToolResultBlocks(blocks), isError: isError || blocks.some(block => block.type === 'unavailable') } : undefined;
