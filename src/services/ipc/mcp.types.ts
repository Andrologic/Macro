/** mcp IPC DTOs. Kept separate for generated Rust binding integration. */

import type { MCPTool } from "../../types";

export interface MCPDiscoverToolsResponseDto {
  tools: MCPTool[];
}

export interface MCPCallToolResponseDto {
  content: string;
  isError?: boolean;
  rawResult?: unknown;
}
