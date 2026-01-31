import type { Tool, MCPServer } from '../types';

// Internal Tools Mock Data (inspired by VS Code Copilot capabilities)
export const mockInternalTools: Tool[] = [
  // Git Tools
  {
    id: 'git-status',
    name: 'Git Status',
    category: 'git',
    status: 'enabled',
    description: 'View current git status and branch information',
    icon: 'git-branch',
    config: { showUntracked: true },
  },
  {
    id: 'git-commit',
    name: 'Git Commit',
    category: 'git',
    status: 'enabled',
    description: 'Create commits with automatic commit messages',
    icon: 'git-commit',
    config: { autoDetectBranch: true },
  },
  {
    id: 'git-diff',
    name: 'Git Diff',
    category: 'git',
    status: 'enabled',
    description: 'Compare file changes with visual diff viewer',
    icon: 'layers',
    config: { splitView: true },
  },

  // Filesystem Tools
  {
    id: 'file-create',
    name: 'Create File',
    category: 'filesystem',
    status: 'enabled',
    description: 'Create new files and directories',
    icon: 'file',
    config: { defaultPath: './' },
  },
  {
    id: 'file-search',
    name: 'File Search',
    category: 'filesystem',
    status: 'enabled',
    description: 'Search files and directories with advanced filters',
    icon: 'search',
    config: { useRegex: false, caseSensitive: false },
  },

  // Web Search Tools
  {
    id: 'web-search',
    name: 'Web Search',
    category: 'web',
    status: 'enabled',
    description: 'Search the web for information and resources',
    icon: 'search',
    config: { provider: 'default', maxResults: 10 },
  },

  // Database Tools
  {
    id: 'database-query',
    name: 'Database Query',
    category: 'database',
    status: 'disabled',
    description: 'Execute SQL queries with auto-completion',
    icon: 'database',
    config: { timeout: 30 },
  },

  // Terminal Tools
  {
    id: 'terminal-cmd',
    name: 'Terminal Command',
    category: 'terminal',
    status: 'enabled',
    description: 'Execute shell commands safely',
    icon: 'terminal',
    config: { shell: 'bash', warnBeforeExecute: true },
  },

  // AI Tools
  {
    id: 'code-completion',
    name: 'Code Completion',
    category: 'ai',
    status: 'enabled',
    description: 'Intelligent code suggestions and completions',
    icon: 'code',
    config: { contextWindow: 5000, maxTokens: 100 },
  },
  {
    id: 'code-review',
    name: 'Code Review',
    category: 'ai',
    status: 'enabled',
    description: 'AI-powered code analysis and suggestions',
    icon: 'message-square',
    config: { checkStyle: true, checkPerformance: true },
  },
];

// MCP Servers Mock Data (inspired by modelcontextprotocol/servers)
export const mockMCPServers: MCPServer[] = [
  // Database Servers
  {
    id: 'mcp-postgres',
    name: 'PostgreSQL',
    category: 'database',
    status: 'online',
    description: 'Interact with PostgreSQL databases via SQL queries and schema inspection',
    icon: 'database',
    website: 'https://www.postgresql.org',
    config: { connectionString: '', readOnly: false },
  },
  {
    id: 'mcp-mongodb',
    name: 'MongoDB',
    category: 'database',
    status: 'online',
    description: 'Interact with MongoDB databases using natural language',
    icon: 'database',
    website: 'https://www.mongodb.com',
    config: { connectionString: '', readOnly: false },
  },
  {
    id: 'mcp-snowflake',
    name: 'Snowflake',
    category: 'database',
    status: 'online',
    description: 'Query Snowflake databases and analyze data',
    icon: 'database',
    website: 'https://www.snowflake.com',
    config: { account: '', role: '', warehouse: '', readOnly: false },
  },
  {
    id: 'mcp-mysql',
    name: 'MySQL',
    category: 'database',
    status: 'online',
    description: 'MySQL database integration with schema inspection',
    icon: 'database',
    website: 'https://www.mysql.com',
    config: { host: '', port: 3306, database: '', readOnly: false },
  },

  // Productivity Servers
  {
    id: 'mcp-linear',
    name: 'Linear',
    category: 'productivity',
    status: 'online',
    description: 'Manage Linear issues, projects, and teams',
    icon: 'check-square',
    website: 'https://linear.app',
    config: { apiKey: '', workspaceId: '', readOnly: false },
  },
  {
    id: 'mcp-notion',
    name: 'Notion',
    category: 'productivity',
    status: 'online',
    description: 'Access Notion pages, databases, and wikis',
    icon: 'list',
    website: 'https://www.notion.so',
    config: { apiKey: '', readOnly: false },
  },
  {
    id: 'mcp-todoist',
    name: 'Todoist',
    category: 'productivity',
    status: 'degraded',
    description: 'Manage tasks and projects',
    icon: 'list-todo',
    website: 'https://todoist.com',
    config: { apiKey: '', syncInterval: 5 },
  },
  {
    id: 'mcp-github',
    name: 'GitHub',
    category: 'productivity',
    status: 'online',
    description: 'Interact with GitHub repositories, issues, and PRs',
    icon: 'git-branch',
    website: 'https://github.com',
    config: { token: '', endpoint: 'api.github.com', readOnly: false },
  },

  // Communication Servers
  {
    id: 'mcp-slack',
    name: 'Slack',
    category: 'communication',
    status: 'online',
    description: 'Send messages, manage channels, and interact with workspaces',
    icon: 'message-square',
    website: 'https://slack.com',
    config: { token: '', scope: ['channels:read', 'channels:write'], readOnly: false },
  },
  {
    id: 'mcp-discord',
    name: 'Discord',
    category: 'communication',
    status: 'online',
    description: 'Send and read messages, manage servers and channels',
    icon: 'message-square',
    website: 'https://discord.com',
    config: { token: '', readOnly: false },
  },

  // Development Servers
  {
    id: 'mcp-vercel',
    name: 'Vercel',
    category: 'development',
    status: 'online',
    description: 'Access logs, search docs, and manage deployments',
    icon: 'zap',
    website: 'https://vercel.com',
    config: { token: '', projectFilter: '', readOnly: false },
  },
  {
    id: 'mcp-supabase',
    name: 'Supabase',
    category: 'development',
    status: 'online',
    description: 'Create tables, query data, deploy edge functions',
    icon: 'database',
    website: 'https://supabase.com',
    config: { url: '', apiKey: '', readOnly: false },
  },
  {
    id: 'mcp-posthog',
    name: 'PostHog',
    category: 'development',
    status: 'online',
    description: 'Analytics, feature flags, and error tracking',
    icon: 'layers',
    website: 'https://posthog.com',
    config: { apiKey: '', project: '', readOnly: false },
  },

  // AI/ML Servers
  {
    id: 'mcp-huggingface',
    name: 'Hugging Face',
    category: 'ai',
    status: 'online',
    description: 'Search models, access datasets, and interact with the HF Hub',
    icon: 'cpu',
    website: 'https://huggingface.co',
    config: { apiKey: '', readOnly: false },
  },
  {
    id: 'mcp-langflow',
    name: 'Langflow',
    category: 'ai',
    status: 'online',
    description: 'Manage Langflow workflows and components',
    icon: 'layers',
    website: 'https://langflow.org',
    config: { url: '', apiKey: '', readOnly: false },
  },

  // Other Servers
  {
    id: 'mcp-filesystem',
    name: 'Filesystem',
    category: 'other',
    status: 'online',
    description: 'Secure file operations with configurable access controls',
    icon: 'folder',
    website: 'https://modelcontextprotocol.io',
    config: { allowedPaths: [''], readOnly: false },
  },
  {
    id: 'mcp-memory',
    name: 'Memory',
    category: 'other',
    status: 'online',
    description: 'Knowledge graph-based persistent memory system',
    icon: 'sparkles',
    website: 'https://modelcontextprotocol.io',
    config: { vectorDB: '', maxEntries: 1000, readOnly: false },
  },
  {
    id: 'mcp-git',
    name: 'Git',
    category: 'other',
    status: 'online',
    description: 'Interact with local git repositories',
    icon: 'git-branch',
    website: 'https://modelcontextprotocol.io',
    config: { repositoryPath: '', autoCommit: false, readOnly: false },
  },
  {
    id: 'mcp-puppeteer',
    name: 'Puppeteer',
    category: 'other',
    status: 'online',
    description: 'Browser automation with screenshot and scraping',
    icon: 'search',
    website: 'https://pptr.dev',
    config: { headless: true, timeout: 30000, readOnly: false },
  },
];

// Default settings
export const defaultToolSettings: Record<string, boolean> = {};
export const defaultMCPServerSettings: Record<string, boolean> = {};
