import { BUILT_IN_TOOLS, BUILT_IN_MCP_SERVERS } from '../tools/builtInTools';
import type { MCPServer, Tool } from '../../types';
import { normalizeArchitectToolId } from '../architectToolNames';
import {
  isMCPServerRecord,
  normalizeMCPIdentifier,
  normalizeMCPServer,
} from '../mcp';
import type { MCPServerSettingsDto, ToolSettingsDto } from '../contracts/dtos';

export const TOOL_SETTINGS_STORAGE_KEY = 'macro_tool_settings';
export const MCP_SERVER_SETTINGS_STORAGE_KEY = 'macro_mcp_server_settings';

const LEGACY_TOOL_ID_MAP: Record<string, string> = {
  'web-search': 'web_search',
  'file-read': 'read_file',
};

const normalizeToolId = (id: string): string =>
  normalizeArchitectToolId(LEGACY_TOOL_ID_MAP[id] || id);

const normalizeToolSettings = (settings: Record<string, boolean>): Record<string, boolean> =>
  Object.fromEntries(Object.entries(settings).map(([id, enabled]) => [normalizeToolId(id), enabled]));

const transientSettings = new Map<string, Record<string, unknown>>();

const readStoredRecord = (key: string): Record<string, unknown> => {
  return transientSettings.get(key) ?? {};
};

const writeStoredRecord = (key: string, value: Record<string, unknown>): void => {
  transientSettings.set(key, structuredClone(value));
};

export const readStoredToolEnablement = (): Record<string, boolean> => {
  const parsed = readStoredRecord(TOOL_SETTINGS_STORAGE_KEY);
  const normalized = Object.fromEntries(
    Object.entries(parsed).filter(([, enabled]) => typeof enabled === 'boolean') as Array<
      [string, boolean]
    >
  );

  return normalizeToolSettings(normalized);
};

export const writeStoredToolEnablement = (tools: Record<string, boolean>): void => {
  writeStoredRecord(TOOL_SETTINGS_STORAGE_KEY, normalizeToolSettings(tools));
};

export const buildToolSettingsPayload = (): ToolSettingsDto => {
  const enabledTools = readStoredToolEnablement();
  writeStoredToolEnablement(enabledTools);

  const tools: Record<string, Tool> = {};
  BUILT_IN_TOOLS.forEach((tool) => {
    const enabled = enabledTools[tool.id] !== false;
    tools[tool.id] = {
      ...tool,
      status: enabled ? 'enabled' : 'disabled',
      config: {
        ...tool.config,
        enabled,
      },
    };
  });

  return {
    tools: tools as unknown as Record<string, boolean>,
  };
};

export const readStoredMCPServerEnablement = (): Record<string, boolean> => {
  const parsed = readStoredRecord(MCP_SERVER_SETTINGS_STORAGE_KEY);
  return Object.fromEntries(
    Object.entries(parsed).map(([id, value]) => [id, value === true])
  );
};

export const writeStoredMCPServerEnablement = (servers: Record<string, boolean>): void => {
  writeStoredRecord(MCP_SERVER_SETTINGS_STORAGE_KEY, servers);
};

export const readStoredMCPServers = (): Record<string, MCPServer> => {
  const parsed = readStoredRecord(MCP_SERVER_SETTINGS_STORAGE_KEY);
  const rawServers =
    parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)
      ? (parsed.servers as Record<string, unknown>)
      : parsed;

  return Object.fromEntries(
    Object.entries(rawServers).map(([id, value]) => {
      if (isMCPServerRecord(value)) {
        const normalized = normalizeMCPServer({ ...value, id: value.id || id });
        return [normalized.id, normalized];
      }

      const normalizedId = normalizeMCPIdentifier(id);
      const legacyEnabled =
        typeof value === 'boolean'
          ? value
          : Boolean(
              value &&
                typeof value === 'object' &&
                'enabled' in value &&
                (value as { enabled?: unknown }).enabled === true
            );
      const normalized = normalizeMCPServer({
        id: normalizedId,
        name: id,
        status: 'unconfigured',
        description: 'Migrated MCP server placeholder. Add transport settings to use it.',
        config: { enabled: legacyEnabled },
      });
      return [normalized.id, normalized];
    })
  );
};

export const writeStoredMCPServers = (servers: Record<string, MCPServer>): void => {
  const normalized = Object.fromEntries(
    Object.values(servers).map((server) => {
      const normalizedServer = normalizeMCPServer(server);
      return [normalizedServer.id, normalizedServer];
    })
  );
  writeStoredRecord(MCP_SERVER_SETTINGS_STORAGE_KEY, normalized);
};

export const buildMCPServerSettingsPayload = (): MCPServerSettingsDto => {
  const storedServers = readStoredMCPServers();
  const servers: Record<string, MCPServer> = Object.fromEntries(
    BUILT_IN_MCP_SERVERS.map((server) => [
      server.id,
      normalizeMCPServer({
        ...server,
        ...(storedServers[server.id] ?? {}),
        config: {
          ...server.config,
          ...(storedServers[server.id]?.config ?? {}),
        },
      }),
    ])
  );

  return {
    servers: {
      ...servers,
      ...storedServers,
    },
  };
};

export const normalizeMCPServerEnablementInput = (
  settings: MCPServerSettingsDto
): Record<string, boolean> => {
  return Object.fromEntries(
    Object.entries(settings.servers || {}).map(([id, value]) => {
      if (typeof value === 'boolean') {
        return [id, value];
      }

      const enabled =
        value &&
        typeof value === 'object' &&
        'config' in value &&
        value.config &&
        typeof value.config === 'object' &&
        'enabled' in value.config
          ? value.config.enabled === true
          : false;

      return [id, enabled];
    })
  );
};

export const normalizeMCPServerSettingsInput = (
  settings: MCPServerSettingsDto
): Record<string, MCPServer> => {
  return Object.fromEntries(
    Object.entries(settings.servers || {}).map(([id, value]) => {
      if (typeof value === 'boolean') {
        const normalized = normalizeMCPServer({
          id,
          name: id,
          status: 'unconfigured',
          description: 'Migrated MCP server placeholder. Add transport settings to use it.',
          config: { enabled: value },
        });
        return [normalized.id, normalized];
      }

      if (isMCPServerRecord(value)) {
        const normalized = normalizeMCPServer({ ...value, id: value.id || id });
        return [normalized.id, normalized];
      }

      const enabled =
        value &&
        typeof value === 'object' &&
        'enabled' in value &&
        (value as { enabled?: unknown }).enabled === true;
      const normalized = normalizeMCPServer({
        id,
        name: id,
        status: 'unconfigured',
        description: 'Migrated MCP server placeholder. Add transport settings to use it.',
        config: { enabled },
      });
      return [normalized.id, normalized];
    })
  );
};
