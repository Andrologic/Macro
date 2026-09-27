import type { MCPTool, SkillPermissionSnapshot } from "../types";
import type { PrepareAssistantStreamParams } from "../services/chatStreamContracts";
import type { ScopedTurnConfiguration } from "../services/configurationClient";
import type { ContextLimitFootprintFields } from "../services/modelContextLimits";
import { estimateConversationFootprint, type MaybeCompactConversationResult } from "../services/contextCompaction";
import {
  prepareAssistantStreamLaunch,
  type ChatRequestPreparationPorts,
  type PreparedChatRequestContext,
} from "../services/chatRequestPreparation";

export const chatRequestPreparationFixture = () => {
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
