export const CHAT_MAX_TURNS_DEFAULT = 50;
export const CHAT_MAX_TURNS_MIN = 3;
export const CHAT_MAX_TURNS_MAX = 50;
export const CHAT_MAX_TURNS_DISABLED = null;

export type ChatMaxTurnsPreference = number | null;

export const isValidChatMaxTurnsPreference = (
  value: unknown,
): value is ChatMaxTurnsPreference =>
  value === CHAT_MAX_TURNS_DISABLED ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= CHAT_MAX_TURNS_MIN &&
    value <= CHAT_MAX_TURNS_MAX);

export const normalizeChatMaxTurns = (value: unknown): ChatMaxTurnsPreference => {
  if (value === undefined || value === CHAT_MAX_TURNS_DISABLED) {
    return CHAT_MAX_TURNS_DISABLED;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CHAT_MAX_TURNS_DEFAULT;
  }

  const integerValue = Math.floor(value);
  if (integerValue < CHAT_MAX_TURNS_MIN) {
    return CHAT_MAX_TURNS_MIN;
  }
  if (integerValue > CHAT_MAX_TURNS_MAX) {
    return CHAT_MAX_TURNS_MAX;
  }
  return integerValue;
};
