import { BUILT_IN_TOOLS, BUILT_IN_MCP_SERVERS } from '../tools/builtInTools';
import type { MCPServer, Tool } from '../../types';
import { normalizeArchitectToolId } from '../architectToolNames';
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

const getBrowserStorage = (): Storage | null => {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    // Ignore storage access errors and fall back to defaults.
  }

  return null;
};

const readStoredRecord = (key: string): Record<string, unknown> => {
  const storage = getBrowserStorage();
  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(key);
    if (!raw || raw === 'undefined') {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    console.error(`Failed to parse persisted settings from ${key}`, error);
    return {};
  }
};

const writeStoredRecord = (key: string, value: Record<string, unknown>): void => {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }

  storage.setItem(key, JSON.stringify(value));
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

export const buildMCPServerSettingsPayload = (): MCPServerSettingsDto => {
  const enabledServers = readStoredMCPServerEnablement();
  const servers: Record<string, MCPServer> = Object.fromEntries(
    BUILT_IN_MCP_SERVERS.map((server) => [
      server.id,
      {
        ...server,
        status: (enabledServers[server.id] ? 'online' : 'offline') as MCPServer['status'],
        config: {
          ...server.config,
          enabled: enabledServers[server.id] ?? false,
        },
      },
    ])
  );

  return {
    servers,
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
