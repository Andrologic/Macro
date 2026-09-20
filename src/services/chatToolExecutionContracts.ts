import type { handleConfigVirtualScopeToolCall } from "./configVirtualScope";
import type { isArchitectPlanReplicaDivergenceError } from "./architectPlanService";
import type { handleSkillToolCall } from "./skills/chatIntegration";
import type { callScopedMcpTool, resolveScopedMcpRuntime } from "./scopedMcpRuntime";
import type { getStreamingWebSearchConfig } from "./webSearchSettings";
import type { ChatQueries } from "../domains/contracts";
import type {
  AgentCodeCheckpointFile, AgentType, AppMode, ConversationApprovalGrant,
  ConversationRuntimeState, ChatMessage, MCPServer, MCPTool, PendingToolApproval, ToolRiskLevel, ToolTrace,
} from "../types";
import type { Citation, SourcePassageKind } from "../types/citation";
import type { ProjectExecutionContext } from "./projectExecutionContext";
import type { handleArchitectToolCall } from "./architectToolRuntime";
import type { resolveExplicitMutatingToolProjectTargets } from "./workspaceToolExecutor";
import type { TerminalSessionDto } from "./tauriIpc";
import type { webSearch } from "./webSearch";

export type PendingToolApprovalResolution =
  | { kind: "allow_once" }
  | { kind: "allow_conversation" }
  | { kind: "expired" }
  | { kind: "deny"; reason?: string };

type ConversationTool = (conversationId: string, args: Record<string, unknown>) => Promise<string>;
type TaskTool = (conversationId: string, name: string, args: Record<string, unknown>) => Promise<string | undefined>;

/** Capabilities owned by chat and adjacent domains. No store snapshots cross this boundary. */
export interface ChatToolExecutionPorts {
  runtime: Pick<ChatQueries, "messages"> & {
    read(conversationId: string): ConversationRuntimeState;
    updateTrace(messageId: string, callId: string, status: ToolTrace["status"], fallback?: Pick<ToolTrace, "tool_name" | "detail">): void;
    persistPartial(message: ChatMessage): Promise<void>;
  };
  approvals: {
    /** Live epoch, shared with reset/hydration and the existing approval actions. */
    readonly epoch: number;
    resolvers: Map<string, (resolution: PendingToolApprovalResolution) => void>;
    mutationVersions: Map<string, number>;
    challenges: Set<string>;
    serialize<T>(conversationId: string, run: () => Promise<T>): Promise<T>;
    pending(conversationId: string): PendingToolApproval | undefined;
    /** With expected, replace only if the same pending object is still published. */
    publish(conversationId: string, value: PendingToolApproval | null, expected?: PendingToolApproval): void;
    grants(conversationId: string): ConversationApprovalGrant[];
    writeGrants(conversationId: string, grants: ConversationApprovalGrant[]): void;
  };
  policy: {
    isPlanReplicaDivergence: typeof isArchitectPlanReplicaDivergenceError;
    resolveMcpRuntime: typeof resolveScopedMcpRuntime;
    webConfig: typeof getStreamingWebSearchConfig;
    isSourceToolEnabled(name: string, mode: AppMode, agentType: AgentType | null): Promise<boolean>;
    executionContext(conversationId: string): ProjectExecutionContext;
    loadRiskLevel(): Promise<ToolRiskLevel>;
    mcpRuntime(): { servers: MCPServer[]; tools: MCPTool[] };
  };
  sources: {
    readFile: ConversationTool;
    readSources: ConversationTool;
    editSource(conversationId: string, args: Record<string, unknown>): string | Promise<string>;
    containsPassage(conversationId: string, passage: string): Promise<boolean>;
    addWebCitations(results: Awaited<ReturnType<typeof webSearch>>, messageId: string, conversationId: string): void;
    addCitation(citation: Omit<Citation, "id" | "timestamp">): string;
    addSourcePassage(payload: {
      conversationId: string; messageId: string; title: string; passage: string;
      source?: string; url?: string; kind?: SourcePassageKind; reason?: string;
    }): string;
  };
  handlers: {
    configVirtualScope: typeof handleConfigVirtualScopeToolCall;
    skill: typeof handleSkillToolCall;
    mcp: typeof callScopedMcpTool;
    taskTodo: TaskTool;
    taskArtifact: TaskTool;
    architect(params: Pick<Parameters<typeof handleArchitectToolCall>[0], "assistantMessageId" | "toolName" | "args">): ReturnType<typeof handleArchitectToolCall>;
  };
  terminal: {
    cachedSession(id: string): TerminalSessionDto | undefined;
    createSession(params: { projectId?: string | null; cwd?: string | null }): Promise<TerminalSessionDto>;
    readSession(id: string): Promise<TerminalSessionDto>;
    runCommand(params: { sessionId: string; command: string; timeoutMs?: number | null; executionId?: string | null }): Promise<TerminalSessionDto>;
    killSession(id: string, executionId?: string | null): Promise<TerminalSessionDto>;
  };
  workspace: {
    executor(): Promise<Pick<typeof import("./workspaceToolExecutor"),
      "resolveMutatingToolApprovalScope" | "resolveExplicitMutatingToolProjectTargets" | "executeWorkspaceTool">>;
    resolvePromotion(params: {
      conversationId: string; executionContext: ProjectExecutionContext; selectedTaskId?: string | null;
      toolName: string; args: Record<string, unknown>;
      resolveExplicitMutatingToolProjectTargets: typeof resolveExplicitMutatingToolProjectTargets;
    }): { task: { id: string } | undefined; projectIds: string[]; unavailableResult: string | null };
    promote(taskId: string, projectIds: string[], options: { triggerTool: string }): Promise<{ promotedProjectIds: string[] } | null | undefined>;
    recordCheckpoint(params: {
      conversationId: string; turnId?: string | null; assistantMessageId: string;
      toolCallId?: string; toolName: string; files: AgentCodeCheckpointFile[];
    }): Promise<void>;
  };
}
