import type {
  McpElicitationAnswer,
  McpInteractionRequest,
  McpInteractionResponse,
} from '../../types/generated/ipc';
import { toServiceError } from '../contracts/errors';
import {
  mcpRuntimeCloseInteractionPort,
  mcpRuntimeListPendingInteractions,
  mcpRuntimeOpenInteractionPort,
  mcpRuntimeRespondToInteraction,
} from '../tauriIpc';
import { parseFormPrompt, type FormPrompt } from './formElicitation';

export type FormHostIssue = 'portBusy' | 'hostUnavailable' | 'expired' | 'cancelled' | 'invalid' | 'failed';
export type QueuedFormRequest = {
  request: McpInteractionRequest;
  forms: Array<FormPrompt | null>;
};
export type FormHostSnapshot = {
  status: 'stopped' | 'opening' | 'ready' | 'unavailable';
  queue: QueuedFormRequest[];
  submittingId: string | null;
  issue: FormHostIssue | null;
};
export type FormHostPort = {
  open: (onRequest: (request: McpInteractionRequest) => void) => Promise<string>;
  close: (leaseId: string) => Promise<void>;
  pending: (leaseId: string) => Promise<string[]>;
  respond: (leaseId: string, response: McpInteractionResponse) => Promise<void>;
};

const nativePort: FormHostPort = {
  open: mcpRuntimeOpenInteractionPort,
  close: mcpRuntimeCloseInteractionPort,
  pending: mcpRuntimeListPendingInteractions,
  respond: mcpRuntimeRespondToInteraction,
};

/** Keeps only active requests in memory. Rust owns correlation and expiry. */
export class McpFormHost {
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshotValue: FormHostSnapshot = {
    status: 'stopped', queue: [], submittingId: null, issue: null,
  };
  private leaseId: string | null = null;
  private mounted = 0;
  private active = false;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private generation = 0;

  constructor(private readonly port: FormHostPort = nativePort) {}

  snapshot(): FormHostSnapshot { return this.snapshotValue; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<FormHostSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    if (this.leaseId && this.snapshotValue.queue.length > 0 && !this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.refreshPending(); }, 1_000);
    } else if (this.snapshotValue.queue.length === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const listener of this.listeners) listener();
  }

  /** Deferred teardown survives React StrictMode's immediate effect replay. */
  mount(): () => void {
    this.mounted += 1;
    if (this.mounted === 1) void this.start();
    return () => {
      this.mounted -= 1;
      queueMicrotask(() => { if (this.mounted === 0) void this.stop(); });
    };
  }

  async start(): Promise<void> {
    if (this.leaseId) return;
    if (this.closing) {
      if (this.active) return this.closing;
      this.active = true;
      const generation = ++this.generation;
      this.update({ status: 'opening', issue: null });
      await this.closing;
      if (this.active && this.generation === generation && this.mounted > 0) await this.start();
      return;
    }
    if (this.opening) {
      if (this.active) return this.opening;
      this.active = true;
      const generation = ++this.generation;
      this.update({ status: 'opening', issue: null });
      await this.opening;
      if (this.active && this.generation === generation && this.mounted > 0) await this.start();
      return;
    }
    this.active = true;
    const generation = ++this.generation;
    this.update({ status: 'opening', issue: null });
    const open = this.port.open((request) => {
      if (this.active && this.generation === generation) this.receive(request);
    })
      .then(async (leaseId) => {
        if (!this.active || this.generation !== generation) {
          await this.port.close(leaseId).catch(() => undefined);
          return;
        }
        this.leaseId = leaseId;
        this.update({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (!this.active || this.generation !== generation) return;
        this.update({
          status: 'unavailable',
          issue: toServiceError(error).code === 'MCP_INTERACTION_PORT_BUSY' ? 'portBusy' : 'hostUnavailable',
        });
      })
      .finally(() => { if (this.opening === open) this.opening = null; });
    this.opening = open;
    return open;
  }

  async retry(): Promise<void> {
    if (this.leaseId || this.opening || this.mounted === 0) return;
    await this.start();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.generation += 1;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const leaseId = this.leaseId;
    this.leaseId = null;
    this.update({ status: 'stopped', queue: [], submittingId: null, issue: null });
    if (leaseId) {
      const closing = this.port.close(leaseId)
        .catch(() => undefined)
        .finally(() => { if (this.closing === closing) this.closing = null; });
      this.closing = closing;
      await closing;
    }
  }

  private receive(request: McpInteractionRequest): void {
    if (!this.active || this.snapshotValue.queue.some((item) => item.request.requestId === request.requestId)) return;
    if (request.expiresAtMs <= Date.now()) {
      this.update({ issue: 'expired' });
      return;
    }
    const item: QueuedFormRequest = {
      request,
      forms: request.prompts.map(parseFormPrompt),
    };
    const timer = setTimeout(() => this.expire(request.requestId),
      Math.min(request.expiresAtMs - Date.now(), 2_147_483_647));
    this.timers.set(request.requestId, timer);
    this.update({ queue: [...this.snapshotValue.queue, item] });
  }

  private remove(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
    this.update({
      queue: this.snapshotValue.queue.filter((item) => item.request.requestId !== requestId),
      submittingId: this.snapshotValue.submittingId === requestId ? null : this.snapshotValue.submittingId,
    });
  }

  private expire(requestId: string): void {
    if (!this.snapshotValue.queue.some((item) => item.request.requestId === requestId)) return;
    this.remove(requestId);
    this.update({ issue: 'expired' });
  }

  /** The backend removes aborted calls before the local deadline. Only IDs cross IPC. */
  async refreshPending(): Promise<void> {
    const leaseId = this.leaseId;
    if (!leaseId || this.polling || this.snapshotValue.queue.length === 0) return;
    this.polling = true;
    const checkedIds = this.snapshotValue.queue.map((item) => item.request.requestId);
    try {
      const live = new Set(await this.port.pending(leaseId));
      if (this.leaseId !== leaseId) return;
      for (const requestId of checkedIds) {
        if (live.has(requestId) || this.snapshotValue.submittingId === requestId) continue;
        const item = this.snapshotValue.queue.find((candidate) => candidate.request.requestId === requestId);
        if (!item) continue;
        this.remove(requestId);
        this.update({ issue: item.request.expiresAtMs <= Date.now() ? 'expired' : 'cancelled' });
      }
    } catch (error) {
      if (this.leaseId !== leaseId) return;
      const code = toServiceError(error).code;
      if (code === 'MCP_INTERACTION_HOST_CLOSED' || code === 'MCP_INTERACTION_PORT_STALE') {
        await this.stop();
        this.update({ status: 'unavailable', issue: 'hostUnavailable' });
      } else {
        this.update({ issue: 'failed' });
      }
    } finally {
      this.polling = false;
    }
  }

  dismissIssue(): void { this.update({ issue: null }); }

  async answer(requestId: string, answers: McpElicitationAnswer[]): Promise<boolean> {
    const item = this.snapshotValue.queue.find((candidate) => candidate.request.requestId === requestId);
    const leaseId = this.leaseId;
    if (!item || !leaseId || this.snapshotValue.submittingId) return false;
    if (item.request.expiresAtMs <= Date.now()) {
      this.expire(requestId);
      return false;
    }
    this.update({ submittingId: requestId, issue: null });
    const { request } = item;
    const generation = this.generation;
    try {
      await this.port.respond(leaseId, {
        requestId: request.requestId,
        key: request.key,
        operationId: request.operationId,
        answers,
      });
      if (this.leaseId !== leaseId || this.generation !== generation) return false;
      this.remove(requestId);
      return true;
    } catch (error) {
      if (this.leaseId !== leaseId || this.generation !== generation) return false;
      const code = toServiceError(error).code;
      if (code === 'MCP_INTERACTION_STALE' || code === 'MCP_RUNTIME_OPERATION_CANCELLED') {
        this.remove(requestId);
        this.update({ issue: 'cancelled' });
      } else if (code === 'MCP_INTERACTION_TIMEOUT') {
        this.remove(requestId);
        this.update({ issue: 'expired' });
      } else if (code === 'MCP_INTERACTION_HOST_CLOSED' || code === 'MCP_INTERACTION_PORT_STALE') {
        await this.stop();
        this.update({ status: 'unavailable', issue: 'hostUnavailable' });
      } else {
        this.update({ submittingId: null, issue: code === 'MCP_INTERACTION_INVALID_RESPONSE' ? 'invalid' : 'failed' });
      }
      return false;
    }
  }
}

export const mcpFormHost = new McpFormHost();
