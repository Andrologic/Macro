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
  {
    id: 'list',
    name: 'List Files',
    category: 'filesystem',
    status: 'enabled',
    description: 'List files and directories in the workspace',
    icon: 'folder',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: false,
    },
  },
  {
    id: 'read',
    name: 'Read Workspace File',
    category: 'filesystem',
    status: 'enabled',
    description: 'Read files directly from the workspace by path',
    icon: 'file-text',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: false,
    },
  },
  {
    id: 'write',
    name: 'Write Workspace File',
    category: 'filesystem',
    status: 'enabled',
    description: 'Create or overwrite workspace files',
    icon: 'save',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: false,
    },
  },
  {
    id: 'edit',
    name: 'Edit Workspace File',
    category: 'filesystem',
    status: 'enabled',
    description: 'Edit workspace files using exact text replacements',
    icon: 'edit',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: false,
    },
  },
  {
    id: 'glob',
    name: 'Glob Files',
    category: 'filesystem',
    status: 'enabled',
    description: 'Find files by glob pattern in the workspace',
    icon: 'search',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: false,
    },
  },
  {
    id: 'grep',
    name: 'Grep Workspace',
    category: 'filesystem',
    status: 'enabled',
    description: 'Search file content in the workspace',
    icon: 'search',
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
    },
  },
  {
    id: 'read_sources',
    name: 'Read Sources',
    category: 'ai',
    status: 'enabled',
    description: 'Read and filter source passages already saved in this conversation',
    icon: 'book-open',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: true,
    },
  },
  {
    id: 'edit_source_passage',
    name: 'Edit Sources',
    category: 'ai',
    status: 'enabled',
    description: 'Update, reclassify, or delete saved source passages',
    icon: 'edit',
    config: {
      enabled: true,
      visible: true,
      chatMode: true,
      internal: true,
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
  list: true,
  read: true,
  write: true,
  edit: true,
  glob: true,
  grep: true,
  mark_source_passage: true,
  read_sources: true,
  edit_source_passage: true,
};
export const defaultMCPServerSettings: Record<string, boolean> = {};
