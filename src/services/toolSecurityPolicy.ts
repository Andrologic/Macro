import type {
  AppMode,
  ConversationApprovalGrant,
  ProjectMount,
  ToolRiskLevel,
  ToolSecurityActionGroup,
  ToolSecurityDecision,
} from "../types";
import { isMCPToolId, parseMCPToolId } from "./mcpToolNames";
import { getToolModePolicy } from "./toolModePolicy";

type RememberStrategy =
  | "tool"
  | "path"
  | "web_domain"
  | "terminal_prefix"
  | "apply_patch_targets";

type DestructiveStrategy =
  | "never"
  | "always"
  | "apply_patch_delete"
  | "edit_source_passage_delete";

type ToolSecurityDefinition = {
  actionGroup: ToolSecurityActionGroup;
  rememberStrategy: RememberStrategy;
  destructiveStrategy: DestructiveStrategy;
  summary: string;
  attachmentOnly?: boolean;
};

export const TOOL_RISK_LEVELS = [
  "strict",
  "balanced",
  "yolo",
] as const satisfies readonly ToolRiskLevel[];

export const DEFAULT_TOOL_RISK_LEVEL: ToolRiskLevel = "balanced";

export const TOOL_LEVEL_REMEMBER_KEY_TOOL_IDS = new Set<string>([
  "question",
  "skill_activate",
  "skill_read_resource",
  "skill_run_script",
  "read_file",
  "web_search",
  "mark_source_passage",
  "read_sources",
  "edit_source_passage",
  "plan_create",
  "strategy_generate",
  "strategy_update",
  "strategy_delete",
  "task_todo_update",
  "task_artifact_put",
  "plan_update",
]);

const TOOL_SECURITY_DEFINITIONS: Record<string, ToolSecurityDefinition> = {
  question: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Ask a blocking question",
  },
  read_file: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Read an attached file",
    attachmentOnly: true,
  },
  skill_activate: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Load skill instructions",
  },
  skill_read_resource: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Read a skill resource",
  },
  skill_run_script: {
    actionGroup: "escape",
    rememberStrategy: "tool",
    destructiveStrategy: "always",
    summary: "Run a skill script",
  },
  read_sources: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Read saved source passages",
  },
  mark_source_passage: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Save a source passage",
  },
  list: {
    actionGroup: "observe",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "List workspace files",
  },
  read: {
    actionGroup: "observe",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Read a workspace file",
  },
  glob: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Search for matching files",
  },
  grep: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Search text in the workspace",
  },
  git_status: {
    actionGroup: "observe",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Inspect git status",
  },
  git_log: {
    actionGroup: "observe",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Read git history",
  },
  git_branch_list: {
    actionGroup: "observe",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "List git branches",
  },
  git_diff: {
    actionGroup: "observe",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Inspect git diff",
  },
  git_get_tree: {
    actionGroup: "observe",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Inspect the repository tree",
  },
  plan_get: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Read a plan",
  },
  plan_list: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "List plans",
  },
  strategy_get: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Read a strategy",
  },
  task_todo_get: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Read task todos",
  },
  task_artifact_list: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "List task artifacts",
  },
  task_artifact_get: {
    actionGroup: "observe",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Read a task artifact",
  },
  write: {
    actionGroup: "change",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Write a workspace file",
  },
  edit: {
    actionGroup: "change",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Edit a workspace file",
  },
  apply_patch: {
    actionGroup: "change",
    rememberStrategy: "apply_patch_targets",
    destructiveStrategy: "apply_patch_delete",
    summary: "Apply a multi-file patch",
  },
  edit_source_passage: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "edit_source_passage_delete",
    summary: "Edit a saved source passage",
  },
  plan_update: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "always",
    summary: "Update the active plan",
  },
  strategy_generate: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "always",
    summary: "Generate a strategy",
  },
  strategy_update: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "always",
    summary: "Update a strategy",
  },
  task_todo_update: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "always",
    summary: "Update task todos",
  },
  task_artifact_put: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "always",
    summary: "Store a task artifact",
  },
  git_add: {
    actionGroup: "change",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Stage git changes",
  },
  git_commit: {
    actionGroup: "change",
    rememberStrategy: "path",
    destructiveStrategy: "never",
    summary: "Create a git commit",
  },
  delete: {
    actionGroup: "escape",
    rememberStrategy: "path",
    destructiveStrategy: "always",
    summary: "Delete a workspace file",
  },
  web_search: {
    actionGroup: "escape",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Search the web",
  },
  web_fetch: {
    actionGroup: "escape",
    rememberStrategy: "web_domain",
    destructiveStrategy: "never",
    summary: "Fetch a web page",
  },
  git_checkout: {
    actionGroup: "escape",
    rememberStrategy: "path",
    destructiveStrategy: "always",
    summary: "Change the git checkout",
  },
  git_merge: {
    actionGroup: "escape",
    rememberStrategy: "path",
    destructiveStrategy: "always",
    summary: "Merge a git branch",
  },
  git_reset: {
    actionGroup: "escape",
    rememberStrategy: "path",
    destructiveStrategy: "always",
    summary: "Reset git state",
  },
  git_stash: {
    actionGroup: "escape",
    rememberStrategy: "path",
    destructiveStrategy: "always",
    summary: "Stash git changes",
  },
  terminal_create_session: {
    actionGroup: "escape",
    rememberStrategy: "terminal_prefix",
    destructiveStrategy: "never",
    summary: "Open a terminal session",
  },
  terminal_run: {
    actionGroup: "escape",
    rememberStrategy: "terminal_prefix",
    destructiveStrategy: "always",
    summary: "Run a terminal command",
  },
  terminal_read: {
    actionGroup: "escape",
    rememberStrategy: "terminal_prefix",
    destructiveStrategy: "never",
    summary: "Read terminal output",
  },
  terminal_kill: {
    actionGroup: "escape",
    rememberStrategy: "terminal_prefix",
    destructiveStrategy: "never",
    summary: "Stop a terminal session",
  },
  strategy_delete: {
    actionGroup: "escape",
    rememberStrategy: "tool",
    destructiveStrategy: "always",
    summary: "Delete a strategy",
  },
  plan_create: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Create a plan",
  },
  plan_restore: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Restore a plan",
  },
  plan_delete: {
    actionGroup: "escape",
    rememberStrategy: "tool",
    destructiveStrategy: "always",
    summary: "Delete a plan",
  },
  plan_set_active: {
    actionGroup: "change",
    rememberStrategy: "tool",
    destructiveStrategy: "never",
    summary: "Set the active plan",
  },
};

export interface EvaluateToolSecurityOptions {
  mode: AppMode;
  riskLevel: ToolRiskLevel;
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  projectMounts?: ProjectMount[];
  grants?: ConversationApprovalGrant[];
}

export interface NormalizedToolSecurityCall {
  toolId: string;
  actionGroup: ToolSecurityActionGroup;
  summary: string;
  detail?: string;
  rememberKey: string;
  isDestructive: boolean;
  isExternalToWorkspace: boolean;
}

export interface ToolSecurityEvaluation {
  decision: ToolSecurityDecision;
  denialReason?: string;
  normalizedCall: NormalizedToolSecurityCall;
}

const cleanString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isAbsolutePath = (value: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(value) ||
  value.startsWith("/") ||
  /^\\\\wsl(?:\.localhost|\$)\\/i.test(value);

const normalizePathForComparison = (value: string): string => {
  const normalized = value.replace(/\\/g, "/").trim();
  const driveMatch = normalized.match(/^([a-zA-Z]):/);
  const prefix = driveMatch ? `${driveMatch[1].toLowerCase()}:` : normalized.startsWith("/") ? "/" : "";
  const body = normalized.replace(/^([a-zA-Z]:)?\/?/, "");
  const segments: string[] = [];

  body.split("/").forEach((segment) => {
    if (!segment || segment === ".") {
      return;
    }
    if (segment === "..") {
      if (segments.length > 0) {
        segments.pop();
      }
      return;
    }
    segments.push(segment);
  });

  return prefix + segments.join("/");
};

const isRelativePathOutsideWorkspace = (value: string): boolean => {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized) return false;

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return true;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return false;
};

const isPathWithinRoot = (targetPath: string, workspaceRoot: string): boolean => {
  const normalizedTarget = normalizePathForComparison(targetPath);
  const normalizedRoot = normalizePathForComparison(workspaceRoot);

  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}/`)
  );
};

const getWorkspaceRoots = (
  options: EvaluateToolSecurityOptions,
): string[] => {
  const roots = [
    cleanString(options.workspacePath),
    cleanString(options.defaultWorkspacePath),
    ...(options.projectMounts ?? []).map((mount) => cleanString(mount.workspacePath)),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(roots)];
};

const getStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => cleanString(item))
        .filter((item): item is string => Boolean(item))
    : [];

const parseApplyPatchTargets = (
  patchText: string | null | undefined,
): { targets: string[]; hasDelete: boolean } => {
  if (!patchText) {
    return { targets: [], hasDelete: false };
  }

  const lines = patchText.split(/\r?\n/);
  const targets: string[] = [];
  let hasDelete = false;

  for (const line of lines) {
    if (line.startsWith("*** Add File: ")) {
      targets.push(line.slice("*** Add File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      targets.push(line.slice("*** Update File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      hasDelete = true;
      targets.push(line.slice("*** Delete File: ".length).trim());
    }
  }

  return { targets, hasDelete };
};

const getTerminalRememberPrefix = (command: string | null): string | null => {
  if (!command) return null;

  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return null;
  if (tokens.length === 1) return tokens[0] ?? null;
  return `${tokens[0]} ${tokens[1]}`;
};

const extractDomain = (urlValue: string | null): string | null => {
  if (!urlValue) return null;

  try {
    return new URL(urlValue).hostname || null;
  } catch {
    return null;
  }
};

const getPathCandidates = (
  toolId: string,
  args: Record<string, unknown>,
): string[] => {
  if (toolId === "apply_patch") {
    return parseApplyPatchTargets(cleanString(args.patch_text)).targets;
  }

  const candidates = [
    cleanString(args.path),
    cleanString(args.repo_path),
    cleanString(args.cwd),
    ...getStringArray(args.paths),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
};

const getPrimaryDetail = (
  toolId: string,
  args: Record<string, unknown>,
  pathCandidates: string[],
): string | undefined => {
  if (toolId === "terminal_run") {
    return cleanString(args.command) ?? undefined;
  }
  if (toolId === "terminal_create_session") {
    return cleanString(args.cwd) ?? cleanString(args.project_id) ?? undefined;
  }
  if (toolId === "terminal_read" || toolId === "terminal_kill") {
    return cleanString(args.session_id) ?? undefined;
  }
  if (toolId === "web_fetch") {
    return cleanString(args.url) ?? undefined;
  }
  if (toolId === "web_search") {
    return cleanString(args.query) ?? undefined;
  }
  if (toolId === "read_file") {
    return cleanString(args.file) ?? undefined;
  }
  if (toolId === "skill_activate") {
    return cleanString(args.skill_id) ?? undefined;
  }
  if (toolId === "skill_read_resource") {
    return cleanString(args.path) ?? cleanString(args.skill_id) ?? undefined;
  }
  if (toolId === "skill_run_script") {
    return cleanString(args.script_path) ?? cleanString(args.skill_id) ?? undefined;
  }
  if (pathCandidates.length === 1) {
    return pathCandidates[0];
  }
  if (pathCandidates.length > 1) {
    return `${pathCandidates.length} paths`;
  }
  return undefined;
};

const isCallExternalToWorkspace = (
  toolId: string,
  args: Record<string, unknown>,
  options: EvaluateToolSecurityOptions,
): boolean => {
  const definition = TOOL_SECURITY_DEFINITIONS[toolId];
  if (definition?.attachmentOnly) {
    return false;
  }

  const pathCandidates = getPathCandidates(toolId, args);
  if (pathCandidates.length === 0) {
    return false;
  }

  const workspaceRoots = getWorkspaceRoots(options);

  return pathCandidates.some((candidate) => {
    if (!candidate) return false;
    if (!isAbsolutePath(candidate)) {
      return isRelativePathOutsideWorkspace(candidate);
    }
    if (workspaceRoots.length === 0) {
      return true;
    }
    return !workspaceRoots.some((root) => isPathWithinRoot(candidate, root));
  });
};

const isCallDestructive = (
  toolId: string,
  args: Record<string, unknown>,
): boolean => {
  const definition = TOOL_SECURITY_DEFINITIONS[toolId];
  if (!definition) return false;

  switch (definition.destructiveStrategy) {
    case "always":
      return true;
    case "apply_patch_delete":
      return parseApplyPatchTargets(cleanString(args.patch_text)).hasDelete;
    case "edit_source_passage_delete":
      return cleanString(args.action) === "delete";
    default:
      return false;
  }
};

export const getRememberKey = (
  toolId: string,
  args: Record<string, unknown>,
): string => {
  const definition = TOOL_SECURITY_DEFINITIONS[toolId];
  if (!definition) {
    return `tool:${toolId}`;
  }

  if (TOOL_LEVEL_REMEMBER_KEY_TOOL_IDS.has(toolId)) {
    return `tool:${toolId}`;
  }

  const pathCandidates = getPathCandidates(toolId, args).map(
    normalizePathForComparison,
  );

  switch (definition.rememberStrategy) {
    case "tool":
      return `tool:${toolId}`;
    case "path":
      if (pathCandidates.length === 0) {
        return `tool:${toolId}`;
      }
      if (pathCandidates.length === 1) {
        return `path:${pathCandidates[0]}`;
      }
      return `paths:${[...pathCandidates].sort().join("|")}`;
    case "web_domain": {
      const domain = extractDomain(cleanString(args.url));
      return domain ? `domain:${domain}` : `tool:${toolId}`;
    }
    case "terminal_prefix": {
      const prefix = getTerminalRememberPrefix(cleanString(args.command));
      return prefix ? `terminal:${prefix}` : `terminal:${toolId}`;
    }
    case "apply_patch_targets": {
      if (pathCandidates.length === 0) {
        return `tool:${toolId}`;
      }
      if (pathCandidates.length === 1) {
        return `path:${pathCandidates[0]}`;
      }
      return `paths:${[...pathCandidates].sort().join("|")}`;
    }
  }
};

const normalizeToolSecurityCall = (
  toolId: string,
  args: Record<string, unknown>,
  options: EvaluateToolSecurityOptions,
): NormalizedToolSecurityCall => {
  const mcpToolIdentity = parseMCPToolId(toolId);
  const definition =
    TOOL_SECURITY_DEFINITIONS[toolId] ??
    (mcpToolIdentity
      ? {
          actionGroup: "escape" as const,
          rememberStrategy: "tool" as const,
          destructiveStrategy: "never" as const,
          summary: `Call MCP tool ${mcpToolIdentity.toolSlug} on ${mcpToolIdentity.serverId}`,
        }
      : {
          actionGroup: "escape" as const,
          rememberStrategy: "tool" as const,
          destructiveStrategy: "never" as const,
          summary: `Use ${toolId}`,
        });

  const pathCandidates = getPathCandidates(toolId, args);

  return {
    toolId,
    actionGroup: definition.actionGroup,
    summary: definition.summary,
    detail: getPrimaryDetail(toolId, args, pathCandidates),
    rememberKey: getRememberKey(toolId, args),
    isDestructive: isCallDestructive(toolId, args),
    isExternalToWorkspace: isCallExternalToWorkspace(toolId, args, options),
  };
};

const hasConversationGrant = (
  grants: ConversationApprovalGrant[] | undefined,
  normalizedCall: NormalizedToolSecurityCall,
): boolean =>
  (grants ?? []).some(
    (grant) =>
      grant.toolId === normalizedCall.toolId &&
      grant.rememberKey === normalizedCall.rememberKey,
  );

const evaluateDecisionForRiskLevel = (
  normalizedCall: NormalizedToolSecurityCall,
  riskLevel: ToolRiskLevel,
): ToolSecurityEvaluation => {
  if (normalizedCall.isExternalToWorkspace) {
    return {
      decision: "deny",
      denialReason: `Tool ${normalizedCall.toolId} cannot access paths outside the current workspace.`,
      normalizedCall,
    };
  }

  if (riskLevel === "yolo") {
    return { decision: "allow", normalizedCall };
  }

  if (riskLevel === "strict") {
    if (normalizedCall.actionGroup === "escape" || normalizedCall.isDestructive) {
      return {
        decision: "deny",
        denialReason: `Tool ${normalizedCall.toolId} is blocked by the current Strict security level.`,
        normalizedCall,
      };
    }

    return {
      decision:
        normalizedCall.actionGroup === "observe" ? "allow" : "ask",
      normalizedCall,
    };
  }

  if (normalizedCall.actionGroup === "observe") {
    return { decision: "allow", normalizedCall };
  }

  if (normalizedCall.actionGroup === "change") {
    return {
      decision: normalizedCall.isDestructive ? "ask" : "allow",
      normalizedCall,
    };
  }

  return { decision: "ask", normalizedCall };
};

export const evaluateToolSecurity = (
  toolId: string,
  args: Record<string, unknown>,
  options: EvaluateToolSecurityOptions,
): ToolSecurityEvaluation => {
  const modePolicy = getToolModePolicy(options.mode);
  if (!modePolicy.allowedToolIds.includes(toolId) && !isMCPToolId(toolId)) {
    const normalizedCall = normalizeToolSecurityCall(toolId, args, options);
    return {
      decision: "deny",
      denialReason: `Tool ${toolId} is not available in ${options.mode} mode.`,
      normalizedCall,
    };
  }

  const normalizedCall = normalizeToolSecurityCall(toolId, args, options);
  const evaluation = evaluateDecisionForRiskLevel(
    normalizedCall,
    options.riskLevel,
  );

  if (
    evaluation.decision === "ask" &&
    hasConversationGrant(options.grants, normalizedCall)
  ) {
    return {
      decision: "allow",
      normalizedCall,
    };
  }

  return evaluation;
};

export const filterDeniedToolIdsForRiskLevel = (
  toolIds: string[],
  riskLevel: ToolRiskLevel,
): string[] => {
  if (riskLevel !== "strict") {
    return [...new Set(toolIds)];
  }

  return [...new Set(toolIds)].filter((toolId) => {
    if (isMCPToolId(toolId)) {
      return false;
    }
    const definition = TOOL_SECURITY_DEFINITIONS[toolId];
    return !definition || definition.actionGroup !== "escape";
  });
};

export const buildToolRiskLevelSystemInstruction = (
  riskLevel: ToolRiskLevel,
): string => {
  if (riskLevel === "strict") {
    return "Tool risk level is STRICT. Stay inside the current workspace. Observe tools are allowed. Change tools require user approval. Escape tools, destructive actions, terminal actions, web access, and outside-workspace access are blocked.";
  }

  if (riskLevel === "yolo") {
    return "Tool risk level is YOLO. Macro will not add extra approval prompts, but you must still respect tool-native safeguards and stay aligned with the user's request.";
  }

  return "Tool risk level is BALANCED. Stay inside the current workspace. Observe tools are allowed. Most change tools are allowed automatically. Escape tools and destructive actions require user approval.";
};
