import {
  CopilotClient,
  defineTool,
  type ModelInfo,
  type PermissionRequest,
  type PermissionRequestResult,
  type Tool,
  type ToolInvocation,
} from '@github/copilot-sdk';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  filterCopilotSupportedToolIds,
  getMacroToolRegistryEntry,
  type JsonSchema,
} from '../../src/shared/macroToolRegistry';
const MIN_CLI_VERSION = '1.0.12';
const CLI_NAME = 'copilot';
const DEFAULT_FRONTEND_TOOL_TIMEOUT_MS = 300_000;
const TERMINAL_RUN_TIMEOUT_MARGIN_MS = 30_000;
const MAX_TERMINAL_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const COPILOT_COMPLETION_MARGIN_MS = 30_000;
const DEFAULT_COPILOT_SEND_TIMEOUT_MS =
  MAX_TERMINAL_RUN_TIMEOUT_MS + TERMINAL_RUN_TIMEOUT_MARGIN_MS + COPILOT_COMPLETION_MARGIN_MS;
const MIN_COPILOT_SEND_TIMEOUT_MS = 60 * 1000;
const TOOL_HOST_URL_ENV = 'MACRO_TOOL_HOST_URL';
const TOOL_HOST_BEARER_TOKEN_ENV = 'MACRO_TOOL_HOST_BEARER_TOKEN';

type JsonRecord = Record<string, unknown>;

const frontendToolTimeoutMs = (
  toolName: string,
  args: JsonRecord,
  sessionTimeoutMs = DEFAULT_COPILOT_SEND_TIMEOUT_MS
): number => {
  const relayBudget = Math.max(1, sessionTimeoutMs - COPILOT_COMPLETION_MARGIN_MS);
  if (toolName === 'question' || toolName.startsWith('need_')) {
    return Math.min(
      MAX_TERMINAL_RUN_TIMEOUT_MS + TERMINAL_RUN_TIMEOUT_MARGIN_MS,
      relayBudget
    );
  }
  if (toolName !== 'terminal_run') {
    return Math.min(DEFAULT_FRONTEND_TOOL_TIMEOUT_MS, relayBudget);
  }

  const requested = args.timeout_ms;
  const requestedMs =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.max(0, Math.floor(requested))
      : DEFAULT_FRONTEND_TOOL_TIMEOUT_MS - TERMINAL_RUN_TIMEOUT_MARGIN_MS;
  return Math.min(
    relayBudget,
    MAX_TERMINAL_RUN_TIMEOUT_MS + TERMINAL_RUN_TIMEOUT_MARGIN_MS,
    Math.max(
      DEFAULT_FRONTEND_TOOL_TIMEOUT_MS,
      requestedMs + TERMINAL_RUN_TIMEOUT_MARGIN_MS,
    ),
  );
};

interface BridgeProjectMount {
  project_id: string;
  mount_name: string;
  workspace_path: string | null;
  display_name?: string;
}

interface BridgeChatMessageImageUrl {
  url: string;
}

interface BridgeChatMessagePart {
  type: string;
  text?: string;
  image_url?: BridgeChatMessageImageUrl;
}

interface BridgeToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface BridgeChatMessage {
  role: string;
  content: string | BridgeChatMessagePart[];
  tool_calls?: BridgeToolCall[];
  tool_call_id?: string;
}

interface BridgeSendRequest {
  request_id?: string;
  model_id: string;
  reasoning_effort?: string | null;
  messages: BridgeChatMessage[];
  allowed_tool_ids?: string[];
  workspace_path?: string | null;
  default_workspace_path?: string | null;
  project_mounts?: BridgeProjectMount[];
  virtual_root_enabled?: boolean;
  focused_project_id?: string | null;
  copilot_send_timeout_ms?: number | null;
}

interface ToolHostClient {
  baseUrl: string;
  bearerToken: string;
}

interface SourcePassageRecord {
  id: string;
  title: string;
  passage: string;
  source?: string;
  url?: string;
  kind: 'interesting' | 'used';
  reason?: string;
  updated_at: string;
}

interface CliProbe {
  cliPath: string;
  installed: boolean;
  version: string | null;
  versionOk: boolean;
  error?: string;
}

interface BridgeHealthResult {
  ok: boolean;
  cli_path: string;
  cli_installed: boolean;
  cli_version: string | null;
  min_cli_version: string;
  version_ok: boolean;
  auth_status: string;
  auth_source?: string;
  account_label?: string;
  status_message?: string;
  error_code?: string;
  error_message?: string;
}

interface WorkspaceCandidate {
  id: string;
  mountName: string;
  displayName: string;
  workspacePath: string;
}

interface WorkspaceContext {
  defaultWorkspacePath: string | null;
  focusedProjectId: string | null;
  virtualRootEnabled: boolean;
  candidates: WorkspaceCandidate[];
}

interface ToolTraceSnapshot {
  tool_call_id: string;
  tool_name: string;
  detail?: string;
  status: 'running' | 'done';
}

interface BridgeToolResultMessage {
  type: 'tool_result';
  request_id?: string;
  tool_call_id: string;
  result?: string;
  hidden_context?: string | null;
  visible_content?: string | null;
  interrupt?: boolean;
  error?: string;
}

interface RelayToolResult {
  result: string;
  hiddenContext?: string;
  visibleContent?: string;
  interrupt?: boolean;
}

interface CopilotSessionEventState {
  finalContent: string;
  lastError: string | null;
  completionReason: 'completed' | 'length' | 'incomplete' | null;
  streamedReasoning: string;
  completeReasoning: string;
  messageReasoning: string;
  thinkingOpen: boolean;
}

class BridgeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const emitJson = (payload: JsonRecord): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const createCopilotSessionEventState = (): CopilotSessionEventState => ({
  finalContent: '',
  lastError: null,
  completionReason: null,
  streamedReasoning: '',
  completeReasoning: '',
  messageReasoning: '',
  thinkingOpen: false,
});

const optionalTrimmedText = (value?: string | null): string | undefined => {
  const trimmed = (value || '').trim();
  return trimmed || undefined;
};

const classifyCopilotWarningCompletionReason = (
  data: Record<string, unknown>,
): 'length' | 'incomplete' | null => {
  const warningType = typeof data.warningType === 'string' ? data.warningType : '';
  const message = typeof data.message === 'string' ? data.message : '';
  const warning = `${warningType} ${message}`.trim();
  if (!warning) return null;
  if (
    /(?:max(?:imum)?[_ -]?(?:output[_ -]?)?tokens?|output[_ -]?limit|token[_ -]?limit|truncat|cut off)/i.test(
      warning,
    )
  ) {
    return 'length';
  }
  if (/(?:incomplete|interrupted|terminated early)/i.test(warning)) {
    return 'incomplete';
  }
  return null;
};

const appendCopilotReasoningDelta = (
  state: CopilotSessionEventState,
  delta: string,
  emit: (payload: JsonRecord) => void
): void => {
  if (!delta) return;
  if (!state.thinkingOpen) {
    emit({ type: 'delta', delta: '<think>' });
    state.thinkingOpen = true;
  }
  state.streamedReasoning += delta;
  emit({ type: 'delta', delta });
};

const closeCopilotThinkingBlock = (
  state: CopilotSessionEventState,
  emit: (payload: JsonRecord) => void,
  beforeResponse: boolean
): void => {
  if (!state.thinkingOpen) return;
  emit({ type: 'delta', delta: beforeResponse ? '</think>\n' : '</think>' });
  state.thinkingOpen = false;
};

const getCopilotReasoningSummary = (
  state: CopilotSessionEventState
): string | undefined =>
  optionalTrimmedText(state.streamedReasoning) ||
  optionalTrimmedText(state.completeReasoning) ||
  optionalTrimmedText(state.messageReasoning);

const normalizeCopilotSendTimeoutMs = (value?: number | null): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= MIN_COPILOT_SEND_TIMEOUT_MS
    ? Math.floor(value)
    : DEFAULT_COPILOT_SEND_TIMEOUT_MS;

const handleCopilotAssistantMessage = (
  state: CopilotSessionEventState,
  data: {
    content?: string;
    reasoningText?: string;
  } | null | undefined,
  emit: (payload: JsonRecord) => void
): void => {
  if (!data) return;
  const content = typeof data.content === 'string' ? data.content : '';
  closeCopilotThinkingBlock(state, emit, Boolean(content));
  if (content) {
    state.finalContent = content;
  }
  const reasoningText = optionalTrimmedText(data.reasoningText);
  if (reasoningText) {
    state.messageReasoning = reasoningText;
  }
};

const handleCopilotSessionEvent = (params: {
  event: {
    type: string;
    data?: Record<string, unknown>;
  };
  state: CopilotSessionEventState;
  toolTraces: Map<string, ToolTraceSnapshot>;
  hiddenContextBlocks: string[];
  emit: (payload: JsonRecord) => void;
}): void => {
  const { event, state, toolTraces, hiddenContextBlocks, emit } = params;
  const data = (event.data || {}) as Record<string, unknown>;

  if (event.type === 'assistant.reasoning_delta') {
    appendCopilotReasoningDelta(
      state,
      typeof data.deltaContent === 'string' ? data.deltaContent : '',
      emit
    );
    return;
  }

  if (event.type === 'assistant.reasoning') {
    const content = typeof data.content === 'string' ? data.content : '';
    if (content) {
      state.completeReasoning = content;
      if (!optionalTrimmedText(state.streamedReasoning)) {
        appendCopilotReasoningDelta(state, content, emit);
      }
    }
    return;
  }

  if (event.type === 'assistant.message_delta') {
    const delta = typeof data.deltaContent === 'string' ? data.deltaContent : '';
    if (delta) {
      closeCopilotThinkingBlock(state, emit, true);
      emit({ type: 'delta', delta });
    }
    return;
  }

  if (event.type === 'assistant.message') {
    handleCopilotAssistantMessage(
      state,
      {
        content: typeof data.content === 'string' ? data.content : '',
        reasoningText: typeof data.reasoningText === 'string' ? data.reasoningText : undefined,
      },
      emit
    );
    return;
  }

  if (event.type === 'tool.execution_start') {
    const args = ((data.arguments || {}) as JsonRecord);
    const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool';
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : randomUUID();
    const detail = formatToolTraceDetail(toolName, args);
    const trace: ToolTraceSnapshot = {
      tool_call_id: toolCallId,
      tool_name: toolName,
      detail,
      status: 'running',
    };
    toolTraces.set(toolCallId, trace);
    emit({ type: 'tool_trace', ...trace });
    return;
  }

  if (event.type === 'tool.execution_complete') {
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
    const existing = toolTraces.get(toolCallId);
    const trace: ToolTraceSnapshot = {
      tool_call_id: toolCallId,
      tool_name: existing?.tool_name || 'tool',
      detail: existing?.detail,
      status: 'done',
    };
    toolTraces.set(toolCallId, trace);
    emit({ type: 'tool_trace', ...trace });

    const result = data.result as
      | {
          detailedContent?: unknown;
          content?: unknown;
        }
      | undefined;
    const resultText =
      (typeof result?.detailedContent === 'string' ? result.detailedContent : '') ||
      (typeof result?.content === 'string' ? result.content : '');
    const block = buildToolContextBlock(
      toolCallId,
      trace.tool_name,
      trace.detail,
      resultText
    );
    if (block) {
      hiddenContextBlocks.push(block);
    }
    return;
  }

  if (event.type === 'session.error') {
    state.lastError =
      (typeof data.message === 'string' ? data.message : '') || 'GitHub Copilot session failed.';
    state.completionReason = 'incomplete';
    return;
  }

  if (event.type === 'session.warning' && typeof data.message === 'string') {
    state.lastError = data.message;
    state.completionReason =
      classifyCopilotWarningCompletionReason(data) ?? state.completionReason;
  }
};

class BridgeControlChannel {
  private readonly reader = createInterface({ input: process.stdin });
  private readonly pendingToolResults = new Map<
    string,
    {
      resolve: (result: RelayToolResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private initialMessage: unknown | null = null;
  private initialError: Error | null = null;
  private initialClosed = false;
  private initialResolved = false;
  private readonly initialWaiters: Array<{
    resolve: (value: unknown | null) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor() {
    this.reader.on('line', (line) => {
      this.handleLine(line);
    });
    this.reader.on('close', () => {
      this.initialClosed = true;
      this.flushInitialWaiters();
      this.rejectPendingToolResults(
        new BridgeError('tool_result_channel_closed', 'Copilot tool result channel closed.')
      );
    });
  }

  async readInitialJson<T>(): Promise<T | null> {
    if (process.stdin.isTTY) {
      return null;
    }

    if (this.initialResolved) {
      if (this.initialError) throw this.initialError;
      return this.initialMessage as T | null;
    }

    return new Promise<T | null>((resolve, reject) => {
      this.initialWaiters.push({
        resolve: (value) => resolve(value as T | null),
        reject,
      });
      this.flushInitialWaiters();
    });
  }

  requestTool(params: {
    requestId: string;
    toolCallId: string;
    toolName: string;
    args: JsonRecord;
    sessionTimeoutMs: number;
  }): Promise<RelayToolResult> {
    if (this.pendingToolResults.has(params.toolCallId)) {
      return Promise.reject(
        new BridgeError(
          'duplicate_tool_call_id',
          `Duplicate Copilot tool call id "${params.toolCallId}".`
        )
      );
    }

    emitJson({
      type: 'tool_request',
      request_id: params.requestId,
      tool_call_id: params.toolCallId,
      tool_name: params.toolName,
      args: params.args,
    });

    return new Promise<RelayToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingToolResults.delete(params.toolCallId);
        reject(
          new BridgeError(
            'tool_result_timeout',
            `Timed out waiting for Macro to execute tool "${params.toolName}".`
          )
        );
      }, frontendToolTimeoutMs(params.toolName, params.args, params.sessionTimeoutMs));

      this.pendingToolResults.set(params.toolCallId, {
        resolve,
        reject,
        timeout,
      });
    });
  }

  close(): void {
    this.reader.close();
    this.rejectPendingToolResults(
      new BridgeError('tool_result_channel_closed', 'Copilot tool result channel closed.')
    );
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      const parsedError = new BridgeError(
        'invalid_control_message',
        `Invalid Copilot control message: ${error instanceof Error ? error.message : String(error)}`
      );
      if (!this.initialResolved) {
        this.initialError = parsedError;
        this.initialResolved = true;
        this.flushInitialWaiters();
        return;
      }
      this.rejectPendingToolResults(parsedError);
      return;
    }

    if (!this.initialResolved) {
      this.initialMessage = message;
      this.initialResolved = true;
      this.flushInitialWaiters();
      return;
    }

    if (isBridgeToolResultMessage(message)) {
      this.resolveToolResult(message);
    }
  }

  private flushInitialWaiters(): void {
    if (!this.initialResolved && !this.initialClosed) return;
    const waiters = this.initialWaiters.splice(0);
    for (const waiter of waiters) {
      if (this.initialError) {
        waiter.reject(this.initialError);
      } else {
        waiter.resolve(this.initialResolved ? this.initialMessage : null);
      }
    }
  }

  private resolveToolResult(message: BridgeToolResultMessage): void {
    const pending = this.pendingToolResults.get(message.tool_call_id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingToolResults.delete(message.tool_call_id);

    if (message.error) {
      pending.reject(new BridgeError('tool_result_failed', message.error));
      return;
    }

    pending.resolve({
      result: typeof message.result === 'string' ? message.result : '',
      hiddenContext:
        typeof message.hidden_context === 'string' ? message.hidden_context : undefined,
      visibleContent:
        typeof message.visible_content === 'string' ? message.visible_content : undefined,
      interrupt: message.interrupt === true,
    });
  }

  private rejectPendingToolResults(error: Error): void {
    for (const [toolCallId, pending] of this.pendingToolResults) {
      clearTimeout(pending.timeout);
      this.pendingToolResults.delete(toolCallId);
      pending.reject(error);
    }
  }
}

const isBridgeToolResultMessage = (value: unknown): value is BridgeToolResultMessage => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === 'tool_result' && typeof record.tool_call_id === 'string';
};

const normalizePath = (value?: string | null): string | null => {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
};

const sanitizeRelativePath = (value?: string | null): string => {
  return (value || '.')
    .trim()
    .replace(/^['"`]+/, '')
    .replace(/['"`]+$/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '') || '.';
};

const escapeToolContextAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const buildToolContextBlock = (
  toolCallId: string,
  toolName: string,
  detail: string | undefined,
  result: string
): string | null => {
  if (!result.trim()) return null;
  const attrs = [
    `tool_call_id="${escapeToolContextAttribute(toolCallId)}"`,
    `tool="${escapeToolContextAttribute(toolName)}"`,
    detail ? `detail="${escapeToolContextAttribute(detail)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<tool_context ${attrs}>\n${result}\n</tool_context>`;
};

const contentToText = (content: BridgeChatMessage['content']): string => {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === 'text') {
        return part.text || '';
      }
      if (part.type === 'image_url') {
        return part.image_url?.url ? `[image:${part.image_url.url}]` : '[image]';
      }
      return '';
    })
    .filter((value) => value.trim().length > 0)
    .join('\n');
};

const requireToolHostClient = (): ToolHostClient => {
  const baseUrl = process.env[TOOL_HOST_URL_ENV]?.trim();
  const bearerToken = process.env[TOOL_HOST_BEARER_TOKEN_ENV]?.trim();
  if (!baseUrl || !bearerToken) {
    throw new BridgeError(
      'tool_host_missing',
      'Macro tool host is unavailable for GitHub Copilot tool execution.'
    );
  }
  return { baseUrl, bearerToken };
};

const toolHostRequest = async <T>(client: ToolHostClient, pathValue: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${client.baseUrl}${pathValue}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${client.bearerToken}`,
      ...(init?.headers || {}),
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
        ? payload.message
        : `Tool host request failed (${response.status})`);
    throw new BridgeError('tool_host_request_failed', message);
  }

  return payload as T;
};

const executeToolHost = async (params: {
  mode: string;
  toolId: string;
  args: JsonRecord;
  workspacePath?: string | null;
  workspaceScope?: string | null;
}): Promise<string> => {
  const client = requireToolHostClient();
  const payload = await toolHostRequest<{ result: string }>(client, '/api/v1/tools/execute', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      tool_id: params.toolId,
      args: params.args,
      workspace_path: params.workspacePath ?? null,
      workspace_scope: params.workspaceScope ?? null,
    }),
  });
  return payload.result;
};

const validateToolViaHost = async (params: {
  mode: string;
  toolId: string;
  path?: string | null;
}): Promise<void> => {
  const client = requireToolHostClient();
  const payload = await toolHostRequest<{
    allowed: boolean;
    reason?: string | null;
  }>(client, '/api/v1/tools/validate', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      tool_id: params.toolId,
      path: params.path ?? null,
    }),
  });

  if (!payload.allowed) {
    throw new BridgeError(
      'tool_not_allowed',
      payload.reason || `Tool ${params.toolId} is not allowed in this mode.`
    );
  }
};

const parseToolContextBlocks = (text: string): Array<{ tool: string | null; body: string }> => {
  const blocks: Array<{ tool: string | null; body: string }> = [];
  const regex = /<tool_context\b([^>]*)>([\s\S]*?)<\/tool_context>/gi;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const attrs = match[1] || '';
    const body = (match[2] || '').trim();
    const toolMatch = /\btool="([^"]+)"/i.exec(attrs);
    blocks.push({
      tool: toolMatch?.[1] || null,
      body,
    });
  }
  return blocks;
};

const extractSourcePassages = (messages: BridgeChatMessage[]): Map<string, SourcePassageRecord> => {
  const passages = new Map<string, SourcePassageRecord>();

  for (const message of messages) {
    const text = contentToText(message.content);
    if (!text.includes('<tool_context')) continue;

    for (const block of parseToolContextBlocks(text)) {
      if (block.tool !== 'mark_source_passage' && block.tool !== 'edit_source_passage') {
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(block.body);
      } catch {
        continue;
      }
      if (!payload || typeof payload !== 'object') continue;
      const record = payload as Record<string, unknown>;
      if (record.type !== 'source_passage') continue;

      if (record.action === 'mark') {
        const citation = record.citation as SourcePassageRecord | undefined;
        if (citation?.id) {
          passages.set(citation.id, citation);
        }
        continue;
      }

      const citationId =
        typeof record.citation_id === 'string' ? record.citation_id.trim() : '';
      if (!citationId) continue;

      if (record.action === 'delete') {
        passages.delete(citationId);
        continue;
      }

      const citation = record.citation as SourcePassageRecord | undefined;
      if (citation?.id) {
        passages.set(citation.id, citation);
      }
    }
  }

  return passages;
};

const readSourcePassages = (messages: BridgeChatMessage[], args: JsonRecord): string => {
  const kind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : 'all';
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const includeSnippet = args.include_snippet !== false;
  const limitRaw = typeof args.limit === 'number' ? args.limit : 20;
  const limit = Math.max(1, Math.min(Math.floor(limitRaw), 50));

  const passages = Array.from(extractSourcePassages(messages).values())
    .filter((citation) => kind === 'all' || citation.kind === kind)
    .filter((citation) => {
      if (!query) return true;
      return [citation.title, citation.passage, citation.source, citation.url, citation.reason]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    })
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, limit)
    .map((citation) => ({
      citation_id: citation.id,
      title: citation.title,
      kind: citation.kind,
      source: citation.source || null,
      url: citation.url || null,
      reason: citation.reason || null,
      updated_at: citation.updated_at,
      ...(includeSnippet ? { passage: citation.passage } : {}),
    }));

  return JSON.stringify(
    {
      total: passages.length,
      passages,
    },
    null,
    2
  );
};

const markSourcePassage = (args: JsonRecord): string => {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const passage = typeof args.passage === 'string' ? args.passage.trim() : '';
  if (!title || !passage) {
    throw new BridgeError(
      'invalid_source_passage',
      'mark_source_passage requires both title and passage.'
    );
  }

  const citation: SourcePassageRecord = {
    id: `srcp_${randomUUID()}`,
    title,
    passage,
    source: typeof args.source === 'string' ? args.source.trim() || undefined : undefined,
    url: typeof args.url === 'string' ? args.url.trim() || undefined : undefined,
    kind: args.kind === 'interesting' ? 'interesting' : 'used',
    reason: typeof args.reason === 'string' ? args.reason.trim() || undefined : undefined,
    updated_at: new Date().toISOString(),
  };

  return JSON.stringify(
    {
      type: 'source_passage',
      action: 'mark',
      citation,
    },
    null,
    2
  );
};

const editSourcePassage = (messages: BridgeChatMessage[], args: JsonRecord): string => {
  const citationId = typeof args.citation_id === 'string' ? args.citation_id.trim() : '';
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (!citationId || !action) {
    throw new BridgeError(
      'invalid_source_passage',
      'edit_source_passage requires citation_id and action.'
    );
  }

  const passages = extractSourcePassages(messages);
  const existing = passages.get(citationId);
  if (!existing) {
    throw new BridgeError(
      'source_passage_not_found',
      `Unknown source passage citation_id "${citationId}".`
    );
  }

  if (action === 'delete') {
    return JSON.stringify(
      {
        type: 'source_passage',
        action: 'delete',
        citation_id: citationId,
      },
      null,
      2
    );
  }

  if (action === 'reclassify') {
    const nextKind = args.kind === 'interesting' ? 'interesting' : args.kind === 'used' ? 'used' : null;
    if (!nextKind) {
      throw new BridgeError(
        'invalid_source_passage',
        'edit_source_passage with action="reclassify" requires kind.'
      );
    }

    return JSON.stringify(
      {
        type: 'source_passage',
        action: 'edit',
        citation_id: citationId,
        citation: {
          ...existing,
          kind: nextKind,
          updated_at: new Date().toISOString(),
        },
      },
      null,
      2
    );
  }

  if (action !== 'update') {
    throw new BridgeError(
      'invalid_source_passage',
      `Unsupported edit_source_passage action "${action}".`
    );
  }

  const nextTitle = typeof args.title === 'string' ? args.title.trim() : existing.title;
  const nextPassage =
    typeof args.passage === 'string' ? args.passage.trim() : existing.passage;
  if (!nextTitle || !nextPassage) {
    throw new BridgeError(
      'invalid_source_passage',
      'Updated source passage requires non-empty title and passage.'
    );
  }

  return JSON.stringify(
    {
      type: 'source_passage',
      action: 'edit',
      citation_id: citationId,
      citation: {
        ...existing,
        title: nextTitle,
        passage: nextPassage,
        source: typeof args.source === 'string' ? args.source.trim() || undefined : existing.source,
        url: typeof args.url === 'string' ? args.url.trim() || undefined : existing.url,
        reason:
          typeof args.reason === 'string' ? args.reason.trim() || undefined : existing.reason,
        kind: args.kind === 'interesting' || args.kind === 'used' ? args.kind : existing.kind,
        updated_at: new Date().toISOString(),
      },
    },
    null,
    2
  );
};

const serializeConversationPrompt = (messages: BridgeChatMessage[]): { system: string; prompt: string } => {
  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => contentToText(message.content).trim())
    .filter(Boolean);

  const transcript = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const label = message.role.toUpperCase();
      const body = contentToText(message.content).trim() || '(empty)';
      const parts = [`[${label}]`, body];

      if (message.tool_calls?.length) {
        for (const toolCall of message.tool_calls) {
          parts.push(
            `[ASSISTANT_TOOL_REQUEST ${toolCall.id}] ${toolCall.function.name} ${toolCall.function.arguments}`
          );
        }
      }

      if (message.role === 'tool' && message.tool_call_id) {
        parts[0] = `[TOOL_RESULT ${message.tool_call_id}]`;
      }

      return parts.join('\n');
    })
    .join('\n\n');

  const prompt = [
    'You are continuing an existing Macro conversation.',
    'Use the transcript below as the authoritative conversation history.',
    'Answer the latest user request only. If a workspace tool is needed, use it before answering.',
    '<conversation>',
    transcript || '[no prior messages]',
    '</conversation>',
  ].join('\n\n');

  return {
    system: systemMessages.join('\n\n').trim(),
    prompt,
  };
};

const formatToolTraceDetail = (toolName: string, args: JsonRecord): string | undefined => {
  if (toolName === 'read_file') {
    const file = typeof args.file === 'string' ? args.file.trim() : '';
    const extractText = args.extract_text === true ? 'extract_text=true' : '';
    return [file, extractText].filter(Boolean).join(', ') || undefined;
  }

  if (toolName === 'list' || toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    return typeof args.path === 'string' ? args.path.trim() : undefined;
  }

  if (toolName === 'glob') {
    return typeof args.pattern === 'string' ? args.pattern.trim() : undefined;
  }

  if (toolName === 'grep') {
    return typeof args.query === 'string' ? args.query.trim() : undefined;
  }

  return undefined;
};

const parseVersion = (value: string): number[] | null => {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part));
};

const compareVersions = (left: string, right: string): number => {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return 0;

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
};

const getCliPath = (): string => {
  const override = (process.env.MACRO_COPILOT_CLI_PATH || '').trim();
  if (override) {
    return override;
  }

  const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(resolver, [CLI_NAME], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    const candidate = `${result.stdout || ''}\n${result.stderr || ''}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (candidate) {
      return candidate;
    }
  }

  return CLI_NAME;
};

const runCliCommand = async (args: string[]): Promise<{ code: number; output: string }> => {
  const cliPath = getCliPath();
  const child = spawn(cliPath, args, {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const recordLine = (line: string) => {
    output += `${line}\n`;
  };

  if (!child.stdout || !child.stderr) {
    throw new BridgeError('spawn_failed', 'Failed to start Copilot CLI subprocess.');
  }

  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });

  stdout.on('line', (line) => recordLine(line));
  stderr.on('line', (line) => recordLine(line));

  const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new BridgeError('cli_missing', 'GitHub Copilot CLI was not found on PATH.'));
        return;
      }
      reject(new BridgeError('spawn_failed', error.message));
    });

    child.once('exit', (code) => {
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });

  stdout.close();
  stderr.close();
  return result;
};

const probeCli = async (): Promise<CliProbe> => {
  const cliPath = getCliPath();

  try {
    const result = await runCliCommand(['version']);
    const versionMatch = result.output.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
    const version = versionMatch?.[1] || null;
    const versionOk = version ? compareVersions(version, MIN_CLI_VERSION) >= 0 : false;

    return {
      cliPath,
      installed: result.code === 0,
      version,
      versionOk,
      error: result.code === 0 ? undefined : result.output || 'Unable to determine Copilot CLI version.',
    };
  } catch (error) {
    if (error instanceof BridgeError) {
      return {
        cliPath,
        installed: false,
        version: null,
        versionOk: false,
        error: error.message,
      };
    }

    return {
      cliPath,
      installed: false,
      version: null,
      versionOk: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const mapAuthStatus = (
  probe: CliProbe,
  auth: {
    isAuthenticated: boolean;
    authType?: string;
    login?: string;
    statusMessage?: string;
  } | null,
  error?: BridgeError | null
): BridgeHealthResult => {
  if (!probe.installed || !probe.versionOk) {
    return {
      ok: false,
      cli_path: probe.cliPath,
      cli_installed: probe.installed,
      cli_version: probe.version,
      min_cli_version: MIN_CLI_VERSION,
      version_ok: probe.versionOk,
      auth_status: 'cli_missing',
      error_code: probe.installed ? 'cli_version_unsupported' : 'cli_missing',
      error_message:
        probe.error ||
        (probe.installed
          ? `GitHub Copilot CLI ${MIN_CLI_VERSION}+ is required.`
          : 'GitHub Copilot CLI was not found on PATH.'),
    };
  }

  if (error?.code === 'policy_blocked') {
    return {
      ok: false,
      cli_path: probe.cliPath,
      cli_installed: true,
      cli_version: probe.version,
      min_cli_version: MIN_CLI_VERSION,
      version_ok: true,
      auth_status: 'policy_blocked',
      auth_source: auth?.authType ? `cli:${auth.authType}` : 'cli',
      account_label: auth?.login,
      status_message: auth?.statusMessage,
      error_code: error.code,
      error_message: error.message,
    };
  }

  if (error?.code === 'quota_or_auth_error') {
    return {
      ok: false,
      cli_path: probe.cliPath,
      cli_installed: true,
      cli_version: probe.version,
      min_cli_version: MIN_CLI_VERSION,
      version_ok: true,
      auth_status: 'quota_or_auth_error',
      auth_source: auth?.authType ? `cli:${auth.authType}` : 'cli',
      account_label: auth?.login,
      status_message: auth?.statusMessage,
      error_code: error.code,
      error_message: error.message,
    };
  }

  if (!auth?.isAuthenticated) {
    return {
      ok: false,
      cli_path: probe.cliPath,
      cli_installed: true,
      cli_version: probe.version,
      min_cli_version: MIN_CLI_VERSION,
      version_ok: true,
      auth_status: 'login_required',
      auth_source: auth?.authType ? `cli:${auth.authType}` : undefined,
      account_label: auth?.login,
      status_message: auth?.statusMessage,
      error_code: error?.code,
      error_message: error?.message,
    };
  }

  return {
    ok: true,
    cli_path: probe.cliPath,
    cli_installed: true,
    cli_version: probe.version,
    min_cli_version: MIN_CLI_VERSION,
    version_ok: true,
    auth_status: 'connected',
    auth_source: auth.authType ? `cli:${auth.authType}` : 'cli',
    account_label: auth.login,
    status_message: auth.statusMessage,
  };
};

const classifySdkError = (error: unknown): BridgeError => {
  if (error instanceof BridgeError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes('not authenticated') ||
    normalized.includes('login required') ||
    normalized.includes('authentication') ||
    normalized.includes('oauth')
  ) {
    return new BridgeError('login_required', message);
  }

  if (
    normalized.includes('policy') ||
    normalized.includes('organization') ||
    normalized.includes('disabled by administrator')
  ) {
    return new BridgeError('policy_blocked', message);
  }

  if (
    normalized.includes('quota') ||
    normalized.includes('premium') ||
    normalized.includes('subscription') ||
    normalized.includes('billing')
  ) {
    return new BridgeError('quota_or_auth_error', message);
  }

  return new BridgeError('copilot_error', message);
};

const withClient = async <T>(
  callback: (client: CopilotClient) => Promise<T>,
  existingProbe?: CliProbe
): Promise<T> => {
  const probe = existingProbe ?? await probeCli();
  if (!probe.installed || !probe.versionOk) {
    throw new BridgeError(
      probe.installed ? 'cli_version_unsupported' : 'cli_missing',
      probe.error ||
        (probe.installed
          ? `GitHub Copilot CLI ${MIN_CLI_VERSION}+ is required.`
          : 'GitHub Copilot CLI was not found on PATH.')
    );
  }

  const client = new CopilotClient({
    cliPath: probe.cliPath,
    autoStart: false,
    useStdio: true,
    useLoggedInUser: true,
    logLevel: 'error',
  });

  await client.start();
  try {
    return await callback(client);
  } finally {
    await client.stop();
  }
};

const buildWorkspaceContext = (request: BridgeSendRequest): WorkspaceContext => {
  const defaultWorkspacePath =
    normalizePath(request.default_workspace_path) || normalizePath(request.workspace_path);

  const candidates = (request.project_mounts || [])
    .map((mount) => {
      const workspacePath = normalizePath(mount.workspace_path);
      if (!workspacePath) {
        return null;
      }
      return {
        id: mount.project_id,
        mountName: mount.mount_name,
        displayName: mount.display_name || mount.mount_name || mount.project_id,
        workspacePath,
      } satisfies WorkspaceCandidate;
    })
    .filter((candidate): candidate is WorkspaceCandidate => Boolean(candidate));

  return {
    defaultWorkspacePath,
    focusedProjectId: request.focused_project_id || null,
    virtualRootEnabled: Boolean(request.virtual_root_enabled && candidates.length > 0),
    candidates,
  };
};

const slugifyAlias = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const getCandidateAliases = (candidate: WorkspaceCandidate): string[] => {
  const tail = candidate.workspacePath.split(path.sep).filter(Boolean).pop() || '';
  return Array.from(
    new Set(
      [
        candidate.id,
        candidate.mountName,
        candidate.displayName,
        slugifyAlias(candidate.displayName),
        tail,
        slugifyAlias(tail),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  );
};

const findCandidateByProject = (
  projectId: string | null | undefined,
  context: WorkspaceContext
): WorkspaceCandidate | null => {
  if (!projectId) return null;
  const normalized = projectId.trim().toLowerCase();
  return (
    context.candidates.find((candidate) => getCandidateAliases(candidate).includes(normalized)) ||
    null
  );
};

const stripCandidatePrefix = (
  inputPath: string,
  context: WorkspaceContext
): { candidate: WorkspaceCandidate; relativePath: string } | null => {
  const normalizedInput = sanitizeRelativePath(inputPath);
  if (!normalizedInput || normalizedInput === '.') return null;

  for (const candidate of context.candidates) {
    for (const alias of getCandidateAliases(candidate)) {
      if (normalizedInput === alias) {
        return { candidate, relativePath: '.' };
      }

      if (normalizedInput.startsWith(`${alias}/`)) {
        return {
          candidate,
          relativePath: normalizedInput.slice(alias.length + 1) || '.',
        };
      }
    }
  }

  return null;
};

const isAbsolutePath = (value: string): boolean => path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);

const ensureWithinWorkspace = (workspacePath: string, inputPath: string): string => {
  const resolved = path.resolve(workspacePath, inputPath || '.');
  const relative = path.relative(workspacePath, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BridgeError('path_outside_workspace', `Path escapes the workspace: ${inputPath}`);
  }

  return resolved;
};

const isWithinCanonicalWorkspace = (canonicalWorkspacePath: string, canonicalPath: string): boolean => {
  const relative = path.relative(canonicalWorkspacePath, canonicalPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveCanonicalWorkspacePath = async (
  workspacePath: string,
  inputPath: string,
  knownCanonicalWorkspacePath?: string
): Promise<{ canonicalWorkspacePath: string; canonicalPath: string }> => {
  const lexicalPath = ensureWithinWorkspace(workspacePath, inputPath);
  const canonicalWorkspacePath = knownCanonicalWorkspacePath || await fs.realpath(workspacePath);
  const canonicalPath = await fs.realpath(lexicalPath);
  if (!isWithinCanonicalWorkspace(canonicalWorkspacePath, canonicalPath)) {
    throw new BridgeError(
      'path_outside_workspace',
      `Path resolves outside the workspace, possibly through a symbolic link: ${inputPath}`
    );
  }
  return { canonicalWorkspacePath, canonicalPath };
};

const pathExists = async (value: string): Promise<boolean> => {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
};

const resolveWorkspaceTarget = async (params: {
  rawPath?: string | null;
  projectId?: string | null;
  context: WorkspaceContext;
  preferFocusedProject?: boolean;
  searchExistingPath?: boolean;
}): Promise<{ candidate: WorkspaceCandidate | null; relativePath: string; virtualRoot: boolean }> => {
  const relativeInput = sanitizeRelativePath(params.rawPath || '.');
  const explicitCandidate = findCandidateByProject(params.projectId, params.context);
  if (explicitCandidate) {
    return {
      candidate: explicitCandidate,
      relativePath: stripCandidatePrefix(relativeInput, params.context)?.relativePath || relativeInput,
      virtualRoot: false,
    };
  }

  const prefixed = stripCandidatePrefix(relativeInput, params.context);
  if (prefixed) {
    return {
      candidate: prefixed.candidate,
      relativePath: prefixed.relativePath,
      virtualRoot: false,
    };
  }

  if (isAbsolutePath(relativeInput)) {
    for (const candidate of params.context.candidates) {
      const normalizedRoot = path.resolve(candidate.workspacePath);
      const normalizedInput = path.resolve(relativeInput);
      if (normalizedInput === normalizedRoot || normalizedInput.startsWith(`${normalizedRoot}${path.sep}`)) {
        return {
          candidate,
          relativePath: path.relative(normalizedRoot, normalizedInput) || '.',
          virtualRoot: false,
        };
      }
    }

    if (params.context.defaultWorkspacePath) {
      return {
        candidate: null,
        relativePath: path.relative(params.context.defaultWorkspacePath, path.resolve(relativeInput)) || '.',
        virtualRoot: false,
      };
    }
  }

  if (params.context.virtualRootEnabled && (!relativeInput || relativeInput === '.')) {
    return {
      candidate: null,
      relativePath: '.',
      virtualRoot: true,
    };
  }

  const focusedCandidate =
    findCandidateByProject(params.context.focusedProjectId, params.context) ||
    params.context.candidates[0] ||
    null;

  if (params.preferFocusedProject && focusedCandidate) {
    return {
      candidate: focusedCandidate,
      relativePath: relativeInput,
      virtualRoot: false,
    };
  }

  if (params.searchExistingPath && relativeInput !== '.' && params.context.candidates.length > 0) {
    const matches: WorkspaceCandidate[] = [];
    for (const candidate of params.context.candidates) {
      try {
        const absolutePath = ensureWithinWorkspace(candidate.workspacePath, relativeInput);
        if (await pathExists(absolutePath)) {
          matches.push(candidate);
          if (matches.length > 1) {
            break;
          }
        }
      } catch {
        // Ignore invalid candidate/path combinations.
      }
    }

    if (matches.length === 1) {
      return {
        candidate: matches[0],
        relativePath: relativeInput,
        virtualRoot: false,
      };
    }

    if (matches.length > 1) {
      throw new BridgeError(
        'ambiguous_path',
        `Path "${relativeInput}" is ambiguous across multiple subprojects. Prefix it with a mount name or pass project_id.`
      );
    }
  }

  if (focusedCandidate) {
    return {
      candidate: focusedCandidate,
      relativePath: relativeInput,
      virtualRoot: false,
    };
  }

  return {
    candidate: null,
    relativePath: relativeInput,
    virtualRoot: false,
  };
};

const CHAT_SAFE_TOOL_IDS = new Set([
  'question',
  'skill_activate',
  'skill_read_resource',
  'skill_run_script',
  'mark_source_passage',
  'read_sources',
  'edit_source_passage',
  'read_file',
  'web_search',
  'web_fetch',
  'terminal_create_session',
  'terminal_run',
  'terminal_read',
  'terminal_kill',
]);
const FRONTEND_RELAY_WORKSPACE_TOOL_IDS = new Set([
  'list',
  'read',
  'glob',
  'grep',
  'ast_grep',
  'write',
  'edit',
  'delete',
  'apply_patch',
]);
const FRONTEND_RELAY_GIT_MUTATION_IDS = new Set([
  'git_add',
  'git_commit',
  'git_checkout',
  'git_merge',
  'git_reset',
  'git_stash',
]);
const FRONTEND_RELAY_PAGED_GIT_READ_IDS = new Set([
  'git_branch_list',
  'git_get_tree',
]);
const TOOL_HOST_GIT_READ_IDS = new Set([
  'git_status',
  'git_log',
  'git_diff',
]);

const isFrontendRelayToolId = (toolId: string): boolean =>
  toolId === 'question' ||
  toolId === 'read_file' ||
  toolId === 'web_fetch' ||
  FRONTEND_RELAY_WORKSPACE_TOOL_IDS.has(toolId) ||
  FRONTEND_RELAY_GIT_MUTATION_IDS.has(toolId) ||
  FRONTEND_RELAY_PAGED_GIT_READ_IDS.has(toolId) ||
  toolId.startsWith('terminal_') ||
  toolId.startsWith('need_') ||
  toolId.startsWith('plan_') ||
  toolId.startsWith('strategy_');

const inferMacroMode = (allowedToolIds: string[]): string => {
  const supportedToolIds = filterCopilotSupportedToolIds(allowedToolIds);
  if (
    supportedToolIds.some(
      (toolId) =>
        toolId.startsWith('need_') ||
        toolId.startsWith('plan_') ||
        toolId.startsWith('strategy_')
    )
  ) {
    return 'Architect';
  }
  if (supportedToolIds.every((toolId) => CHAT_SAFE_TOOL_IDS.has(toolId))) {
    return 'Chat';
  }
  return 'Implement';
};

const routeToolHostTarget = async (params: {
  context: WorkspaceContext;
  rawPath?: string | null;
  projectId?: string | null;
  preferFocusedProject?: boolean;
  searchExistingPath?: boolean;
}): Promise<{ workspacePath: string; relativePath: string }> => {
  const target = await resolveWorkspaceTarget({
    rawPath: params.rawPath,
    projectId: params.projectId,
    context: params.context,
    preferFocusedProject: params.preferFocusedProject,
    searchExistingPath: params.searchExistingPath,
  });

  const workspacePath = target.candidate?.workspacePath || params.context.defaultWorkspacePath;
  if (!workspacePath) {
    throw new BridgeError('missing_workspace', 'No workspace is configured for this Copilot request.');
  }

  return {
    workspacePath,
    relativePath: target.relativePath || '.',
  };
};

const executeCopilotMacroTool = async (
  request: BridgeSendRequest,
  context: WorkspaceContext,
  toolId: string,
  args: JsonRecord,
  invocation?: ToolInvocation,
  controlChannel?: BridgeControlChannel,
  recordRelayResult?: (result: RelayToolResult) => void
): Promise<string> => {
  const mode = inferMacroMode(request.allowed_tool_ids || []);

  if (isFrontendRelayToolId(toolId)) {
    if (!controlChannel) {
      throw new BridgeError(
        'frontend_tool_relay_unavailable',
        `Macro frontend relay is unavailable for tool "${toolId}".`
      );
    }

    const result = await controlChannel.requestTool({
      requestId: request.request_id || invocation?.sessionId || 'copilot',
      toolCallId: invocation?.toolCallId || `${toolId}_${randomUUID()}`,
      toolName: toolId,
      args,
      sessionTimeoutMs: normalizeCopilotSendTimeoutMs(request.copilot_send_timeout_ms),
    });
    recordRelayResult?.(result);
    return result.result;
  }

  if (toolId === 'mark_source_passage') {
    return markSourcePassage(args);
  }

  if (toolId === 'read_sources') {
    return readSourcePassages(request.messages, args);
  }

  if (toolId === 'edit_source_passage') {
    return editSourcePassage(request.messages, args);
  }

  if (TOOL_HOST_GIT_READ_IDS.has(toolId)) {
    const rawRepoPath = typeof args.repo_path === 'string' ? args.repo_path : '.';
    const routed = await routeToolHostTarget({
      context,
      rawPath: rawRepoPath,
      projectId: typeof args.project_id === 'string' ? args.project_id : null,
      preferFocusedProject: true,
      searchExistingPath: rawRepoPath !== '.',
    });

    const nextArgs: JsonRecord = { ...args, repo_path: routed.relativePath || '.' };
    delete nextArgs.project_id;

    return executeToolHost({
      mode,
      toolId,
      args: nextArgs,
      workspacePath: routed.workspacePath,
    });
  }

  throw new BridgeError(
    'unsupported_tool',
    `Macro AI runtime does not support tool "${toolId}" yet.`
  );
};

const buildMacroTools = (
  request: BridgeSendRequest,
  options?: {
    controlChannel?: BridgeControlChannel;
    recordRelayResult?: (result: RelayToolResult) => void;
  }
): Tool[] => {
  const context = buildWorkspaceContext(request);
  const allowedToolIds = filterCopilotSupportedToolIds(request.allowed_tool_ids || []);

  return allowedToolIds
    .map((toolId) => getMacroToolRegistryEntry(toolId))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) =>
      defineTool(entry.id, {
        description: entry.description,
        parameters: entry.parameters as JsonSchema & { type: 'object' },
        ...(entry.copilot?.overridesBuiltInTool === true
          ? { overridesBuiltInTool: true }
          : {}),
        handler: async (args: JsonRecord, invocation: ToolInvocation) => {
          try {
            return await executeCopilotMacroTool(
              request,
              context,
              entry.id,
              args,
              invocation,
              options?.controlChannel,
              options?.recordRelayResult
            );
          } catch (error) {
            return `Error executing ${entry.id}: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        },
      })
    );
};

const handleHealth = async (): Promise<void> => {
  const probe = await probeCli();
  if (!probe.installed || !probe.versionOk) {
    emitJson(mapAuthStatus(probe, null, null));
    return;
  }

  try {
    const result = await withClient(async (client) => {
      const auth = await client.getAuthStatus();
      return mapAuthStatus(probe, auth, null);
    }, probe);
    emitJson(result);
  } catch (error) {
    const classified = classifySdkError(error);
    let auth: Awaited<ReturnType<CopilotClient['getAuthStatus']>> | null = null;

    try {
      auth = await withClient((client) => client.getAuthStatus(), probe);
    } catch {
      auth = null;
    }

    emitJson(mapAuthStatus(probe, auth, classified));
  }
};

const modelDescription = (model: ModelInfo): string | null => {
  const parts: string[] = [];
  if (model.capabilities.supports.vision) {
    parts.push('vision');
  }
  if (model.capabilities.supports.reasoningEffort && model.supportedReasoningEfforts?.length) {
    parts.push(`reasoning:${model.supportedReasoningEfforts.join('/')}`);
  }
  return parts.length > 0 ? `Copilot model (${parts.join(', ')})` : null;
};

const handleModels = async (): Promise<void> => {
  const probe = await probeCli();
  if (!probe.installed || !probe.versionOk) {
    throw new BridgeError(
      probe.installed ? 'cli_version_unsupported' : 'cli_missing',
      probe.error ||
        (probe.installed
          ? `GitHub Copilot CLI ${MIN_CLI_VERSION}+ is required.`
          : 'GitHub Copilot CLI was not found on PATH.')
    );
  }

  const models = await withClient(async (client) => {
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) {
      throw new BridgeError('login_required', auth.statusMessage || 'GitHub Copilot CLI is not logged in.');
    }

    return client.listModels();
  }, probe);

  emitJson({
    models: models.map((model) => ({
      model_id: model.id,
      name: model.name || model.id,
      description: modelDescription(model),
      owned_by: 'github-copilot',
      supported_reasoning_efforts: model.supportedReasoningEfforts || undefined,
    })),
  });
};

const handleSend = async (): Promise<void> => {
  const controlChannel = new BridgeControlChannel();

  try {
    const request = await controlChannel.readInitialJson<BridgeSendRequest>();
    if (!request) {
      throw new BridgeError('invalid_request', 'Missing Copilot send request payload.');
    }

    const probe = await probeCli();
    if (!probe.installed || !probe.versionOk) {
      throw new BridgeError(
        probe.installed ? 'cli_version_unsupported' : 'cli_missing',
        probe.error ||
          (probe.installed
            ? `GitHub Copilot CLI ${MIN_CLI_VERSION}+ is required.`
            : 'GitHub Copilot CLI was not found on PATH.')
      );
    }

    const { system, prompt } = serializeConversationPrompt(request.messages);
    const toolTraces = new Map<string, ToolTraceSnapshot>();
    const hiddenContextBlocks: string[] = [];
    const eventState = createCopilotSessionEventState();
    let interruptResult: RelayToolResult | null = null;
    const recordRelayResult = (result: RelayToolResult) => {
      if (result.hiddenContext?.trim()) {
        hiddenContextBlocks.push(result.hiddenContext.trim());
      }
      if (result.interrupt) {
        interruptResult = result;
      }
    };
    const tools = buildMacroTools(request, {
      controlChannel,
      recordRelayResult,
    });
    const allowedToolNames = new Set(tools.map((tool) => tool.name));

    await withClient(async (client) => {
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) {
        throw new BridgeError('login_required', auth.statusMessage || 'GitHub Copilot CLI is not logged in.');
      }

      const session = await client.createSession({
        model: request.model_id,
        ...(request.reasoning_effort ? { reasoningEffort: request.reasoning_effort } : {}),
        workingDirectory:
          normalizePath(request.workspace_path) ||
          normalizePath(request.default_workspace_path) ||
          undefined,
        streaming: true,
        systemMessage: system ? { mode: 'append', content: system } : undefined,
        tools,
        availableTools: Array.from(allowedToolNames),
        onPermissionRequest: (permissionRequest: PermissionRequest): PermissionRequestResult => {
          if (
            permissionRequest.kind === 'custom-tool' &&
            typeof permissionRequest.toolName === 'string' &&
            allowedToolNames.has(permissionRequest.toolName)
          ) {
            return { kind: 'approved' };
          }

          return { kind: 'denied-no-approval-rule-and-could-not-request-from-user' };
        },
      });

      try {
        session.on((event) => {
          handleCopilotSessionEvent({
            event,
            state: eventState,
            toolTraces,
            hiddenContextBlocks,
            emit: emitJson,
          });
        });

        const assistantMessage = await session.sendAndWait(
          { prompt },
          normalizeCopilotSendTimeoutMs(request.copilot_send_timeout_ms)
        );
        handleCopilotAssistantMessage(eventState, assistantMessage?.data, emitJson);
        eventState.completionReason ??= 'completed';
      } finally {
        await session.disconnect();
      }
    }, probe);

    if (!eventState.finalContent && eventState.lastError) {
      throw classifySdkError(new Error(eventState.lastError));
    }

    closeCopilotThinkingBlock(eventState, emitJson, Boolean(eventState.finalContent));
    emitJson({
      type: 'done',
      content:
        interruptResult?.interrupt && interruptResult.visibleContent != null
          ? interruptResult.visibleContent
          : eventState.finalContent,
      reasoning_summary: getCopilotReasoningSummary(eventState),
      hidden_context: hiddenContextBlocks.join('\n\n').trim() || undefined,
      tool_traces: Array.from(toolTraces.values()),
      completion_reason: eventState.completionReason ?? 'incomplete',
    });
  } finally {
    controlChannel.close();
  }
};

const main = async (): Promise<void> => {
  const command = process.argv[2];

  switch (command) {
    case 'health':
      await handleHealth();
      return;
    case 'models':
      await handleModels();
      return;
    case 'send':
      await handleSend();
      return;
    default:
      throw new BridgeError(
        'unknown_command',
        `Unknown bridge command "${command || ''}". Expected one of: health, models, send.`
      );
  }
};

export const __testables = {
  buildMacroTools,
  closeCopilotThinkingBlock,
  classifyCopilotWarningCompletionReason,
  createCopilotSessionEventState,
  getCopilotReasoningSummary,
  frontendToolTimeoutMs,
  handleCopilotSessionEvent,
  normalizeCopilotSendTimeoutMs,
  inferMacroMode,
  isFrontendRelayToolId,
  serializeConversationPrompt,
};

if (process.env.MACRO_COPILOT_BRIDGE_TEST_IMPORT !== '1') {
  void main().catch((error) => {
    const classified = classifySdkError(error);
    emitJson({
      type: 'error',
      code: classified.code,
      message: classified.message,
    });
    process.exitCode = 1;
  });
}
