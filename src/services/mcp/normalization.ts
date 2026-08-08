import type { MCPServer, MCPTool } from '../../types';
import { buildMCPToolId, normalizeMCPIdentifier } from './identifiers';

export const isMCPServerEnabled = (server: MCPServer): boolean =>
  server.config?.enabled === true;

export const hasRunnableMCPTransport = (server: Pick<MCPServer, 'transport'>): boolean => {
  const transport = server.transport;
  return transport?.type === 'stdio'
    ? transport.command.trim().length > 0
    : Boolean(transport && 'url' in transport && transport.url.trim().length > 0);
};

export const normalizeMCPServerTools = (
  server: Pick<MCPServer, 'id' | 'tools'>,
  tools: MCPTool[] = server.tools ?? []
): MCPTool[] =>
  tools.map((tool) => ({
    ...tool,
    id: tool.id || buildMCPToolId(server.id, tool.name),
    serverId: server.id,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    enabled: tool.enabled !== false,
  }));

export const normalizeMCPServer = (server: Partial<MCPServer> & { id: string }): MCPServer => {
  const id = normalizeMCPIdentifier(server.id || server.name || 'server');
  const normalized: MCPServer = {
    ...server,
    id,
    name: server.name?.trim() || id,
    category: server.category ?? 'development',
    status: server.status ?? (hasRunnableMCPTransport(server) ? 'offline' : 'unconfigured'),
    description: server.description ?? 'Custom MCP server',
    icon: server.icon ?? 'server',
    transport: server.transport,
    lastError: server.lastError ?? null,
    discoveredAt: server.discoveredAt ?? null,
    config: {
      ...(server.config ?? {}),
      enabled: server.config?.enabled === true,
    },
  };

  return {
    ...normalized,
    tools: normalizeMCPServerTools(normalized),
  };
};

export const toMCPServerSettingsMap = (servers: MCPServer[]): Record<string, MCPServer> =>
  Object.fromEntries(
    servers.map((server) => {
      const normalized = normalizeMCPServer(server);
      return [normalized.id, normalized];
    })
  );

export const isMCPServerRecord = (value: unknown): value is MCPServer =>
  Boolean(value && typeof value === 'object' && 'id' in value && 'name' in value);
