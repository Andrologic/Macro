import type { MCPServer, MCPTool } from '../types';
import { services } from './index';
import { isMCPServerEnabled, normalizeMCPServer, normalizeMCPServerTools } from './mcp';

export interface ScopedMcpRuntime {
  servers: MCPServer[];
  tools: MCPTool[];
}

type CacheEntry = {
  expiresAt: number;
  promise: Promise<MCPServer>;
};

const CACHE_TTL_MS = 30_000;
const discoveryCache = new Map<string, CacheEntry>();

const toRuntimeServer = (id: string, definition: Record<string, unknown>): MCPServer =>
  normalizeMCPServer({
    id,
    name: typeof definition.name === 'string' ? definition.name : id,
    description: typeof definition.description === 'string' ? definition.description : '',
    category: typeof definition.category === 'string'
      ? definition.category as MCPServer['category']
      : 'other',
    icon: typeof definition.icon === 'string' ? definition.icon as MCPServer['icon'] : 'server',
    website: typeof definition.website === 'string' ? definition.website : undefined,
    transport: definition.transport as MCPServer['transport'],
    config: { enabled: definition.enabled === true },
  });

const discoverServer = async (
  server: MCPServer,
  discover: typeof services.mcpDiscoverTools,
): Promise<MCPServer> => {
  const response = await discover(server);
  const online = normalizeMCPServer({ ...server, status: 'online', tools: response.tools });
  return { ...online, tools: normalizeMCPServerTools(online) };
};

const loadServer = (
  server: MCPServer,
  fallbackServers: readonly MCPServer[],
  discover: typeof services.mcpDiscoverTools,
): Promise<MCPServer> => {
  const fallback = fallbackServers.find((candidate) =>
    candidate.id === server.id
      && isMCPServerEnabled(candidate)
      && candidate.status === 'online'
      && JSON.stringify(candidate.transport) === JSON.stringify(server.transport)
  );
  if (fallback) return Promise.resolve(fallback);

  const cacheKey = `${server.id}:${JSON.stringify(server.transport)}`;
  const now = Date.now();
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = discoverServer(server, discover).catch((error) => {
    discoveryCache.delete(cacheKey);
    throw error;
  });
  discoveryCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, promise });
  return promise;
};

export const resolveScopedMcpRuntime = async (
  definitions: Readonly<Record<string, Record<string, unknown>>>,
  fallbackServers: readonly MCPServer[],
  discover: typeof services.mcpDiscoverTools = services.mcpDiscoverTools,
): Promise<ScopedMcpRuntime> => {
  const configured = Object.entries(definitions)
    .map(([id, definition]) => toRuntimeServer(id, definition))
    .filter(isMCPServerEnabled);
  const settled = await Promise.allSettled(
    configured.map((server) => loadServer(server, fallbackServers, discover)),
  );
  const servers = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  return {
    servers,
    tools: servers.flatMap((server) => normalizeMCPServerTools(server).filter((tool) => tool.enabled !== false)),
  };
};

export const callScopedMcpTool = async (
  toolId: string,
  args: Record<string, unknown>,
  servers: readonly MCPServer[],
  callTool: typeof services.mcpCallTool = services.mcpCallTool,
): Promise<string> => {
  for (const server of servers) {
    const tool = normalizeMCPServerTools(server).find((candidate) => candidate.id === toolId);
    if (!tool) continue;
    const response = await callTool({
      server,
      toolName: tool.name,
      arguments: args,
    });
    if (response.isError) {
      throw new Error(response.content || `MCP tool ${tool.name} reported an error.`);
    }
    return response.content;
  }
  return `MCP tool ${toolId} is not configured for this turn.`;
};
