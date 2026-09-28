import { toFunctionToolShape, type MacroToolRegistryEntry } from '../../shared/macroToolRegistry';
import type { MCPTool } from '../../types';
import { MCP_CALL_TOOL_ID, MCP_SEARCH_TOOL_ID } from './identifiers';

export { MCP_CALL_TOOL_ID, MCP_SEARCH_TOOL_ID } from './identifiers';
const MAX_INLINE_TOOLS = 12;
const MAX_INLINE_SCHEMA_CHARS = 16_000;
const MAX_RESULTS = 5;
const MAX_RESULT_BYTES = 24_000;

export const MCP_DISCOVERY_DEFINITIONS: MacroToolRegistryEntry[] = [
  {
    id: MCP_SEARCH_TOOL_ID,
    description: 'Search the MCP tools available in this turn by name, server, or description. Returns at most five matching tools and their argument schemas. Search before using mcp_call.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words describing the needed capability.' } }, required: ['query'] },
  },
  {
    id: MCP_CALL_TOOL_ID,
    description: 'Call an MCP tool returned by mcp_search. The selected tool keeps its own permissions, validation, and approval.',
    parameters: { type: 'object', properties: {
      tool_id: { type: 'string', description: 'Exact tool id returned by mcp_search.' },
      arguments: { type: 'object', description: 'Arguments matching the selected tool schema.' },
    }, required: ['tool_id', 'arguments'] },
  },
];

export const mcpDiscoveryToolShapes = MCP_DISCOVERY_DEFINITIONS.map(toFunctionToolShape);

export const allowedMcpTools = (ids: ReadonlySet<string>, tools: readonly MCPTool[]): MCPTool[] =>
  tools.filter(tool => ids.has(tool.id) && tool.enabled !== false);

export const shouldDiscoverMcpTools = (ids: ReadonlySet<string>, tools: readonly MCPTool[]): boolean => {
  const permitted = allowedMcpTools(ids, tools);
  if (permitted.length > MAX_INLINE_TOOLS) return true;
  let schemaChars = 0;
  for (const tool of permitted) {
    schemaChars += JSON.stringify(tool.inputSchema ?? {}).length;
    if (schemaChars > MAX_INLINE_SCHEMA_CHARS) return true;
  }
  return false;
};

export const modelAllowedToolIds = (ids: readonly string[], tools: readonly MCPTool[]): string[] => {
  const allowed = new Set(ids);
  if (!shouldDiscoverMcpTools(allowed, tools)) return [...ids];
  const hiddenIds = new Set(allowedMcpTools(allowed, tools).map(tool => tool.id));
  return [...ids.filter(id => !hiddenIds.has(id)), MCP_SEARCH_TOOL_ID, MCP_CALL_TOOL_ID];
};

export const searchMcpTools = (query: unknown, tools: readonly MCPTool[]): { text: string; ids: string[] } => {
  if (typeof query !== 'string' || !query.trim() || query.length > 120) {
    return { text: 'Provide a non-empty query of at most 120 characters.', ids: [] };
  }
  const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches = tools.map(tool => {
    const name = normalize(`${tool.id} ${tool.name} ${tool.serverId}`);
    const description = normalize(tool.description ?? '');
    const score = words.reduce((total, word) => total + (name.includes(word) ? 2 : description.includes(word) ? 1 : 0), 0);
    return { tool, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id));
  const selected: MCPTool[] = [];
  const lines: string[] = [];
  let bytes = 0;
  const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
  for (const { tool } of matches) {
    if (selected.length >= MAX_RESULTS) break;
    const separatorBytes = lines.length ? 1 : 0;
    const summary = { id: tool.id, server: tool.serverId, name: tool.name,
      description: (tool.description ?? '').slice(0, 2_000) };
    let line = JSON.stringify({ ...summary, inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } });
    if (bytes + separatorBytes + byteLength(line) > MAX_RESULT_BYTES) {
      line = JSON.stringify({ ...summary, schemaOmitted: 'Schema exceeds the bounded search output.' });
    }
    if (bytes + separatorBytes + byteLength(line) > MAX_RESULT_BYTES) break;
    selected.push(tool);
    lines.push(line);
    bytes += separatorBytes + byteLength(line);
  }
  return { text: lines.length ? lines.join('\n') : 'No matching MCP tools found within the result limit. Try a more specific query.', ids: selected.map(tool => tool.id) };
};
