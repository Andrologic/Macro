/**
 * MCP IPC Service
 * 
 * Tauri IPC functions for MCP server management and tool invocation.
 * These functions bridge the frontend store to the Rust backend.
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  McpServer,
  McpToolCall,
  McpToolResult,
} from '../types/mcp';

// ============ Types for IPC ============

/** Input for adding a new server (without auto-generated fields) */
export interface AddServerInput {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  autoConnect: boolean;
}

/** Input for updating a server */
export interface UpdateServerInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  autoConnect?: boolean;
}

// ============ Server Management ============

/**
 * List all configured MCP servers with their current status
 */
export async function listServers(): Promise<McpServer[]> {
  return invoke<McpServer[]>('mcp_list_servers');
}

/**
 * Add a new MCP server configuration
 */
export async function addServer(input: AddServerInput): Promise<McpServer> {
  return invoke<McpServer>('mcp_add_server', { input });
}

/**
 * Update an existing MCP server configuration
 */
export async function updateServer(id: string, input: UpdateServerInput): Promise<void> {
  return invoke('mcp_update_server', { id, input });
}

/**
 * Remove an MCP server configuration
 */
export async function removeServer(id: string): Promise<void> {
  return invoke('mcp_remove_server', { id });
}

/**
 * Connect to an MCP server (starts the process and initializes protocol)
 */
export async function connectServer(id: string): Promise<McpServer> {
  return invoke<McpServer>('mcp_connect_server', { id });
}

/**
 * Disconnect from an MCP server (terminates the process)
 */
export async function disconnectServer(id: string): Promise<void> {
  return invoke('mcp_disconnect_server', { id });
}

// ============ Tool Invocation ============

/**
 * Call a tool on a connected MCP server
 */
export async function callTool(call: McpToolCall): Promise<McpToolResult> {
  return invoke<McpToolResult>('mcp_call_tool', {
    serverId: call.serverId,
    toolName: call.name,
    arguments: call.arguments,
    callId: call.id,
  });
}

// ============ Utility ============

/**
 * Ping an MCP server to check if it's responsive
 */
export async function pingServer(id: string): Promise<boolean> {
  try {
    await invoke('mcp_ping_server', { id });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get server logs for debugging
 */
export async function getServerLogs(id: string, limit?: number): Promise<string[]> {
  return invoke<string[]>('mcp_get_server_logs', { id, limit: limit ?? 100 });
}
