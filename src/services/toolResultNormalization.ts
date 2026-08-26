import type { ToolCallResolution } from './streamingChat';

export const normalizeLegacyToolExecutionResult = (
  toolName: string,
  resolution: ToolCallResolution | string | void,
): ToolCallResolution | string | void => {
  if (typeof resolution !== 'string') return resolution;

  const withoutPromotionNotice = resolution.trim().replace(
    /^\[macro_scope_promotion\][^\r\n]*(?:\r?\n)+/,
    '',
  );
  const errorPatternsByTool: Partial<Record<string, RegExp[]>> = {
    read: [/^File not found:/i],
    read_file: [/^File not found:/i],
    edit: [/^No match found/i],
    plan_delete: [/^plan_delete is disabled/i],
  };
  const isError = (errorPatternsByTool[toolName] ?? []).some((pattern) =>
    pattern.test(withoutPromotionNotice),
  );

  return isError
    ? {
        kind: 'result',
        result: resolution,
        isError: true,
        errorKind: 'execution',
        toString: () => resolution,
      }
    : resolution;
};
