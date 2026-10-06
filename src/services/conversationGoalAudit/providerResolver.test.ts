import { expect, mock, test } from "bun:test";
import { createGoalAuditProviderResolver, type GoalAuditProviderSnapshot } from "./providerResolver";
import { createGoalAuditProviderExecutor } from "./providerExecutor";
import type { GoalAuditChildInput } from "./types";

const input: GoalAuditChildInput = {
  profile: "goal_auditor", systemPrompt: "Inspect evidence.",
  authorization: { agentId: "goal_auditor", serializedContext: "Synthetic evidence", childDepth: 1, activeDelegationsForParent: 0,
    policy: { capabilities: ["workspace.read", "git.read"], limits: { maxChildDepth: 1, maxConcurrencyPerParent: 1, maxContextBytes: 4096, maxTurns: 3 } } },
};

test("Goal executor keeps its slot until the real resolver key IPC ends after Stop", async () => {
  let finish!: (value: string | undefined) => void;
  const key = new Promise<string | undefined>(resolve => { finish = resolve; });
  const snapshot: GoalAuditProviderSnapshot = {
    config: { id: "provider", name: "Synthetic", providerType: "openai", baseUrl: "https://example.invalid", hasStoredApiKey: true, isEnabled: true, isLocal: false },
    model: { id: "model", name: "Synthetic", provider_id: "provider" },
    hasCredentials: true, availableReasoningEfforts: [], transportUnavailable: false, requiresApiKey: true,
  };
  const resolveApiKey = mock(() => key);
  const stream = mock(async () => {});
  const resolveChildConversation = mock(() => { throw new Error("Cancelled resolution must not admit a child"); });
  const executor = createGoalAuditProviderExecutor({
    resolveProvider: createGoalAuditProviderResolver({ providerId: "provider", modelId: "model" }, { readSnapshot: () => snapshot, resolveApiKey }),
    resolveChildConversation, executeReadTool: async () => "unused", stream,
  });
  const controller = new AbortController();
  const pending = executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input, signal: controller.signal });
  let ended = false;
  void pending.then(() => { ended = true; }, () => { ended = true; });
  expect(resolveApiKey).toHaveBeenCalledTimes(1);
  controller.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(ended).toBe(false);
  finish("synthetic-key");
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(resolveChildConversation).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
});
