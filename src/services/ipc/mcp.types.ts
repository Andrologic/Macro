import type {
McpCallToolResponse as NativeMCPCallToolResponseDto
} from '../../types/generated/ipc';
import type { OmitFields, OptionalFields } from './compatibility.types';

/** mcp IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type MCPCallToolResponseDto = OptionalFields<OmitFields<NativeMCPCallToolResponseDto, "rawResult">, "isError" | "blocks"> & {
  rawResult?: unknown;
};
