import type { AgentType, AppMode } from "../types";
import {
  getArchitectChatActionToolIds,
} from "./architectToolSurface";

export interface ToolModePolicy {
  allowedToolIds: string[];
  enforceMacroOnlyWrites: boolean;
}

const SKILL_READ_TOOLS = [
  "skill_activate",
  "skill_read_resource",
] as const;
const SKILL_EXECUTION_TOOLS = ["skill_run_script"] as const;
const CONFIG_TOOLS = [
  "config_list",
  "config_get",
  "config_validate",
  "config_patch",
] as const;
const SHARED_CONTEXT_TOOLS = [
  "question",
  ...CONFIG_TOOLS,
  ...SKILL_READ_TOOLS,
  "read_file",
  "web_search",
  "web_fetch",
] as const;

const WORKSPACE_READ_TOOLS = ["list", "read", "glob", "grep", "ast_grep"] as const;
const WORKSPACE_WRITE_TOOLS = ["write", "edit", "delete", "apply_patch"] as const;
const TERMINAL_TOOLS = [
  "terminal_create_session",
  "terminal_run",
  "terminal_read",
  "terminal_kill",
] as const;
const CHAT_SAFE_TOOLS = [
  "question",
  ...CONFIG_TOOLS,
  ...SKILL_READ_TOOLS,
  ...SKILL_EXECUTION_TOOLS,
  "mark_source_passage",
  "read_sources",
  "edit_source_passage",
  "read_file",
  "web_search",
  "web_fetch",
  ...TERMINAL_TOOLS,
] as const;
const GIT_READ_TOOLS = [
  "git_status",
  "git_log",
  "git_branch_list",
  "git_diff",
  "git_get_tree",
] as const;

const GIT_WRITE_TOOLS = [
  "git_add",
  "git_commit",
  "git_checkout",
  "git_merge",
  "git_reset",
  "git_stash",
] as const;

const GIT_TOOLS = [...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS] as const;
const IMPLEMENT_TASK_TODO_TOOLS = [
  "task_todo_get",
  "task_todo_update",
] as const;
const IMPLEMENT_TASK_ARTIFACT_READ_TOOLS = [
  "task_artifact_list",
  "task_artifact_get",
] as const;
const IMPLEMENT_TASK_ARTIFACT_TOOLS = [
  ...IMPLEMENT_TASK_ARTIFACT_READ_TOOLS,
  "task_artifact_put",
] as const;
const IMPLEMENT_PLAN_TOOLS = [
  ...SHARED_CONTEXT_TOOLS,
  ...WORKSPACE_READ_TOOLS,
  ...GIT_READ_TOOLS,
  "task_todo_get",
  ...IMPLEMENT_TASK_ARTIFACT_READ_TOOLS,
] as const;

const ARCHITECT_AND_IMPLEMENT_WORKSPACE_TOOLS = [
  ...SHARED_CONTEXT_TOOLS,
  ...SKILL_EXECUTION_TOOLS,
  ...WORKSPACE_READ_TOOLS,
  ...WORKSPACE_WRITE_TOOLS,
] as const;

export const getToolModePolicy = (
  mode: AppMode,
): ToolModePolicy => {
  if (mode === "Architect") {
    return {
      allowedToolIds: [
        ...ARCHITECT_AND_IMPLEMENT_WORKSPACE_TOOLS,
        ...GIT_READ_TOOLS,
        ...getArchitectChatActionToolIds(),
      ],
      enforceMacroOnlyWrites: true,
    };
  }

  if (mode === "Chat") {
    return {
      allowedToolIds: [...CHAT_SAFE_TOOLS],
      enforceMacroOnlyWrites: false,
    };
  }

  return {
    allowedToolIds: [
      ...ARCHITECT_AND_IMPLEMENT_WORKSPACE_TOOLS,
      ...IMPLEMENT_TASK_TODO_TOOLS,
      ...IMPLEMENT_TASK_ARTIFACT_TOOLS,
      ...GIT_TOOLS,
      ...TERMINAL_TOOLS,
    ],
    enforceMacroOnlyWrites: false,
  };
};

export const getImplementAgentToolPolicy = (
  agentType: AgentType,
): ToolModePolicy => {
  if (agentType === "plan") {
    return {
      allowedToolIds: [...IMPLEMENT_PLAN_TOOLS],
      enforceMacroOnlyWrites: false,
    };
  }

  return getToolModePolicy("Implement");
};

export const isToolAllowedForImplementAgent = (
  agentType: AgentType,
  toolId: string,
): boolean => getImplementAgentToolPolicy(agentType).allowedToolIds.includes(toolId);

const normalizeRelativePathParts = (rawPath: string): string[] | null => {
  const normalized = rawPath.replace(/\\/g, "/").trim();
  if (!normalized) return null;

  const trimmedStart = normalized.replace(/^\.\//, "");
  const isAbsolute = /^(?:[a-zA-Z]:\/|\/)/.test(trimmedStart);
  if (isAbsolute) return null;

  const parts = trimmedStart.split("/").filter((segment) => segment.length > 0);
  if (parts.length === 0) return null;

  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) {
        return null;
      }
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return resolved.length > 0 ? resolved : null;
};

export const isMacroScopedPath = (rawPath: string): boolean => {
  const resolved = normalizeRelativePathParts(rawPath);
  if (!resolved) return false;
  return resolved[0] === ".macro";
};

// Architect mutations already select the metadata workspace explicitly. Their
// paths are therefore relative to that root, unlike read/list paths where
// `.macro/...` is the virtual project-root address of the same metadata.
export const isMetadataRelativePath = (rawPath: string): boolean => {
  const resolved = normalizeRelativePathParts(rawPath);
  if (!resolved) return false;
  if (resolved[0] === "workspace.json") {
    return resolved.length === 1;
  }
  return resolved[0] === "branches";
};

export const isGitToolId = (toolId: string): boolean => {
  return (GIT_TOOLS as readonly string[]).includes(toolId);
};
