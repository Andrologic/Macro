export const ARCHITECT_PLAN_CHAT_TOOL_IDS = [
  "plan_list",
  "plan_get",
  "plan_update",
] as const;

export const ARCHITECT_NEED_GUARDED_TOOL_IDS = [
  "need_add",
  "need_list",
  "need_get",
  "need_update",
] as const;

export const ARCHITECT_NEED_DESTRUCTIVE_TOOL_IDS = ["need_delete"] as const;

export const ARCHITECT_STRATEGY_GUARDED_TOOL_IDS = [
  "strategy_generate",
  "strategy_get",
  "strategy_update",
] as const;

export const ARCHITECT_STRATEGY_DESTRUCTIVE_TOOL_IDS = [
  "strategy_delete",
] as const;

export const ARCHITECT_CHAT_UI_ONLY_TOOL_IDS = [
  "plan_create",
  "plan_set_active",
  "plan_delete",
  "plan_restore",
] as const;

export const ARCHITECT_GUARDED_CHAT_ACTION_TOOL_IDS = [
  ...ARCHITECT_NEED_GUARDED_TOOL_IDS,
  ...ARCHITECT_STRATEGY_GUARDED_TOOL_IDS,
  ...ARCHITECT_PLAN_CHAT_TOOL_IDS,
] as const;

export const ARCHITECT_CHAT_ACTION_TOOL_IDS = [
  ...ARCHITECT_GUARDED_CHAT_ACTION_TOOL_IDS,
  ...ARCHITECT_NEED_DESTRUCTIVE_TOOL_IDS,
  ...ARCHITECT_STRATEGY_DESTRUCTIVE_TOOL_IDS,
] as const;

const UI_ONLY_TOOL_ID_SET = new Set<string>(ARCHITECT_CHAT_UI_ONLY_TOOL_IDS);

export const getArchitectChatActionToolIds = (): string[] => [
  ...ARCHITECT_CHAT_ACTION_TOOL_IDS,
];

export const getArchitectProfileAdjustedToolIds = (
  toolIds: string[],
): string[] => {
  const nextToolIds = new Set<string>();

  toolIds.forEach((toolId) => {
    if (UI_ONLY_TOOL_ID_SET.has(toolId)) {
      return;
    }
    nextToolIds.add(toolId);
  });

  getArchitectChatActionToolIds().forEach((toolId) => {
    nextToolIds.add(toolId);
  });

  return [...nextToolIds];
};

export const isArchitectDestructiveChatToolId = (toolId: string): boolean =>
  (ARCHITECT_NEED_DESTRUCTIVE_TOOL_IDS as readonly string[]).includes(toolId) ||
  (ARCHITECT_STRATEGY_DESTRUCTIVE_TOOL_IDS as readonly string[]).includes(toolId);

export const isArchitectUiOnlyToolId = (toolId: string): boolean =>
  UI_ONLY_TOOL_ID_SET.has(toolId);
