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
  reasoningEffort?: string;
  workspacePath?: string;
}

export interface GoalAuditEffectiveSelection {
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
}

export interface GoalAuditChildConversation {
  id: string;
  runId: string;
  parentConversationId: string;
  selection: GoalAuditEffectiveSelection;
}

export interface GoalAuditReadToolContext {
  readonly runId: string;
  readonly parentConversationId: string;
  readonly childConversationId: string;
}

export interface GoalAuditProviderPorts {
  /** Resolve the provider for this child without reading the parent chat store. */
  resolveProvider(input: GoalAuditChildInput, signal: AbortSignal): GoalAuditProvider | Promise<GoalAuditProvider>;
  /** Create or resume a durable child conversation linked to this parent and run; honor abort. */
  resolveChildConversation(input: {
    runId: string;
    parentConversationId: string;
    selection: GoalAuditEffectiveSelection;
    signal: AbortSignal;
  }): GoalAuditChildConversation | Promise<GoalAuditChildConversation>;
  stream?: (options: StreamingChatOptions) => Promise<void>;
  /** Executes only an already authorized read tool. */
  executeReadTool(
    name: string,
    args: Record<string, unknown>,
    id: string | undefined,
    signal: AbortSignal,
    context: GoalAuditReadToolContext,
  ): ReturnType<NonNullable<StreamingChatOptions["onToolCall"]>>;
}

const hasValidChildBinding = (
  child: GoalAuditChildConversation,
  runId: string,
  parentConversationId: string,
  selection: GoalAuditEffectiveSelection,
): boolean => !!child && typeof child.id === "string" && !!child.id.trim() &&
  child.id.trim() === child.id && child.id !== runId &&
  child.id !== parentConversationId && child.runId === runId &&
  child.parentConversationId === parentConversationId &&
  child.selection?.providerId === selection.providerId &&
  child.selection?.modelId === selection.modelId &&
  child.selection?.reasoningEffort === selection.reasoningEffort;

const abortError = (): DOMException => new DOMException("Aborted", "AbortError");

const awaitAbortable = <T>(signal: AbortSignal, start: () => T | Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      Promise.resolve(start()).then(
        (value) => finish(() => signal.aborted ? reject(abortError()) : resolve(value)),
        (error) => finish(() => reject(signal.aborted ? abortError() : error)),
      );
    } catch (error) {
      finish(() => reject(signal.aborted ? abortError() : error));
    }
  });

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
    const initialProvider = { ...await awaitAbortable(signal, () => ports.resolveProvider(input, signal)) };
    const selection: GoalAuditEffectiveSelection = Object.freeze({
      providerId: initialProvider.providerId,
      modelId: input.authorization.model ?? initialProvider.modelId,
      reasoningEffort: initialProvider.reasoningEffort ?? input.authorization.effort,
    });
    if (!selection.providerId?.trim() || !selection.modelId?.trim() ||
      (selection.reasoningEffort !== undefined && !selection.reasoningEffort.trim())) {
      throw new Error("Invalid goal auditor provider selection.");
    }
    const childConversation = await awaitAbortable(signal, () => ports.resolveChildConversation({
      runId: request.childRunId,
      parentConversationId: request.parentConversationId,
      selection,
      signal,
    }));
    if (!hasValidChildBinding(childConversation, request.childRunId, request.parentConversationId, selection)) {
      throw new Error("Invalid goal auditor child conversation binding.");
    }
    const readToolContext: GoalAuditReadToolContext = Object.freeze({
      runId: request.childRunId,
      parentConversationId: request.parentConversationId,
      childConversationId: childConversation.id,
    });
    const provider = await awaitAbortable(signal, () => ports.resolveProvider(input, signal));
    if (provider.providerId !== selection.providerId ||
      (input.authorization.model ?? provider.modelId) !== selection.modelId ||
      (provider.reasoningEffort ?? input.authorization.effort) !== selection.reasoningEffort ||
      provider.providerType !== initialProvider.providerType || provider.baseUrl !== initialProvider.baseUrl ||
      provider.apiKey !== initialProvider.apiKey ||
      provider.workspacePath !== initialProvider.workspacePath) {
      throw new Error("Goal auditor provider changed after child reservation.");
    }
    const allowedToolIds = filterToolIdsForInternalAgentProfile(
      [
        ...(capabilities.includes("workspace.read") ? WORKSPACE_READ_TOOLS : []),
        ...(capabilities.includes("git.read") ? GIT_READ_TOOLS : []),
      ],
      input.profile,
    );
    const allowed = new Set<string>(allowedToolIds);
    const emitProgress = (event: SubagentProgressEvent) => {
      if (!signal.aborted) onProgress?.(event);
    };
    const assertReadToolBinding = () => {
      if (!hasValidChildBinding(childConversation, readToolContext.runId, readToolContext.parentConversationId, selection) ||
        childConversation.id !== readToolContext.childConversationId) {
        throw new Error("Invalid goal auditor child conversation binding.");
      }
    };
    let completion: StreamCompletionResult | undefined;
    let failure: Error | undefined;
    await awaitAbortable(signal, () => (ports.stream ?? streamChat)({
      sessionId: request.childRunId,
      conversationId: readToolContext.childConversationId,
      internalAgentProfile: "goal_auditor",
      providerId: provider.providerId,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
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
      onToken: (token) => emitProgress({ kind: "token", message: token }),
      onToolCall: async (name, args, id) => {
        if (signal.aborted) return { kind: "result", result: "Audit cancelled.", isError: true };
        if (!allowed.has(name)) {
          emitProgress({ kind: "tool_refused", message: name });
          return { kind: "result", result: `Tool ${name} is not allowed for goal_auditor.`, isError: true };
        }
        assertReadToolBinding();
        emitProgress({ kind: "tool_started", message: name });
        if (signal.aborted) return { kind: "result", result: "Audit cancelled.", isError: true };
        assertReadToolBinding();
        return ports.executeReadTool(name, args, id, signal, readToolContext);
      },
      onToolResult: (name) => emitProgress({ kind: "tool_finished", message: name }),
      onComplete: (result) => { if (!signal.aborted) completion = result; },
      onError: (error) => { if (!signal.aborted) failure = error; },
    }));
    if (signal.aborted) throw abortError();
    if (failure) throw failure;
    if (!completion) throw new Error("Goal auditor provider completed without a result.");
    return { text: stripThinkingBlocksForModel(completion.visibleContent).trim() };
  },
});
