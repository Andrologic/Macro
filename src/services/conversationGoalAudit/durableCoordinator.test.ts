import { describe, expect, it } from "bun:test";
import type { AgentRun } from "../../types/generated/ipc";
import { createDurableGoalAuditCoordinator } from "./durableCoordinator";

describe("durable goal audit composition", () => {
  it("links a real child conversation after the running transition and before provider streaming", async () => {
    const events: string[] = [];
    const coordinator = createDurableGoalAuditCoordinator({
      idFactory: () => "audit-run",
      verdictPort: { applyVerdict: () => "applied" },
      journalPorts: {
        async recordTransition(input) {
          events.push(`transition:${input.transition.state}`);
          return {} as AgentRun;
        },
        async linkChildConversation(runId, parentId, childId) {
          events.push(`link:${runId}:${parentId}:${childId}`);
          return {} as AgentRun;
        },
      },
      providerPorts: {
        resolveProvider: () => ({
          providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model",
        }),
        resolveChildConversation: ({ runId, parentConversationId }) => ({
          id: "real-child-conversation", runId, parentConversationId,
        }),
        executeReadTool: async () => "unused",
        stream: async (options) => {
          events.push(`stream:${options.conversationId}`);
          options.onComplete({
            visibleContent: JSON.stringify({
              verdict: "achieved", summary: "Criterion met", criteria: [{
                criterion: "The audit is read-only", status: "met",
                evidence: [{ source: "source", finding: "read-only tools" }],
              }], feedback: "", questionForUser: null, confidence: 0.9,
            }),
            toolTraces: [],
          });
        },
      },
    });
    const scope = { capabilities: ["workspace.read", "git.read", "delegate"] as const };
    const result = await coordinator.audit({
      conversationId: "parent", goalId: "goal", goalRevision: 1,
      objective: "Audit the goal", successCriteria: ["The audit is read-only"],
      lastExecutorTurn: { turnId: "turn", summary: "Implementation done" },
      userPolicy: scope, parentPolicy: scope,
    });
    expect(result.status).toBe("applied");
    expect(events.slice(0, 4)).toEqual([
      "transition:queued", "transition:running",
      "link:audit-run:parent:real-child-conversation", "stream:real-child-conversation",
    ]);
    expect(() => coordinator.journal.registerRun({
      runId: "audit-run", parentConversationId: "parent",
      profile: "goal_auditor", depth: 1, prompt: "New audit",
    })).not.toThrow();
  });
});
