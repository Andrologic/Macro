import { create } from 'zustand';
import { services } from '../services';
import type { Tool, MCPServer, MCPTool } from '../types';
import { toServiceError } from '../services/contracts/errors';
import { normalizeArchitectToolId } from '../services/architectToolNames';
import { getToolModePolicy } from '../services/toolModePolicy';
import { getEffectiveConfigDocument, patchUserConfigTopLevel } from '../services/configDocuments';
import { isConfigurationClientAvailable } from '../services/configurationClient';
import { callScopedMcpTool } from '../services/scopedMcpRuntime';
import {
  isMCPServerEnabled,
  isMCPToolId,
  normalizeMCPServer,
  normalizeMCPServerTools,
  toMCPServerSettingsMap,
} from '../services/mcp';

export const CHAT_MODE_TOOL_SETTINGS_KEY = 'macro_chat_mode_tool_settings';
let chatModeToolIds: Set<string> | null = null;
const getChatModeToolIds = (): Set<string> => {
  chatModeToolIds ??= new Set(getToolModePolicy('Chat').allowedToolIds);
  return chatModeToolIds;
};
const CHAT_SOURCE_TOOL_IDS = ['mark_source_passage', 'read_sources', 'edit_source_passage'] as const;
const CHAT_TERMINAL_TOOL_IDS = [
  'terminal_create_session',
  'terminal_run',
  'terminal_read',
  'terminal_kill',
] as const;
const CHAT_TOGGLE_GROUPS: Record<string, readonly string[]> = {
  sources: CHAT_SOURCE_TOOL_IDS,
  terminal: CHAT_TERMINAL_TOOL_IDS,
};

const MCP_SERVER_DEGRADING_ERROR_CODES = new Set([
  'MCP_RUNTIME_NOT_CONNECTED',
  'MCP_RUNTIME_STALE_GENERATION',
  'MCP_RUNTIME_CONFIG_CHANGED',
  'MCP_RUNTIME_CONNECT_FAILED',
  'MCP_RUNTIME_CALL_TOOL_FAILED',
  'MCP_RUNTIME_CLOSE_TIMEOUT',
]);

const getConfigBoolean = (tool: Tool, key: string): boolean | undefined => {
  const value = tool.config?.[key];
  return typeof value === 'boolean' ? value : undefined;
};

const getConfigString = (tool: Tool, key: string): string | undefined => {
  const value = tool.config?.[key];
  return typeof value === 'string' ? value : undefined;
};

const isToolEnabledState = (tool: Tool): boolean => {
  const enabledFromConfig = getConfigBoolean(tool, 'enabled');
  return enabledFromConfig ?? tool.status === 'enabled';
};

const isChatEligibleTool = (tool: Tool): boolean =>
  getChatModeToolIds().has(tool.id) && getConfigBoolean(tool, 'chatMode') !== false;
const isVisibleChatTool = (tool: Tool): boolean =>
  isChatEligibleTool(tool) &&
  getConfigBoolean(tool, 'visible') !== false &&
  getConfigBoolean(tool, 'chatToolboxVisible') !== false;
const isLockedTool = (tool: Tool): boolean => getConfigBoolean(tool, 'locked') === true;
const getChatToggleGroupIds = (tool: Tool): readonly string[] => {
  const group = getConfigString(tool, 'chatToggleGroup');
  return group ? CHAT_TOGGLE_GROUPS[group] ?? [tool.id] : [tool.id];
};

interface ToolsModeConfigDocument extends Record<string, unknown> {
  modes?: Record<string, Record<string, boolean>>;
}

let chatModeSettingsCache: Record<string, boolean> = {};

const normalizeChatModeSettings = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    (Object.entries(value)
      .filter(([, enabled]) => typeof enabled === 'boolean') as Array<[string, boolean]>).map(
      ([id, enabled]) => [normalizeArchitectToolId(id), enabled],
    ),
  );
};

const loadChatModeToolSettings = async (): Promise<Record<string, boolean>> => {
  if (!isConfigurationClientAvailable()) return chatModeSettingsCache;
  const config = await getEffectiveConfigDocument<ToolsModeConfigDocument>('tools');
  chatModeSettingsCache = normalizeChatModeSettings(config.modes?.Chat);
  return chatModeSettingsCache;
};

const persistChatModeToolSettings = (settings: Record<string, boolean>): void => {
  chatModeSettingsCache = normalizeChatModeSettings(settings);
  if (!isConfigurationClientAvailable()) return;
  void getEffectiveConfigDocument<ToolsModeConfigDocument>('tools')
    .then((config) => patchUserConfigTopLevel('tools', 'modes', {
      ...(config.modes ?? {}),
      Chat: chatModeSettingsCache,
    }))
    .catch((error: unknown) => {
      useToolsStore.setState({ lastError: toServiceError(error).message });
    });
};

let settingsMutationVersion = 0;

interface ToolsStore {
  // Internal Tools
  internalTools: Record<string, Tool>;
  chatToolStates: Record<string, boolean>;

  // MCP Servers
  mcpServers: MCPServer[];

  // Settings state
  isLoading: boolean;
  lastError: string | null;
  saving: boolean;

  // Actions
  loadSettings: () => Promise<void>;
  toggleTool: (toolId: string) => Promise<void>;
  toggleMCPServer: (serverId: string) => Promise<void>;
  upsertMCPServer: (server: MCPServer) => Promise<void>;
  removeMCPServer: (serverId: string) => Promise<void>;
  refreshMCPServerTools: (serverId: string) => Promise<void>;
  authorizeMCPServer: (serverId: string) => Promise<void>;
  logoutMCPServer: (serverId: string) => Promise<void>;
  storeMCPOAuthClientSecret: (serverId: string, value: string) => Promise<string>;
  deleteMCPOAuthClientSecret: (serverId: string) => Promise<void>;
  saveAll: (tools?: Record<string, boolean>, servers?: Record<string, boolean>) => Promise<void>;
  resetToDefaults: () => Promise<void>;
  toggleChatTool: (toolId: string) => void;
  isChatToolEnabled: (toolId: string) => boolean;
  getChatModeTools: () => Tool[];
  getEnabledChatTools: () => Tool[];
  getEnabledChatToolIds: () => string[];
  getEnabledMCPTools: () => MCPTool[];
  getEnabledMCPToolIds: () => string[];
  getMCPToolById: (toolId: string) => { server: MCPServer; tool: MCPTool } | null;
  callMCPTool: (toolId: string, args: Record<string, unknown>) => Promise<string>;
  isToolEnabled: (toolId: string) => boolean;
}

export const useToolsStore = create<ToolsStore>((set, get) => ({
  internalTools: {},
  chatToolStates: {},
  mcpServers: [],
  isLoading: false,
  lastError: null,
  saving: false,

  loadSettings: async () => {
    const hydrationVersion = settingsMutationVersion;
    set({ isLoading: true, lastError: null });
    try {
      const [toolsDto, mcpServersDto] = await Promise.all([
        services.getToolSettings(),
        services.getMCPServerSettings(),
      ]);

      const loadedTools = toolsDto.tools as unknown as Record<string, Tool>;
      const persistedChatStates = await loadChatModeToolSettings();
      const chatToolStates: Record<string, boolean> = {};
      Object.values(loadedTools).forEach((tool) => {
        if (!isChatEligibleTool(tool)) return;
        if (isLockedTool(tool)) {
          chatToolStates[tool.id] = true;
          return;
        }
        const defaultEnabled = isToolEnabledState(tool);
        chatToolStates[tool.id] = persistedChatStates[tool.id] ?? defaultEnabled;
      });
      Object.values(CHAT_TOGGLE_GROUPS).forEach((groupIds) => {
        const representativeId = groupIds[0];
        if (!representativeId || !(representativeId in chatToolStates)) return;
        const groupEnabled =
          persistedChatStates[representativeId] ??
          groupIds.every((toolId) => {
            const tool = loadedTools[toolId];
            return tool ? isToolEnabledState(tool) : false;
          });
        groupIds.forEach((toolId) => {
          if (toolId in chatToolStates) {
            chatToolStates[toolId] = groupEnabled;
          }
        });
      });
      const currentState = get();
      const shouldPreserveLocalState = hydrationVersion !== settingsMutationVersion;
      const nextChatToolStates = shouldPreserveLocalState
        ? currentState.chatToolStates
        : chatToolStates;
      const nextInternalTools = shouldPreserveLocalState
        ? Object.fromEntries(
            Object.entries(loadedTools).map(([toolId, loadedTool]) => {
              const currentTool = currentState.internalTools[toolId];
              if (!currentTool) return [toolId, loadedTool];
              const enabled = isToolEnabledState(currentTool);
              return [
                toolId,
                {
                  ...loadedTool,
                  status: enabled ? 'enabled' : 'disabled',
                  config: { ...loadedTool.config, enabled },
                },
              ];
            })
          ) as Record<string, Tool>
        : loadedTools;
      const loadedMcpServers = Object.values(mcpServersDto.servers)
        .filter((server): server is MCPServer => Boolean(server && typeof server === 'object' && 'id' in server))
        .map(normalizeMCPServer);
      const nextMcpServers =
        shouldPreserveLocalState && currentState.mcpServers.length > 0
          ? currentState.mcpServers
          : loadedMcpServers;

      set({
        internalTools: nextInternalTools,
        chatToolStates: nextChatToolStates,
        mcpServers: nextMcpServers,
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        lastError: toServiceError(error).message,
      });
    }
  },

  toggleTool: async (toolId: string) => {
    settingsMutationVersion += 1;
    set({ saving: true, lastError: null });
    try {
      const currentTools = get().internalTools;
      const tool = currentTools[toolId];

      if (tool) {
        if (tool.config?.locked === true) {
          set({ saving: false });
          return;
        }

        const nextEnabled = !isToolEnabledState(tool);
        const newSettings: Record<string, boolean> = {
          ...Object.fromEntries(
            Object.entries(currentTools).map(([id, t]) => [
              id,
              id === toolId ? nextEnabled : isToolEnabledState(t),
            ])
          ),
        };

        await services.updateToolSettings({ tools: newSettings });
        set({
          internalTools: {
            ...currentTools,
            [toolId]: {
              ...tool,
              status: nextEnabled ? 'enabled' : 'disabled',
              config: {
                ...tool.config,
                enabled: nextEnabled,
              },
            },
          },
        });
      }

      set({ saving: false });
    } catch (error) {
      set({
        saving: false,
        lastError: toServiceError(error).message,
      });
    }
  },

  toggleMCPServer: async (serverId: string) => {
    settingsMutationVersion += 1;
    set({ saving: true, lastError: null });
    try {
      const currentServers = get().mcpServers;
      const server = currentServers.find((s) => s.id === serverId);

      if (server) {
        const nextServers = currentServers.map((s) => {
          if (s.id !== serverId) return s;
          const enabled = !isMCPServerEnabled(s);
          const status = enabled
            ? s.transport
              ? s.status === 'unconfigured'
                ? 'offline'
                : s.status
              : 'unconfigured'
            : 'offline';
          return {
            ...s,
            status,
            config: { ...s.config, enabled },
          } satisfies MCPServer;
        });

        await services.updateMCPServerSettings({ servers: toMCPServerSettingsMap(nextServers) });
        set({ mcpServers: nextServers });
      }

      set({ saving: false });
    } catch (error) {
      const message = toServiceError(error).message;
      set({ saving: false, lastError: message });
      throw new Error(message);
    }
  },

  upsertMCPServer: async (server: MCPServer) => {
    settingsMutationVersion += 1;
    set({ saving: true, lastError: null });
    try {
      const normalized = normalizeMCPServer(server);
      const currentServers = get().mcpServers;
      const exists = currentServers.some((s) => s.id === normalized.id);
      const nextServers = exists
        ? currentServers.map((s) => (s.id === normalized.id ? normalized : s))
        : [...currentServers, normalized];
      await services.updateMCPServerSettings({ servers: toMCPServerSettingsMap(nextServers) });
      set({ mcpServers: nextServers, saving: false });
    } catch (error) {
      const message = toServiceError(error).message;
      set({ saving: false, lastError: message });
      throw new Error(message);
    }
  },

  removeMCPServer: async (serverId: string) => {
    settingsMutationVersion += 1;
    set({ saving: true, lastError: null });
    try {
      const nextServers = get().mcpServers.filter((server) => server.id !== serverId);
      await services.updateMCPServerSettings({ servers: toMCPServerSettingsMap(nextServers) });
      set({ mcpServers: nextServers, saving: false });
    } catch (error) {
      const message = toServiceError(error).message;
      set({ saving: false, lastError: message });
      throw new Error(message);
    }
  },

  refreshMCPServerTools: async (serverId: string) => {
    settingsMutationVersion += 1;
    set({ saving: true, lastError: null });
    const currentServers = get().mcpServers;
    const server = currentServers.find((s) => s.id === serverId);
    if (!server) {
      set({ saving: false });
      return;
    }

    try {
      const snapshot = await services.mcpRuntimeConnect({ serverId, projectIds: [] });
      const response = await services.mcpRuntimeRefreshCatalog(snapshot.key);
      const discoveredAt = new Date().toISOString();
      const tools = normalizeMCPServerTools(server, response.tools).map((tool) => ({
        ...tool,
        discoveredAt,
      }));
      const nextServers = currentServers.map((s) =>
        s.id === serverId
          ? {
              ...s,
              status: 'online' as const,
              tools,
              lastError: null,
              discoveredAt,
            }
          : s
      );
      await services.updateMCPServerSettings({ servers: toMCPServerSettingsMap(nextServers) });
      set({ mcpServers: nextServers, saving: false });
    } catch (error) {
      const message = toServiceError(error).message;
      const nextServers = currentServers.map((s) =>
        s.id === serverId
          ? {
              ...s,
              status: s.transport ? ('degraded' as const) : ('unconfigured' as const),
              lastError: message,
            }
          : s
      );
      await services.updateMCPServerSettings({ servers: toMCPServerSettingsMap(nextServers) }).catch(
        () => undefined
      );
      set({ mcpServers: nextServers, saving: false, lastError: message });
      throw error;
    }
  },

  authorizeMCPServer: async (serverId: string) => {
    set({ saving: true, lastError: null });
    try {
      await services.mcpOAuthAuthorize({ serverId, projectIds: [] });
      set({ saving: false });
      await get().refreshMCPServerTools(serverId);
    } catch (error) {
      const message = toServiceError(error).message;
      set({ saving: false, lastError: message });
      throw new Error(message);
    }
  },

  logoutMCPServer: async (serverId: string) => {
    set({ saving: true, lastError: null });
    try {
      await services.mcpOAuthLogout({ serverId, projectIds: [] });
      set((state) => ({
        mcpServers: state.mcpServers.map((server) =>
          server.id === serverId
            ? { ...server, status: 'offline' as const, lastError: null }
            : server
        ),
        saving: false,
      }));
    } catch (error) {
      const message = toServiceError(error).message;
      set({ saving: false, lastError: message });
      throw new Error(message);
    }
  },

  storeMCPOAuthClientSecret: async (serverId: string, value: string) => {
    try {
      return await services.mcpStoreOAuthClientSecret({ serverId, value });
    } catch (error) {
      const message = toServiceError(error).message;
      set({ lastError: message });
      throw new Error(message);
    }
  },

  deleteMCPOAuthClientSecret: async (serverId: string) => {
    try {
      await services.mcpDeleteOAuthClientSecret(serverId);
    } catch (error) {
      const message = toServiceError(error).message;
      set({ lastError: message });
      throw new Error(message);
    }
  },

  saveAll: async (tools?: Record<string, boolean>, servers?: Record<string, any>) => {
    settingsMutationVersion += 1;
    set({ saving: true, lastError: null });
    try {
      const state = get();
      const toolsToSave = tools || Object.fromEntries(
        Object.entries(state.internalTools).map(([id, t]) => [id, isToolEnabledState(t)])
      );

      const serversToSave = servers
        ? Object.fromEntries(
            state.mcpServers.map((server) => [
              server.id,
              {
                ...server,
                config: {
                  ...server.config,
                  enabled: servers[server.id] === true,
                },
              },
            ])
          )
        : toMCPServerSettingsMap(state.mcpServers);

      await Promise.all([
        services.updateToolSettings({ tools: toolsToSave }),
        services.updateMCPServerSettings({ servers: serversToSave }),
      ]);
      set({ saving: false });
    } catch (error) {
      set({
        saving: false,
        lastError: toServiceError(error).message,
      });
    }
  },

  resetToDefaults: async () => {
    settingsMutationVersion += 1;
    set({ isLoading: true, lastError: null });
    try {
      await Promise.all([
        services.updateToolSettings({ tools: {} }),
        services.updateMCPServerSettings({ servers: {} }),
      ]);
      set({
        internalTools: {},
        chatToolStates: {},
        mcpServers: [],
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        lastError: toServiceError(error).message,
      });
    }
  },

  toggleChatTool: (toolId: string) => {
    const state = get();
    const tool = state.internalTools[toolId];
    if (!tool || !isVisibleChatTool(tool) || isLockedTool(tool)) return;

    settingsMutationVersion += 1;

    const nextEnabled = !(state.chatToolStates[toolId] ?? isToolEnabledState(tool));
    const nextStates = { ...state.chatToolStates };
    getChatToggleGroupIds(tool).forEach((groupToolId) => {
      const groupTool = state.internalTools[groupToolId];
      if (groupTool && isChatEligibleTool(groupTool) && !isLockedTool(groupTool)) {
        nextStates[groupToolId] = nextEnabled;
      }
    });
    persistChatModeToolSettings(nextStates);
    set({ chatToolStates: nextStates });
  },

  isChatToolEnabled: (toolId: string) => {
    const state = get();
    const tool = state.internalTools[toolId];
    if (!tool || !isChatEligibleTool(tool)) return false;
    const globallyEnabled = isToolEnabledState(tool);
    if (!globallyEnabled) return false;
    if (isLockedTool(tool)) return true;
    return state.chatToolStates[toolId] ?? globallyEnabled;
  },

  getChatModeTools: () => {
    const tools = Object.values(get().internalTools);
    return tools.filter((tool) => isVisibleChatTool(tool));
  },

  getEnabledChatTools: () => {
    const state = get();
    return state.getChatModeTools().filter((tool) => state.isChatToolEnabled(tool.id));
  },

  getEnabledChatToolIds: () => {
    const state = get();
    return Object.values(state.internalTools)
      .filter((tool) => isChatEligibleTool(tool) && state.isChatToolEnabled(tool.id))
      .map((tool) => tool.id);
  },

  getEnabledMCPTools: () => {
    return get().mcpServers.flatMap((server) => {
      if (!isMCPServerEnabled(server) || server.status !== 'online') {
        return [];
      }
      return normalizeMCPServerTools(server).filter((tool) => tool.enabled !== false);
    });
  },

  getEnabledMCPToolIds: () => {
    return get().getEnabledMCPTools().map((tool) => tool.id);
  },

  getMCPToolById: (toolId: string) => {
    if (!isMCPToolId(toolId)) return null;
    for (const server of get().mcpServers) {
      const tool = normalizeMCPServerTools(server).find((candidate) => candidate.id === toolId);
      if (tool) {
        return { server, tool };
      }
    }
    return null;
  },

  callMCPTool: async (toolId: string, args: Record<string, unknown>) => {
    const resolved = get().getMCPToolById(toolId);
    if (!resolved) {
      return `MCP tool ${toolId} is not configured.`;
    }
    if (!isMCPServerEnabled(resolved.server)) {
      return `MCP server ${resolved.server.name} is disabled.`;
    }
    if (resolved.server.status !== 'online') {
      return `MCP server ${resolved.server.name} is ${resolved.server.status}. Refresh tools before calling ${resolved.tool.name}.`;
    }

    try {
      return await callScopedMcpTool(toolId, args, [resolved.server]);
    } catch (error) {
      const normalizedError = toServiceError(error);
      const message = normalizedError.message;
      if (!MCP_SERVER_DEGRADING_ERROR_CODES.has(normalizedError.code)) {
        set({ lastError: message });
        throw new Error(
          `Error executing MCP tool ${resolved.tool.name} on ${resolved.server.name}: ${message}`
        );
      }
      const nextServers = get().mcpServers.map((server) =>
        server.id === resolved.server.id
          ? { ...server, status: 'degraded' as const, lastError: message }
          : server
      );
      await services.updateMCPServerSettings({ servers: toMCPServerSettingsMap(nextServers) }).catch(
        () => undefined
      );
      set({ mcpServers: nextServers, lastError: message });
      throw new Error(`Error executing MCP tool ${resolved.tool.name} on ${resolved.server.name}: ${message}`);
    }
  },

  isToolEnabled: (toolId: string) => {
    const tool = get().internalTools[toolId];
    if (!tool) return false;
    return isToolEnabledState(tool);
  },
}));
