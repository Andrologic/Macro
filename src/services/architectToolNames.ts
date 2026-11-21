export const ARCHITECT_TOOL_ID_ALIASES: Record<string, string> = {
  generate_plan: 'strategy_generate',
  strategy_generate: 'strategy_generate',
  create_plan: 'plan_create',
  plan_create: 'plan_create',
  list_plans: 'plan_list',
  plan_list: 'plan_list',
  get_plan: 'plan_get',
  plan_get: 'plan_get',
  update_plan: 'plan_update',
  plan_update: 'plan_update',
  delete_plan: 'plan_delete',
  plan_delete: 'plan_delete',
  restore_plan: 'plan_restore',
  plan_restore: 'plan_restore',
  set_active_plan: 'plan_set_active',
  plan_set_active: 'plan_set_active',
  get_strategy: 'strategy_get',
  strategy_get: 'strategy_get',
  update_strategy: 'strategy_update',
  strategy_update: 'strategy_update',
  delete_strategy: 'strategy_delete',
  strategy_delete: 'strategy_delete',
};

export const normalizeArchitectToolId = (toolId: string): string =>
  Object.hasOwn(ARCHITECT_TOOL_ID_ALIASES, toolId) ? ARCHITECT_TOOL_ID_ALIASES[toolId] : toolId;

// Old names still identify historical traces and saved tool preferences.
const RETIRED_ARCHITECT_TOOL_IDS = new Set(Object.values(ARCHITECT_TOOL_ID_ALIASES));

export const isRetiredArchitectToolId = (toolId: string): boolean =>
  RETIRED_ARCHITECT_TOOL_IDS.has(normalizeArchitectToolId(toolId));
