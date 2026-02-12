import type { Tool, MCPServer } from '../types';

// Internal Tools - Only real, functional tools
export const mockInternalTools: Tool[] = [
  // Web Search Tool (uses Tavily/Brave API)
  {
    id: 'web_search',
    name: 'Web Search',
    category: 'web',
    status: 'enabled',
    description: 'Search the web for information with citations',
    icon: 'search',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: false,
      provider: 'tavily',
      maxResults: 5,
    },
  },
  // Web fetch tool (direct URL retrieval, no API key required)
  {
    id: 'web_fetch',
    name: 'Web Fetch',
    category: 'web',
    status: 'enabled',
    description: 'Fetch and read a specific URL directly',
    icon: 'globe',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: false,
    },
  },
  // File reading tool
  {
    id: 'read_file',
    name: 'Read File',
    category: 'filesystem',
    status: 'enabled',
    description: 'Read file contents from the workspace',
    icon: 'file-text',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: false,
    },
  },
  // Internal source citation helper (always enabled, visible in chat toolbox)
  {
    id: 'mark_source_passage',
    name: 'Sources',
    category: 'ai',
    status: 'enabled',
    description: 'Track interesting passages and passages used by the AI',
    icon: 'book-open',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: true,
      locked: true,
    },
  },
];

// MCP Servers - Empty by default (users can configure their own)
export const mockMCPServers: MCPServer[] = [];

// Default settings
export const defaultToolSettings: Record<string, boolean> = {
  web_search: true,
  web_fetch: true,
  read_file: true,
  mark_source_passage: true,
};
export const defaultMCPServerSettings: Record<string, boolean> = {};
