import { invoke } from "../tauriRuntimeBridge";
import type {
  ActivateConversationGoalInput,
  ApplyConversationGoalVerdictInput,
  ConversationGoal,
  ConversationGoalAudit,
  DeactivateConversationGoalInput,
  GoalCasOutcome,
  UpdateConversationGoalInput,
} from "../../types/generated/ipc";
import type { GoalAuditVerdictPort } from "../conversationGoalAudit/types";

export const getCurrentConversationGoal = (conversationId: string): Promise<ConversationGoal | null> =>
  invoke("db_get_current_conversation_goal", { conversationId });

export const activateConversationGoal = (input: ActivateConversationGoalInput): Promise<ConversationGoal> =>
  invoke("db_activate_conversation_goal", { input });

export const updateConversationGoal = (input: UpdateConversationGoalInput): Promise<GoalCasOutcome> =>
  invoke("db_update_conversation_goal", { input });

export const deactivateConversationGoal = (input: DeactivateConversationGoalInput): Promise<GoalCasOutcome> =>
  invoke("db_deactivate_conversation_goal", { input });

export const getConversationGoalAudit = (auditId: string): Promise<ConversationGoalAudit | null> =>
  invoke("db_get_conversation_goal_audit", { auditId });

export const listRecoverableConversationGoalAudits = (): Promise<ConversationGoalAudit[]> =>
  invoke("db_list_recoverable_conversation_goal_audits");

export const applyConversationGoalVerdict = (input: ApplyConversationGoalVerdictInput): Promise<GoalCasOutcome> =>
  invoke("db_apply_conversation_goal_verdict", { input });

/** Bind a previously claimed audit to the coordinator's verdict port. */
export const createNativeGoalAuditVerdictPort = (
  auditId: string,
  executorTurnId: string,
): GoalAuditVerdictPort => ({
  async applyVerdict({ conversationId, goalId, expectedRevision, runId, verdict, signal }) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const outcome = await applyConversationGoalVerdict({
      auditId, conversationId, goalId, expectedRevision, executorTurnId, runId, verdict,
    });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (outcome === "duplicate") throw new Error("This executor turn was already audited.");
    return outcome;
  },
});
