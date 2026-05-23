export const MCP_TOOL_ID_PREFIX = 'mcp__';

const MCP_IDENTIFIER_MAX_LENGTH = 64;

export const normalizeMCPIdentifier = (value: string, fallback = 'server'): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MCP_IDENTIFIER_MAX_LENGTH);

  return normalized || fallback;
};

export const isMCPToolId = (toolId: string): boolean =>
  toolId.startsWith(MCP_TOOL_ID_PREFIX) && toolId.split('__').length >= 3;

export const buildMCPToolId = (serverId: string, toolName: string): string =>
  `${MCP_TOOL_ID_PREFIX}${normalizeMCPIdentifier(serverId)}__${normalizeMCPIdentifier(
    toolName,
    'tool'
  )}`;

export const parseMCPToolId = (
  toolId: string
): { serverId: string; toolSlug: string } | null => {
  if (!isMCPToolId(toolId)) {
    return null;
  }

  const [, serverId, ...toolParts] = toolId.split('__');
  const toolSlug = toolParts.join('__');
  if (!serverId || !toolSlug) {
    return null;
  }

  return { serverId, toolSlug };
};
