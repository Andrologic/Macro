import { create } from 'zustand';
import { services } from '../services';
import type { Tool, MCPServer } from '../types';
import { toServiceError } from '../services/contracts/errors';
import { normalizeArchitectToolId } from '../services/architectToolNames';

const CHAT_MODE_TOOL_SETTINGS_KEY = 'macro_chat_mode_tool_settings';

const getConfigBoolean = (tool: Tool, key: string): boolean | undefined => {
  const value = tool.config?.[key];
  return typeof value === 'boolean' ? value : undefined;
};

const isToolEnabledState = (tool: Tool): boolean => {
  const enabledFromConfig = getConfigBoolean(tool, 'enabled');
  return enabledFromConfig ?? tool.status === 'enabled';
};

const isChatEligibleTool = (tool: Tool): boolean => getConfigBoolean(tool, 'chatMode') !== false;
const isVisibleChatTool = (tool: Tool): boolean => isChatEligibleTool(tool) && getConfigBoolean(tool, 'visible') !== false;
const isLockedTool = (tool: Tool): boolean => getConfigBoolean(tool, 'locked') === true;

const loadChatModeToolSettings = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(CHAT_MODE_TOOL_SETTINGS_KEY);
    if (!raw || raw === 'undefined') return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      (Object.entries(parsed)
        .filter(([, value]) => typeof value === 'boolean') as Array<[string, boolean]>).map(([id, enabled]) => [
        normalizeArchitectToolId(id),
        enabled,
      ])
    );
  } catch {
    return {};
  }
};

const persistChatModeToolSettings = (settings: Record<string, boolean>): void => {
  localStorage.setItem(CHAT_MODE_TOOL_SETTINGS_KEY, JSON.stringify(settings));
};

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
  saveAll: (tools?: Record<string, boolean>, servers?: Record<string, boolean>) => Promise<void>;
  resetToDefaults: () => Promise<void>;
  toggleChatTool: (toolId: string) => void;
  isChatToolEnabled: (toolId: string) => boolean;
  getChatModeTools: () => Tool[];
  getEnabledChatTools: () => Tool[];
  getEnabledChatToolIds: () => string[];
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
    set({ isLoading: true, lastError: null });
    try {
      const [toolsDto, mcpServersDto] = await Promise.all([
        services.getToolSettings(),
        services.getMCPServerSettings(),
      ]);

      const loadedTools = toolsDto.tools as Record<string, Tool>;
      const persistedChatStates = loadChatModeToolSettings();
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
      persistChatModeToolSettings(chatToolStates);

      set({
        internalTools: loadedTools,
        chatToolStates,
        mcpServers: Object.values(mcpServersDto.servers),
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
    set({ saving: true, lastError: null });
    try {
      const currentServers = get().mcpServers;
      const server = currentServers.find((s) => s.id === serverId);
      
      if (server) {
        const newServers: Record<string, any> = {};
        currentServers.forEach((s) => {
          const enabled = (s.config as any)?.enabled ?? false;
          newServers[s.id] = { ...s.config, enabled: s.id === serverId ? !enabled : enabled };
        });

        await services.updateMCPServerSettings({ servers: newServers });
        set({
          mcpServers: currentServers.map((s) =>
            s.id === serverId
              ? { ...s, config: { ...s.config, enabled: !(s.config as any)?.enabled } }
              : s
          ),
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

  saveAll: async (tools?: Record<string, boolean>, servers?: Record<string, any>) => {
    set({ saving: true, lastError: null });
    try {
      const state = get();
      const toolsToSave = tools || Object.fromEntries(
        Object.entries(state.internalTools).map(([id, t]) => [id, isToolEnabledState(t)])
      );
      
      const serversToSave = servers || Object.fromEntries(
        state.mcpServers.map(s => [s.id, (s.config as any)?.enabled !== false])
      );

      await Promise.all([
        services.updateToolSettings({ tools: toolsToSave }),
        services.updateMCPServerSettings({ servers: serversToSave as any }),
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

    const nextEnabled = !(state.chatToolStates[toolId] ?? isToolEnabledState(tool));
    const nextStates = {
      ...state.chatToolStates,
      [toolId]: nextEnabled,
    };
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

  isToolEnabled: (toolId: string) => {
    const tool = get().internalTools[toolId];
    if (!tool) return false;
    return isToolEnabledState(tool);
  },
}));
