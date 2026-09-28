import { reserveGoalAuditChildConversation } from "../ipc/goalAudit";
import { isTauriAvailable } from "../ipc/runtime";
import type { GoalAuditProviderPorts } from "./providerExecutor";

/** Resolve only the durable child reserved for this running native goal audit. */
export const resolveNativeGoalAuditChildConversation: GoalAuditProviderPorts["resolveChildConversation"] =
  async ({ runId, parentConversationId, signal }) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!isTauriAvailable()) throw new Error("Native goal audit child reservation requires Tauri.");
    const id = await reserveGoalAuditChildConversation(runId, parentConversationId);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return { id, runId, parentConversationId };
  };
