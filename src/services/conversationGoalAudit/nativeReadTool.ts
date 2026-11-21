import { executeGoalAuditorRead, type GoalAuditorReadInput } from "../ipc/goalAudit";
import { isTauriAvailable } from "../ipc/runtime";
import type { GoalAuditProviderPorts, GoalAuditReadToolContext } from "./providerExecutor";

type ReadToolResult = Awaited<ReturnType<GoalAuditProviderPorts["executeReadTool"]>>;

const NATIVE_READ_TOOLS = new Set<GoalAuditorReadInput["toolId"]>([
  "list", "read", "glob", "grep", "ast_grep",
  "git_status", "git_log", "git_branch_list", "git_diff", "git_get_tree",
]);

const abortError = () => new DOMException("Goal audit read cancelled.", "AbortError");

// Revoking publication cannot release the owner of an IPC already dispatched.
const readUntilAbort = async (input: GoalAuditorReadInput, signal: AbortSignal): Promise<string> => {
  if (signal.aborted) throw abortError();
  const value = await executeGoalAuditorRead(input);
  if (signal.aborted) throw abortError();
  return value;
};

/** The executor supplies audit identity separately from provider arguments. */
export async function executeNativeGoalAuditReadTool(
  name: string,
  args: Record<string, unknown>,
  _id: string | undefined,
  signal: AbortSignal,
  context: GoalAuditReadToolContext,
): Promise<ReadToolResult> {
  if (signal.aborted) throw abortError();
  if (!context ||
      ![context.runId, context.parentConversationId, context.childConversationId]
        .every((value) => typeof value === "string" && value.length > 0 && value.trim() === value)) {
    throw new Error("Goal audit read requires a valid runtime context.");
  }
  if (typeof name !== "string" || !NATIVE_READ_TOOLS.has(name as GoalAuditorReadInput["toolId"])) {
    throw new Error("Invalid goal audit read tool.");
  }
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      ["runId", "parentConversationId", "childConversationId"]
        .some((key) => Object.hasOwn(args, key))) {
    throw new Error("Invalid goal audit read arguments.");
  }
  if (!isTauriAvailable()) throw new Error("Tauri is unavailable for goal audit reads.");
  if (signal.aborted) throw abortError();

  const input: GoalAuditorReadInput = {
    runId: context.runId,
    parentConversationId: context.parentConversationId,
    childConversationId: context.childConversationId,
    toolId: name as GoalAuditorReadInput["toolId"],
    args,
  };
  const result = await readUntilAbort(input, signal);
  if (signal.aborted) throw abortError();
  return { kind: "result", result };
}
