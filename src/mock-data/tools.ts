import type { Tool, MCPServer } from '../types';

// Internal Tools - Only real, functional tools
export const mockInternalTools: Tool[] = [
  // Web Search Tool (uses Tavily/Brave API)
  {
    id: 'web-search',
    name: 'Web Search',
    category: 'web',
    status: 'enabled',
    description: 'Search the web for information with citations',
    icon: 'search',
    config: { provider: 'tavily', maxResults: 5 },
  },
  // File reading tool
  {
    id: 'file-read',
    name: 'Read File',
    category: 'filesystem',
    status: 'enabled',
    description: 'Read file contents from the workspace',
    icon: 'file',
    config: {},
  },
];

// MCP Servers - Empty by default (users can configure their own)
export const mockMCPServers: MCPServer[] = [];

// Default settings
export const defaultToolSettings: Record<string, boolean> = {
  'web-search': true,
  'file-read': true,
};
export const defaultMCPServerSettings: Record<string, boolean> = {};
