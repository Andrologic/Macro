import type {
McpCallToolResponse as NativeMCPCallToolResponseDto,
McpDiscoverToolsResponse as NativeMCPDiscoverToolsResponseDto
} from '../../types/generated/ipc';
import type { OmitFields, OptionalFields } from './compatibility.types';

/** mcp IPC contracts and explicit frontend adaptations of generated native bindings. */

import type { MCPTool } from "../../types";

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type MCPDiscoverToolsResponseDto = OmitFields<NativeMCPDiscoverToolsResponseDto, "tools"> & {
  tools: MCPTool[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type MCPCallToolResponseDto = OptionalFields<OmitFields<NativeMCPCallToolResponseDto, "rawResult">, "isError"> & {
  rawResult?: unknown;
};
