import { invoke } from "../tauriRuntimeBridge";
import type { AgentRun, RecordGoalAuditTransitionInput } from "../../types/generated/ipc";

export function recordGoalAuditTransition(input: RecordGoalAuditTransitionInput): Promise<AgentRun> {
  return invoke<AgentRun>("db_record_goal_audit_transition", { input });
}

export function linkGoalAuditChildConversation(
  runId: string,
  parentConversationId: string,
  childConversationId: string,
): Promise<AgentRun> {
  return invoke<AgentRun>("db_link_goal_audit_child_conversation", {
    runId, parentConversationId, childConversationId,
  });
}
