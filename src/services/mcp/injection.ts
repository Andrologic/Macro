import { filterCopilotSupportedToolIds } from '../../shared/macroToolRegistry';
import { isMCPToolId } from './identifiers';
import type { AgentType, AppMode } from '../../types';

export const selectInjectableMCPToolIds = (params: {
  enabledToolIds: string[];
  supportsNativeToolCalling: boolean;
  providerType?: string | null;
  mode: AppMode;
  agentType?: AgentType | null;
}): string[] => {
  if (!params.supportsNativeToolCalling) {
    return [];
  }
  if (params.mode === 'Implement' && params.agentType === 'plan') {
    return [];
  }
  return params.enabledToolIds;
};

/** Configured MCP tools use the same guarded frontend relay on native Copilot. */
export const selectCopilotToolIds = (toolIds: string[]): string[] => {
  const supported = new Set(filterCopilotSupportedToolIds(toolIds));
  return toolIds.filter(id => supported.has(id) || isMCPToolId(id));
};
