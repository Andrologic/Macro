import { isRetiredArchitectToolId } from "./architectToolNames";

const ARCHITECT_CHAT_ACTION_TOOL_IDS = ["agsdl_get", "agsdl_update"] as const;

export const getArchitectChatActionToolIds = (): string[] => [
  ...ARCHITECT_CHAT_ACTION_TOOL_IDS,
];

export const getArchitectProfileAdjustedToolIds = (toolIds: string[]): string[] => [
  ...new Set([...toolIds.filter(id => !isRetiredArchitectToolId(id)), ...ARCHITECT_CHAT_ACTION_TOOL_IDS]),
];
