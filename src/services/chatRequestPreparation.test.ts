import { describe, expect, it, spyOn } from "bun:test";
import type { MCPTool, SkillPermissionSnapshot } from "../types";
import type { PrepareAssistantStreamParams } from "./chatStreamContracts";
import type { ScopedTurnConfiguration } from "./configurationClient";
import type { ContextLimitFootprintFields } from "./modelContextLimits";
import { estimateConversationFootprint, type MaybeCompactConversationResult } from "./contextCompaction";
import {
  prepareAssistantStreamLaunch,
  type ChatRequestPreparationPorts,
  type PreparedChatRequestContext,
} from "./chatRequestPreparation";

const fixture = () => {
  const params: PrepareAssistantStreamParams = {
    conversationId: "conversation", replyToMessageId: "user", userContent: "Read the attached file",
    resolvedTaskId: "", modeAtSend: "Chat", providerId: "provider", modelId: "model",
    providerSupportsNativeToolCalling: true,
    providerConfig: {
      id: "provider", name: "Provider", providerType: "openai", baseUrl: "https://example.invalid",
      hasStoredApiKey: true, isEnabled: true, isLocal: false,
    },
  };
  const footprintFields: ContextLimitFootprintFields = {
    modelContextWindowTokens: 100_000, outputLimitTokens: 1_000,
    contextLimitSource: "provider_metadata", contextLimitConfidence: "verified",
    isContextLimitAuthoritative: true,
  };
  const snapshot: SkillPermissionSnapshot = {
    conversationId: "conversation", turnId: "user", capturedAt: "2026-01-01T00:00:00Z", skills: {},
  };
  const prepared: PreparedChatRequestContext = {
    systemMessage: "Use the supplied context.",
    preparedMessages: [{ role: "user", content: "Read the attached file", provider_input_items: [{ type: "message", content: "file" }] }],
    orderedMessages: [{
      id: "user", conversation_id: "conversation", task_id: "", role: "user",
      content: "Read the attached file", timestamp: "2026-01-01T00:00:00Z",
      context_refs: [{ id: "file", kind: "file", title: "File", path: "src/example.ts" }],
    }],
    citations: [{
      id: "citation", conversationId: "conversation", messageId: "user", type: "file", scope: "context",
      title: "Example", source: "src/example.ts", path: "src/example.ts", content: "export const example = 1;",
      timestamp: "2026-01-01T00:00:00Z",
    }],
    executionContext: {
      groupId: null, groupName: null, projectIds: ["project"], actionableProjectIds: ["project"],
      contextProjectIds: [], projectMounts: [], focusedProjectId: "project", virtualRootEnabled: false,
      workspacePathsByProjectId: {}, defaultWorkspacePath: null,
      projectId: "project", projectName: "Example", taskId: null, branchName: null, workspacePath: null,
    },
    repositoryInstructionContext: {
      contextBlock: "Instructions", sources: [{
        projectId: "project", projectName: "Example", sourcePath: "AGENTS.md", relativePath: "AGENTS.md",
        depth: 0, sizeBytes: 12, content: "Instructions",
      }], issues: [{ projectId: "project", code: "truncated", message: "Instruction truncated" }], totalBytes: 12,
    },
    skillPermissionSnapshot: snapshot, skillTurnFeedback: null,
    persistableProviderInputItemsByMessageId: { user: [{ type: "message", content: "file" }] },
  };
  const footprint = estimateConversationFootprint({
    ...prepared, ...footprintFields, toolDefinitions: [], budgetPolicy: { reservedTokens: 1_000 },
  });
  const compacted: MaybeCompactConversationResult = {
    compactionState: null, footprintBefore: footprint, footprintAfter: footprint,
    messages: [{ role: "system", content: prepared.systemMessage }, ...prepared.preparedMessages],
    usedExistingCompaction: false, degraded: false, decision: "send",
    pruning: { method: "deterministic_superseded_tool_results", elements: [], estimatedTokensSaved: 0,
      cacheBoundaryMessageId: null, promptCacheCompatibility: "preserved" },
  };
  const mcpTools: MCPTool[] = [
    { id: "mcp__server__read", serverId: "server", name: "read" },
    { id: "mcp__server__write", serverId: "server", name: "write" },
  ];
  const scoped: ScopedTurnConfiguration = {
    projectIds: ["project"], focusProjectId: "project", riskLevel: "balanced", maxTurns: 7,
    models: {}, builtInTools: {}, modeTools: {}, allowedMcpServerIds: ["server"], mcpServers: { server: {} },
  };
  const ports: ChatRequestPreparationPorts = {
    isCurrent: () => true,
    tasks: { find: () => undefined },
    policy: {
      resolveInternalAgentProfile: () => null,
      filterForInternalAgentProfile: (ids) => ids,
    },
    tools: {
      ensureLoaded: async () => {}, loadStatus: () => ({ lastError: null, hasInternalTools: true }),
      mcpSnapshot: () => ({ servers: [], enabledTools: () => mcpTools }),
      allowedForMode: async () => ["read_file", "skill_activate", "mcp__stale__read"],
      filterForImplementTask: (ids) => ids, filterForArchitectPlan: (ids) => ids,
      resolveScopedMcp: async () => ({ tools: mcpTools, servers: [], failures: [] }),
      reportUnavailableMcpServers: () => {},
      definitions: (ids) => ids.map((id) => ({ id, description: id, parameters: { type: "object", properties: {} } })),
      guidedRetry: () => undefined,
    },
    configuration: {
      loadScoped: async () => scoped,
      restrictTools: (ids, config) => ids.filter(id => config?.builtInTools[id] !== false && config?.modeTools[id] !== false),
      loadRiskLevel: async () => "yolo", loadMaxTurns: async () => 12,
      webSearch: () => ({ enableWebSearch: true, enableWebFetch: false,
        webSearchOptions: { provider: "brave", configured: true, maxResults: 3 } }),
    },
    skills: {
      createPermissionSnapshot: () => snapshot, publishFeedback: () => {},
      toolIdsForRequest: () => ({ skillToolIds: ["skill"], runnableSkillToolIds: [] }),
    },
    context: {
      executionContext: () => prepared.executionContext,
      prepareMessages: async () => prepared,
      citations: () => prepared.citations,
      fileRefPath: (ref) => "path" in ref && ref.path ? ref.path : ref.title,
    },
    provider: {
      supportsNativeToolCalling: () => true, ensureContextMetadata: async () => {},
      modelContext: () => ({ footprintFields }), estimateSerializedPayloadTokens: () => 100,
    },
    compaction: {
      loadBudgetPolicy: async () => ({ reservedTokens: 1_000 }), status: () => null,
      setStatus: () => {}, compact: async () => compacted, recordEvent: async () => {},
    },
    persistence: { providerInputItems: async () => {} },
  };
  return { params, ports, prepared, compacted, snapshot, scoped, mcpTools,
    run: () => prepareAssistantStreamLaunch(params, ports) };
};

describe("chat request preparation", () => {
  it("stops before request preparation when tool settings failed without a usable registry", async () => {
    const f = fixture();
    f.ports.tools.loadStatus = () => ({ lastError: "offline", hasInternalTools: false });
    const prepare = spyOn(f.ports.context, "prepareMessages");
    const persist = spyOn(f.ports.persistence, "providerInputItems");
    await expect(f.run()).rejects.toThrow("Failed to load tool settings: offline");
    expect(prepare).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    // A refresh error with an existing registry remains usable.
    f.ports.tools.loadStatus = () => ({ lastError: "offline", hasInternalTools: true });
    expect((await f.run()).allowedToolIds).toContain("read_file");
  });

  it("preserves scoped policy, the skill snapshot and feedback, file context, and diagnostic copies", async () => {
    const f = fixture();
    f.scoped.builtInTools = { "mcp__server__write": false };
    f.scoped.modeTools = { skill_activate: false };
    f.prepared.skillTurnFeedback = { messageId: "user", loaded: [], warnings: [] };
    const prepare = spyOn(f.ports.context, "prepareMessages");
    const feedback = spyOn(f.ports.skills, "publishFeedback");
    const skills = spyOn(f.ports.skills, "toolIdsForRequest");
    const metadata = spyOn(f.ports.provider, "ensureContextMetadata");
    const persist = spyOn(f.ports.persistence, "providerInputItems");
    const fallbackRisk = spyOn(f.ports.configuration, "loadRiskLevel");
    const fallbackTurns = spyOn(f.ports.configuration, "loadMaxTurns");
    const result = await f.run();
    expect(result.allowedToolIds).toEqual(["read_file", "mcp__server__read"]);
    expect(result.mcpTools.map(t => t.id)).toEqual(["mcp__server__read"]);
    expect(result.riskLevel).toBe("balanced");
    expect(result.maxTurns).toBe(7);
    expect(fallbackRisk).not.toHaveBeenCalled();
    expect(fallbackTurns).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith("conversation", result.allowedToolIds, null, "Chat", undefined,
      "user", f.snapshot, f.prepared.executionContext, "balanced");
    expect(feedback).toHaveBeenCalledWith("user", f.prepared.skillTurnFeedback);
    expect(skills).toHaveBeenCalledWith(result.allowedToolIds, f.snapshot);
    expect(metadata).toHaveBeenCalledWith("provider", "model", "pre_send");
    expect(persist).toHaveBeenCalledWith("user", f.prepared.persistableProviderInputItemsByMessageId.user);
    expect(result.fileToolContext).toHaveLength(1);
    expect(result.fileToolContext[0].content).toBe(f.prepared.citations[0].content);
    expect(result.enableWebSearch).toBe(true);
    expect(result.enableWebFetch).toBe(false);
    expect(result.skillToolIds).toEqual(["skill"]);
    const diagnostics = result.contextDiagnosticsBaselineSeed;
    expect(diagnostics.messagesForRequest[1]).not.toBe(f.compacted.messages[1]);
    expect(diagnostics.messagesForRequest[1].provider_input_items).not.toBe(f.compacted.messages[1].provider_input_items);
    expect(diagnostics.citations[0]).not.toBe(f.prepared.citations[0]);
    expect(diagnostics.repositoryInstructionSources[0]).not.toHaveProperty("content");
    expect(diagnostics.repositoryInstructionIssues[0]).not.toBe(f.prepared.repositoryInstructionContext.issues[0]);
  });

  it("honors explicit null scoped configuration and keeps legacy MCP, feedback clearing and turn limits", async () => {
    const f = fixture();
    f.params.scopedTurnConfigurationOverride = null;
    f.params.executionContext = f.prepared.executionContext;
    f.ports.configuration.loadMaxTurns = async () => 1;
    const loadScoped = spyOn(f.ports.configuration, "loadScoped");
    const resolveMcp = spyOn(f.ports.tools, "resolveScopedMcp");
    const resolveContext = spyOn(f.ports.context, "executionContext");
    const feedback = spyOn(f.ports.skills, "publishFeedback");
    const result = await f.run();
    expect(loadScoped).not.toHaveBeenCalled();
    expect(resolveMcp).not.toHaveBeenCalled();
    expect(resolveContext).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledWith("user", null);
    expect(result.riskLevel).toBe("yolo");
    expect(result.maxTurns).toBe(3);
    expect(result.mcpTools).toEqual(f.mcpTools);
  });

  for (const restriction of ["strict", "copilot", "no-native", "implement-plan"] as const) {
    it(`excludes MCP tools for ${restriction} even when present in the base tool list`, async () => {
      const f = fixture();
      if (restriction === "strict") f.scoped.riskLevel = "strict";
      if (restriction === "copilot") f.params.providerConfig.providerType = "copilot";
      if (restriction === "no-native") f.params.providerSupportsNativeToolCalling = false;
      if (restriction === "implement-plan") {
        f.params.modeAtSend = "Implement";
        f.params.agentTypeAtSend = "plan";
      }
      const result = await f.run();
      expect(result.mcpTools).toEqual([]);
      expect(result.allowedToolIds.some(id => id.startsWith("mcp__"))).toBe(false);
    });
  }

  it("reports scoped MCP failures and applies the Architect tool scope before preparing context", async () => {
    const f = fixture();
    f.params.modeAtSend = "Architect";
    const failures = [{ serverId: "offline", code: "TIMEOUT", message: "Timed out" }];
    f.ports.tools.resolveScopedMcp = async () => ({ servers: [], tools: f.mcpTools, failures });
    f.ports.tools.filterForArchitectPlan = ids => ids.filter(id => id !== "read_file");
    const report = spyOn(f.ports.tools, "reportUnavailableMcpServers");
    const filter = spyOn(f.ports.tools, "filterForArchitectPlan");
    const result = await f.run();
    expect(result.allowedToolIds).not.toContain("read_file");
    expect(filter.mock.calls[0][1]).toBe(f.prepared.executionContext);
    expect(report).toHaveBeenCalledWith(failures, "offline (TIMEOUT)");
  });

  it("retries compaction in safety mode when the first pass still crosses the proactive threshold", async () => {
    const f = fixture();
    const compact = spyOn(f.ports.compaction, "compact");
    compact.mockResolvedValueOnce({ ...f.compacted,
      footprintAfter: { ...f.compacted.footprintAfter, threshold: "blocking" } });
    const status = spyOn(f.ports.compaction, "setStatus");
    f.ports.compaction.status = () => ({ phase: "idle", summaryText: "Previous summary" });
    await f.run();
    expect(compact.mock.calls.map(([input]) => input.mode)).toEqual(["blocking", "safety_prestream"]);
    expect(compact.mock.calls[1][0].forcePrune).toBe(true);
    expect(compact.mock.calls[1][0].displayAfterMessageId).toBe("user");
    expect(status.mock.calls[0][1]).toMatchObject({ phase: "safety_compacting", summaryText: "Previous summary" });
  });

  it("uses the serialized payload estimate to enter safety compaction before the first pass", async () => {
    const f = fixture();
    f.ports.provider.estimateSerializedPayloadTokens = () => 150_000;
    const compact = spyOn(f.ports.compaction, "compact");
    await f.run();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0][0]).toMatchObject({ mode: "safety_prestream", forcePrune: true });
  });

  for (const latestTooLarge of [false, true]) {
    it(`records a blocked request with ${latestTooLarge ? "an oversized latest message" : "automatic compaction disabled"}`, async () => {
      const f = fixture();
      f.ports.compaction.loadBudgetPolicy = async () => ({ auto: false });
      const after = f.compacted.footprintAfter;
      f.compacted.decision = "hard_stop";
      f.compacted.footprintAfter = { ...after, isHardStop: true, usableContextRatio: 1.2,
        totalEstimatedTokens: after.usableContextTokens + 1,
        hardStopEstimatedTokens: after.usableContextTokens + 1,
        latestUserBlockableTokens: latestTooLarge ? after.usableContextTokens + 1 : 10 };
      const event = spyOn(f.ports.compaction, "recordEvent");
      const status = spyOn(f.ports.compaction, "setStatus");
      const persist = spyOn(f.ports.persistence, "providerInputItems");
      await expect(f.run()).rejects.toThrow(latestTooLarge ? "still too large" : "compaction");
      expect(status.mock.calls.at(-1)?.[1].phase).toBe(latestTooLarge ? "too_large" : "needs_manual_compaction");
      expect(event.mock.calls[0][0].status).toBe(latestTooLarge ? "blocked" : "skipped");
      expect(event.mock.calls[0][0].metadata?.result).toBe(latestTooLarge ? "context_too_large" : "auto_compaction_disabled");
      expect(persist).not.toHaveBeenCalled();
    });
  }

  it("preserves explicit recovery compaction flags and propagates provider metadata persistence failure", async () => {
    const f = fixture();
    f.params.compactionMode = "overflow_recovery";
    f.params.forceCompaction = true;
    f.params.forcePrune = true;
    f.params.compactionDisplayAfterMessageId = "previous";
    const compact = spyOn(f.ports.compaction, "compact");
    f.ports.persistence.providerInputItems = async () => { throw new Error("metadata write failed"); };
    await expect(f.run()).rejects.toThrow("metadata write failed");
    expect(compact.mock.calls[0][0]).toMatchObject({ mode: "overflow_recovery", forceCompaction: true,
      forcePrune: true, displayAfterMessageId: "previous" });
  });
});

it("does not project feedback or launch compaction after its turn is replaced during context preparation", async () => {
  const f = fixture();
  let current = true;
  let release!: (value: PreparedChatRequestContext) => void;
  f.ports.isCurrent = () => current;
  f.ports.context.prepareMessages = () => new Promise(resolve => { release = resolve; });
  const feedback = spyOn(f.ports.skills, "publishFeedback");
  const compact = spyOn(f.ports.compaction, "compact");
  const persist = spyOn(f.ports.persistence, "providerInputItems");
  const pending = f.run();
  await new Promise(resolve => setImmediate(resolve));
  current = false;
  release(f.prepared);
  await expect(pending).rejects.toThrow("superseded");
  expect(feedback).not.toHaveBeenCalled();
  expect(compact).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});
