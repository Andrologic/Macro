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
  if (params.providerType === 'copilot') {
    return [];
  }
  if (params.mode === 'Implement' && params.agentType === 'plan') {
    return [];
  }
  return params.enabledToolIds;
};
