import { GoalAuditCoordinator } from "./GoalAuditCoordinator";
import { DurableGoalAuditJournal, type GoalAuditJournalPorts } from "./durableJournal";
import type { ClaimConversationGoalAuditInput, ResumeConversationGoalAuditInput } from "../../types/generated/ipc";
import { createGoalAuditProviderExecutor, type GoalAuditProviderPorts } from "./providerExecutor";
import type { GoalAuditCoordinatorOptions } from "./types";

export interface DurableGoalAuditCoordinatorOptions
  extends Omit<GoalAuditCoordinatorOptions, "executor" | "journal"> {
  providerPorts: GoalAuditProviderPorts;
  journalPorts?: GoalAuditJournalPorts;
  goalClaim?: Omit<ClaimConversationGoalAuditInput, "runId">;
  goalResume?: Omit<ResumeConversationGoalAuditInput, "newRunId">;
}

/** Assemble the durable journal and provider turn without choosing a UI trigger. */
export function createDurableGoalAuditCoordinator(options: DurableGoalAuditCoordinatorOptions): GoalAuditCoordinator {
  const journal = new DurableGoalAuditJournal(options.journalPorts, options.goalClaim, options.goalResume);
  const executor = createGoalAuditProviderExecutor({
    ...options.providerPorts,
    async resolveChildConversation(request) {
      const child = await options.providerPorts.resolveChildConversation(request);
      if (!child || typeof child.id !== "string" || !child.id.trim() ||
        child.id.trim() !== child.id || child.id === request.runId ||
        child.id === request.parentConversationId || child.runId !== request.runId ||
        child.parentConversationId !== request.parentConversationId) {
        throw new Error("Invalid goal auditor child conversation binding.");
      }
      if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
      await journal.linkChildConversation(request.runId, request.parentConversationId, child.id);
      if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return child;
    },
  });
  return new GoalAuditCoordinator({
    verdictPort: options.verdictPort,
    idFactory: options.idFactory,
    clock: options.clock,
    onJournalError: options.onJournalError,
    executor,
    journal,
  });
}
