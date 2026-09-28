import type { StreamingChatOptions, StreamCompletionResult } from "../streamingChat";
import { streamChat } from "../streamingChat";
import { stripThinkingBlocksForModel } from "../ai/chatCompletionsCodec";
import { filterToolIdsForInternalAgentProfile } from "../internalAgentProfile";
import type { ChildTurnExecutor, SubagentProgressEvent } from "../subagentRuntime";
import type { GoalAuditChildInput } from "./types";

const WORKSPACE_READ_TOOLS = ["list", "read", "glob", "grep", "ast_grep"] as const;
const GIT_READ_TOOLS = [
  "git_status", "git_log", "git_branch_list", "git_diff", "git_get_tree",
] as const;

export interface GoalAuditProvider {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  workspacePath?: string;
}

export interface GoalAuditChildConversation {
  id: string;
  runId: string;
  parentConversationId: string;
}

export interface GoalAuditProviderPorts {
  /** Resolve the provider for this child without reading the parent chat store. */
  resolveProvider(input: GoalAuditChildInput): GoalAuditProvider | Promise<GoalAuditProvider>;
  /** Create or resume a durable child conversation linked to this parent and run; honor abort. */
  resolveChildConversation(input: {
    runId: string;
    parentConversationId: string;
    signal: AbortSignal;
  }): GoalAuditChildConversation | Promise<GoalAuditChildConversation>;
  stream?: (options: StreamingChatOptions) => Promise<void>;
  /** Executes only an already authorized read tool. */
  executeReadTool: NonNullable<StreamingChatOptions["onToolCall"]>;
}

export const createGoalAuditProviderExecutor = (
  ports: GoalAuditProviderPorts,
): ChildTurnExecutor<GoalAuditChildInput, unknown, SubagentProgressEvent> => ({
  async execute(request) {
    const { input, signal, onProgress } = request;
    if (input.profile !== "goal_auditor" || request.depth !== 1 ||
      input.authorization.childDepth !== 1 || input.authorization.agentId !== "goal_auditor") {
      throw new Error("Invalid goal auditor child authorization.");
    }
    const capabilities = input.authorization.policy.capabilities;
    if (capabilities.length !== 2 || !capabilities.includes("workspace.read") ||
      !capabilities.includes("git.read")) {
      throw new Error("Goal auditor requires its exact read-only capability set.");
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const provider = await ports.resolveProvider(input);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const childConversation = await ports.resolveChildConversation({
      runId: request.childRunId,
      parentConversationId: request.parentConversationId,
      signal,
    });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!childConversation || typeof childConversation.id !== "string" ||
      !childConversation.id.trim() || childConversation.id.trim() !== childConversation.id ||
      childConversation.id === request.childRunId ||
      childConversation.id === request.parentConversationId ||
      childConversation.runId !== request.childRunId ||
      childConversation.parentConversationId !== request.parentConversationId) {
      throw new Error("Invalid goal auditor child conversation binding.");
    }
    const allowedToolIds = filterToolIdsForInternalAgentProfile(
      [
        ...(capabilities.includes("workspace.read") ? WORKSPACE_READ_TOOLS : []),
        ...(capabilities.includes("git.read") ? GIT_READ_TOOLS : []),
      ],
      input.profile,
    );
    const allowed = new Set<string>(allowedToolIds);
    let completion: StreamCompletionResult | undefined;
    let failure: Error | undefined;
    await (ports.stream ?? streamChat)({
      sessionId: request.childRunId,
      conversationId: childConversation.id,
      internalAgentProfile: "goal_auditor",
      providerId: provider.providerId,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      modelId: input.authorization.model ?? provider.modelId,
      reasoningEffort: input.authorization.effort,
      workspacePath: provider.workspacePath,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.authorization.serializedContext },
      ],
      allowedToolIds: [...allowedToolIds],
      enableWebSearch: false,
      enableWebFetch: false,
      maxTurns: Math.min(input.authorization.remainingTurns ?? input.authorization.policy.limits.maxTurns ?? 4, 4),
      signal,
      onToken: (token) => onProgress?.({ kind: "token", message: token }),
      onToolCall: async (name, args, id) => {
        if (signal.aborted) return { kind: "result", result: "Audit cancelled.", isError: true };
        if (!allowed.has(name)) {
          onProgress?.({ kind: "tool_refused", message: name });
          return { kind: "result", result: `Tool ${name} is not allowed for goal_auditor.`, isError: true };
        }
        onProgress?.({ kind: "tool_started", message: name });
        return ports.executeReadTool(name, args, id);
      },
      onToolResult: (name) => onProgress?.({ kind: "tool_finished", message: name }),
      onComplete: (result) => { completion = result; },
      onError: (error) => { failure = error; },
    });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (failure) throw failure;
    if (!completion) throw new Error("Goal auditor provider completed without a result.");
    return { text: stripThinkingBlocksForModel(completion.visibleContent).trim() };
  },
});
