import type { ConversationGoalRecord } from "../../types";
import type {
  ActivateConversationGoalInput,
  ApplyConversationGoalVerdictInput,
  ConversationGoal,
  DeactivateConversationGoalInput,
  GoalCasOutcome,
  GoalStatus,
  UpdateConversationGoalInput,
} from "../../types/generated/ipc";
import {
  activateConversationGoal,
  applyConversationGoalVerdict,
  deactivateConversationGoal,
  getCurrentConversationGoal,
  updateConversationGoal,
} from "../ipc/conversationGoals";
import { isTauriAvailable } from "../ipc/runtime";

export type PersistedConversationGoalRecord = ConversationGoalRecord & {
  successCriteria: string[];
};

export interface ConversationGoalProductPorts {
  isAvailable(): boolean;
  getCurrentGoal(conversationId: string): Promise<ConversationGoal | null>;
  activateGoal(input: ActivateConversationGoalInput): Promise<ConversationGoal>;
  updateGoal(input: UpdateConversationGoalInput): Promise<GoalCasOutcome>;
  applyVerdict(input: ApplyConversationGoalVerdictInput): Promise<GoalCasOutcome>;
  deactivateGoal(input: DeactivateConversationGoalInput): Promise<GoalCasOutcome>;
}

const nativePorts: ConversationGoalProductPorts = {
  isAvailable: isTauriAvailable,
  getCurrentGoal: getCurrentConversationGoal,
  activateGoal: activateConversationGoal,
  updateGoal: updateConversationGoal,
  applyVerdict: applyConversationGoalVerdict,
  deactivateGoal: deactivateConversationGoal,
};

export function mapConversationGoalRecord(goal: ConversationGoal): PersistedConversationGoalRecord {
  return {
    conversationId: goal.conversationId,
    goalId: goal.goalId,
    revision: goal.revision,
    status: goal.status,
    objective: goal.objective,
    successCriteria: [...goal.successCriteria],
    providerId: goal.providerId,
    modelId: goal.modelId,
    reasoningEffort: goal.reasoningEffort,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    lastAuditedAt: goal.lastAuditedAt,
    lastExecutorTurnAt: goal.lastExecutorTurnAt,
    awaitingUserSinceAt: goal.awaitingUserSinceAt,
    executorTurnCount: goal.executorTurnCount,
    auditCount: goal.auditCount,
    continuationCount: goal.continuationCount,
    latestVerdict: goal.latestVerdict,
    lastError: goal.lastError,
  };
}

type NewGoalInput = Omit<ActivateConversationGoalInput, "replaceGoalId" | "replaceRevision">;
type ReplacementGoalInput = NewGoalInput & {
  replaceGoalId: string;
  replaceRevision: number;
};
type MutableGoalStatus = Exclude<GoalStatus, "auditing" | "achieved">;

/** The caller updates its UI only after the native operation has succeeded. */
export class ConversationGoalProductRepository {
  constructor(private readonly ports: ConversationGoalProductPorts = nativePorts) {}

  private requireNative(): void {
    if (!this.ports.isAvailable()) {
      throw new Error("Conversation goal storage requires the Tauri runtime.");
    }
  }

  async loadCurrentGoal(conversationId: string): Promise<PersistedConversationGoalRecord | null> {
    this.requireNative();
    const goal = await this.ports.getCurrentGoal(conversationId);
    return goal ? mapConversationGoalRecord(goal) : null;
  }

  async activateGoal(input: NewGoalInput): Promise<PersistedConversationGoalRecord> {
    this.requireNative();
    return mapConversationGoalRecord(await this.ports.activateGoal({
      ...input, replaceGoalId: null, replaceRevision: null,
    }));
  }

  async replaceGoal(input: ReplacementGoalInput): Promise<PersistedConversationGoalRecord> {
    this.requireNative();
    return mapConversationGoalRecord(await this.ports.activateGoal(input));
  }

  async updateGoalStatus(
    goal: PersistedConversationGoalRecord,
    status: MutableGoalStatus,
    reason: string | null = null,
  ): Promise<GoalCasOutcome> {
    this.requireNative();
    return this.ports.updateGoal({
      conversationId: goal.conversationId,
      goalId: goal.goalId,
      expectedRevision: goal.revision,
      objective: goal.objective,
      successCriteria: goal.successCriteria,
      status,
      reason,
    });
  }

  async applyVerdict(input: ApplyConversationGoalVerdictInput): Promise<GoalCasOutcome> {
    this.requireNative();
    return this.ports.applyVerdict(input);
  }

  async stopGoal(goal: Pick<ConversationGoalRecord, "conversationId" | "goalId" | "revision">): Promise<GoalCasOutcome> {
    this.requireNative();
    return this.ports.deactivateGoal({
      conversationId: goal.conversationId,
      goalId: goal.goalId,
      expectedRevision: goal.revision,
    });
  }
}
