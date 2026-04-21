import type { AppMode, TaskStatus } from "../types";
import {
  INTERNAL_AGENT_PROFILE_PROMPT_KEYS,
  getDefaultPromptForPreferenceKey,
  type PromptBackedInternalAgentProfile,
  type PromptPreferenceKey,
} from "./preferences";
import { getArchitectChatActionToolIds } from "./architectToolSurface";

export type InternalAgentProfile =
  | "default_executor"
  | "plan_explorer"
  | "task_reviewer"
  | "repo_auditor";

interface ResolveInternalAgentProfileParams {
  mode: AppMode;
  taskStatus?: TaskStatus | null;
  overrideProfile?: InternalAgentProfile | null;
}

const PLAN_EXPLORER_TOOL_IDS = new Set([
  "mark_source_passage",
  "read_sources",
  "edit_source_passage",
  "read_file",
  "web_search",
  "web_fetch",
  "list",
  "read",
  "glob",
  "grep",
  "git_status",
  "git_log",
  "git_branch_list",
  "git_diff",
  "git_get_tree",
  ...getArchitectChatActionToolIds("full"),
]);

const TASK_REVIEWER_TOOL_IDS = new Set([
  "mark_source_passage",
  "read_sources",
  "edit_source_passage",
  "read_file",
  "web_search",
  "web_fetch",
  "list",
  "read",
  "glob",
  "grep",
  "apply_patch",
  "delete",
  "git_status",
  "git_log",
  "git_branch_list",
  "git_diff",
  "git_get_tree",
  "terminal_create_session",
  "terminal_run",
  "terminal_read",
  "terminal_kill",
]);

const REPO_AUDITOR_TOOL_IDS = new Set([
  "list",
  "read",
  "glob",
  "grep",
  "git_status",
  "git_log",
  "git_branch_list",
  "git_diff",
  "git_get_tree",
]);

const PROFILE_TOOL_ALLOWLISTS: Partial<Record<InternalAgentProfile, Set<string>>> = {
  plan_explorer: PLAN_EXPLORER_TOOL_IDS,
  task_reviewer: TASK_REVIEWER_TOOL_IDS,
  repo_auditor: REPO_AUDITOR_TOOL_IDS,
};

export const resolveInternalAgentProfile = (
  params: ResolveInternalAgentProfileParams
): InternalAgentProfile | null => {
  if (params.overrideProfile) {
    return params.overrideProfile;
  }

  if (params.mode === "Architect") {
    return "plan_explorer";
  }

  if (params.mode === "Implement") {
    if (params.taskStatus === "InReview") {
      return "task_reviewer";
    }
    return "default_executor";
  }

  return null;
};

export const filterToolIdsForInternalAgentProfile = (
  allowedToolIds: string[],
  profile: InternalAgentProfile | null | undefined
): string[] => {
  if (!profile || profile === "default_executor") {
    return Array.from(new Set(allowedToolIds));
  }

  const allowlist = PROFILE_TOOL_ALLOWLISTS[profile];
  if (!allowlist) {
    return Array.from(new Set(allowedToolIds));
  }

  return Array.from(
    new Set(allowedToolIds.filter((toolId) => allowlist.has(toolId)))
  );
};

export const buildInternalAgentProfileSystemPrompt = (
  profile: InternalAgentProfile | null | undefined
): string | null => {
  const promptKey = getInternalAgentProfilePromptPreferenceKey(profile);
  return promptKey ? getDefaultPromptForPreferenceKey(promptKey) : null;
};

export const getInternalAgentProfilePromptPreferenceKey = (
  profile: InternalAgentProfile | null | undefined
): PromptPreferenceKey | null => {
  if (!profile || profile === "default_executor") {
    return null;
  }

  return INTERNAL_AGENT_PROFILE_PROMPT_KEYS[
    profile as PromptBackedInternalAgentProfile
  ];
};
