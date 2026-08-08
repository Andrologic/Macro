import type { FunctionToolShape } from '../../shared/macroToolRegistry';
import type { MCPTool } from '../../types';

export const toMCPFunctionToolShape = (tool: MCPTool): FunctionToolShape => ({
  type: 'function',
  function: {
    name: tool.id,
    description: [
      `MCP tool ${tool.name} from server ${tool.serverId}.`,
      tool.description || '',
    ]
      .filter(Boolean)
      .join(' '),
    parameters: (tool.inputSchema as FunctionToolShape['function']['parameters']) ?? {
      type: 'object',
      properties: {},
    },
  },
});
