/** mcp IPC wrappers and frontend adapters. */

import type { MCPServer } from "../../types";
import type {
  MCPCatalogDto,
  MCPRuntimeKey,
  MCPRuntimeSelector,
  MCPRuntimeServerSnapshot,
  MCPRuntimeSnapshotDto,
} from "../contracts/serviceProvider";
import { invoke } from "../tauriRuntimeBridge";
import type {
  MCPCallToolResponseDto,
  MCPDiscoverToolsResponseDto,
} from "./mcp.types";

export async function mcpDiscoverTools(params: {
  server: MCPServer;
}): Promise<MCPDiscoverToolsResponseDto> {
  return invoke<MCPDiscoverToolsResponseDto>("mcp_discover_tools", {
    server: params.server,
  });
}

export async function mcpCallTool(params: {
  server: MCPServer;
  toolName: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number | null;
}): Promise<MCPCallToolResponseDto> {
  return invoke<MCPCallToolResponseDto>("mcp_call_tool", {
    server: params.server,
    toolName: params.toolName,
    arguments: params.arguments,
    timeoutMs: params.timeoutMs ?? null,
  });
}

export async function mcpStoreEnvSecret(params: {
  serverId: string;
  key: string;
  value: string;
}): Promise<string> {
  return invoke<string>("mcp_store_env_secret", {
    serverId: params.serverId,
    key: params.key,
    value: params.value,
  });
}

export async function mcpDeleteEnvSecret(params: {
  serverId: string;
  key: string;
}): Promise<void> {
  return invoke("mcp_delete_env_secret", {
    serverId: params.serverId,
    key: params.key,
  });
}

export async function mcpStoreOAuthClientSecret(params: {
  serverId: string;
  value: string;
}): Promise<string> {
  return invoke<string>('mcp_store_oauth_client_secret', params);
}

export async function mcpDeleteOAuthClientSecret(serverId: string): Promise<void> {
  return invoke('mcp_delete_oauth_client_secret', { serverId });
}

export async function mcpOAuthAuthorize(selector: MCPRuntimeSelector): Promise<void> {
  return invoke('mcp_oauth_authorize', { selector });
}

export async function mcpOAuthLogout(selector: MCPRuntimeSelector): Promise<void> {
  return invoke('mcp_oauth_logout', { selector });
}

// Tauri commands for the persistent MCP runtime. The event channel remains
// reserved for status/catalog push notifications added with the UI migration.

export const MCP_RUNTIME_EVENT_NAME = "mcp:runtime";

export async function mcpRuntimeGetSnapshot(): Promise<MCPRuntimeSnapshotDto> {
  return invoke<MCPRuntimeSnapshotDto>("mcp_runtime_get_snapshot");
}

export async function mcpRuntimeConnect(
  selector: MCPRuntimeSelector,
): Promise<MCPRuntimeServerSnapshot> {
  return invoke<MCPRuntimeServerSnapshot>("mcp_runtime_connect", { selector });
}

export async function mcpRuntimeDisconnect(key: MCPRuntimeKey): Promise<void> {
  return invoke("mcp_runtime_disconnect", { key });
}

export async function mcpRuntimeRefreshCatalog(
  key: MCPRuntimeKey,
): Promise<MCPCatalogDto> {
  return invoke<MCPCatalogDto>("mcp_runtime_refresh_catalog", { key });
}

export async function mcpRuntimeCallTool(params: {
  key: MCPRuntimeKey;
  toolName: string;
  arguments: Record<string, unknown>;
  operationId: string;
}): Promise<MCPCallToolResponseDto> {
  return invoke<MCPCallToolResponseDto>("mcp_runtime_call_tool", {
    key: params.key,
    toolName: params.toolName,
    arguments: params.arguments,
    operationId: params.operationId,
  });
}

export async function mcpRuntimeCancelOperation(
  operationId: string,
): Promise<boolean> {
  return invoke<boolean>("mcp_runtime_cancel_operation", { operationId });
}
