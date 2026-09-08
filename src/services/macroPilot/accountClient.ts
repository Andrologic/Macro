import {
  validateContentMessage,
  validateContentResponse,
  type ContentAccount,
  type ContentSession,
  type ContentPage,
} from './contentProtocol';
import { PilotClientError } from './nativeClient';

export type PilotAccountIdentity = ContentAccount;
export type PilotAccountSession = ContentSession;
export interface PilotAccountCatalog {
  identity: PilotAccountIdentity;
  sessions: PilotAccountSession[];
  revision: number;
}
export type PilotAccountConfirmation = Pick<PilotAccountIdentity, 'account_id' | 'session_id' | 'login' | 'subject'>;
type Page = ContentPage;
interface AccountContext { key: string; accountId: string; sessionId: string }
export interface AccountTransport {
  context: () => AccountContext;
  id: () => string;
  now: () => number;
  send: (path: string, body: unknown, requestId: string, signal: AbortSignal) => Promise<unknown>;
  clear: () => Promise<void>;
}

/** Account-only negotiation and transient catalogs. No instance or local project data. */
export class PilotAccountClient {
  private negotiatedKey: string | null = null;
  private catalog: PilotAccountCatalog | null = null;
  private catalogKey: string | null = null;
  private active: { kind: 'read' | 'mutation'; controller: AbortController } | null = null;

  constructor(private readonly transport: AccountTransport) {}

  reset(): void {
    this.active?.controller.abort();
    this.negotiatedKey = null;
    this.catalog = null;
    this.catalogKey = null;
  }

  private check(context: AccountContext, signal?: AbortSignal): void {
    if (signal?.aborted) throw new PilotClientError('context_changed');
    if (this.transport.context().key !== context.key) throw new PilotClientError('context_changed');
  }

  private async exclusive<T>(
    kind: 'read' | 'mutation',
    work: (context: AccountContext, signal: AbortSignal) => Promise<T>,
    options: { preemptRead?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.active) {
      if (!options.preemptRead || this.active.kind !== 'read') throw new PilotClientError('conflict');
      this.reset();
    }
    const active = { kind, controller: new AbortController() };
    const signal = options.signal ? AbortSignal.any([options.signal, active.controller.signal]) : active.controller.signal;
    this.active = active;
    let context: AccountContext | undefined;
    try { context = this.transport.context(); return await work(context, signal); }
    catch (error) {
      if (this.active === active && !signal.aborted && error instanceof PilotClientError && ['unauthorized', 'session_revoked'].includes(error.code)) {
        if (context) {
          this.check(context, signal);
          this.reset();
          await this.transport.clear();
        }
      }
      throw error;
    }
    finally { if (this.active === active) this.active = null; }
  }

  private async negotiate(context: AccountContext, signal: AbortSignal): Promise<void> {
    this.check(context, signal);
    if (this.negotiatedKey === context.key) return;
    const request = {
      negotiation_version: '1.0', type: 'negotiate',
      request_id: this.transport.id(), supported_versions: ['2.0'],
    };
    let response: unknown;
    try {
      response = await this.transport.send('/pilot/extensions/negotiate', request, request.request_id, signal);
    } catch (error) {
      if (error instanceof PilotClientError && error.code === 'not_found') throw new PilotClientError('extension_unavailable');
      throw error;
    }
    this.check(context, signal);
    if (!validateContentMessage(response) || !validateContentResponse(request, response) || response.type !== 'negotiated') {
      throw new PilotClientError('invalid_response');
    }
    if (response.selected_version !== '2.0') throw new PilotClientError('extension_unavailable');
    this.negotiatedKey = context.key;
  }

  private async request<T>(context: AccountContext, operation: string, body: object, signal: AbortSignal): Promise<T> {
    this.check(context, signal);
    const request = { contract_version: '2.0', type: 'request', account_id: context.accountId,
      request_id: this.transport.id(), operation, body };
    if (!validateContentMessage(request)) throw new PilotClientError('invalid_configuration');
    const response = await this.transport.send('/pilot/v2/account/requests', request, request.request_id, signal);
    this.check(context, signal);
    if (!validateContentMessage(response) || !validateContentResponse(request, response) || response.type !== 'response') {
      throw new PilotClientError('invalid_response');
    }
    return response.result as T;
  }

  getCatalog(signal?: AbortSignal): Promise<PilotAccountCatalog> {
    return this.exclusive('read', async (context, signal) => {
      // A failed refresh must not leave a catalog eligible for mutations.
      this.catalog = null;
      this.catalogKey = null;
      await this.negotiate(context, signal);
      const identity = await this.request<PilotAccountIdentity>(context, 'account.get', {}, signal);
      if (identity.account_id !== context.accountId || identity.session_id !== context.sessionId) throw new PilotClientError('invalid_response');
      const sessions: PilotAccountSession[] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let first: Page | null = null;
      let continuation: { snapshot_id: string; cursor: string } | undefined;
      let bytes = 0;
      do {
        const result = await this.request<{ page: Page; items: PilotAccountSession[] }>(context, 'sessions.list', continuation ? { continuation } : {}, signal);
        const page = result.page;
        bytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;
        if (bytes > 64 * 1024 * 1024) throw new PilotClientError('resource_limit');
        if (Date.parse(page.expires_at) <= this.transport.now()) throw new PilotClientError('snapshot_expired');
        if (page.revision !== identity.revision) throw new PilotClientError('stale_revision');
        if (page.offset !== sessions.length || (first &&
          (['snapshot_id', 'revision', 'observed_at', 'expires_at', 'export_policy_revision', 'total'] as const)
            .some((key) => page[key] !== first![key]))) throw new PilotClientError('invalid_response');
        first ??= page;
        for (const session of result.items) {
          if (ids.has(session.session_id)) throw new PilotClientError('invalid_response');
          ids.add(session.session_id);
          sessions.push(session);
        }
        if (page.next_cursor !== null) {
          if (result.items.length === 0 || cursors.has(page.next_cursor)) throw new PilotClientError('invalid_response');
          cursors.add(page.next_cursor);
          continuation = { snapshot_id: page.snapshot_id, cursor: page.next_cursor };
        } else continuation = undefined;
      } while (continuation);
      this.check(context, signal);
      if (!sessions.some((session) => session.session_id === context.sessionId && session.state === 'active')) throw new PilotClientError('invalid_response');
      const catalog = { identity, sessions, revision: identity.revision };
      this.catalog = structuredClone(catalog);
      this.catalogKey = context.key;
      return catalog;
    }, { signal });
  }

  mutate(operation: 'session.revoke' | 'sessions.revoke_all' | 'account.delete' | 'session.logout', target?: string | PilotAccountConfirmation): Promise<{ revocationConfirmed: boolean }> {
    return this.exclusive('mutation', async (context, signal) => {
      const catalog = this.catalogKey === context.key ? this.catalog : null;
      if (operation !== 'session.logout' && !catalog) throw new PilotClientError('stale_revision');
      if (operation === 'session.revoke' && (typeof target !== 'string' || !catalog!.sessions.some((session) => session.session_id === target && session.state === 'active'))) {
        throw new PilotClientError('forbidden');
      }
      if (operation === 'account.delete' && (typeof target !== 'object' || target === null ||
        (['account_id', 'session_id', 'login', 'subject'] as const).some((key) => target[key] !== catalog!.identity[key]))) {
        throw new PilotClientError('invalid_configuration');
      }
      const self = operation !== 'session.revoke' || target === context.sessionId;
      let submitted = false;
      try {
        await this.negotiate(context, signal);
        const body = { idempotency_key: this.transport.id(),
          ...(operation !== 'session.logout' ? { expected_revision: catalog!.revision } : {}),
          ...(operation === 'session.revoke' ? { session_id: target } : {}),
          ...(operation === 'account.delete' ? { confirmation: 'delete_cloud_account' } : {}) };
        submitted = true;
        await this.request(context, operation, body, signal);
        this.reset();
        if (self) await this.transport.clear();
        return { revocationConfirmed: true };
      } catch (error) {
        // A caller may lose its terminal acknowledgement at the revocation boundary.
        // Never replay this mutation with the invalidated bearer.
        const uncertain = error instanceof PilotClientError && ['offline', 'unauthorized', 'session_revoked', 'invalid_response', 'response_too_large', 'redirect_refused'].includes(error.code);
        if ((self && submitted && uncertain) || operation === 'session.logout') {
          try { this.check(context); }
          catch { throw error; }
          this.reset();
          await this.transport.clear();
          return { revocationConfirmed: false };
        }
        this.catalog = null;
        this.catalogKey = null;
        throw error;
      }
    }, { preemptRead: operation === 'session.logout' });
  }
}
