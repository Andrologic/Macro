import { describe, expect, test } from 'bun:test';
import type { MCPTool } from '../../types';
import { allowedMcpTools, modelAllowedToolIds, searchMcpTools, shouldDiscoverMcpTools } from './toolDiscovery';

const catalog = (count: number): MCPTool[] => Array.from({ length: count }, (_, index) => ({
  id: `mcp__docs__tool_${index}`, serverId: 'docs', name: `tool_${index}`,
  description: index === count - 1 ? 'Rare bilingual recherche archive' : 'Read a document',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
}));

describe('MCP discovery selection', () => {
  test('keeps a small catalog and replaces a large one with two bounded tools', () => {
    const small = catalog(12);
    const smallIds = small.map(tool => tool.id);
    expect(shouldDiscoverMcpTools(new Set(smallIds), small)).toBe(false);
    expect(modelAllowedToolIds(smallIds, small)).toEqual(smallIds);
    const large = catalog(13);
    const largeIds = large.map(tool => tool.id);
    expect(modelAllowedToolIds(largeIds, large)).toEqual(['mcp_search', 'mcp_call']);
    expect(modelAllowedToolIds(largeIds.slice(0, 2), large)).toEqual(largeIds.slice(0, 2));
  });

  test('only searches permitted enabled tools and caps results', () => {
    const tools = catalog(20);
    tools[1].enabled = false;
    const permitted = allowedMcpTools(new Set(tools.slice(1).map(tool => tool.id)), tools);
    expect(permitted).not.toContainEqual(tools[0]);
    expect(permitted).not.toContainEqual(tools[1]);
    const rare = searchMcpTools('recherché archive', permitted);
    expect(rare.ids).toEqual([tools[19].id]);
    const broad = searchMcpTools('document', permitted);
    expect(broad.ids).toHaveLength(5);
    expect(broad.text.length).toBeLessThanOrEqual(24_000);
    expect(searchMcpTools(' ', permitted).ids).toEqual([]);
  });

  test('uses discovery when a few schemas exceed the inline budget', () => {
    const tools = catalog(2);
    tools[0].inputSchema = { type: 'object', description: 'x'.repeat(16_001) };
    expect(shouldDiscoverMcpTools(new Set(tools.map(tool => tool.id)), tools)).toBe(true);
  });

  test('keeps an oversized schema discoverable while bounding output', () => {
    const tools = catalog(1);
    tools[0].inputSchema = { type: 'object', description: 'x'.repeat(30_000) };
    tools[0].description = 'é'.repeat(2_000);
    const result = searchMcpTools('tool_0', tools);
    expect(result.ids).toEqual([tools[0].id]);
    expect(result.text).toContain('schemaOmitted');
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(24_000);
  });
});
