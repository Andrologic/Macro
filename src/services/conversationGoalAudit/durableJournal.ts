import type { AgentRun, ClaimConversationGoalAuditInput, RecordGoalAuditTransitionInput, ResumeConversationGoalAuditInput } from "../../types/generated/ipc";
import { linkGoalAuditChildConversation, recordGoalAuditTransition } from "../tauriIpc";
import type { SubagentProgressEvent, SubagentTransition } from "../subagentRuntime";
import type { GoalAuditJournal, GoalAuditRunDescriptor } from "./journal";

export interface GoalAuditJournalPorts {
  recordTransition(input: RecordGoalAuditTransitionInput): Promise<AgentRun>;
  linkChildConversation(runId: string, parentConversationId: string, childConversationId: string): Promise<AgentRun>;
}

const tauriPorts: GoalAuditJournalPorts = {
  recordTransition: recordGoalAuditTransition,
  linkChildConversation: linkGoalAuditChildConversation,
};

const wireJson = (value: unknown): RecordGoalAuditTransitionInput["transition"]["snapshot"] => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Goal audit transition is not serializable.");
  return JSON.parse(serialized);
};

interface PendingTransition {
  payload: string;
  promise: Promise<void>;
}

export class DurableGoalAuditJournal<TProgress extends SubagentProgressEvent = SubagentProgressEvent>
  implements GoalAuditJournal<TProgress> {
  readonly #ports: GoalAuditJournalPorts;
  readonly #descriptors = new Map<string, GoalAuditRunDescriptor>();
  readonly #transitions = new Map<string, Map<number, PendingTransition>>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #goalClaim?: Omit<ClaimConversationGoalAuditInput, "runId">;
  readonly #goalResume?: Omit<ResumeConversationGoalAuditInput, "newRunId">;

  constructor(
    ports: GoalAuditJournalPorts = tauriPorts,
    goalClaim?: Omit<ClaimConversationGoalAuditInput, "runId">,
    goalResume?: Omit<ResumeConversationGoalAuditInput, "newRunId">,
  ) {
    if (goalClaim && goalResume) throw new Error("Goal audit cannot claim and resume in the same run.");
    this.#ports = ports;
    this.#goalClaim = goalClaim;
    this.#goalResume = goalResume;
  }

  registerRun(descriptor: GoalAuditRunDescriptor): void {
    if (this.#descriptors.has(descriptor.runId)) {
      throw new Error(`Goal audit run is already registered: ${descriptor.runId}`);
    }
    this.#descriptors.set(descriptor.runId, { ...descriptor });
    this.#transitions.set(descriptor.runId, new Map());
  }

  releaseRun(runId: string): void {
    this.#descriptors.delete(runId);
    this.#transitions.delete(runId);
    this.#tails.delete(runId);
  }

  claimRun(transition: SubagentTransition<unknown, TProgress> & {
    sequence: 0; previousState: null; state: "queued";
  }): Promise<void> {
    return this.recordTransition(transition);
  }

  recordTransition(transition: SubagentTransition<unknown, TProgress>): Promise<void> {
    const descriptor = this.#descriptors.get(transition.runId);
    const recorded = this.#transitions.get(transition.runId);
    if (!descriptor || !recorded || descriptor.parentConversationId !== transition.parentConversationId) {
      throw new Error(`Goal audit run is not registered for this parent: ${transition.runId}`);
    }
    const metrics = transition.result?.metrics ?? transition.snapshot.metrics;
    const input: RecordGoalAuditTransitionInput = {
      ...(transition.sequence === 0 && this.#goalClaim ? {
        auditClaim: { ...this.#goalClaim, runId: transition.runId },
      } : {}),
      ...(transition.sequence === 0 && this.#goalResume ? {
        auditResume: { ...this.#goalResume, newRunId: transition.runId },
      } : {}),
      descriptor: transition.sequence === 0 ? {
        id: descriptor.runId,
        parent_conversation_id: descriptor.parentConversationId,
        child_conversation_id: null,
        agent_profile: descriptor.profile,
        depth: descriptor.depth,
        prompt: descriptor.prompt,
        model_metadata_json: descriptor.model || descriptor.effort
          ? JSON.stringify({ model: descriptor.model, effort: descriptor.effort }) : null,
      } : null,
      transition: {
        runId: transition.runId,
        parentConversationId: transition.parentConversationId,
        sequence: transition.sequence,
        previousState: transition.previousState,
        state: transition.state,
        occurredAt: transition.occurredAt,
        snapshot: wireJson(transition.snapshot),
        result: transition.result ? wireJson(transition.result) : null,
      },
      usage: {
        input_tokens: metrics?.inputTokens ?? null,
        output_tokens: metrics?.outputTokens ?? null,
        cached_input_tokens: null,
        reasoning_tokens: null,
        total_tokens: metrics?.totalTokens ?? null,
        usage_json: metrics ? JSON.stringify(metrics) : null,
      },
    };
    const payload = JSON.stringify(input);
    const replay = recorded.get(transition.sequence);
    if (replay) {
      if (replay.payload !== payload) {
        throw new Error(`Conflicting goal audit transition replay: ${transition.runId}/${transition.sequence}`);
      }
      return replay.promise;
    }
    let expectedSequence = 0;
    while (recorded.has(expectedSequence)) expectedSequence += 1;
    if (transition.sequence !== expectedSequence) {
      throw new Error(`Expected goal audit transition ${expectedSequence}, received ${transition.sequence}`);
    }
    const previous = this.#tails.get(transition.runId) ?? Promise.resolve();
    const promise = previous.then(() => this.#ports.recordTransition(input)).then(() => undefined);
    recorded.set(transition.sequence, { payload, promise });
    this.#tails.set(transition.runId, promise.catch(() => undefined));
    void promise.catch(() => {
      if (recorded.get(transition.sequence)?.promise === promise) {
        recorded.delete(transition.sequence);
      }
    });
    return promise;
  }

  async linkChildConversation(runId: string, parentConversationId: string, childConversationId: string): Promise<void> {
    const descriptor = this.#descriptors.get(runId);
    if (!descriptor || descriptor.parentConversationId !== parentConversationId) {
      throw new Error(`Goal audit run is not registered for this parent: ${runId}`);
    }
    await (this.#tails.get(runId) ?? Promise.reject(new Error(`Goal audit run has not started: ${runId}`)));
    await this.#ports.linkChildConversation(runId, parentConversationId, childConversationId);
  }
}
