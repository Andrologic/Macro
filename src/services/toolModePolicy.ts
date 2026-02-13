import type { AppMode } from '../types';

export interface ToolModePolicy {
  allowedToolIds: string[];
  enforceMacroOnlyWrites: boolean;
}

const BASE_SOURCE_TOOLS = [
  'mark_source_passage',
  'read_sources',
  'edit_source_passage',
  'read_file',
  'web_search',
  'web_fetch',
] as const;

const WORKSPACE_READ_TOOLS = ['list', 'read', 'glob', 'grep'] as const;
const WORKSPACE_WRITE_TOOLS = ['write', 'edit'] as const;

export const getToolModePolicy = (mode: AppMode): ToolModePolicy => {
  if (mode === 'Architect') {
    return {
      allowedToolIds: [
        ...BASE_SOURCE_TOOLS,
        ...WORKSPACE_READ_TOOLS,
        ...WORKSPACE_WRITE_TOOLS,
      ],
      enforceMacroOnlyWrites: true,
    };
  }

  if (mode === 'Chat') {
    return {
      allowedToolIds: [
        ...BASE_SOURCE_TOOLS,
        ...WORKSPACE_READ_TOOLS,
        ...WORKSPACE_WRITE_TOOLS,
      ],
      enforceMacroOnlyWrites: false,
    };
  }

  return {
    allowedToolIds: [
      ...BASE_SOURCE_TOOLS,
      ...WORKSPACE_READ_TOOLS,
      ...WORKSPACE_WRITE_TOOLS,
    ],
    enforceMacroOnlyWrites: false,
  };
};

export const isMacroScopedPath = (rawPath: string): boolean => {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return normalized === '.macro' || normalized.startsWith('.macro/');
};
