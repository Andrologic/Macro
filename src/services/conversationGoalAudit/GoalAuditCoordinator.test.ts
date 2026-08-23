import { describe, expect, it } from "bun:test";
import type { ConversationGoalVerdict } from "../../types";
import type {
  AgentCapability,
  DelegationPolicyScope,
} from "../subagentPolicy";
import type {
  ChildTurnExecutionOutput,
  ChildTurnExecutionRequest,
  ChildTurnExecutor,
  SubagentRuntimeClock,
} from "../subagentRuntime";
import { GoalAuditCoordinator } from "./GoalAuditCoordinator";
import {
  InMemoryGoalAuditJournal,
  type GoalAuditRunDescriptor,
} from "./journal";
import type {
  GoalAuditChildInput,
  GoalAuditRequest,
  GoalAuditVerdictApplyResult,
  GoalAuditVerdictPort,
} from "./types";

const AUTHORITY_CAPABILITIES: AgentCapability[] = [
  "workspace.read",
  "git.read",
  "delegate",
];

const scope = (
  capabilities: readonly AgentCapability[] = AUTHORITY_CAPABILITIES,
): DelegationPolicyScope => ({ capabilities });

const request = (overrides: Partial<GoalAuditRequest> = {}): GoalAuditRequest => ({
  conversationId: "conversation-1",
  goalId: "goal-1",
  goalRevision: 4,
  objective: "Ship the goal auditor",
  successCriteria: ["The audit is read-only"],
  lastExecutorTurn: {
    turnId: "turn-9",
    summary: "Implemented the coordinator and ran focused tests.",
  },
  evidence: [
    {
      source: "src/services/conversationGoalAudit/GoalAuditCoordinator.ts",
      finding: "The coordinator delegates through the read-only profile.",
    },
  ],
  userPolicy: scope(),
  parentPolicy: scope(),
  ...overrides,
});
const verdict: ConversationGoalVerdict = {
  verdict: "achieved",
  summary: "The read-only policy is present and enforced.",
  criteria: [
    {
      criterion: "The audit is read-only",
      status: "met",
      evidence: [
        {
          source: "src/services/conversationGoalAudit/GoalAuditCoordinator.ts",
          finding: "The authorization contains workspace.read and git.read only.",
        },
      ],
    },
  ],
  feedback: "",
  questionForUser: null,
  confidence: 0.94,
};

interface PendingChild {
  request: ChildTurnExecutionRequest<GoalAuditChildInput>;
  resolve: (output: ChildTurnExecutionOutput<unknown>) => void;
  reject: (error: unknown) => void;
}

class ControlledGoalAuditExecutor
  implements ChildTurnExecutor<GoalAuditChildInput, unknown> {
  readonly pending = new Map<string, PendingChild>();
  readonly requests: Array<ChildTurnExecutionRequest<GoalAuditChildInput>> = [];
  readonly #requestWaiters: Array<{ count: number; resolve: () => void }> = [];

  execute(
    childRequest: ChildTurnExecutionRequest<GoalAuditChildInput>,
  ): Promise<ChildTurnExecutionOutput<unknown>> {
    this.requests.push(childRequest);
    for (const waiter of [...this.#requestWaiters]) {
      if (this.requests.length < waiter.count) continue;
      this.#requestWaiters.splice(this.#requestWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        childRequest.signal.removeEventListener("abort", onAbort);
        this.pending.delete(childRequest.childRunId);
        callback();
      };
      const onAbort = () => finish(() => reject(new Error("audit aborted")));
      childRequest.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(childRequest.childRunId, {
        request: childRequest,
        resolve: (output) => finish(() => resolve(output)),
        reject: (error) => finish(() => reject(error)),
      });
    });
  }

  waitForRequestCount(count: number): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#requestWaiters.push({ count, resolve });
    });
  }

  complete(runId: string, output: ChildTurnExecutionOutput<unknown>): void {
    const child = this.pending.get(runId);
    if (!child) throw new Error(`Missing audit child ${runId}`);
    child.resolve(output);
  }
}

class RecordingVerdictPort implements GoalAuditVerdictPort {
  readonly applications: Parameters<GoalAuditVerdictPort["applyVerdict"]>[0][] = [];
  outcome: GoalAuditVerdictApplyResult = "applied";

  applyVerdict(
    input: Parameters<GoalAuditVerdictPort["applyVerdict"]>[0],
  ): GoalAuditVerdictApplyResult | Promise<GoalAuditVerdictApplyResult> {
    this.applications.push(input);
    return this.outcome;
  }
}

class DelayedVerdictPort extends RecordingVerdictPort {
  readonly started: Promise<void>;
  #resolveStarted!: () => void;
  #resolveApplication!: (outcome: GoalAuditVerdictApplyResult) => void;
  #rejectApplication!: (error: unknown) => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  applyVerdict(
    input: Parameters<GoalAuditVerdictPort["applyVerdict"]>[0],
  ): Promise<GoalAuditVerdictApplyResult> {
    this.applications.push(input);
    this.#resolveStarted();
    return new Promise((resolve, reject) => {
      this.#resolveApplication = resolve;
      this.#rejectApplication = reject;
    });
  }

  resolve(outcome: GoalAuditVerdictApplyResult): void {
    this.#resolveApplication(outcome);
  }

  reject(error: unknown): void {
    this.#rejectApplication(error);
  }
}

class DelayedRegistrationJournal extends InMemoryGoalAuditJournal {
  #resolveRegistration!: () => void;
  #rejectRegistration!: (error: unknown) => void;

  override registerRun(descriptor: GoalAuditRunDescriptor): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#resolveRegistration = () => {
        try {
          super.registerRun(descriptor);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      this.#rejectRegistration = reject;
    });
  }

  resolveRegistration(): void {
    this.#resolveRegistration();
  }

  rejectRegistration(error: unknown): void {
    this.#rejectRegistration(error);
  }
}

class FakeClock implements SubagentRuntimeClock {
  #now = 1_000;
  #sequence = 0;
  readonly timers = new Map<number, { deadline: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    this.#sequence += 1;
    this.timers.set(this.#sequence, { deadline: this.#now + delayMs, callback });
    return this.#sequence;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(durationMs: number): void {
    this.#now += durationMs;
    for (const [id, timer] of [...this.timers.entries()]) {
      if (timer.deadline > this.#now || !this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

const makeCoordinator = (options?: {
  clock?: FakeClock;
  verdictPort?: RecordingVerdictPort;
}) => {
  const executor = new ControlledGoalAuditExecutor();
  const verdictPort = options?.verdictPort ?? new RecordingVerdictPort();
  const journal = new InMemoryGoalAuditJournal();
  let sequence = 0;
  const coordinator = new GoalAuditCoordinator({
    executor,
    verdictPort,
    journal,
    clock: options?.clock,
    idFactory: () => `audit-${++sequence}`,
  });
  return { coordinator, executor, journal, verdictPort };
};

describe("GoalAuditCoordinator", () => {
  it("runs a depth-one read-only goal auditor and atomically applies a valid verdict", async () => {
    const { coordinator, executor, journal, verdictPort } = makeCoordinator();
    const handle = coordinator.startAudit(request());
    await executor.waitForRequestCount(1);
    const childRequest = executor.requests[0];

    expect(handle.runId).toBe("audit-1");
    expect(childRequest?.depth).toBe(1);
    expect(childRequest?.input.profile).toBe("goal_auditor");
    expect(childRequest?.input.authorization.policy.capabilities).toEqual([
      "workspace.read",
      "git.read",
    ]);
    expect(childRequest?.input.authorization.policy.capabilities).not.toContain(
      "workspace.write",
    );
    expect(JSON.parse(childRequest?.input.authorization.serializedContext ?? "{}")).toMatchObject({
      objective: "Ship the goal auditor",
      successCriteria: ["The audit is read-only"],
      establishedFacts: [
        "Last executor turn turn-9: Implemented the coordinator and ran focused tests.",
        "Explicit evidence from src/services/conversationGoalAudit/GoalAuditCoordinator.ts: The coordinator delegates through the read-only profile.",
      ],
    });

    executor.complete("audit-1", { text: JSON.stringify(verdict) });
    expect(await handle.result).toEqual({
      status: "applied",
      runId: "audit-1",
      verdict,
    });
    expect(verdictPort.applications).toHaveLength(1);
    expect(verdictPort.applications[0]).toMatchObject({
      conversationId: "conversation-1",
      goalId: "goal-1",
      expectedRevision: 4,
      verdict,
      runId: "audit-1",
    });
    expect(verdictPort.applications[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(journal.getRun("audit-1")?.transitions.map(({ state }) => state)).toEqual([
      "queued",
      "running",
      "completed",
    ]);
  });

  it("rejects invalid JSON without applying any partial verdict", async () => {
    const { coordinator, executor, verdictPort } = makeCoordinator();
    const handle = coordinator.startAudit(request());
    await executor.waitForRequestCount(1);

    executor.complete("audit-1", { text: '{"verdict":"achieved"' });

    expect(await handle.result).toMatchObject({
      status: "failed",
      runId: "audit-1",
      error: { code: "INVALID_AUDITOR_VERDICT" },
    });
    expect(verdictPort.applications).toEqual([]);
  });

  it("times out the child and never applies a verdict", async () => {
    const clock = new FakeClock();
    const { coordinator, verdictPort } = makeCoordinator({ clock });
    const handle = coordinator.startAudit(request({ timeoutMs: 50 }));

    clock.advanceBy(50);

    expect(await handle.result).toEqual({
      status: "timed_out",
      runId: "audit-1",
      timeoutMs: 50,
    });
    expect(verdictPort.applications).toEqual([]);
  });

  it("cancels an active audit cooperatively", async () => {
    const { coordinator, verdictPort } = makeCoordinator();
    const handle = coordinator.startAudit(request());

    expect(handle.cancel()).toBe(true);
    expect(await handle.result).toEqual({
      status: "cancelled",
      runId: "audit-1",
      reason: "child_cancelled",
    });
    expect(verdictPort.applications).toEqual([]);
  });

  it("cancels during verdict application and aborts the port signal", async () => {
    const verdictPort = new DelayedVerdictPort();
    const { coordinator, executor } = makeCoordinator({ verdictPort });
    const handle = coordinator.startAudit(request());

    await executor.waitForRequestCount(1);
    executor.complete("audit-1", { structured: verdict });
    await verdictPort.started;

    expect(coordinator.isAuditActive("conversation-1")).toBe(true);
    expect(handle.cancel()).toBe(true);
    expect(verdictPort.applications[0]?.signal.aborted).toBe(true);
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(coordinator.isAuditActive("conversation-1")).toBe(true);

    verdictPort.resolve("applied");
    expect(await handle.result).toEqual({
      status: "applied",
      runId: "audit-1",
      verdict,
    });
  });

  it("keeps cancelAudit active during verdict application", async () => {
    const verdictPort = new DelayedVerdictPort();
    const { coordinator, executor } = makeCoordinator({ verdictPort });
    const handle = coordinator.startAudit(request());

    await executor.waitForRequestCount(1);
    executor.complete("audit-1", { structured: verdict });
    await verdictPort.started;

    expect(coordinator.cancelAudit("conversation-1")).toBe(true);
    expect(coordinator.isAuditActive("conversation-1")).toBe(true);
    verdictPort.resolve("stale");
    expect(await handle.result).toEqual({
      status: "stale",
      runId: "audit-1",
      reason: "revision_changed",
      verdict,
    });
  });

  it("uses the original audit deadline while applying the verdict", async () => {
    const clock = new FakeClock();
    const verdictPort = new DelayedVerdictPort();
    const { coordinator, executor } = makeCoordinator({ clock, verdictPort });
    const handle = coordinator.startAudit(request({ timeoutMs: 50 }));

    await executor.waitForRequestCount(1);
    clock.advanceBy(40);
    executor.complete("audit-1", { structured: verdict });
    await verdictPort.started;
    clock.advanceBy(10);

    expect(verdictPort.applications[0]?.signal.aborted).toBe(true);
    expect(coordinator.isAuditActive("conversation-1")).toBe(true);
    verdictPort.reject(new Error("deadline exceeded"));
    expect(await handle.result).toEqual({
      status: "timed_out",
      runId: "audit-1",
      timeoutMs: 50,
    });

  });

  it("fails when the verdict port returns an invalid result", async () => {
    const verdictPort = new RecordingVerdictPort();
    verdictPort.outcome = "invalid" as GoalAuditVerdictApplyResult;
    const { coordinator, executor } = makeCoordinator({ verdictPort });
    const handle = coordinator.startAudit(request());

    await executor.waitForRequestCount(1);
    executor.complete("audit-1", { structured: verdict });

    expect(await handle.result).toMatchObject({
      status: "failed",
      runId: "audit-1",
      error: { code: "VERDICT_APPLICATION_FAILED" },
    });
  });

  it("does not execute an audit when durable run registration fails", async () => {
    class RejectingJournal extends InMemoryGoalAuditJournal {
      override async registerRun(): Promise<void> {
        throw new Error("journal unavailable");
      }
    }

    const executor = new ControlledGoalAuditExecutor();
    const verdictPort = new RecordingVerdictPort();
    const coordinator = new GoalAuditCoordinator({
      executor,
      verdictPort,
      journal: new RejectingJournal(),
      idFactory: () => "audit-1",
    });
    const handle = coordinator.startAudit(request());

    expect(await handle.result).toMatchObject({
      status: "failed",
      runId: "audit-1",
      error: { code: "JOURNAL_REGISTRATION_FAILED" },
    });
    expect(executor.requests).toEqual([]);
    expect(verdictPort.applications).toEqual([]);
  });

  it("waits for registration after timeout and persists a terminal transition", async () => {
    const clock = new FakeClock();
    const journal = new DelayedRegistrationJournal();
    const executor = new ControlledGoalAuditExecutor();
    const verdictPort = new RecordingVerdictPort();
    const coordinator = new GoalAuditCoordinator({
      executor,
      verdictPort,
      journal,
      clock,
      idFactory: () => "audit-1",
    });
    const handle = coordinator.startAudit(request({ timeoutMs: 50 }));

    clock.advanceBy(50);
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(coordinator.isAuditActive("conversation-1")).toBe(true);
    expect(executor.requests).toEqual([]);

    journal.resolveRegistration();

    expect(await handle.result).toEqual({
      status: "timed_out",
      runId: "audit-1",
      timeoutMs: 50,
    });
    expect(executor.requests).toEqual([]);
    expect(journal.getRun("audit-1")?.transitions.map(({ state }) => state)).toEqual([
      "queued",
      "running",
      "timed_out",
    ]);
    expect(journal.getRun("audit-1")?.transitions.at(-1)?.result).toMatchObject({
      status: "timed_out",
      timeoutMs: 50,
    });
  });

  it("keeps registration failure authoritative after cancellation", async () => {
    const journal = new DelayedRegistrationJournal();
    const executor = new ControlledGoalAuditExecutor();
    const verdictPort = new RecordingVerdictPort();
    const coordinator = new GoalAuditCoordinator({
      executor,
      verdictPort,
      journal,
      idFactory: () => "audit-1",
    });
    const handle = coordinator.startAudit(request());

    expect(handle.cancel()).toBe(true);
    expect(coordinator.isAuditActive("conversation-1")).toBe(true);
    journal.rejectRegistration(new Error("journal unavailable"));

    expect(await handle.result).toMatchObject({
      status: "failed",
      runId: "audit-1",
      error: { code: "JOURNAL_REGISTRATION_FAILED" },
    });
    expect(executor.requests).toEqual([]);
  });

  it("waits for late registration before disposing the runtime", async () => {
    const journal = new DelayedRegistrationJournal();
    const executor = new ControlledGoalAuditExecutor();
    const verdictPort = new RecordingVerdictPort();
    const coordinator = new GoalAuditCoordinator({
      executor,
      verdictPort,
      journal,
      idFactory: () => "audit-1",
    });
    const handle = coordinator.startAudit(request());

    const disposal = coordinator.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();

    expect(disposed).toBe(false);
    expect(coordinator.isAuditActive("conversation-1")).toBe(true);
    journal.resolveRegistration();

    expect(await handle.result).toEqual({
      status: "cancelled",
      runId: "audit-1",
      reason: "runtime_disposed",
    });
    await disposal;
    expect(executor.requests).toEqual([]);
    expect(journal.getRun("audit-1")?.transitions.map(({ state }) => state)).toEqual([
      "queued",
      "cancelled",
    ]);
  });

  it("waits for verdict application during disposal and keeps applied authoritative", async () => {
    const verdictPort = new DelayedVerdictPort();
    const { coordinator, executor } = makeCoordinator({ verdictPort });
    const handle = coordinator.startAudit(request());

    await executor.waitForRequestCount(1);
    executor.complete("audit-1", { structured: verdict });
    await verdictPort.started;

    const disposal = coordinator.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();

    expect(disposed).toBe(false);
    expect(verdictPort.applications[0]?.signal.aborted).toBe(true);
    expect(coordinator.isAuditActive("conversation-1")).toBe(true);
    verdictPort.resolve("applied");

    expect(await handle.result).toEqual({
      status: "applied",
      runId: "audit-1",
      verdict,
    });
    await disposal;
  });

  it("rejects new audits as soon as disposal starts", async () => {
    const executor = new ControlledGoalAuditExecutor();
    const verdictPort = new RecordingVerdictPort();
    const journal = new InMemoryGoalAuditJournal();
    const coordinator = new GoalAuditCoordinator({
      executor,
      verdictPort,
      journal,
      idFactory: () => "audit-1",
    });

    const disposal = coordinator.dispose();
    const rejected = coordinator.startAudit(request());

    expect(await rejected.result).toMatchObject({
      status: "failed",
      runId: null,
      error: { code: "COORDINATOR_DISPOSED" },
    });
    await disposal;
    expect(journal.listRuns()).toEqual([]);
    expect(executor.requests).toEqual([]);
  });

  it("returns a stale result when the goal revision changed before application", async () => {
    const verdictPort = new RecordingVerdictPort();
    verdictPort.outcome = "stale";
    const { coordinator, executor } = makeCoordinator({ verdictPort });
    const handle = coordinator.startAudit(request());

    await executor.waitForRequestCount(1);
    executor.complete("audit-1", { structured: verdict });

    expect(await handle.result).toEqual({
      status: "stale",
      runId: "audit-1",
      reason: "revision_changed",
      verdict,
    });
  });

  it("rejects a second audit for one conversation while allowing another conversation", async () => {
    const { coordinator, executor } = makeCoordinator();
    const first = coordinator.startAudit(request());
    const duplicate = coordinator.startAudit(request());
    const independent = coordinator.startAudit(
      request({ conversationId: "conversation-2", goalId: "goal-2" }),
    );

    expect(await duplicate.result).toMatchObject({
      status: "failed",
      runId: null,
      error: { code: "AUDIT_ALREADY_ACTIVE" },
    });
    await executor.waitForRequestCount(2);
    expect(executor.requests).toHaveLength(2);

    executor.complete("audit-1", { text: JSON.stringify(verdict) });
    executor.complete("audit-2", { text: JSON.stringify(verdict) });
    expect((await first.result).status).toBe("applied");
    expect((await independent.result).status).toBe("applied");
  });

  it("fails preflight when the parent has no delegation authority", async () => {
    const { coordinator, executor } = makeCoordinator();
    const handle = coordinator.startAudit(
      request({ parentPolicy: scope(["workspace.read", "git.read"]) }),
    );

    expect(await handle.result).toMatchObject({
      status: "failed",
      runId: null,
      error: { code: "DELEGATION_PREFLIGHT_REJECTED" },
    });
    expect(executor.requests).toEqual([]);
  });
});
