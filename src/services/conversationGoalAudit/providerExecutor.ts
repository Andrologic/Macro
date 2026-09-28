import type { StreamingChatOptions, StreamCompletionResult } from "../streamingChat";
import { streamChat } from "../streamingChat";
import { stripThinkingBlocksForModel } from "../ai/chatCompletionsCodec";
import type { ChildTurnExecutor, SubagentProgressEvent } from "../subagentRuntime";
import type { GoalAuditChildInput } from "./types";

const READ_TOOLS = [
  "read_file", "list", "read", "glob", "grep", "ast_grep",
  "git_status", "git_log", "git_branch_list", "git_diff", "git_get_tree",
] as const;
const WORKSPACE_TOOLS = new Set<string>(READ_TOOLS.slice(0, 6));

export interface GoalAuditProvider {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  workspacePath?: string;
}

export interface GoalAuditProviderPorts {
  /** Resolve the provider for this child without reading the parent chat store. */
  resolveProvider(input: GoalAuditChildInput): GoalAuditProvider | Promise<GoalAuditProvider>;
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
    const allowedToolIds = READ_TOOLS.filter((tool) =>
      WORKSPACE_TOOLS.has(tool) ? capabilities.includes("workspace.read") : capabilities.includes("git.read"),
    );
    const allowed = new Set<string>(allowedToolIds);
    let completion: StreamCompletionResult | undefined;
    let failure: Error | undefined;
    await (ports.stream ?? streamChat)({
      sessionId: request.childRunId,
      conversationId: request.childRunId,
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
