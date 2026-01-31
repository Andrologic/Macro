import { create } from 'zustand';
import { services } from '../services';
import type { Tool, MCPServer, ToolSettings, MCPServerSettings } from '../types';
import { toServiceError } from '../services/contracts/errors';

interface ToolsStore {
  // Internal Tools
  internalTools: Record<string, Tool>;
  
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
}

export const useToolsStore = create<ToolsStore>((set, get) => ({
  internalTools: {},
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

      set({
        internalTools: toolsDto.tools,
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
        const newSettings: Record<string, boolean> = {
          ...Object.fromEntries(
            Object.entries(currentTools).map(([id, t]) => [id, id === toolId ? !t.config?.enabled : !!t.config?.enabled])
          ),
        };

        await services.updateToolSettings({ tools: newSettings });
        set({ internalTools: { ...currentTools, [toolId]: { ...tool, config: { ...tool.config, enabled: !tool.config?.enabled } } } });
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
        Object.entries(state.internalTools).map(([id, t]) => [id, (t.config as any)?.enabled !== false])
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
}));