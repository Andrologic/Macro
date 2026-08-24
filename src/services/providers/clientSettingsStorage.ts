import { BUILT_IN_TOOLS, BUILT_IN_MCP_SERVERS } from '../tools/builtInTools';
import type {
  MCPProtocolSettings,
  MCPProtocolMode,
  MCPServer,
  MCPTransportConfig,
  Tool,
} from '../../types';
import { normalizeArchitectToolId } from '../architectToolNames';
import {
  isMCPServerRecord,
  normalizeMCPIdentifier,
  normalizeMCPServer,
} from '../mcp';
import type { MCPServerSettingsDto, ToolSettingsDto } from '../contracts/dtos';

export const TOOL_SETTINGS_STORAGE_KEY = 'macro_tool_settings';
export const MCP_SERVER_SETTINGS_STORAGE_KEY = 'macro_mcp_server_settings';

export interface BoundedRange {
  readonly min: number;
  readonly max: number;
}

export const MCP_PROBE_TIMEOUT_MS_RANGE: BoundedRange = { min: 500, max: 15_000 };
export const MCP_STARTUP_TIMEOUT_MS_RANGE: BoundedRange = { min: 1_000, max: 300_000 };
export const MCP_OPERATION_TIMEOUT_MS_RANGE: BoundedRange = { min: 1_000, max: 600_000 };
export const MCP_MAX_CONCURRENT_OPERATIONS_RANGE: BoundedRange = { min: 1, max: 16 };

const MCP_PROTOCOL_MODES: readonly MCPProtocolMode[] = ['auto', 'legacy', 'modern'];

export interface PersistedMCPServer {
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
  website?: string;
  enabled?: boolean;
  transport?: MCPTransportConfig;
  protocol?: MCPProtocolSettings;
  startupTimeoutMs?: number;
  operationTimeoutMs?: number;
  maxConcurrentOperations?: number;
  disabledTools?: string[];
}

type MCPServerPolicyFields = Pick<
  MCPServer,
  | 'protocol'
  | 'startupTimeoutMs'
  | 'operationTimeoutMs'
  | 'maxConcurrentOperations'
  | 'disabledTools'
>;

export const clampBoundedNumber = (value: unknown, range: BoundedRange): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
};

export const normalizeMCPProtocolMode = (value: unknown): MCPProtocolMode | undefined =>
  MCP_PROTOCOL_MODES.find((mode) => mode === value);

export const normalizeMCPProtocolSettings = (
  value: unknown
): MCPProtocolSettings | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const mode = normalizeMCPProtocolMode(source.mode);
  const probeTimeoutMs = clampBoundedNumber(source.probeTimeoutMs, MCP_PROBE_TIMEOUT_MS_RANGE);
  if (!mode && probeTimeoutMs === undefined) {
    return undefined;
  }
  const settings: MCPProtocolSettings = {};
  if (mode) {
    settings.mode = mode;
  }
  if (probeTimeoutMs !== undefined) {
    settings.probeTimeoutMs = probeTimeoutMs;
  }
  return settings;
};

export const normalizeMCPDisabledTools = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  );
};

export const normalizeMCPServerPolicy = (
  server: Partial<MCPServerPolicyFields> | undefined
): Partial<MCPServerPolicyFields> => {
  const policy: Partial<MCPServerPolicyFields> = {};
  if (!server) {
    return policy;
  }
  const protocol = normalizeMCPProtocolSettings(server.protocol);
  if (protocol) {
    policy.protocol = protocol;
  }
  const startupTimeoutMs = clampBoundedNumber(
    server.startupTimeoutMs,
    MCP_STARTUP_TIMEOUT_MS_RANGE
  );
  if (startupTimeoutMs !== undefined) {
    policy.startupTimeoutMs = startupTimeoutMs;
  }
  const operationTimeoutMs = clampBoundedNumber(
    server.operationTimeoutMs,
    MCP_OPERATION_TIMEOUT_MS_RANGE
  );
  if (operationTimeoutMs !== undefined) {
    policy.operationTimeoutMs = operationTimeoutMs;
  }
  const maxConcurrentOperations = clampBoundedNumber(
    server.maxConcurrentOperations,
    MCP_MAX_CONCURRENT_OPERATIONS_RANGE
  );
  if (maxConcurrentOperations !== undefined) {
    policy.maxConcurrentOperations = maxConcurrentOperations;
  }
  const disabledTools = normalizeMCPDisabledTools(server.disabledTools);
  if (disabledTools) {
    policy.disabledTools = disabledTools;
  }
  return policy;
};

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

export const toRuntimeMCPServers = (
  servers: Record<string, PersistedMCPServer> = {}
): Record<string, MCPServer> =>
  Object.fromEntries(
    Object.entries(servers).map(([id, server]) => {
      const normalized = normalizeMCPServer({
        id,
        name: server.name ?? id,
        description: server.description,
        category: server.category as MCPServer['category'] | undefined,
        icon: server.icon as MCPServer['icon'] | undefined,
        website: server.website,
        transport: server.transport,
        ...normalizeMCPServerPolicy(server),
        config: { enabled: server.enabled === true },
      });
      return [normalized.id, normalized];
    })
  );

export const toPersistedMCPServers = (
  servers: Record<string, MCPServer>
): Record<string, PersistedMCPServer> =>
  Object.fromEntries(
    Object.values(servers).map((server) => [
      server.id,
      {
        name: server.name,
        description: server.description,
        category: server.category,
        icon: server.icon,
        website: server.website,
        enabled: server.config?.enabled === true,
        transport: server.transport,
        ...normalizeMCPServerPolicy(server),
      },
    ])
  );
