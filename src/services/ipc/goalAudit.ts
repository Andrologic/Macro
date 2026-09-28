import { invoke } from "../tauriRuntimeBridge";
import type {
  AgentRun,
  GoalAuditorReadInput as NativeGoalAuditorReadInput,
  RecordGoalAuditTransitionInput,
} from "../../types/generated/ipc";

/** The native command derives authorization from the durable run, never from a caller mode. */
export type GoalAuditorReadInput = Omit<
  NativeGoalAuditorReadInput,
  "toolId" | "args"
> & {
  toolId: "list" | "read" | "glob" | "grep" | "ast_grep"
    | "git_status" | "git_log" | "git_branch_list" | "git_diff" | "git_get_tree";
  args: Record<string, unknown>;
};

export function executeGoalAuditorRead(input: GoalAuditorReadInput): Promise<string> {
  return invoke<string>("tool_execute_goal_auditor_read", { input });
}

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

export function reserveGoalAuditChildConversation(
  runId: string,
  parentConversationId: string,
): Promise<string> {
  return invoke<string>("db_reserve_goal_audit_child_conversation", {
    runId, parentConversationId,
  });
}
