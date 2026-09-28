import type { FrozenToolCallContext } from "./chatStreamContracts";
import type { ToolCallResolution } from "./ai/contracts";
import { normalizeArchitectToolId } from "./architectToolNames";
import { normalizeLegacyToolExecutionResult } from "./toolResultNormalization";
import type { MCPTool } from '../types';
import { allowedMcpTools, MCP_CALL_TOOL_ID, MCP_SEARCH_TOOL_ID, searchMcpTools, shouldDiscoverMcpTools } from './mcp/toolDiscovery';
import { isMCPToolId } from './mcpToolNames';
import type { CompleteToolInvocationInput, RecordToolInvocationInput, RecordToolInvocationResult, ToolInvocation, ToolInvocationIdentity, ToolEffectClass } from '../types/generated/ipc';

export interface ChatToolInvocationJournal {
  /** The remote kernel has its own execution journal for supported mutations. */
  isRemoteRuntime(): boolean;
  record(input: RecordToolInvocationInput): Promise<RecordToolInvocationResult>;
  complete(input: CompleteToolInvocationInput): Promise<ToolInvocation>;
  markUnknown(identity: ToolInvocationIdentity): Promise<ToolInvocation>;
}

const READ_ONLY_TOOLS = new Set([
  'read_sources', 'read_file', 'config_list', 'config_get', 'config_validate',
  'skill_activate', 'skill_read_resource', 'task_artifact_get', 'task_artifact_list',
  'task_todo_get', 'strategy_get', 'plan_get', 'plan_list', 'list', 'read',
  'glob', 'grep', 'ast_grep', 'git_status', 'git_log', 'git_branch_list',
  'git_diff', 'git_get_tree', 'terminal_read',
]);
const WORKSPACE_MUTATIONS = new Set([
  'write', 'edit', 'delete', 'apply_patch', 'git_add', 'git_commit',
  'git_checkout', 'git_merge', 'git_reset', 'git_stash',
]);

export function classifyChatToolEffect(name: string): ToolEffectClass {
  if (isMCPToolId(name)) return 'external_effect';
  if (READ_ONLY_TOOLS.has(name)) return 'read_only';
  if (WORKSPACE_MUTATIONS.has(name)) return 'workspace_mutation';
  return 'external_effect';
}

const isValidIdentityPart = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 512 &&
  !Array.from(value).some(char => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159);
  });

const journalFailure = (message: string): ToolCallResolution => ({
  kind: 'result', result: message, isError: true, errorKind: 'execution',
});

export interface ChatToolDispatchPorts {
  journal: ChatToolInvocationJournal;
  execute(operation: FrozenToolCallContext, name: string, args: Record<string, unknown>, callId?: string, isCurrent?: () => boolean): Promise<ToolCallResolution | string | void>;
  preserve(operation: FrozenToolCallContext, name: string, callId: string | undefined, resolution: ToolCallResolution | string | void): Promise<ToolCallResolution | string | void>;
  boundError(operation: FrozenToolCallContext, name: string, callId: string | undefined, error: unknown): Promise<unknown>;
}

const ABORTED: ToolCallResolution = {
  kind: "result", result: "Tool execution aborted", isError: true,
  errorKind: "aborted", toString: () => "Tool execution aborted",
};

export function createChatToolDispatch(
  operation: FrozenToolCallContext,
  ports: ChatToolDispatchPorts,
  accepts: () => boolean,
  progress: () => void,
  mcpTools: readonly MCPTool[] = [],
) {
  const isCurrent = () => !operation.signal.aborted && accepts();
  const discoveryEnabled = shouldDiscoverMcpTools(new Set(operation.allowedToolIds), mcpTools);
  const searchableTools = discoveryEnabled ? allowedMcpTools(new Set(operation.allowedToolIds), mcpTools) : [];
  const discoveredIds = new Set<string>();
  return async (toolName: string, args: Record<string, unknown>, toolCallId?: string) => {
    if (!isCurrent()) return ABORTED;
    progress();
    let normalizedName = normalizeArchitectToolId(toolName);
    let resolution: ToolCallResolution | string | void;
    const executeJournaled = async (name: string, executionArgs: Record<string, unknown>) => {
      const identity: ToolInvocationIdentity = {
        conversationId: operation.conversationId,
        turnId: operation.turnId,
        messageId: operation.assistantMessageId,
        callId: toolCallId ?? '',
      };
      if (Object.values(identity).some(value => !isValidIdentityPart(value))) {
        return journalFailure('Tool execution refused because its invocation identity is missing or invalid.');
      }
      let canonicalArgs: Record<string, unknown>;
      try {
        canonicalArgs = JSON.parse(JSON.stringify(executionArgs)) as Record<string, unknown>;
      } catch {
        return journalFailure('Tool execution refused because its arguments are not valid JSON.');
      }
      // Remote mode has no SQLite conversation journal. Its workspace mutation
      // transport owns the executionId, durable intent, and status recovery.
      // Keep this path on its existing contract until a remote conversation
      // journal can reserve the same executionId before dispatch.
      if (ports.journal.isRemoteRuntime()) {
        return ports.execute(operation, name, canonicalArgs, toolCallId, isCurrent);
      }
      try {
        const recorded = await ports.journal.record({
          ...identity, toolName: name, effectClass: classifyChatToolEffect(name),
          arguments: canonicalArgs as RecordToolInvocationInput['arguments'], remoteExecutionId: null,
        });
        if (!recorded.is_new) {
          return journalFailure('Tool execution refused because this invocation was already recorded. Inspect its outcome before retrying.');
        }
      } catch {
        return journalFailure('Tool execution refused because its durable invocation journal is unavailable.');
      }
      const markUnknown = async () => {
        try { await ports.journal.markUnknown(identity); } catch { /* Pending becomes unknown on restart. */ }
      };
      if (!isCurrent()) {
        await markUnknown();
        return ABORTED;
      }
      let result: ToolCallResolution | string | void;
      try {
        result = await ports.execute(operation, name, canonicalArgs, toolCallId, isCurrent);
      } catch (error) {
        await markUnknown();
        throw error;
      }
      if (!isCurrent() || result === undefined ||
        (typeof result === 'object' && result?.kind === 'result' && result.errorKind === 'aborted')) {
        await markUnknown();
        return result === undefined
          ? journalFailure('Tool execution returned no confirmed result. Inspect its outcome before retrying.')
          : ABORTED;
      }
      try {
        // This receipt confirms only the executor response. Copilot's provider
        // submission receipt remains a separate requirement for replay.
        await ports.journal.complete({ ...identity, receiptId: globalThis.crypto?.randomUUID?.() ?? 'local-executor-response' });
      } catch {
        await markUnknown();
        return journalFailure('Tool execution returned, but its durable completion could not be confirmed. Inspect the outcome before retrying.');
      }
      return result;
    };
    try {
      if (discoveryEnabled && toolName === MCP_SEARCH_TOOL_ID) {
        const result = searchMcpTools(args.query, searchableTools);
        if (!isCurrent()) return ABORTED;
        result.ids.forEach(id => discoveredIds.add(id));
        resolution = result.text;
      } else if (discoveryEnabled && toolName === MCP_CALL_TOOL_ID) {
        const target = args.tool_id;
        const targetArgs = args.arguments;
        if (typeof target !== 'string' || !discoveredIds.has(target) ||
          !targetArgs || typeof targetArgs !== 'object' || Array.isArray(targetArgs)) {
          resolution = { kind: 'result', result: 'Select a tool returned by mcp_search and provide an arguments object.', isError: true, errorKind: 'validation' };
        } else {
          normalizedName = target;
          resolution = await executeJournaled(target, targetArgs as Record<string, unknown>);
        }
      } else if (discoveryEnabled && isMCPToolId(toolName)) {
        resolution = { kind: 'result', result: 'Search for this MCP tool with mcp_search before calling it.', isError: true, errorKind: 'permission' };
      } else {
        resolution = await executeJournaled(normalizedName, args);
      }
    } catch (error) {
      if (!isCurrent()) return ABORTED;
      const bounded = await ports.boundError(operation, normalizedName, toolCallId, error);
      if (!isCurrent()) return ABORTED;
      throw bounded;
    }
    if (!isCurrent()) {
      // Preserve explicit denial without starting a new artifact write after Stop.
      return typeof resolution === "object" && resolution?.kind === "result" && resolution.errorKind === "permission"
        ? resolution : ABORTED;
    }
    const preserved = await ports.preserve(operation, normalizedName, toolCallId, resolution);
    if (!isCurrent()) return ABORTED;
    return normalizeLegacyToolExecutionResult(normalizedName, preserved);
  };
}
