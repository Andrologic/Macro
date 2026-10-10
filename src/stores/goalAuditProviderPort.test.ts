import { afterEach, describe, expect, it, mock } from "bun:test";
import { useProviderStore } from "./useProviderStore";
import type { AIModel, ProviderConfig } from "../types";
import type { GoalAuditChildInput } from "../services/conversationGoalAudit/types";
import { createStoreGoalAuditProviderResolver } from "./goalAuditProviderPort";

const original = useProviderStore.getState();
afterEach(() => useProviderStore.setState(original, true));

const config = (id: string): ProviderConfig => ({
  id, name: id, providerType: "openai", baseUrl: `https://${id}.invalid/v1`,
  apiKey: `${id}-key`, apiKeyLoaded: true, hasStoredApiKey: true,
  isEnabled: true, isLocal: false,
});
const model = (providerId: string): AIModel => ({
  id: "model", name: "Model", provider_id: providerId, isEnabled: true,
  reasoningCapability: {
    reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low",
    transportMode: "openai_effort", configurable: true, source: "provider_metadata",
  },
});
const input = (modelId?: string, effort?: string): GoalAuditChildInput => ({
  profile: "goal_auditor", systemPrompt: "Audit",
  authorization: {
    agentId: "goal_auditor", childDepth: 1, activeDelegationsForParent: 0,
    serializedContext: "Context", model: modelId, effort,
    policy: {
      capabilities: ["workspace.read", "git.read"],
      limits: { maxChildDepth: 1, maxConcurrencyPerParent: 1, maxContextBytes: 4096, maxTurns: 3 },
    },
  },
});
const setup = () => useProviderStore.setState({
  providerConfigs: [config("frozen"), config("ui")],
  modelsByProvider: { frozen: [model("frozen")], ui: [model("ui")] },
  selectedProviderId: "ui", selectedModelId: "model", selectedReasoningEffort: "low",
});

describe("goal auditor provider resolver", () => {
  it("uses the frozen provider, model, effort and workspace despite UI selection changes", async () => {
    setup();
    const resolve = createStoreGoalAuditProviderResolver({
      providerId: "frozen", modelId: "model", effort: "high", workspacePath: "/workspace",
    });
    useProviderStore.setState({ selectedProviderId: "ui", selectedReasoningEffort: "low" });
    expect(await resolve(input("model", "high"), new AbortController().signal)).toEqual({
      providerId: "frozen", providerType: "openai", baseUrl: "https://frozen.invalid/v1",
      apiKey: "frozen-key", modelId: "model", reasoningEffort: "high", workspacePath: "/workspace",
    });
  });

  it("rejects stale, disabled and unauthorized selections without falling back to the UI", async () => {
    setup();
    const signal = new AbortController().signal;
    await expect(createStoreGoalAuditProviderResolver({ providerId: "gone", modelId: "model" })(input(), signal)).rejects.toThrow("provider is unavailable");
    await expect(createStoreGoalAuditProviderResolver({ providerId: "frozen", modelId: "missing" })(input(), signal)).rejects.toThrow("model is unavailable");
    await expect(createStoreGoalAuditProviderResolver({ providerId: "frozen", modelId: "model", effort: "max" })(input(), signal)).rejects.toThrow("reasoning effort is unavailable");
    await expect(createStoreGoalAuditProviderResolver({ providerId: "frozen", modelId: "model" })(input("other"), signal)).rejects.toThrow("conflicts with its authorization");
    useProviderStore.setState({ providerConfigs: [{ ...config("frozen"), isEnabled: false }, config("ui")] });
    await expect(createStoreGoalAuditProviderResolver({ providerId: "frozen", modelId: "model" })(input(), signal)).rejects.toThrow("provider is unavailable");
    useProviderStore.setState({ providerConfigs: [config("frozen"), config("ui")], modelsByProvider: { frozen: [{ ...model("frozen"), isEnabled: false }], ui: [model("ui")] } });
    await expect(createStoreGoalAuditProviderResolver({ providerId: "frozen", modelId: "model" })(input(), signal)).rejects.toThrow("model is unavailable");
  });

  it("rejects an abort or configuration change while the API key is resolving", async () => {
    setup();
    let finish!: (key: string) => void;
    const resolveProviderApiKey = mock(() => new Promise<string>((resolve) => { finish = resolve; }));
    useProviderStore.setState({ resolveProviderApiKey });
    const resolve = createStoreGoalAuditProviderResolver({ providerId: "frozen", modelId: "model" });
    const controller = new AbortController();
    const aborted = resolve(input(), controller.signal);
    controller.abort();
    await expect(Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Abort stalled")), 100)),
    ])).rejects.toHaveProperty("name", "AbortError");
    finish("key");

    const changed = resolve(input(), new AbortController().signal);
    useProviderStore.setState({ providerConfigs: [{ ...config("frozen"), baseUrl: "https://changed.invalid/v1" }, config("ui")] });
    finish("key");
    await expect(changed).rejects.toThrow("configuration changed");
    expect(resolveProviderApiKey).toHaveBeenCalledTimes(2);
  });

  it("rejects a key rotated while resolution is pending", async () => {
    setup();
    let finish!: (key: string) => void;
    useProviderStore.setState({
      resolveProviderApiKey: () => new Promise<string>((resolve) => { finish = resolve; }),
    });
    const resolve = createStoreGoalAuditProviderResolver({ providerId: "frozen", modelId: "model" });
    const pending = resolve(input(), new AbortController().signal);
    useProviderStore.setState({
      providerConfigs: [{ ...config("frozen"), apiKey: "new-key" }, config("ui")],
    });
    finish("frozen-key");
    await expect(pending).rejects.toThrow("API key changed during resolution");
  });
});
