/**
 * MCP Store
 * 
 * Manages MCP (Model Context Protocol) servers for the chat functionality.
 * Handles server configuration, connection lifecycle, and tool invocation.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  McpServer,
  McpServerConfig,
  McpServerStatus,
  McpTool,
  McpToolCall,
  McpToolResult,
  ChatToolDefinition,
} from '../types/mcp';
import { toServiceError } from '../services/contracts/errors';
import * as mcpIpc from '../services/mcpIpc';

// ============ Store Interface ============

interface McpStore {
  // State
  servers: Record<string, McpServer>;
  isLoading: boolean;
  lastError: string | null;

  // Server lifecycle
  loadServers: () => Promise<void>;
  addServer: (config: Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>) => Promise<McpServer>;
  updateServer: (id: string, config: Partial<McpServerConfig>) => Promise<void>;
  removeServer: (id: string) => Promise<void>;
  connectServer: (id: string) => Promise<void>;
  disconnectServer: (id: string) => Promise<void>;

  // Tools
  getEnabledTools: () => McpTool[];
  getToolDefinitions: () => ChatToolDefinition[];
  callTool: (call: McpToolCall) => Promise<McpToolResult>;

  // Helpers
  getServerById: (id: string) => McpServer | undefined;
  getConnectedServers: () => McpServer[];
}

// ============ Store Implementation ============

export const useMcpStore = create<McpStore>()(
  subscribeWithSelector((set, get) => ({
    servers: {},
    isLoading: false,
    lastError: null,

    loadServers: async () => {
      set({ isLoading: true, lastError: null });
      try {
        const servers = await mcpIpc.listServers();
        const serversMap: Record<string, McpServer> = {};
        for (const server of servers) {
          serversMap[server.config.id] = server;
        }
        set({ servers: serversMap, isLoading: false });
      } catch (error) {
        set({
          isLoading: false,
          lastError: toServiceError(error).message,
        });
      }
    },

    addServer: async (config) => {
      set({ isLoading: true, lastError: null });
      try {
        const server = await mcpIpc.addServer(config);
        set((state) => ({
          servers: { ...state.servers, [server.config.id]: server },
          isLoading: false,
        }));
        return server;
      } catch (error) {
        const err = toServiceError(error);
        set({ isLoading: false, lastError: err.message });
        throw err;
      }
    },

    updateServer: async (id, configUpdate) => {
      set({ lastError: null });
      try {
        await mcpIpc.updateServer(id, configUpdate);
        set((state) => {
          const server = state.servers[id];
          if (!server) return state;
          return {
            servers: {
              ...state.servers,
              [id]: {
                ...server,
                config: { ...server.config, ...configUpdate },
              },
            },
          };
        });
      } catch (error) {
        set({ lastError: toServiceError(error).message });
      }
    },

    removeServer: async (id) => {
      set({ lastError: null });
      try {
        await mcpIpc.removeServer(id);
        set((state) => {
          const { [id]: _, ...rest } = state.servers;
          return { servers: rest };
        });
      } catch (error) {
        set({ lastError: toServiceError(error).message });
      }
    },

    connectServer: async (id) => {
      // Update status to connecting
      set((state) => {
        const server = state.servers[id];
        if (!server) return state;
        return {
          servers: {
            ...state.servers,
            [id]: { ...server, status: 'connecting' as McpServerStatus },
          },
        };
      });

      try {
        const updatedServer = await mcpIpc.connectServer(id);
        set((state) => ({
          servers: { ...state.servers, [id]: updatedServer },
        }));
      } catch (error) {
        set((state) => {
          const server = state.servers[id];
          if (!server) return state;
          return {
            servers: {
              ...state.servers,
              [id]: {
                ...server,
                status: 'error' as McpServerStatus,
                error: toServiceError(error).message,
              },
            },
            lastError: toServiceError(error).message,
          };
        });
      }
    },

    disconnectServer: async (id) => {
      try {
        await mcpIpc.disconnectServer(id);
        set((state) => {
          const server = state.servers[id];
          if (!server) return state;
          return {
            servers: {
              ...state.servers,
              [id]: {
                ...server,
                status: 'disconnected' as McpServerStatus,
                tools: [],
                resources: [],
              },
            },
          };
        });
      } catch (error) {
        set({ lastError: toServiceError(error).message });
      }
    },

    getEnabledTools: () => {
      const { servers } = get();
      const tools: McpTool[] = [];
      for (const server of Object.values(servers)) {
        if (server.status === 'connected') {
          tools.push(...server.tools);
        }
      }
      return tools;
    },

    getToolDefinitions: () => {
      const tools = get().getEnabledTools();
      return tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: `${tool.serverId}__${tool.name}`,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    },

    callTool: async (call) => {
      try {
        return await mcpIpc.callTool(call);
      } catch (error) {
        return {
          toolCallId: call.id,
          success: false,
          error: toServiceError(error).message,
        };
      }
    },

    getServerById: (id) => get().servers[id],

    getConnectedServers: () => 
      Object.values(get().servers).filter((s) => s.status === 'connected'),
  }))
);

// ============ Auto-connect on load ============

// Subscribe to load completion and auto-connect servers
useMcpStore.subscribe(
  (state) => state.isLoading,
  (isLoading, previousIsLoading) => {
    if (previousIsLoading && !isLoading) {
      // Loading just finished, auto-connect servers that have autoConnect enabled
      const { servers, connectServer } = useMcpStore.getState();
      for (const server of Object.values(servers)) {
        if (server.config.autoConnect && server.status === 'disconnected') {
          connectServer(server.config.id).catch(console.error);
        }
      }
    }
  }
);
