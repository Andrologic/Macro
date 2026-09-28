import { invoke } from "../tauriRuntimeBridge";
import type {
  CompleteToolInvocationInput,
  RecordToolInvocationInput,
  RecordToolInvocationResult,
  ToolInvocation,
  ToolInvocationIdentity,
} from "../../types/generated/ipc";

/** Persist this intent before dispatch. A retry with the same identity must match. */
export function recordToolInvocation(input: RecordToolInvocationInput): Promise<RecordToolInvocationResult> {
  return invoke<RecordToolInvocationResult>("db_record_tool_invocation", { input });
}

/** Call only after the result was confirmed by the owning transport. */
export function completeToolInvocation(input: CompleteToolInvocationInput): Promise<ToolInvocation> {
  return invoke<ToolInvocation>("db_complete_tool_invocation", { input });
}

export function markToolInvocationUnknown(identity: ToolInvocationIdentity): Promise<ToolInvocation> {
  return invoke<ToolInvocation>("db_mark_tool_invocation_unknown", { identity });
}

export function listUnresolvedToolInvocations(conversationId: string): Promise<ToolInvocation[]> {
  return invoke<ToolInvocation[]>("db_list_unresolved_tool_invocations", { conversationId });
}
