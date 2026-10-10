import type { WebSearchOptions } from '../webSearch';
import { isMacroToolCopilotBuiltInOverride, type JsonSchema, type MacroToolRegistryEntry, requireMacroToolRegistryEntry, toFunctionToolShape } from '../../shared/macroToolRegistry';
import { toMCPFunctionToolShape } from '../mcp';
import { allowedMcpTools, mcpDiscoveryToolShapes, shouldDiscoverMcpTools } from '../mcp/toolDiscovery';
import type { MCPTool } from '../../types';

// Tool definitions for the LLM
export const WEB_SEARCH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('web_search'));
export const WEB_FETCH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('web_fetch'));
export const QUESTION_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('question'));
export const CONFIG_LIST_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('config_list'));
export const CONFIG_GET_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('config_get'));
export const CONFIG_VALIDATE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('config_validate'));
export const CONFIG_PATCH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('config_patch'));
export const MAX_SKILL_TOOL_ENUM_IDS = 120;
export const MARK_SOURCE_PASSAGE_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('mark_source_passage')
);
export const READ_SOURCES_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('read_sources'));
export const EDIT_SOURCE_PASSAGE_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('edit_source_passage')
);
export const READ_FILE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('read_file'));
export const LIST_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('list'));
export const READ_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('read'));
export const WRITE_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('write'));
export const EDIT_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('edit'));
export const APPLY_PATCH_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('apply_patch'));
export const AST_GREP_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('ast_grep'));
export const DELETE_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('delete'));
export const GLOB_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('glob'));
export const GREP_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('grep'));
export const GIT_STATUS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_status'));
export const GIT_LOG_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_log'));
export const GIT_BRANCH_LIST_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_branch_list'));
export const GIT_DIFF_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_diff'));
export const GIT_GET_TREE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_get_tree'));
export const GIT_ADD_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_add'));
export const GIT_COMMIT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_commit'));
export const GIT_CHECKOUT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_checkout'));
export const GIT_MERGE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_merge'));
export const GIT_RESET_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_reset'));
export const GIT_STASH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_stash'));
export const TERMINAL_CREATE_SESSION_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('terminal_create_session')
);
export const TERMINAL_RUN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('terminal_run'));
export const TERMINAL_READ_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('terminal_read'));
export const TERMINAL_KILL_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('terminal_kill'));
export const GENERATE_PLAN_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('strategy_generate')
);
export const CREATE_PLAN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_create'));
export const LIST_PLANS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_list'));
export const GET_PLAN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_get'));
export const UPDATE_PLAN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_update'));
export const DELETE_PLAN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_delete'));
export const RESTORE_PLAN_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('plan_restore')
);
export const SET_ACTIVE_PLAN_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('plan_set_active')
);
export const GET_STRATEGY_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('strategy_get'));
export const GET_TASK_TODOS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_todo_get'));
export const UPDATE_TASK_TODOS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_todo_update'));
export const LIST_TASK_ARTIFACTS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_artifact_list'));
export const GET_TASK_ARTIFACT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_artifact_get'));
export const PUT_TASK_ARTIFACT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_artifact_put'));
export const UPDATE_STRATEGY_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('strategy_update')
);
export const DELETE_STRATEGY_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('strategy_delete')
);

export const cloneJsonSchema = (schema: JsonSchema): JsonSchema =>
  JSON.parse(JSON.stringify(schema)) as JsonSchema;

export const buildSkillToolShape = (
  toolId: 'skill_activate' | 'skill_read_resource' | 'skill_run_script',
  skillIds: string[],
): unknown => {
  const entry = requireMacroToolRegistryEntry(toolId);
  const parameters = cloneJsonSchema(entry.parameters);
  if (
    skillIds.length > 0 &&
    skillIds.length <= MAX_SKILL_TOOL_ENUM_IDS &&
    'type' in parameters &&
    parameters.type === 'object'
  ) {
    const skillIdSchema = parameters.properties?.skill_id;
    if (skillIdSchema && 'type' in skillIdSchema && skillIdSchema.type === 'string') {
      parameters.properties = {
        ...parameters.properties,
        skill_id: {
          ...skillIdSchema,
          enum: skillIds,
        },
      };
    }
  }

  return toFunctionToolShape({
    ...entry,
    parameters,
  } satisfies MacroToolRegistryEntry);
};

/**
 * Send a streaming chat completion request
 */
export const collectAllowedTools = (params: {
  allowedTools: Set<string>;
  enableWebSearch: boolean;
  enableWebFetch: boolean;
  webSearchOptions?: WebSearchOptions;
  mcpTools?: MCPTool[];
  skillToolIds?: string[];
  runnableSkillToolIds?: string[];
}): unknown[] => {
  const {
    allowedTools,
    enableWebSearch,
    enableWebFetch,
    webSearchOptions,
    mcpTools,
    skillToolIds = [],
    runnableSkillToolIds = [],
  } = params;
  const tools: unknown[] = [];

  if (allowedTools.has('list')) tools.push(LIST_TOOL);
  if (allowedTools.has('read')) tools.push(READ_WORKSPACE_TOOL);
  if (allowedTools.has('write')) tools.push(WRITE_WORKSPACE_TOOL);
  if (allowedTools.has('edit')) tools.push(EDIT_WORKSPACE_TOOL);
  if (allowedTools.has('apply_patch')) tools.push(APPLY_PATCH_WORKSPACE_TOOL);
  if (allowedTools.has('ast_grep')) tools.push(AST_GREP_WORKSPACE_TOOL);
  if (allowedTools.has('delete')) tools.push(DELETE_WORKSPACE_TOOL);
  if (allowedTools.has('glob')) tools.push(GLOB_WORKSPACE_TOOL);
  if (allowedTools.has('grep')) tools.push(GREP_WORKSPACE_TOOL);
  if (allowedTools.has('question')) tools.push(QUESTION_TOOL);
  if (allowedTools.has('config_list')) tools.push(CONFIG_LIST_TOOL);
  if (allowedTools.has('config_get')) tools.push(CONFIG_GET_TOOL);
  if (allowedTools.has('config_validate')) tools.push(CONFIG_VALIDATE_TOOL);
  if (allowedTools.has('config_patch')) tools.push(CONFIG_PATCH_TOOL);
  if (allowedTools.has('skill_activate') && skillToolIds.length > 0) {
    tools.push(buildSkillToolShape('skill_activate', skillToolIds));
  }
  if (allowedTools.has('skill_read_resource') && skillToolIds.length > 0) {
    tools.push(buildSkillToolShape('skill_read_resource', skillToolIds));
  }
  if (allowedTools.has('skill_run_script') && runnableSkillToolIds.length > 0) {
    tools.push(buildSkillToolShape('skill_run_script', runnableSkillToolIds));
  }
  if (allowedTools.has('read_file')) tools.push(READ_FILE_TOOL);
  if (allowedTools.has('mark_source_passage')) tools.push(MARK_SOURCE_PASSAGE_TOOL);
  if (allowedTools.has('read_sources')) tools.push(READ_SOURCES_TOOL);
  if (allowedTools.has('edit_source_passage')) tools.push(EDIT_SOURCE_PASSAGE_TOOL);
  if (allowedTools.has('git_status')) tools.push(GIT_STATUS_TOOL);
  if (allowedTools.has('git_diff')) tools.push(GIT_DIFF_TOOL);
  if (allowedTools.has('git_log')) tools.push(GIT_LOG_TOOL);
  if (allowedTools.has('git_branch_list')) tools.push(GIT_BRANCH_LIST_TOOL);
  if (allowedTools.has('git_checkout')) tools.push(GIT_CHECKOUT_TOOL);
  if (allowedTools.has('git_commit')) tools.push(GIT_COMMIT_TOOL);
  if (allowedTools.has('git_add')) tools.push(GIT_ADD_TOOL);
  if (allowedTools.has('git_reset')) tools.push(GIT_RESET_TOOL);
  if (allowedTools.has('git_merge')) tools.push(GIT_MERGE_TOOL);
  if (allowedTools.has('git_stash')) tools.push(GIT_STASH_TOOL);
  if (allowedTools.has('git_get_tree')) tools.push(GIT_GET_TREE_TOOL);
  if (allowedTools.has('terminal_create_session')) tools.push(TERMINAL_CREATE_SESSION_TOOL);
  if (allowedTools.has('terminal_run')) tools.push(TERMINAL_RUN_TOOL);
  if (allowedTools.has('terminal_read')) tools.push(TERMINAL_READ_TOOL);
  if (allowedTools.has('terminal_kill')) tools.push(TERMINAL_KILL_TOOL);
  if (
    allowedTools.has('web_search') &&
    enableWebSearch &&
    (webSearchOptions?.configured ||
      webSearchOptions?.tavilyApiKey ||
      webSearchOptions?.braveApiKey)
  ) {
    tools.push(WEB_SEARCH_TOOL);
  }
  if (allowedTools.has('web_fetch') && enableWebFetch) tools.push(WEB_FETCH_TOOL);
  if (allowedTools.has('strategy_generate')) tools.push(GENERATE_PLAN_TOOL);
  if (allowedTools.has('plan_create')) tools.push(CREATE_PLAN_TOOL);
  if (allowedTools.has('plan_list')) tools.push(LIST_PLANS_TOOL);
  if (allowedTools.has('plan_get')) tools.push(GET_PLAN_TOOL);
  if (allowedTools.has('plan_update')) tools.push(UPDATE_PLAN_TOOL);
  if (allowedTools.has('plan_delete')) tools.push(DELETE_PLAN_TOOL);
  if (allowedTools.has('plan_restore')) tools.push(RESTORE_PLAN_TOOL);
  if (allowedTools.has('plan_set_active')) tools.push(SET_ACTIVE_PLAN_TOOL);
  if (allowedTools.has('strategy_get')) tools.push(GET_STRATEGY_TOOL);
  if (allowedTools.has('task_todo_get')) tools.push(GET_TASK_TODOS_TOOL);
  if (allowedTools.has('task_todo_update')) tools.push(UPDATE_TASK_TODOS_TOOL);
  if (allowedTools.has('task_artifact_list')) tools.push(LIST_TASK_ARTIFACTS_TOOL);
  if (allowedTools.has('task_artifact_get')) tools.push(GET_TASK_ARTIFACT_TOOL);
  if (allowedTools.has('task_artifact_put')) tools.push(PUT_TASK_ARTIFACT_TOOL);
  if (allowedTools.has('strategy_update')) tools.push(UPDATE_STRATEGY_TOOL);
  if (allowedTools.has('strategy_delete')) tools.push(DELETE_STRATEGY_TOOL);
  if (shouldDiscoverMcpTools(allowedTools, mcpTools ?? [])) {
    tools.push(...mcpDiscoveryToolShapes);
  } else {
    allowedMcpTools(allowedTools, mcpTools ?? []).forEach(tool => tools.push(toMCPFunctionToolShape(tool)));
  }

  return tools;
};

export const getFunctionToolName = (tool: unknown): string | null => {
  if (!tool || typeof tool !== 'object') {
    return null;
  }

  const functionValue = (tool as { function?: { name?: unknown } }).function;
  return typeof functionValue?.name === 'string' ? functionValue.name : null;
};

export const withCopilotBuiltInToolOverrides = (tools: unknown[]): unknown[] =>
  tools.map((tool) => {
    const toolName = getFunctionToolName(tool);
    if (
      !toolName ||
      !isMacroToolCopilotBuiltInOverride(toolName) ||
      !tool ||
      typeof tool !== 'object'
    ) {
      return tool;
    }

    return {
      ...(tool as Record<string, unknown>),
      overridesBuiltInTool: true,
    };
  });

export const normalizeNativeProviderTools = (
  tools: unknown[],
  providerType: string,
): unknown[] =>
  providerType.trim().toLowerCase() === 'copilot'
    ? withCopilotBuiltInToolOverrides(tools)
    : tools;
