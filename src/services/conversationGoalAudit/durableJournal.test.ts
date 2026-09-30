import { describe, expect, it } from "bun:test";
import type { AgentRun, RecordGoalAuditTransitionInput } from "../../types/generated/ipc";
import type { SubagentTransition } from "../subagentRuntime";
import { DurableGoalAuditJournal, type GoalAuditJournalPorts } from "./durableJournal";

const transition = (sequence: number, state: "queued" | "running" | "completed"): SubagentTransition => ({
  runId: "run-1", parentConversationId: "parent-1", sequence,
  previousState: sequence === 0 ? null : sequence === 1 ? "queued" : "running",
  state, occurredAt: 1_700_000_000_000 + sequence,
  snapshot: {
    runId: "run-1", parentConversationId: "parent-1", depth: 1, state,
    queuedAt: 1_700_000_000_000,
  },
  ...(state === "completed" ? {
    result: {
      status: "completed" as const, runId: "run-1", parentConversationId: "parent-1",
      queuedAt: 1_700_000_000_000, endedAt: 1_700_000_000_002,
      output: { text: "Done" }, metrics: { inputTokens: 2, outputTokens: 3 },
    },
  } : {}),
});

describe("DurableGoalAuditJournal", () => {
  it("carries an explicit resume in the queued IPC payload only", async () => {
    const inputs: RecordGoalAuditTransitionInput[] = [];
    const journal = new DurableGoalAuditJournal({
      async recordTransition(input) { inputs.push(input); return {} as AgentRun; },
      async linkChildConversation() { return {} as AgentRun; },
    }, undefined, { auditId: "audit-1", expectedRunId: "old-run" });
    journal.registerRun({ runId: "run-1", parentConversationId: "parent-1", profile: "goal_auditor", depth: 1, prompt: "Audit" });
    await journal.recordTransition(transition(0, "queued"));
    await journal.recordTransition(transition(1, "running"));
    expect(inputs[0]?.auditResume).toEqual({ auditId: "audit-1", expectedRunId: "old-run", newRunId: "run-1" });
    expect(inputs[1]?.auditResume).toBeUndefined();
  });

  it("retries a rejected sequence instead of inheriting a rejected tail", async () => {
    let attempts = 0;
    const journal = new DurableGoalAuditJournal({
      async recordTransition() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary IPC failure");
        return {} as AgentRun;
      },
      async linkChildConversation() { return {} as AgentRun; },
    });
    journal.registerRun({ runId: "run-1", parentConversationId: "parent-1", profile: "goal_auditor", depth: 1, prompt: "Audit" });
    await expect(journal.recordTransition(transition(0, "queued"))).rejects.toThrow("temporary IPC failure");
    await journal.recordTransition(transition(0, "queued"));
    await journal.recordTransition(transition(1, "running"));
    expect(attempts).toBe(3);
  });

  it("serializes transitions, replays the same identity, and links the child after running", async () => {
    const calls: string[] = [];
    const inputs: RecordGoalAuditTransitionInput[] = [];
    let releaseQueued!: () => void;
    const queuedGate = new Promise<void>((resolve) => { releaseQueued = resolve; });
    const ports: GoalAuditJournalPorts = {
      async recordTransition(input) {
        calls.push(`transition:${input.transition.sequence}`);
        inputs.push(input);
        if (input.transition.sequence === 0) await queuedGate;
        return {} as AgentRun;
      },
      async linkChildConversation(runId, parentId, childId) {
        calls.push(`link:${runId}:${parentId}:${childId}`);
        return {} as AgentRun;
      },
    };
    const journal = new DurableGoalAuditJournal(ports);
    journal.registerRun({
      runId: "run-1", parentConversationId: "parent-1", profile: "goal_auditor",
      depth: 1, prompt: "Audit", model: "test-model",
    });
    const queued = journal.recordTransition(transition(0, "queued"));
    expect(journal.recordTransition(transition(0, "queued"))).toBe(queued);
    const running = journal.recordTransition(transition(1, "running"));
    const linked = journal.linkChildConversation("run-1", "parent-1", "child-1");
    await Promise.resolve();
    expect(calls).toEqual(["transition:0"]);
    releaseQueued();
    await Promise.all([queued, running, linked]);
    expect(calls).toEqual(["transition:0", "transition:1", "link:run-1:parent-1:child-1"]);
    await journal.recordTransition(transition(2, "completed"));
    expect(inputs[0]?.descriptor?.agent_profile).toBe("goal_auditor");
    expect(inputs[2]?.usage.input_tokens).toBe(2);
    expect(inputs[2]?.usage.output_tokens).toBe(3);
    expect(() => journal.recordTransition({ ...transition(2, "completed"), occurredAt: 9 }))
      .toThrow("Conflicting goal audit transition replay");
    expect(() => journal.recordTransition(transition(4, "completed")))
      .toThrow("Expected goal audit transition 3");
    journal.releaseRun("run-1");
    expect(() => journal.recordTransition(transition(2, "completed")))
      .toThrow("Goal audit run is not registered");
    expect(() => journal.registerRun({
      runId: "run-1", parentConversationId: "parent-1", profile: "goal_auditor",
      depth: 1, prompt: "Audit",
    })).not.toThrow();
  });
});
