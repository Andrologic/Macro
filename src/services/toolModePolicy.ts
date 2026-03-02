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
const CHAT_SAFE_TOOLS = ['read_sources', 'read_file', 'web_search', 'web_fetch'] as const;
const GIT_READ_TOOLS = [
  'git_status',
  'git_log',
  'git_branch_list',
  'git_diff',
  'git_get_tree',
] as const;

const GIT_WRITE_TOOLS = [
  'git_add',
  'git_commit',
  'git_checkout',
  'git_reset',
  'git_stash',
] as const;

const GIT_TOOLS = [...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS] as const;

const ALL_WORKSPACE_TOOLS = [
  ...BASE_SOURCE_TOOLS,
  ...WORKSPACE_READ_TOOLS,
  ...WORKSPACE_WRITE_TOOLS,
] as const;

const ARCHITECT_PLAN_TOOLS = [
  'plan_create',
  'plan_list',
  'plan_get',
  'plan_update',
  'plan_delete',
  'plan_restore',
  'plan_set_active',
  'strategy_get',
  'strategy_update',
  'strategy_delete',
] as const;

export const getToolModePolicy = (mode: AppMode): ToolModePolicy => {
  if (mode === 'Architect') {
    return {
      allowedToolIds: [...ALL_WORKSPACE_TOOLS, ...GIT_READ_TOOLS, ...ARCHITECT_PLAN_TOOLS, 'need_add', 'strategy_generate'],
      enforceMacroOnlyWrites: true,
    };
  }

  if (mode === 'Chat') {
    return {
      allowedToolIds: [...CHAT_SAFE_TOOLS],
      enforceMacroOnlyWrites: false,
    };
  }

  if (mode === 'Debug') {
    return {
      allowedToolIds: [...ALL_WORKSPACE_TOOLS, ...GIT_TOOLS],
      enforceMacroOnlyWrites: false,
    };
  }

  return {
    allowedToolIds: [...ALL_WORKSPACE_TOOLS, ...GIT_TOOLS],
    enforceMacroOnlyWrites: false,
  };
};

export const isMacroScopedPath = (rawPath: string): boolean => {
  const normalized = rawPath.replace(/\\/g, '/').trim();
  if (!normalized) return false;

  const trimmedStart = normalized.replace(/^\.\//, '');
  const isAbsolute = /^(?:[a-zA-Z]:\/|\/)/.test(trimmedStart);
  if (isAbsolute) return false;

  const parts = trimmedStart.split('/').filter((segment) => segment.length > 0);
  if (parts.length === 0) return false;

  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) {
        return false;
      }
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  if (resolved.length === 0) return false;
  return resolved[0] === '.macro';
};

export const isGitToolId = (toolId: string): boolean => {
  return (GIT_TOOLS as readonly string[]).includes(toolId);
};
