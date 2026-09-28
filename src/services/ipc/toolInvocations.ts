import { invoke } from "../tauriRuntimeBridge";
import type {
  CompleteToolInvocationInput,
  RecordToolInvocationInput,
  RecordToolInvocationResult,
  ToolInvocation,
  ToolInvocationIdentity,
} from "../../types/generated/ipc";

export const TOOL_INVOCATIONS_CHANGED_EVENT = "macro:tool-invocations-changed";

const notifyToolInvocationsChanged = (conversationId: string): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(TOOL_INVOCATIONS_CHANGED_EVENT, {
      detail: { conversationId },
    }));
  }
};

/** Persist this intent before dispatch. A retry with the same identity must match. */
export async function recordToolInvocation(input: RecordToolInvocationInput): Promise<RecordToolInvocationResult> {
  const result = await invoke<RecordToolInvocationResult>("db_record_tool_invocation", { input });
  if (result.is_new) notifyToolInvocationsChanged(input.conversationId);
  return result;
}

/** Call only after the result was confirmed by the owning transport. */
export async function completeToolInvocation(input: CompleteToolInvocationInput): Promise<ToolInvocation> {
  const invocation = await invoke<ToolInvocation>("db_complete_tool_invocation", { input });
  notifyToolInvocationsChanged(input.conversationId);
  return invocation;
}

export async function markToolInvocationUnknown(identity: ToolInvocationIdentity): Promise<ToolInvocation> {
  const invocation = await invoke<ToolInvocation>("db_mark_tool_invocation_unknown", { identity });
  notifyToolInvocationsChanged(identity.conversationId);
  return invocation;
}

export function listUnresolvedToolInvocations(conversationId: string): Promise<ToolInvocation[]> {
  return invoke<ToolInvocation[]>("db_list_unresolved_tool_invocations", { conversationId });
}
