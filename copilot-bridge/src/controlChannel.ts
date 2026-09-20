import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  BridgeControlError,
  decodeToolResultMessage,
  validateControlId,
  type BridgeToolRequestMessage,
  type BridgeToolResultMessage,
  type JsonRecord,
  type RelayToolResult,
} from './protocol';

const DEFAULT_FRONTEND_TOOL_TIMEOUT_MS = 300_000;
const TERMINAL_RUN_TIMEOUT_MARGIN_MS = 30_000;
const MAX_TERMINAL_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const COPILOT_COMPLETION_MARGIN_MS = 30_000;
const DEFAULT_COPILOT_SEND_TIMEOUT_MS =
  MAX_TERMINAL_RUN_TIMEOUT_MS + TERMINAL_RUN_TIMEOUT_MARGIN_MS + COPILOT_COMPLETION_MARGIN_MS;
const MIN_COPILOT_SEND_TIMEOUT_MS = 60 * 1000;

export const frontendToolTimeoutMs = (
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

export const normalizeCopilotSendTimeoutMs = (value?: number | null): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= MIN_COPILOT_SEND_TIMEOUT_MS
    ? Math.floor(value)
    : DEFAULT_COPILOT_SEND_TIMEOUT_MS;

export class BridgeControlChannel {
  private readonly reader: Interface;
  private readonly pendingToolResults = new Map<
    string,
    {
      requestId: string;
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

  constructor(
    private readonly input: Readable & { isTTY?: boolean } = process.stdin,
    private readonly emit: (payload: BridgeToolRequestMessage) => void = (payload) => {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    },
  ) {
    this.reader = createInterface({ input });
    this.reader.on('line', (line) => {
      this.handleLine(line);
    });
    this.reader.on('close', () => {
      this.initialClosed = true;
      this.flushInitialWaiters();
      this.rejectPendingToolResults(
        new BridgeControlError('tool_result_channel_closed', 'Copilot tool result channel closed.')
      );
    });
  }

  async readInitialJson<T>(): Promise<T | null> {
    if (this.input.isTTY) {
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
    if (this.initialClosed) {
      return Promise.reject(
        new BridgeControlError('tool_result_channel_closed', 'Copilot tool result channel closed.')
      );
    }
    try {
      validateControlId(params.requestId, 'request_id');
      validateControlId(params.toolCallId, 'tool_call_id');
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pendingToolResults.has(params.toolCallId)) {
      return Promise.reject(
        new BridgeControlError(
          'duplicate_tool_call_id',
          `Duplicate Copilot tool call id "${params.toolCallId}".`
        )
      );
    }

    return new Promise<RelayToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingToolResults.delete(params.toolCallId);
        reject(
          new BridgeControlError(
            'tool_result_timeout',
            `Timed out waiting for Macro to execute tool "${params.toolName}".`
          )
        );
      }, frontendToolTimeoutMs(params.toolName, params.args, params.sessionTimeoutMs));

      this.pendingToolResults.set(params.toolCallId, {
        requestId: params.requestId,
        resolve,
        reject,
        timeout,
      });
      // Register before writing: even an immediate response must find its pending call.
      try {
        this.emit({
          type: 'tool_request',
          request_id: params.requestId,
          tool_call_id: params.toolCallId,
          tool_name: params.toolName,
          args: params.args,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingToolResults.delete(params.toolCallId);
        reject(new BridgeControlError(
          'tool_result_channel_failed',
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  }

  close(): void {
    this.initialClosed = true;
    this.reader.close();
    this.flushInitialWaiters();
    this.rejectPendingToolResults(
      new BridgeControlError('tool_result_channel_closed', 'Copilot tool result channel closed.')
    );
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      const parsedError = new BridgeControlError(
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

    try {
      const result = decodeToolResultMessage(message);
      if (result) this.resolveToolResult(result);
    } catch (error) {
      if (!(error instanceof BridgeControlError)) throw error;
      this.rejectPendingToolResults(error);
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
    // Stale results cannot consume a pending call, even if its tool ID was reused.
    if (!pending || pending.requestId !== message.request_id) return;

    clearTimeout(pending.timeout);
    this.pendingToolResults.delete(message.tool_call_id);

    if (message.error) {
      pending.reject(new BridgeControlError('tool_result_failed', message.error));
      return;
    }

    pending.resolve({
      result: typeof message.result === 'string' ? message.result : '',
      isError: message.is_error,
      errorKind: message.error_kind,
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
