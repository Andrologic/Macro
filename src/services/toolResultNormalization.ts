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
    read: [/^File not found:/i, /^Error executing read:/i],
    read_file: [/^File not found:/i],
    write: [/^(?:Cannot|Error executing write:)/i],
    edit: [/^(?:Cannot|No match found|Error executing edit:)/i],
    delete: [/^(?:Cannot|Error executing delete:)/i],
    apply_patch: [/^(?:Cannot|Error executing apply_patch:)/i],
    list: [/^Error executing list:/i],
    glob: [/^Error executing glob:/i],
    grep: [/^Error executing grep:/i],
    git_status: [/^Error executing (?:git_status|git tool):/i],
    git_branch_list: [/^Error executing (?:git_branch_list|git tool):/i],
    git_get_tree: [/^Error executing (?:git_get_tree|git tool):/i],
    git_diff: [/^Error executing (?:git_diff|git tool):/i],
    git_log: [/^Error executing (?:git_log|git tool):/i],
    git_show: [/^Error executing (?:git_show|git tool):/i],
    git_add: [/^Error executing (?:git_add|git tool):/i],
    git_commit: [/^Error executing (?:git_commit|git tool):/i],
    git_checkout: [/^Error executing (?:git_checkout|git tool):/i],
    git_merge: [/^Error executing (?:git_merge|git tool):/i],
    git_reset: [/^Error executing (?:git_reset|git tool):/i],
    git_stash: [/^Error executing (?:git_stash|git tool):/i],
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
