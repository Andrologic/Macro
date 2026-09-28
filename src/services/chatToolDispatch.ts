import type { FrozenToolCallContext } from "./chatStreamContracts";
import type { ToolCallResolution } from "./ai/contracts";
import { normalizeArchitectToolId } from "./architectToolNames";
import { normalizeLegacyToolExecutionResult } from "./toolResultNormalization";
import type { MCPTool } from '../types';
import { allowedMcpTools, MCP_CALL_TOOL_ID, MCP_SEARCH_TOOL_ID, searchMcpTools, shouldDiscoverMcpTools } from './mcp/toolDiscovery';
import { isMCPToolId } from './mcpToolNames';

export interface ChatToolDispatchPorts {
  execute(operation: FrozenToolCallContext, name: string, args: Record<string, unknown>, callId?: string, isCurrent?: () => boolean): Promise<ToolCallResolution | string | void>;
  preserve(operation: FrozenToolCallContext, name: string, callId: string | undefined, resolution: ToolCallResolution | string | void): Promise<ToolCallResolution | string | void>;
  boundError(operation: FrozenToolCallContext, name: string, callId: string | undefined, error: unknown): Promise<unknown>;
}

const ABORTED: ToolCallResolution = {
  kind: "result", result: "Tool execution aborted", isError: true,
  errorKind: "aborted", toString: () => "Tool execution aborted",
};

export function createChatToolDispatch(
  operation: FrozenToolCallContext,
  ports: ChatToolDispatchPorts,
  accepts: () => boolean,
  progress: () => void,
  mcpTools: readonly MCPTool[] = [],
) {
  const isCurrent = () => !operation.signal.aborted && accepts();
  const discoveryEnabled = shouldDiscoverMcpTools(new Set(operation.allowedToolIds), mcpTools);
  const searchableTools = discoveryEnabled ? allowedMcpTools(new Set(operation.allowedToolIds), mcpTools) : [];
  const discoveredIds = new Set<string>();
  return async (toolName: string, args: Record<string, unknown>, toolCallId?: string) => {
    if (!isCurrent()) return ABORTED;
    progress();
    let normalizedName = normalizeArchitectToolId(toolName);
    let resolution: ToolCallResolution | string | void;
    try {
      if (discoveryEnabled && toolName === MCP_SEARCH_TOOL_ID) {
        const result = searchMcpTools(args.query, searchableTools);
        if (!isCurrent()) return ABORTED;
        result.ids.forEach(id => discoveredIds.add(id));
        resolution = result.text;
      } else if (discoveryEnabled && toolName === MCP_CALL_TOOL_ID) {
        const target = args.tool_id;
        const targetArgs = args.arguments;
        if (typeof target !== 'string' || !discoveredIds.has(target) ||
          !targetArgs || typeof targetArgs !== 'object' || Array.isArray(targetArgs)) {
          resolution = { kind: 'result', result: 'Select a tool returned by mcp_search and provide an arguments object.', isError: true, errorKind: 'validation' };
        } else {
          normalizedName = target;
          resolution = await ports.execute(operation, target, targetArgs as Record<string, unknown>, toolCallId, isCurrent);
        }
      } else if (discoveryEnabled && isMCPToolId(toolName)) {
        resolution = { kind: 'result', result: 'Search for this MCP tool with mcp_search before calling it.', isError: true, errorKind: 'permission' };
      } else {
        resolution = await ports.execute(operation, toolName, args, toolCallId, isCurrent);
      }
    } catch (error) {
      if (!isCurrent()) return ABORTED;
      const bounded = await ports.boundError(operation, normalizedName, toolCallId, error);
      if (!isCurrent()) return ABORTED;
      throw bounded;
    }
    if (!isCurrent()) {
      // Preserve explicit denial without starting a new artifact write after Stop.
      return typeof resolution === "object" && resolution?.kind === "result" && resolution.errorKind === "permission"
        ? resolution : ABORTED;
    }
    const preserved = await ports.preserve(operation, normalizedName, toolCallId, resolution);
    if (!isCurrent()) return ABORTED;
    return normalizeLegacyToolExecutionResult(normalizedName, preserved);
  };
}
