import { StreamStopUnconfirmedError, preserveStreamStopError } from "../ai/streamCancellation";
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

// A rejected receipt is still missing proof. Keep the child slot reserved;
// returning any error here would let SubagentRuntime admit its successor.
const awaitStopReceipt = async (error: StreamStopUnconfirmedError): Promise<void> => {
  try { await error.whenStopped; }
  catch (failure) {
    error.secondaryErrors.push(failure instanceof Error ? failure : new Error(String(failure)));
    await new Promise<void>(() => {});
  }
};

// Admission and streaming ports own work until their promise settles. A signal
// revokes the next effect immediately; racing it against the promise would let
// a child owner disappear while its provider or conversation write continues.
const awaitOwned = async <T>(signal: AbortSignal, start: () => T | Promise<T>): Promise<T> => {
  if (signal.aborted) throw abortError();
  try {
    const value = await start();
    if (signal.aborted) throw abortError();
    return value;
  } catch (error) {
    if (error instanceof StreamStopUnconfirmedError) {
      // A child slot cannot be released by an unconfirmed cancellation error.
      // Keep the typed error until a later receipt proves local task completion.
      await awaitStopReceipt(error);
      throw error;
    }
    throw signal.aborted ? abortError() : error;
  }
};

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
    const initialProvider = { ...await awaitOwned(signal, () => ports.resolveProvider(input, signal)) };
    const selection: GoalAuditEffectiveSelection = Object.freeze({
      providerId: initialProvider.providerId,
      modelId: input.authorization.model ?? initialProvider.modelId,
      reasoningEffort: initialProvider.reasoningEffort ?? input.authorization.effort,
    });
    if (!selection.providerId?.trim() || !selection.modelId?.trim() ||
      (selection.reasoningEffort !== undefined && !selection.reasoningEffort.trim())) {
      throw new Error("Invalid goal auditor provider selection.");
    }
    const childConversation = await awaitOwned(signal, () => ports.resolveChildConversation({
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
    const provider = await awaitOwned(signal, () => ports.resolveProvider(input, signal));
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
    const diagnosticFailures: unknown[] = [];
    const emitProgress = (event: SubagentProgressEvent) => {
      if (signal.aborted) return;
      try { onProgress?.(event); }
      catch (error) { diagnosticFailures.push(error); }
    };
    const assertReadToolBinding = () => {
      if (!hasValidChildBinding(childConversation, readToolContext.runId, readToolContext.parentConversationId, selection) ||
        childConversation.id !== readToolContext.childConversationId) {
        throw new Error("Invalid goal auditor child conversation binding.");
      }
    };
    const readWork = new Set<Promise<unknown>>();
    const readFailures: unknown[] = [];
    let completion: StreamCompletionResult | undefined;
    let failure: Error | undefined;
    const reportedFailures: Error[] = [];
    let streamFailed = false;
    let streamFailure: unknown;
    try {
      if (signal.aborted) throw abortError();
      await (ports.stream ?? streamChat)({
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
            const work = (async () => ports.executeReadTool(name, args, id, signal, readToolContext))();
            readWork.add(work);
            void work.catch(error => {
              readFailures.push(error);
              if (!(error instanceof StreamStopUnconfirmedError)) emitProgress({ kind: "tool_failed", message: error instanceof Error ? error.message : String(error) });
            });
            try { return await work; }
            finally { readWork.delete(work); }
          },
          onToolResult: (name) => emitProgress({ kind: "tool_finished", message: name }),
          onComplete: (result) => { if (!signal.aborted) completion = result; },
          onError: (error) => {
            reportedFailures.push(error);
            if (!signal.aborted || error instanceof StreamStopUnconfirmedError) failure = error;
          },
        });
    } catch (error) {
      streamFailed = true;
      streamFailure = error;
    }
    // A provider can finish while an already-dispatched read still ignores Stop.
    while (readWork.size) await Promise.all(Array.from(readWork, work => work.then(() => undefined, () => undefined)));
    const failures = [...reportedFailures, ...readFailures, ...diagnosticFailures, ...(streamFailed ? [streamFailure] : [])];
    const owners = [...new Set(failures.filter((error): error is StreamStopUnconfirmedError => error instanceof StreamStopUnconfirmedError))];
    if (owners.length) {
      let owner = owners[0];
      for (const next of owners.slice(1)) owner = preserveStreamStopError(owner, next);
      for (const diagnostic of failures) {
        if (!(diagnostic instanceof StreamStopUnconfirmedError)) owner = preserveStreamStopError(owner, diagnostic);
      }
      await awaitStopReceipt(owner);
      throw owner;
    }
    // Finite failures stay in the tool response and progress diagnostics.
    // They are not evidence of a still-running executor.
    if (streamFailed) throw streamFailure;
    if (diagnosticFailures.length) throw diagnosticFailures[0];
    if (signal.aborted) throw abortError();
    if (failure) throw failure;
    if (!completion) throw new Error("Goal auditor provider completed without a result.");
    return { text: stripThinkingBlocksForModel(completion.visibleContent).trim() };
  },
});
