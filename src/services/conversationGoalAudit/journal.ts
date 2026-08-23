import type { ReasoningEffort } from "../../types";
import type {
  SubagentProgressEvent,
  SubagentTransition,
  SubagentTransitionRecorder,
} from "../subagentRuntime";

export interface GoalAuditRunDescriptor {
  runId: string;
  parentConversationId: string;
  profile: "goal_auditor";
  depth: 1;
  prompt: string;
  model?: string;
  effort?: ReasoningEffort;
}
export interface GoalAuditJournal<
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> extends SubagentTransitionRecorder<unknown, TProgress> {
  registerRun(descriptor: GoalAuditRunDescriptor): void;
}

export interface InMemoryGoalAuditRun<
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> {
  descriptor: GoalAuditRunDescriptor;
  transitions: Array<SubagentTransition<unknown, TProgress>>;
}

export class InMemoryGoalAuditJournal<
  TProgress extends SubagentProgressEvent = SubagentProgressEvent,
> implements GoalAuditJournal<TProgress> {
  readonly #runs = new Map<string, InMemoryGoalAuditRun<TProgress>>();

  registerRun(descriptor: GoalAuditRunDescriptor): void {
    if (this.#runs.has(descriptor.runId)) {
      throw new Error(`Goal audit run is already registered: ${descriptor.runId}`);
    }
    this.#runs.set(descriptor.runId, {
      descriptor: { ...descriptor },
      transitions: [],
    });
  }

  recordTransition(transition: SubagentTransition<unknown, TProgress>): void {
    const run = this.#runs.get(transition.runId);
    if (!run) {
      throw new Error(`Goal audit run is not registered: ${transition.runId}`);
    }
    const expectedSequence = run.transitions.length;
    if (transition.sequence !== expectedSequence) {
      throw new Error(
        `Expected transition ${expectedSequence} for ${transition.runId}, received ${transition.sequence}`,
      );
    }
    run.transitions.push(transition);
  }

  getRun(runId: string): InMemoryGoalAuditRun<TProgress> | undefined {
    const run = this.#runs.get(runId);
    if (!run) return undefined;
    return {
      descriptor: { ...run.descriptor },
      transitions: [...run.transitions],
    };
  }

  listRuns(): Array<InMemoryGoalAuditRun<TProgress>> {
    return [...this.#runs.keys()]
      .map((runId) => this.getRun(runId))
      .filter((run): run is InMemoryGoalAuditRun<TProgress> => Boolean(run));
  }
}
