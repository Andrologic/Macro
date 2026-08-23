import type {
  ConversationGoalEvidence,
  ConversationGoalVerdict,
} from "../../types";
import type {
  DelegationAuthorization,
  DelegationPolicyScope,
  DelegationRelevantArea,
} from "../subagentPolicy";
import type {
  ChildTurnExecutor,
  SubagentProgressEvent,
  SubagentRuntimeClock,
} from "../subagentRuntime";
import type { GoalAuditJournal, GoalAuditRunDescriptor } from "./journal";

export interface GoalAuditExecutorTurn {
  turnId: string;
  summary: string;
}

export interface GoalAuditRequest {
  conversationId: string;
  goalId: string;
  goalRevision: number;
  objective: string;
  successCriteria: readonly string[];
  lastExecutorTurn: GoalAuditExecutorTurn;
  evidence?: readonly ConversationGoalEvidence[];
  relevantAreas?: readonly DelegationRelevantArea[];
  constraints?: readonly string[];
  userPolicy: DelegationPolicyScope;
  parentPolicy: DelegationPolicyScope;
  modePolicy?: DelegationPolicyScope;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoalAuditChildInput {
  profile: "goal_auditor";
  systemPrompt: string;
  authorization: DelegationAuthorization;
}

export interface ApplyGoalAuditVerdictInput {
  conversationId: string;
  goalId: string;
  expectedRevision: number;
  verdict: ConversationGoalVerdict;
  runId: string;
  signal: AbortSignal;
}

export type GoalAuditVerdictApplyResult = "applied" | "stale" | "missing";

export interface GoalAuditVerdictPort {
  applyVerdict(
    input: ApplyGoalAuditVerdictInput,
  ): GoalAuditVerdictApplyResult | Promise<GoalAuditVerdictApplyResult>;
}

export type GoalAuditErrorCode =
  | "AUDIT_ALREADY_ACTIVE"
  | "COORDINATOR_DISPOSED"
  | "INVALID_AUDIT_CONTEXT"
  | "DELEGATION_PREFLIGHT_REJECTED"
  | "POLICY_INVARIANT_VIOLATION"
  | "CHILD_EXECUTION_FAILED"
  | "INVALID_AUDITOR_VERDICT"
  | "JOURNAL_REGISTRATION_FAILED"
  | "VERDICT_APPLICATION_FAILED";

export interface GoalAuditError {
  code: GoalAuditErrorCode | string;
  message: string;
  details?: unknown;
}

export type GoalAuditResult =
  | {
      status: "applied";
      runId: string;
      verdict: ConversationGoalVerdict;
    }
  | {
      status: "stale";
      runId: string;
      reason: "revision_changed" | "goal_missing";
      verdict: ConversationGoalVerdict;
    }
  | {
      status: "timed_out";
      runId: string;
      timeoutMs: number;
    }
  | {
      status: "cancelled";
      runId: string;
      reason: "parent_cancelled" | "child_cancelled" | "runtime_disposed";
    }
  | {
      status: "failed";
      runId: string | null;
      error: GoalAuditError;
    };

export interface GoalAuditHandle {
  runId: string | null;
  result: Promise<GoalAuditResult>;
  cancel(): boolean;
}

export interface GoalAuditCoordinatorOptions<
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  executor: ChildTurnExecutor<GoalAuditChildInput, unknown, TProgress>;
  verdictPort: GoalAuditVerdictPort;
  journal?: GoalAuditJournal<TProgress>;
  idFactory?: () => string;
  clock?: SubagentRuntimeClock;
  onJournalError?: (
    error: unknown,
    descriptor?: GoalAuditRunDescriptor,
  ) => void | Promise<void>;
}
