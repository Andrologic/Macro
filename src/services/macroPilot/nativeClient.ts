import { PilotAccountClient, type PilotAccountConfirmation } from './accountClient';
import { validateContentMessage, validateContentResponse } from './contentProtocol';
export type { PilotAccountCatalog, PilotAccountConfirmation } from './accountClient';
import { tauriFetch } from '../tauriHttp';
import {
  pilotSecretDelete,
  pilotSecretRead,
  pilotSecretWrite,
  stateGetSnapshot,
  stateSetValue,
  type PilotSecretKind,
  type PilotSecretScope,
} from '../tauriIpc';

const TRANSPORT_VERSION = '1.0' as const;
const CONTRACT_VERSION = '1.0' as const;
const STATE_KEY = 'macro_pilot_native_v1';
const MAX_BODY_BYTES = 1_048_576;
const GITHUB_DEVICE_VERIFICATION_URI = 'https://github.com/login/device';
const PILOT_PERMISSIONS = new Set<PilotPermission>([
  'supervise',
  'respond',
  'approve_tools',
  'review',
]);

export type PilotPermission = 'supervise' | 'respond' | 'approve_tools' | 'review';
export type PilotConnectionState =
  | 'unconfigured'
  | 'signed_out'
  | 'authorizing'
  | 'confirming_account'
  | 'connected'
  | 'offline'
  | 'vault_unavailable';

export interface PilotAccount {
  contract_version: '1.0';
  type: 'account';
  account_id: string;
  identity: {
    provider: 'github';
    subject: string;
    login: string;
    display_name?: string;
    avatar_url?: string;
  };
  revision: number;
}

export interface PilotDeviceSession {
  contract_version: '1.0';
  type: 'device_session';
  ref: { type: 'session'; account_id: string; session_id: string };
  device_id: string;
  state: 'active' | 'revoked' | 'expired';
  issued_at: string;
  expires_at?: string;
  revoked_at?: string;
  revision: number;
}

export interface PilotInstance {
  contract_version: '1.0';
  type: 'instance';
  ref: { type: 'instance'; instance_id: string };
  label: string;
  connection_state: 'reachable' | 'unreachable' | 'revoked';
  supported_contract_versions: string[];
  last_seen_at?: string;
  revision: number;
}

export interface PilotInstanceAccess {
  contract_version: '1.0';
  type: 'instance_access';
  ref: {
    type: 'instance_access';
    account_id: string;
    session_id: string;
    instance_id: string;
  };
  state: 'granted' | 'revoked';
  permissions: PilotPermission[];
  granted_at: string;
  revoked_at?: string;
  revision: number;
}

export interface PilotAccessRequest {
  access_request_id: string;
  device_session: PilotDeviceSession;
  device_label: string;
  expires_at: string;
}

export interface PilotAuthAttempt {
  attemptKey: string;
  attemptId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number;
  identifiedAccount?: PilotAccount;
}

export interface PilotPublicState {
  status: PilotConnectionState;
  configurationId: string | null;
  relayOrigin: string | null;
  account: PilotAccount | null;
  deviceSession: PilotDeviceSession | null;
  instance: PilotInstance | null;
  instanceAccess: PilotInstanceAccess | null;
  attempt: PilotAuthAttempt | null;
  lastError: PilotClientErrorCode | null;
  logoutRevocationConfirmed: boolean | null;
}

interface PersistedPilotState {
  configurationId: string;
  relayOrigin: string | null;
  account: PilotAccount | null;
  deviceSession: PilotDeviceSession | null;
  instance: PilotInstance | null;
  instanceAccess: PilotInstanceAccess | null;
  instanceCreationId: string | null;
  pendingInstanceLabel: string | null;
  pendingSecretCleanup: PilotSecretScope[];
  attempt: PilotAuthAttempt | null;
}

export type PilotClientErrorCode =
  | 'extension_unavailable'
  | 'snapshot_expired'
  | 'resource_limit'
  | 'context_changed'
  | 'invalid_configuration'
  | 'invalid_response'
  | 'response_too_large'
  | 'redirect_refused'
  | 'unauthorized'
  | 'session_revoked'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'stale_revision'
  | 'unavailable'
  | 'vault_unavailable'
  | 'offline';

export class PilotClientError extends Error {
  constructor(
    public readonly code: PilotClientErrorCode,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly requestId?: string,
  ) {
    super(code);
    this.name = 'PilotClientError';
  }
}

export interface PilotRequestOptions {
  authenticated?: boolean;
  producer?: boolean;
  signal?: AbortSignal;
  authorizationToken?: string;
}

export interface PilotResponse<T = unknown> {
  status: number;
  data: T | null;
  requestId: string;
}

export interface PilotClientDependencies {
  fetch: typeof tauriFetch;
  getStateSnapshot: typeof stateGetSnapshot;
  setStateValue: typeof stateSetValue;
  secretRead: typeof pilotSecretRead;
  secretWrite: typeof pilotSecretWrite;
  secretDelete: typeof pilotSecretDelete;
  randomBytes: (size: number) => Uint8Array;
  sha256: (value: Uint8Array) => Promise<Uint8Array>;
  now: () => Date;
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const randomBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
};

const defaultDependencies: PilotClientDependencies = {
  fetch: tauriFetch,
  getStateSnapshot: stateGetSnapshot,
  setStateValue: stateSetValue,
  secretRead: pilotSecretRead,
  secretWrite: pilotSecretWrite,
  secretDelete: pilotSecretDelete,
  randomBytes,
  sha256: async (value) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer)),
  now: () => new Date(),
};

const createOpaqueId = (prefix: string, dependencies: PilotClientDependencies): string =>
  `${prefix}:${base64Url(dependencies.randomBytes(18))}`;

const createSecret = (dependencies: PilotClientDependencies): string =>
  base64Url(dependencies.randomBytes(32));

const normalizeOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PilotClientError('invalid_configuration');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new PilotClientError('invalid_configuration');
  }
  return url.origin;
};

const safePath = (path: string): string => {
  if (!path.startsWith('/') || path.includes('://') || path.includes('..') || path.includes('?') || path.includes('#')) {
    throw new PilotClientError('invalid_configuration');
  }
  // A1 opaque identifiers use ':' as a literal path character in relay routes.
  // Preserve it while leaving reserved separators such as encoded '/' escaped.
  return path.replace(/%3a/gi, ':');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorCodeForStatus = (status: number, data: unknown): PilotClientErrorCode => {
  const remoteCode = isRecord(data) && typeof data.code === 'string'
    ? data.code
    : isRecord(data) && isRecord(data.error) && typeof data.error.code === 'string'
      ? data.error.code
      : null;
  if (remoteCode === 'session_revoked') return 'session_revoked';
  if (remoteCode === 'stale_revision') return 'stale_revision';
  if (remoteCode === 'snapshot_expired') return 'snapshot_expired';
  if (remoteCode === 'resource_limit') return 'resource_limit';
  if (remoteCode === 'unsupported_version') return 'extension_unavailable';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429 || status === 503) return 'unavailable';
  return 'invalid_response';
};

// Abort even when a transport promise does not settle promptly after cancellation.
const abortable = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const aborted = () => { reject(new PilotClientError('offline')); };
  if (signal.aborted) aborted();
  else signal.addEventListener('abort', aborted, { once: true });
  void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
});

const readBoundedJson = async (response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> => {
  if (response.status === 204 || response.status === 205) return null;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new PilotClientError('response_too_large', response.status);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (signal.aborted) throw new PilotClientError('offline');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new PilotClientError('response_too_large', response.status);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new PilotClientError('invalid_response', response.status); }
  } catch (error) {
    cancel();
    if (error instanceof PilotClientError) throw error;
    throw new PilotClientError('offline', response.status);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
};

const emptyPublicState = (): PilotPublicState => ({
  status: 'unconfigured',
  configurationId: null,
  relayOrigin: null,
  account: null,
  deviceSession: null,
  instance: null,
  instanceAccess: null,
  attempt: null,
  lastError: null,
  logoutRevocationConfirmed: null,
});

const emptyPersistedState = (configurationId: string): PersistedPilotState => ({
  configurationId,
  relayOrigin: null,
  account: null,
  deviceSession: null,
  instance: null,
  instanceAccess: null,
  instanceCreationId: null,
  pendingInstanceLabel: null,
  pendingSecretCleanup: [],
  attempt: null,
});

export class MacroPilotNativeClient {
  private publicState = emptyPublicState();
  private persisted: PersistedPilotState | null = null;
  private initializationPromise: Promise<PilotPublicState> | null = null;
  private persistenceTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private scopeController = new AbortController();
  private readonly pendingReads = new Set<AbortController>();
  private readonly accountClient = new PilotAccountClient({
    context: () => {
      const state = this.persisted;
      if (!this.publicState.deviceSession || !state?.deviceSession || !state.account) throw new PilotClientError('unauthorized');
      return { key: this.contextKey(), accountId: state.account.account_id, sessionId: state.deviceSession.ref.session_id };
    },
    id: () => createOpaqueId('request', this.dependencies),
    now: () => this.dependencies.now().getTime(),
    send: async (path, body, requestId, signal) => (await this.sendRequest('POST', path, body, { authenticated: true, signal }, true, requestId)).data,
    clear: () => this.clearSession(),
  });

  private contextKey(): string {
    return JSON.stringify([this.epoch, this.persisted?.configurationId, this.persisted?.relayOrigin,
      this.persisted?.account?.account_id, this.persisted?.deviceSession?.ref.session_id, this.persisted?.attempt?.attemptKey]);
  }

  private checkContext(key: string): void {
    if (this.contextKey() !== key) throw new PilotClientError('context_changed');
  }

  getAccountCatalog = (signal?: AbortSignal) => this.accountClient.getCatalog(signal);
  revokeSession = (sessionId: string) => this.accountClient.mutate('session.revoke', sessionId);
  revokeAllSessions = () => this.accountClient.mutate('sessions.revoke_all');
  deleteAccount = (confirmation: PilotAccountConfirmation) => this.accountClient.mutate('account.delete', confirmation);

  constructor(private readonly dependencies: PilotClientDependencies = defaultDependencies) {}

  getState = (): PilotPublicState => this.publicState;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<PilotPublicState>): void {
    this.publicState = { ...this.publicState, ...patch };
    for (const listener of this.listeners) listener();
  }

  private persist(patch: Partial<PersistedPilotState>): Promise<void> {
    const context = this.contextKey();
    const write = this.persistenceTail.then(async () => {
      this.checkContext(context);
      if (!this.persisted) throw new PilotClientError('invalid_configuration');
      const next = { ...this.persisted, ...patch };
      try { await this.dependencies.setStateValue(STATE_KEY, next); }
      catch (error) { this.checkContext(context); throw error; }
      // A logout may have invalidated this write while native storage was busy.
      // Its queued tombstone must finish before logout reports completion.
      this.checkContext(context);
      this.persisted = next;
    });
    this.persistenceTail = write.catch(() => undefined);
    return write;
  }

  private secretScope(kind: PilotSecretKind, resourceId: string): PilotSecretScope {
    if (!this.persisted?.relayOrigin) throw new PilotClientError('invalid_configuration');
    return {
      configuration_id: this.persisted.configurationId,
      relay_origin: this.persisted.relayOrigin,
      kind,
      resource_id: resourceId,
    };
  }

  private async readSecret(kind: PilotSecretKind, resourceId: string): Promise<string> {
    try {
      const value = await this.dependencies.secretRead(this.secretScope(kind, resourceId));
      if (!value) throw new PilotClientError('unauthorized');
      return value;
    } catch (error) {
      if (error instanceof PilotClientError) throw error;
      this.publish({ status: 'vault_unavailable', lastError: 'vault_unavailable' });
      throw new PilotClientError('vault_unavailable');
    }
  }

  initialize(): Promise<PilotPublicState> {
    if (this.initializationPromise) return this.initializationPromise;
    const initialization = this.initializeOnce();
    this.initializationPromise = initialization;
    void initialization.then(
      () => {
        if (this.initializationPromise === initialization) this.initializationPromise = null;
      },
      () => {
        if (this.initializationPromise === initialization) this.initializationPromise = null;
      },
    );
    return initialization;
  }

  private async initializeOnce(): Promise<PilotPublicState> {
    const epoch = this.epoch;
    await this.persistenceTail;
    if (epoch !== this.epoch) throw new PilotClientError('context_changed');
    const snapshot = await this.dependencies.getStateSnapshot();
    if (epoch !== this.epoch) throw new PilotClientError('context_changed');
    const raw = snapshot.values[STATE_KEY];
    const configurationId = isRecord(raw) && typeof raw.configurationId === 'string'
      ? raw.configurationId
      : createOpaqueId('config', this.dependencies);
    this.persisted = isRecord(raw)
      ? { ...emptyPersistedState(configurationId), ...raw, configurationId } as PersistedPilotState
      : emptyPersistedState(configurationId);
    if (!isRecord(raw)) await this.persist({});
    await this.cleanupPendingSecrets();
    const configured = Boolean(this.persisted.relayOrigin);
    this.publish({
      configurationId,
      relayOrigin: this.persisted.relayOrigin,
      account: this.persisted.account,
      deviceSession: this.persisted.deviceSession,
      instance: this.persisted.instance,
      instanceAccess: this.persisted.instanceAccess,
      attempt: this.persisted.deviceSession ? null : this.persisted.attempt,
      status: this.persisted.deviceSession ? 'offline' : configured ? 'signed_out' : 'unconfigured',
      lastError: null,
    });
    if (!this.persisted.deviceSession) return this.publicState;
    await this.finishClaimCleanup();
    if (epoch !== this.epoch) throw new PilotClientError('context_changed');
    try {
      const context = this.contextKey();
      const response = await this.request<{ account: PilotAccount; device_session: PilotDeviceSession }>(
        'GET', '/me', undefined, { authenticated: true },
      );
      this.checkContext(context);
      await this.persist({ account: response.data!.account, deviceSession: response.data!.device_session });
      this.checkContext(context);
      this.publish({ account: response.data!.account, deviceSession: response.data!.device_session, status: 'connected' });
    } catch (error) {
      if (epoch !== this.epoch) throw new PilotClientError('context_changed');
      if (error instanceof PilotClientError && error.code === 'context_changed') throw error;
      if (error instanceof PilotClientError && (error.code === 'unauthorized' || error.code === 'session_revoked')) {
        await this.clearSession();
      } else if (error instanceof PilotClientError && error.code === 'vault_unavailable') {
        // readSecret already published the precise state.
      } else {
        this.publish({ status: 'offline', lastError: 'offline' });
      }
    }
    return this.publicState;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: PilotRequestOptions = {},
  ): Promise<PilotResponse<T>> {
    return this.sendRequest<T>(method, path, body, options);
  }

  private async sendRequest<T = unknown>(
    method: string, path: string, body: unknown, options: PilotRequestOptions,
    extension = false, requestId = createOpaqueId('request', this.dependencies),
  ): Promise<PilotResponse<T>> {
    const readController = method === 'GET' ? new AbortController() : null;
    if (readController) this.pendingReads.add(readController);
    const signal = readController
      ? AbortSignal.any([readController.signal, ...(options.signal ? [options.signal] : [])])
      : options.signal;
    try { return await this.sendRequestOnce<T>(method, path, body, { ...options, signal }, extension, requestId); }
    finally { if (readController) this.pendingReads.delete(readController); }
  }

  private async sendRequestOnce<T = unknown>(
    method: string, path: string, body: unknown, options: PilotRequestOptions,
    extension: boolean, requestId: string,
  ): Promise<PilotResponse<T>> {
    if (!this.persisted?.relayOrigin) throw new PilotClientError('invalid_configuration');
    const context = this.contextKey();
    const signals = [this.scopeController.signal];
    if (options.signal) signals.push(options.signal);
    if (extension) signals.push(AbortSignal.timeout(30_000));
    const signal = AbortSignal.any(signals);
    const check = () => {
      this.checkContext(context);
      if (options.signal?.aborted) throw new PilotClientError('context_changed');
      if (signal.aborted) throw new PilotClientError('offline');
    };
    const url = `${normalizeOrigin(this.persisted.relayOrigin)}${extension ? '' : '/pilot/v1'}${safePath(path)}`;
    const headers = new Headers({ Accept: 'application/json', 'X-Request-Id': requestId });
    if (body !== undefined) headers.set('Content-Type', 'application/json; charset=utf-8');
    let token = options.authorizationToken;
    if (options.authenticated && !this.publicState.deviceSession) throw new PilotClientError('unauthorized');
    if (options.authenticated && !token) {
      const sessionId = this.persisted.deviceSession?.ref.session_id;
      if (!sessionId) throw new PilotClientError('unauthorized');
      token = await this.readSecret('session_token', sessionId);
    }
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.producer) {
      if (!this.persisted.instanceCreationId) throw new PilotClientError('unauthorized');
      headers.set('X-Instance-Key', await this.readSecret('instance_key', this.persisted.instanceCreationId));
    }
    check();
    let response: Response;
    try {
      const fetching = this.dependencies.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        maxRedirections: 0,
      });
      // A late response after an abort must not retain an unread native body.
      void fetching.then(result => { if (signal.aborted) void result.body?.cancel().catch(() => undefined); }, () => undefined);
      response = await abortable(fetching, signal);
    } catch (error) {
      check();
      if (error instanceof PilotClientError) throw error;
      if (options.authenticated) {
        this.publish({ status: 'offline', lastError: 'offline' });
      }
      throw new PilotClientError('offline');
    }
    check();
    if (response.url && response.url !== url) {
      void response.body?.cancel().catch(() => undefined);
      throw new PilotClientError('redirect_refused', response.status);
    }
    let data: unknown;
    try { data = await readBoundedJson(response, extension ? 256 * 1024 : MAX_BODY_BYTES, signal); }
    catch (error) {
      check();
      if (options.authenticated && error instanceof PilotClientError && error.code === 'offline') {
        this.publish({ status: 'offline', lastError: 'offline' });
      }
      throw error;
    }
    check();
    const responseRequestId = response.headers.get('x-request-id') || requestId;
    if (
      !extension && isRecord(data) &&
      (('transport_version' in data && data.transport_version !== TRANSPORT_VERSION) ||
        ('contract_version' in data && data.contract_version !== CONTRACT_VERSION))
    ) {
      throw new PilotClientError('invalid_response', response.status, false, responseRequestId);
    }
    if (extension) {
      const responseHeader = response.headers.get('x-request-id');
      if (responseHeader && responseHeader !== requestId) throw new PilotClientError('invalid_response');
      // Before authentication the relay may return a transport error, with no account envelope.
      if (response.ok || (isRecord(data) && data.contract_version === '2.0')) {
        if (!validateContentMessage(data) || !validateContentResponse(body, data)) throw new PilotClientError('invalid_response');
      }
    }
    if (!response.ok || (extension && isRecord(data) && data.type === 'error')) {
      const code = errorCodeForStatus(response.status, data);
      if (
        options.authenticated &&
        (code === 'unauthorized' || code === 'session_revoked')
      ) {
        // The account mutation caller handles self-revocation acknowledgement loss.
        if (!extension) await this.clearSession();
      }
      throw new PilotClientError(code, response.status, response.status === 429 || response.status === 503, responseRequestId);
    }
    if (options.authenticated && this.publicState.status === 'offline') {
      this.publish({ status: 'connected', lastError: null });
    }
    return { status: response.status, data: data as T | null, requestId: responseRequestId };
  }

  async connect(relayOrigin: string, deviceLabel: string): Promise<PilotAuthAttempt> {
    if (!this.persisted) await this.initialize();
    await this.cleanupPendingSecrets();
    const origin = normalizeOrigin(relayOrigin.trim());
    if (!deviceLabel.trim() || deviceLabel.trim().length > 120) {
      throw new PilotClientError('invalid_configuration');
    }
    if (this.persisted!.deviceSession) {
      throw new PilotClientError('invalid_configuration');
    }
    this.epoch += 1;
    this.scopeController.abort();
    this.scopeController = new AbortController();
    this.accountClient.reset();
    await this.persist({ relayOrigin: origin });
    this.publish({ relayOrigin: origin, status: 'authorizing', lastError: null });
    const attemptKey = createOpaqueId('attempt', this.dependencies);
    const claimSecret = createSecret(this.dependencies);
    const challenge = base64Url(await this.dependencies.sha256(new TextEncoder().encode(claimSecret)));
    try {
      await this.dependencies.secretWrite(this.secretScope('claim_secret', attemptKey), claimSecret);
      const response = await this.request<{
        attempt_id: string; poll_secret: string; user_code: string; verification_uri: string;
        expires_at: string; interval: number;
      }>('POST', '/auth/attempts', {
        transport_version: TRANSPORT_VERSION,
        client_kind: 'desktop',
        device_label: deviceLabel.trim(),
        claim_challenge: challenge,
      });
      const data = response.data!;
      if (data.verification_uri !== GITHUB_DEVICE_VERIFICATION_URI) {
        throw new PilotClientError('invalid_response', response.status);
      }
      await this.dependencies.secretWrite(this.secretScope('poll_secret', attemptKey), data.poll_secret);
      const attempt: PilotAuthAttempt = {
        attemptKey,
        attemptId: data.attempt_id,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresAt: data.expires_at,
        interval: Math.max(5, data.interval),
      };
      await this.persist({ attempt });
      this.publish({ attempt, status: 'authorizing' });
      return attempt;
    } catch (error) {
      await Promise.all((['claim_secret', 'poll_secret'] as const).map((kind) =>
        this.dependencies.secretDelete(this.secretScope(kind, attemptKey)).catch(() => undefined),
      ));
      if (!(error instanceof PilotClientError)) {
        this.publish({ status: 'vault_unavailable', lastError: 'vault_unavailable' });
        throw new PilotClientError('vault_unavailable');
      }
      this.publish({ status: 'signed_out', lastError: error.code });
      throw error;
    }
  }

  async pollAuth(signal?: AbortSignal): Promise<PilotAccount | null> {
    const attempt = this.persisted?.attempt;
    if (!attempt) throw new PilotClientError('invalid_configuration');
    if (this.dependencies.now().getTime() >= new Date(attempt.expiresAt).getTime()) {
      await this.clearAttempt();
      throw new PilotClientError('unauthorized');
    }
    const pollSecret = await this.readSecret('poll_secret', attempt.attemptKey);
    const response = await this.request<{ status: 'pending'; interval: number } | { status: 'identified'; account: PilotAccount }>(
      'POST', `/auth/attempts/${encodeURIComponent(attempt.attemptId)}/poll`,
      { transport_version: TRANSPORT_VERSION },
      { authorizationToken: pollSecret, signal },
    );
    if (response.data!.status === 'pending') {
      const nextAttempt = { ...attempt, interval: Math.max(5, response.data!.interval) };
      await this.persist({ attempt: nextAttempt });
      this.publish({ attempt: nextAttempt, status: 'authorizing' });
      return null;
    }
    const nextAttempt = { ...attempt, identifiedAccount: response.data!.account };
    await this.persist({ attempt: nextAttempt });
    this.publish({ attempt: nextAttempt, status: 'confirming_account' });
    return response.data!.account;
  }

  async confirmAccount(accountId: string): Promise<PilotDeviceSession> {
    const attempt = this.persisted?.attempt;
    if (!attempt?.identifiedAccount || attempt.identifiedAccount.account_id !== accountId) {
      throw new PilotClientError('invalid_configuration');
    }
    if (this.dependencies.now().getTime() >= new Date(attempt.expiresAt).getTime()) {
      await this.clearAttempt();
      throw new PilotClientError('unauthorized');
    }
    const [pollSecret, claimSecret] = await Promise.all([
      this.readSecret('poll_secret', attempt.attemptKey),
      this.readSecret('claim_secret', attempt.attemptKey),
    ]);
    const response = await this.request<{
      account: PilotAccount; device_session: PilotDeviceSession; session_token: string;
    }>('POST', `/auth/attempts/${encodeURIComponent(attempt.attemptId)}/claim`, {
      transport_version: TRANSPORT_VERSION,
      account_id: accountId,
      claim_secret: claimSecret,
    }, { authorizationToken: pollSecret }).catch(async (error: unknown) => {
      if (error instanceof PilotClientError && (error.code === 'unauthorized' || error.code === 'not_found')) {
        await this.clearAttempt();
      }
      throw error;
    });
    const data = response.data!;
    const sessionScope = this.secretScope('session_token', data.device_session.ref.session_id);
    await this.dependencies.secretWrite(sessionScope, data.session_token);
    try {
      // Keep the attempt identifier until its secrets have been cleaned up.
      await this.persist({ account: data.account, deviceSession: data.device_session });
    } catch {
      await this.dependencies.secretDelete(sessionScope).catch(() => undefined);
      this.publish({ status: 'vault_unavailable', lastError: 'vault_unavailable' });
      throw new PilotClientError('vault_unavailable');
    }
    await this.finishClaimCleanup();
    this.publish({
      account: data.account,
      deviceSession: data.device_session,
      attempt: null,
      status: 'connected',
      lastError: null,
    });
    return data.device_session;
  }

  async createOrAttachInstance(input: { label?: string; instanceId?: string } = {}): Promise<PilotInstance> {
    if (!this.persisted?.deviceSession) throw new PilotClientError('unauthorized');
    const existingId = input.instanceId || this.persisted.instance?.ref.instance_id;
    if (existingId && this.persisted.instanceCreationId) {
      const response = await this.request<{ instance: PilotInstance; instance_access: PilotInstanceAccess }>(
        'POST', `/instances/${encodeURIComponent(existingId)}/attach`,
        { transport_version: TRANSPORT_VERSION }, { authenticated: true, producer: true },
      );
      await this.persist({ instance: response.data!.instance, instanceAccess: response.data!.instance_access });
      this.publish({ instance: response.data!.instance, instanceAccess: response.data!.instance_access });
      return response.data!.instance;
    }
    const label = this.persisted.pendingInstanceLabel || input.label?.trim();
    if (!label || label.length > 120) throw new PilotClientError('invalid_configuration');
    const creationId = this.persisted.instanceCreationId || createOpaqueId('creation', this.dependencies);
    const instanceKey = this.persisted.instanceCreationId
      ? await this.readSecret('instance_key', creationId)
      : createSecret(this.dependencies);
    const instanceKeyHash = base64Url(await this.dependencies.sha256(new TextEncoder().encode(instanceKey)));
    if (!this.persisted.instanceCreationId) {
      await this.dependencies.secretWrite(this.secretScope('instance_key', creationId), instanceKey);
      try {
        await this.persist({ instanceCreationId: creationId, pendingInstanceLabel: label });
      } catch (error) {
        await this.dependencies.secretDelete(this.secretScope('instance_key', creationId)).catch(() => undefined);
        throw error;
      }
    }
    const response = await this.request<{ instance: PilotInstance; instance_access: PilotInstanceAccess }>(
      'POST', '/instances', {
        transport_version: TRANSPORT_VERSION,
        creation_id: creationId,
        label,
        instance_key_hash: instanceKeyHash,
      }, { authenticated: true },
    );
    await this.persist({
      instance: response.data!.instance,
      instanceAccess: response.data!.instance_access,
      pendingInstanceLabel: null,
    });
    this.publish({ instance: response.data!.instance, instanceAccess: response.data!.instance_access });
    return response.data!.instance;
  }

  async listAccessRequests(signal?: AbortSignal): Promise<PilotAccessRequest[]> {
    const instanceId = this.persisted?.instance?.ref.instance_id;
    if (!instanceId) throw new PilotClientError('invalid_configuration');
    const response = await this.request<{ requests: PilotAccessRequest[] }>(
      'GET', `/instances/${encodeURIComponent(instanceId)}/access-requests`, undefined,
      { authenticated: true, producer: true, signal },
    );
    return response.data!.requests;
  }

  async resolveAccess(
    accessRequestId: string,
    verdict: 'grant' | 'deny',
  ): Promise<'granted' | 'denied'> {
    const instanceId = this.persisted?.instance?.ref.instance_id;
    if (!instanceId) throw new PilotClientError('invalid_configuration');
    const body: Record<string, unknown> = { transport_version: TRANSPORT_VERSION, verdict };
    if (verdict === 'grant') body.permissions = [...PILOT_PERMISSIONS];
    const response = await this.request<{ status: 'granted' | 'denied' }>(
      'POST', `/instances/${encodeURIComponent(instanceId)}/access-requests/${encodeURIComponent(accessRequestId)}/resolve`,
      body, { authenticated: true, producer: true },
    );
    return response.data!.status;
  }

  async logout(): Promise<{ revocationConfirmed: boolean }> {
    for (const controller of this.pendingReads) controller.abort();
    if (!this.persisted?.deviceSession) {
      await this.clearSession();
      return { revocationConfirmed: false };
    }
    const result = await this.accountClient.mutate('session.logout');
    this.publish({ logoutRevocationConfirmed: result.revocationConfirmed });
    return result;
  }

  private async finishClaimCleanup(): Promise<void> {
    const attempt = this.persisted?.attempt;
    if (!this.persisted?.deviceSession || !attempt) return;
    try {
      await this.clearAttemptSecrets(attempt);
      await this.persist({ attempt: null });
    } catch {
      // The session is durable. Retain the attempt identifier to retry cleanup on startup.
    }
  }

  private async clearAttemptSecrets(attempt: PilotAuthAttempt): Promise<void> {
    await Promise.all([
      this.dependencies.secretDelete(this.secretScope('claim_secret', attempt.attemptKey)),
      this.dependencies.secretDelete(this.secretScope('poll_secret', attempt.attemptKey)),
    ]);
  }

  private async clearAttempt(): Promise<void> {
    const attempt = this.persisted?.attempt;
    if (attempt) await this.clearAttemptSecrets(attempt);
    await this.persist({ attempt: null });
    this.publish({ attempt: null, status: 'signed_out' });
  }

  private async cleanupPendingSecrets(): Promise<void> {
    const pending = this.persisted?.pendingSecretCleanup || [];
    if (!pending.length) return;
    const results = await Promise.allSettled(pending.map((scope) => this.dependencies.secretDelete(scope)));
    const remaining = pending.filter((_, index) => results[index].status === 'rejected');
    await this.persist({ pendingSecretCleanup: remaining });
    if (remaining.length) {
      this.publish({ status: 'vault_unavailable', lastError: 'vault_unavailable' });
      throw new PilotClientError('vault_unavailable');
    }
  }

  private async clearSession(): Promise<void> {
    this.epoch += 1;
    this.scopeController.abort();
    this.scopeController = new AbortController();
    this.accountClient.reset();
    const pending = [...(this.persisted?.pendingSecretCleanup || [])];
    const sessionId = this.persisted?.deviceSession?.ref.session_id;
    if (sessionId) pending.push(this.secretScope('session_token', sessionId));
    if (this.persisted?.instanceCreationId) pending.push(this.secretScope('instance_key', this.persisted.instanceCreationId));
    if (this.persisted?.attempt) {
      pending.push(this.secretScope('claim_secret', this.persisted.attempt.attemptKey));
      pending.push(this.secretScope('poll_secret', this.persisted.attempt.attemptKey));
    }
    this.publish({ account: null, deviceSession: null, instanceAccess: null, attempt: null, instance: null, status: 'signed_out' });
    // Remove secrets immediately, even when an earlier metadata write is still pending.
    const deletions = Promise.allSettled(pending.map((scope) => this.dependencies.secretDelete(scope)));
    // Only relay metadata is touched. Keep failed vault deletions for the next startup.
    try {
      await this.persist({ account: null, deviceSession: null, instanceAccess: null, attempt: null,
        instance: null, instanceCreationId: null, pendingInstanceLabel: null, pendingSecretCleanup: pending });
    } catch {
      // Even if metadata storage fails, never keep the bearer available for replay.
      await deletions;
      this.publish({ status: 'vault_unavailable', lastError: 'vault_unavailable' });
      throw new PilotClientError('vault_unavailable');
    }
    const results = await deletions;
    const remaining = pending.filter((_, index) => results[index].status === 'rejected');
    await this.persist({ pendingSecretCleanup: remaining });
    if (remaining.length) {
      this.publish({ status: 'vault_unavailable', lastError: 'vault_unavailable' });
      throw new PilotClientError('vault_unavailable');
    }
  }
}

export const macroPilotNativeClient = new MacroPilotNativeClient();
