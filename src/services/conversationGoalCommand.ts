export type ConversationGoalCommand =
  | { kind: 'activate'; objective: string }
  | { kind: 'missing_objective' };

export const parseConversationGoalCommand = (
  value: string,
): ConversationGoalCommand | null => {
  const trimmed = value.trim();
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;

  const objective = match[1]?.trim() ?? '';
  return objective
    ? { kind: 'activate', objective }
    : { kind: 'missing_objective' };
};
