import type { AgentCodeCheckpointFileSnapshot, AppMode, ProjectMount } from '../types';
import { isRemoteServiceRuntime } from './serviceRuntime';
import { remoteRequest, resolveRemoteConfig } from './providers/remoteHttp';
import { TOOL_OUTPUT_LIMITS } from '../shared/toolOutputLimits';

interface RemoteToolModePolicy {
  allowed_tool_ids: string[];
  enforce_macro_only_writes: boolean;
  capabilities?: string[];
}

const CONTENT_REVISIONS_CAPABILITY = 'content_revisions_v1';
const BOUNDED_TOOL_OUTPUT_CAPABILITY = 'bounded_tool_output_v1';
const BOUNDED_GIT_OUTPUT_CAPABILITY = 'bounded_git_output_v1';
const STRUCTURAL_SEARCH_CAPABILITY = 'structural_search_v1';
const RECOVERABLE_CHECKPOINTS_CAPABILITY = 'recoverable_checkpoints_v1';
const IDEMPOTENT_TOOL_EXECUTION_CAPABILITY = 'idempotent_tool_execution_v1';
const INTERRUPTIBLE_REMOTE_TOOL_IDS = new Set(['list', 'read', 'glob', 'grep', 'ast_grep']);
const MUTATING_REMOTE_TOOL_IDS = new Set([
  'write',
  'edit',
  'delete',
  'apply_patch',
  'git_add',
  'git_commit',
  'git_checkout',
  'git_merge',
  'git_reset',
  'git_stash',
]);
const BOUNDED_OUTPUT_TOOL_IDS = new Set(['list', 'read', 'glob', 'grep', 'ast_grep']);
const BOUNDED_GIT_OUTPUT_TOOL_IDS = new Set([
  'git_status',
  'git_log',
  'git_branch_list',
  'git_diff',
  'git_get_tree',
]);
const REMOTE_MUTATION_RESPONSE_TIMEOUT_MS = 30_000;
const REMOTE_MUTATION_STATUS_POLL_INTERVAL_MS = 500;
const REMOTE_MUTATION_STATUS_POLL_ATTEMPTS = 20;
const REMOTE_MUTATION_INTENT_STORAGE_PREFIX = 'macro.remoteMutationIntent.v1.';

interface DurableRemoteMutationIntent {
  fingerprint: string;
  requestFingerprint: string;
  executionId: string;
  createdAt: string;
}

interface RemoteToolExecutionStatus {
  state: 'pending' | 'completed';
  status_code?: number;
  body?: unknown;
}

const inMemoryRemoteMutationIntents = new Map<string, string>();

const remoteMutationIntentStorage = (): Storage | null => {
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      return globalThis.localStorage;
    }
  } catch {
    // Access can be denied for hardened or opaque webview origins.
  }
  return null;
};

const remoteMutationFingerprint = async (value: string): Promise<string> => {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  if (typeof window !== 'undefined') {
    throw new Error(
      'Remote mutations require Web Crypto to persist a collision-resistant execution identity.',
    );
  }
  // Unit-test runtimes without a DOM use an isolated in-memory store. Production
  // browser/webview runtimes must take the Web Crypto branch above.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `test-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const remoteMutationIntentKey = (fingerprint: string): string =>
  `${REMOTE_MUTATION_INTENT_STORAGE_PREFIX}${fingerprint}`;

const loadDurableRemoteMutationIntent = (
  fingerprint: string,
): DurableRemoteMutationIntent | null => {
  const key = remoteMutationIntentKey(fingerprint);
  const storage = remoteMutationIntentStorage();
  const raw = storage?.getItem(key) ?? inMemoryRemoteMutationIntents.get(key) ?? null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DurableRemoteMutationIntent>;
    if (
      parsed.fingerprint !== fingerprint ||
      typeof parsed.requestFingerprint !== 'string' ||
      parsed.requestFingerprint.trim().length === 0 ||
      typeof parsed.executionId !== 'string' ||
      parsed.executionId.trim().length === 0 ||
      typeof parsed.createdAt !== 'string'
    ) {
      throw new Error('invalid durable mutation intent');
    }
    return parsed as DurableRemoteMutationIntent;
  } catch (error) {
    throw new Error(
      `The durable remote mutation intent is invalid and must be resolved before retrying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const persistDurableRemoteMutationIntent = (intent: DurableRemoteMutationIntent): void => {
  const key = remoteMutationIntentKey(intent.fingerprint);
  const encoded = JSON.stringify(intent);
  const storage = remoteMutationIntentStorage();
  if (storage) {
    try {
      storage.setItem(key, encoded);
      return;
    } catch (error) {
      throw new Error(
        `The remote mutation was not sent because its execution identity could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (typeof window !== 'undefined') {
    throw new Error(
      'The remote mutation was not sent because durable browser storage is unavailable.',
    );
  }
  inMemoryRemoteMutationIntents.set(key, encoded);
};

const clearDurableRemoteMutationIntent = (fingerprint: string): void => {
  const key = remoteMutationIntentKey(fingerprint);
  const storage = remoteMutationIntentStorage();
  if (storage) {
    try {
      storage.removeItem(key);
    } catch {
      // A stale completed identity is safe: the server will replay the same
      // durable result instead of executing the mutation twice.
    }
  }
  inMemoryRemoteMutationIntents.delete(key);
};

export const __remoteKernelApiTestables = {
  resetDurableMutationIntents: (): void => {
    inMemoryRemoteMutationIntents.clear();
    const storage = remoteMutationIntentStorage();
    if (!storage) return;
    const matchingKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(REMOTE_MUTATION_INTENT_STORAGE_PREFIX)) {
        matchingKeys.push(key);
      }
    }
    matchingKeys.forEach((key) => storage.removeItem(key));
  },
};

const requiresContentRevisions = (params: {
  toolId: string;
  args: Record<string, unknown>;
}): boolean => {
  return ['write', 'edit', 'delete', 'apply_patch'].includes(params.toolId);
};

interface RemoteToolValidation {
  allowed: boolean;
  reason?: string | null;
  enforce_macro_only_writes: boolean;
}

type RemoteKernelRequestOptions = RequestInit & { timeoutMs?: number | null };

const remoteKernelRequest = async <T>(
  path: string,
  options: RemoteKernelRequestOptions = {},
): Promise<T> => remoteRequest<T>(path, options);

const invalidResponse = (endpoint: string, response: unknown): never => {
  throw {
    code: 'REMOTE_INVALID_RESPONSE',
    message: `Remote ${endpoint} response did not match its contract`,
    details: response,
  };
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const remoteToolTimeoutMs = (toolId: string): number | null | undefined => {
  if (toolId === 'grep') return TOOL_OUTPUT_LIMITS.grep.timeoutMs + 1_000;
  if (toolId === 'ast_grep') return TOOL_OUTPUT_LIMITS.ast.timeoutMs + 1_000;
  if (toolId === 'read') return TOOL_OUTPUT_LIMITS.read.timeoutMs + 1_000;
  if (toolId === 'list') return TOOL_OUTPUT_LIMITS.list.timeoutMs + 1_000;
  if (toolId === 'glob') return TOOL_OUTPUT_LIMITS.glob.timeoutMs + 1_000;
  if (MUTATING_REMOTE_TOOL_IDS.has(toolId)) return REMOTE_MUTATION_RESPONSE_TIMEOUT_MS;
  return undefined;
};

let remoteToolExecutionCounter = 0;

const createRemoteToolExecutionId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  remoteToolExecutionCounter += 1;
  return `remote-tool-${Date.now()}-${remoteToolExecutionCounter}`;
};

export const cancelRemoteWorkspaceTool = async (executionId: string): Promise<boolean> => {
  const result = await remoteKernelRequest<unknown>('/tools/cancel', {
    method: 'POST',
    body: JSON.stringify({ execution_id: executionId }),
  });
  if (!result || typeof result !== 'object' || typeof (result as Record<string, unknown>).cancelled !== 'boolean') {
    return invalidResponse('tool cancellation', result);
  }
  return (result as { cancelled: boolean }).cancelled;
};

const remoteErrorCode = (error: unknown): string | null => {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

const remoteErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object' || !('details' in error)) return null;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || !('status' in details)) return null;
  const status = (details as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
};

const readRemoteToolExecutionStatus = async (
  executionId: string,
): Promise<RemoteToolExecutionStatus | null> => {
  try {
    const result = await remoteKernelRequest<unknown>(
      `/tools/executions/${encodeURIComponent(executionId)}`,
      { method: 'GET', timeoutMs: REMOTE_MUTATION_RESPONSE_TIMEOUT_MS },
    );
    if (!result || typeof result !== 'object') {
      return invalidResponse('tool execution status', result);
    }
    const status = result as Record<string, unknown>;
    if (
      (status.state !== 'pending' && status.state !== 'completed') ||
      (status.status_code !== undefined && !Number.isInteger(status.status_code))
    ) {
      return invalidResponse('tool execution status', result);
    }
    return status as unknown as RemoteToolExecutionStatus;
  } catch (error) {
    if (remoteErrorStatus(error) === 404) return null;
    throw error;
  }
};

const delayRemoteMutationPoll = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, REMOTE_MUTATION_STATUS_POLL_INTERVAL_MS);
  });
};

const completedRemoteToolExecution = (
  status: RemoteToolExecutionStatus,
): RemoteWorkspaceToolExecution | null => {
  if (status.state !== 'completed') return null;
  const statusCode = status.status_code;
  if (!Number.isInteger(statusCode)) {
    throw new Error('The remote kernel returned a completed execution without a status code.');
  }
  if (Number(statusCode) < 200 || Number(statusCode) >= 300) {
    const body = status.body;
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `Remote mutation failed (${statusCode})`;
    throw {
      code: 'REMOTE_EXECUTION_COMPLETED_ERROR',
      message,
      details: { status: statusCode, body },
    };
  }
  if (!status.body || typeof status.body !== 'object') {
    throw new Error('The remote kernel returned an invalid completed mutation result.');
  }
  return status.body as RemoteWorkspaceToolExecution;
};

const pollRemoteMutationResult = async (
  executionId: string,
): Promise<RemoteWorkspaceToolExecution | null> => {
  for (let attempt = 0; attempt < REMOTE_MUTATION_STATUS_POLL_ATTEMPTS; attempt += 1) {
    const status = await readRemoteToolExecutionStatus(executionId);
    if (status === null) return null;
    const completed = completedRemoteToolExecution(status);
    if (completed) return completed;
    if (attempt + 1 < REMOTE_MUTATION_STATUS_POLL_ATTEMPTS) {
      await delayRemoteMutationPoll();
    }
  }
  throw {
    code: 'REMOTE_MUTATION_PENDING',
    message:
      'The remote mutation is still pending. Its durable execution identity was preserved and it will not be submitted under a new identity.',
  };
};

export const canUseRemoteKernel = (): boolean => {
  try {
    return isRemoteServiceRuntime() && resolveRemoteConfig() !== null;
  } catch {
    return false;
  }
};

export const getRemoteToolModePolicy = async (
  mode: AppMode,
  projectId?: string,
  signal?: AbortSignal,
): Promise<RemoteToolModePolicy> => {
  const query = [
    `mode=${encodeURIComponent(mode)}`,
    ...(projectId ? [`projectId=${encodeURIComponent(projectId)}`] : []),
  ].join('&');
  const response = await remoteKernelRequest<unknown>(`/tools/mode-policy?${query}`, {
    method: 'GET',
    signal,
  });
  if (!response || typeof response !== 'object') {
    return invalidResponse('mode policy', response);
  }
  const value = response as Record<string, unknown>;
  if (
    !isStringArray(value.allowed_tool_ids) ||
    typeof value.enforce_macro_only_writes !== 'boolean' ||
    (value.capabilities !== undefined && !isStringArray(value.capabilities))
  ) {
    return invalidResponse('mode policy', response);
  }
  return {
    allowed_tool_ids: value.allowed_tool_ids,
    enforce_macro_only_writes: value.enforce_macro_only_writes,
    ...(value.capabilities === undefined ? {} : { capabilities: value.capabilities }),
  };
};

export const validateRemoteToolExecution = async (params: {
  mode: AppMode;
  toolId: string;
  path?: string;
  projectId: string;
  args?: Record<string, unknown>;
}): Promise<RemoteToolValidation> => {
  const response = await remoteKernelRequest<unknown>('/tools/validate', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      tool_id: params.toolId,
      path: params.path,
      projectId: params.projectId,
      args: params.args ?? {},
    }),
  });
  if (!response || typeof response !== 'object') {
    return invalidResponse('tool validation', response);
  }
  const value = response as Record<string, unknown>;
  if (
    typeof value.allowed !== 'boolean' ||
    typeof value.enforce_macro_only_writes !== 'boolean' ||
    (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string')
  ) {
    return invalidResponse('tool validation', response);
  }
  return {
    allowed: value.allowed,
    enforce_macro_only_writes: value.enforce_macro_only_writes,
    reason: value.reason as string | null | undefined,
  };
};

export interface RemoteCheckpointSnapshotFile {
  path: string;
  before: AgentCodeCheckpointFileSnapshot;
  after: AgentCodeCheckpointFileSnapshot;
}

export interface RemoteWorkspaceToolExecution {
  result: string;
  checkpoint?: { files: RemoteCheckpointSnapshotFile[] } | null;
}

export const executeRemoteWorkspaceToolDetailed = async (params: {
  mode: AppMode;
  toolId: string;
  args: Record<string, unknown>;
  projectId?: string | null;
  workspacePath?: string | null;
  workspaceScope?: 'default' | 'metadata';
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  signal?: AbortSignal;
  checkpointRequired?: boolean;
  invocationId?: string;
}): Promise<RemoteWorkspaceToolExecution> => {
  const needsContentRevisions = requiresContentRevisions(params);
  const needsBoundedOutput = BOUNDED_OUTPUT_TOOL_IDS.has(params.toolId);
  const needsBoundedGitOutput = BOUNDED_GIT_OUTPUT_TOOL_IDS.has(params.toolId);
  const needsStructuralSearch = params.toolId === 'ast_grep';
  const needsIdempotentMutation = MUTATING_REMOTE_TOOL_IDS.has(params.toolId);
  if (
    needsContentRevisions ||
    needsBoundedOutput ||
    needsBoundedGitOutput ||
    needsStructuralSearch ||
    params.checkpointRequired ||
    needsIdempotentMutation
  ) {
    const policy = await getRemoteToolModePolicy(
      params.mode,
      params.projectId ?? params.focusedProjectId ?? undefined,
      params.signal,
    );
    if (needsContentRevisions && !policy.capabilities?.includes(CONTENT_REVISIONS_CAPABILITY)) {
      throw new Error(
        'The remote Macro kernel cannot enforce content revisions. Update the remote kernel before retrying this guarded mutation.',
      );
    }
    if (needsBoundedOutput && !policy.capabilities?.includes(BOUNDED_TOOL_OUTPUT_CAPABILITY)) {
      throw new Error(
        'The remote Macro kernel cannot guarantee bounded, resumable tool output. Update the remote kernel before retrying this read-only tool.',
      );
    }
    if (needsBoundedGitOutput && !policy.capabilities?.includes(BOUNDED_GIT_OUTPUT_CAPABILITY)) {
      throw new Error(
        'The remote Macro kernel cannot guarantee bounded Git tool output. Update the remote kernel before retrying this repository inspection tool.',
      );
    }
    if (needsStructuralSearch && !policy.capabilities?.includes(STRUCTURAL_SEARCH_CAPABILITY)) {
      throw new Error(
        'The remote Macro kernel does not support structural search. Update the remote kernel before retrying ast_grep.',
      );
    }
    if (
      params.checkpointRequired &&
      !policy.capabilities?.includes(RECOVERABLE_CHECKPOINTS_CAPABILITY)
    ) {
      throw new Error(
        'The remote Macro kernel cannot provide recoverable code checkpoints. Update the remote kernel before retrying this mutation.',
      );
    }
    if (
      needsIdempotentMutation &&
      !policy.capabilities?.includes(IDEMPOTENT_TOOL_EXECUTION_CAPABILITY)
    ) {
      throw new Error(
        'The remote Macro kernel cannot replay mutation results idempotently. Update the remote kernel before retrying this mutation.',
      );
    }
  }
  if (MUTATING_REMOTE_TOOL_IDS.has(params.toolId) && params.signal?.aborted) {
    throw params.signal.reason instanceof Error
      ? params.signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
  const requestPayload = {
    mode: params.mode,
    tool_id: params.toolId,
    args: params.args,
    workspace_path: params.workspacePath ?? null,
    workspace_scope: params.workspaceScope ?? null,
    project_mounts: (params.projectMounts ?? []).map((mount) => ({
      project_id: mount.projectId,
      mount_name: mount.mountName,
      workspace_path: mount.workspacePath ?? null,
      display_name: mount.displayName,
      is_read_only: Boolean(mount.isReadOnly),
    })),
    virtual_root_enabled: params.virtualRootEnabled ?? null,
    focused_project_id: params.focusedProjectId ?? null,
    checkpoint_required: params.checkpointRequired ?? false,
  };
  let mutationFingerprint: string | null = null;
  let executionId: string;
  if (needsIdempotentMutation) {
    const config = resolveRemoteConfig();
    if (!config) {
      throw new Error('The remote Macro kernel is not configured.');
    }
    const requestFingerprint = await remoteMutationFingerprint(
      JSON.stringify({
        endpoint: {
          baseUrl: config.baseUrl,
          apiPrefix: config.apiPrefix,
          workspaceId: config.workspaceId ?? null,
        },
        request: requestPayload,
      }),
    );
    const invocationId = params.invocationId?.trim() || createRemoteToolExecutionId();
    mutationFingerprint = await remoteMutationFingerprint(
      JSON.stringify({
        endpoint: {
          baseUrl: config.baseUrl,
          apiPrefix: config.apiPrefix,
          workspaceId: config.workspaceId ?? null,
        },
        invocationId,
      }),
    );
    const existingIntent = loadDurableRemoteMutationIntent(mutationFingerprint);
    if (existingIntent && existingIntent.requestFingerprint !== requestFingerprint) {
      throw new Error(
        'The remote mutation invocation identity was reused with a different request.',
      );
    }
    executionId = existingIntent?.executionId ?? createRemoteToolExecutionId();
    if (!existingIntent) {
      persistDurableRemoteMutationIntent({
        fingerprint: mutationFingerprint,
        requestFingerprint,
        executionId,
        createdAt: new Date().toISOString(),
      });
    }
  } else {
    executionId = createRemoteToolExecutionId();
  }
  const signal = params.signal;
  const interruptible = INTERRUPTIBLE_REMOTE_TOOL_IDS.has(params.toolId);
  const sendCancellation = (): void => {
    void cancelRemoteWorkspaceTool(executionId).catch(() => false);
  };
  const abortListener =
    interruptible && signal && !signal.aborted
      ? (): void => {
          sendCancellation();
        }
      : undefined;
  if (interruptible && signal?.aborted) {
    sendCancellation();
  } else if (abortListener && signal) {
    signal.addEventListener('abort', abortListener, { once: true });
  }

  try {
    const requestBody = JSON.stringify({
      ...requestPayload,
      execution_id: executionId,
    });
    const requestExecution = async (): Promise<RemoteWorkspaceToolExecution> => {
      const response = await remoteKernelRequest<unknown>('/tools/execute', {
        method: 'POST',
        signal: interruptible ? signal : undefined,
        timeoutMs: remoteToolTimeoutMs(params.toolId),
        body: requestBody,
      });
      if (!response || typeof response !== 'object' || typeof (response as Record<string, unknown>).result !== 'string') {
        return invalidResponse('tool execution', response);
      }
      return response as RemoteWorkspaceToolExecution;
    };
    let payload: RemoteWorkspaceToolExecution;
    try {
      payload = await requestExecution();
    } catch (error) {
      const code = remoteErrorCode(error);
      const canRecover =
        needsIdempotentMutation &&
        ['REMOTE_REQUEST_ERROR', 'REMOTE_TIMEOUT', 'REMOTE_MUTATION_PENDING'].includes(code ?? '');
      if (!canRecover) throw error;

      let recoveredBeforeRetry: RemoteWorkspaceToolExecution | null = null;
      try {
        recoveredBeforeRetry = await pollRemoteMutationResult(executionId);
      } catch (recoveryError) {
        if (remoteErrorCode(recoveryError) === 'REMOTE_MUTATION_PENDING') throw recoveryError;
        // A status lookup can fail with the same transient transport outage.
        // The single resend below still uses the durable execution identity.
      }
      if (recoveredBeforeRetry) {
        payload = recoveredBeforeRetry;
      } else {
        try {
          payload = await requestExecution();
        } catch (retryError) {
          const retryCode = remoteErrorCode(retryError);
          if (
            ['REMOTE_REQUEST_ERROR', 'REMOTE_TIMEOUT', 'REMOTE_MUTATION_PENDING'].includes(
              retryCode ?? '',
            )
          ) {
            const recovered = await pollRemoteMutationResult(executionId);
            if (recovered) {
              payload = recovered;
            } else {
              throw retryError;
            }
          } else {
            throw retryError;
          }
        }
      }
    }

    if (params.checkpointRequired) {
      const files = payload.checkpoint?.files;
      if (
        !Array.isArray(files) ||
        files.length === 0 ||
        files.some(
          (file) =>
            !file ||
            typeof file.path !== 'string' ||
            file.path.trim().length === 0 ||
            !isRemoteCheckpointSnapshot(file.before) ||
            !isRemoteCheckpointSnapshot(file.after),
        )
      ) {
        throw new Error(
          'The remote Macro kernel completed a mutation without returning valid recoverable checkpoint snapshots.',
        );
      }
    }
    if (mutationFingerprint) {
      clearDurableRemoteMutationIntent(mutationFingerprint);
    }
    return payload;
  } catch (error) {
    if (
      interruptible &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'REMOTE_TIMEOUT'
    ) {
      sendCancellation();
    }
    if (mutationFingerprint) {
      const code = remoteErrorCode(error);
      const outcomeMayBeUnknown =
        code === null ||
        [
          'REMOTE_REQUEST_ERROR',
          'REMOTE_TIMEOUT',
          'REMOTE_MUTATION_PENDING',
          'REMOTE_MUTATION_OUTCOME_INDETERMINATE',
          'REMOTE_MUTATION_JOURNAL_UNAVAILABLE',
        ].includes(code);
      if (!outcomeMayBeUnknown) {
        clearDurableRemoteMutationIntent(mutationFingerprint);
      }
    }
    throw error;
  } finally {
    if (abortListener && signal) {
      signal.removeEventListener('abort', abortListener);
    }
  }
};

export const executeRemoteWorkspaceTool = async (
  params: Parameters<typeof executeRemoteWorkspaceToolDetailed>[0],
): Promise<string> => (await executeRemoteWorkspaceToolDetailed(params)).result;

const isRemoteCheckpointSnapshot = (value: unknown): value is AgentCodeCheckpointFileSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.exists !== 'boolean') return false;
  if (
    candidate.unixMode !== undefined &&
    candidate.unixMode !== null &&
    (!Number.isInteger(candidate.unixMode) ||
      Number(candidate.unixMode) < 0 ||
      Number(candidate.unixMode) > 0o7777)
  ) {
    return false;
  }
  if (!candidate.exists) {
    return (
      candidate.content === null &&
      (candidate.revision === null || candidate.revision === undefined)
    );
  }
  return (
    typeof candidate.content === 'string' &&
    typeof candidate.revision === 'string' &&
    candidate.revision.trim().length > 0 &&
    candidate.isBinary !== true
  );
};

export const readRemoteWorkspaceCheckpointSnapshot = async (params: {
  mode: AppMode;
  path: string;
  projectId?: string | null;
  workspacePath?: string | null;
  workspaceScope?: 'default' | 'metadata';
}): Promise<AgentCodeCheckpointFileSnapshot> => {
  const projectId = params.projectId?.trim();
  if (!projectId) {
    throw new Error('A project is required to read a remote checkpoint snapshot.');
  }
  const policy = await getRemoteToolModePolicy(params.mode, projectId);
  if (!policy.capabilities?.includes(RECOVERABLE_CHECKPOINTS_CAPABILITY)) {
    throw new Error(
      'The remote Macro kernel cannot provide recoverable code checkpoints. Update the remote kernel before retrying this replay.',
    );
  }
  const response = await remoteKernelRequest<{ snapshot: unknown }>('/tools/checkpoint-snapshot', {
    method: 'POST',
    body: JSON.stringify({
      mode: params.mode,
      path: params.path,
      project_id: projectId,
      workspace_path: params.workspacePath ?? null,
      workspace_scope: params.workspaceScope ?? null,
    }),
  });
  const parsed = response.snapshot;
  if (!isRemoteCheckpointSnapshot(parsed)) {
    throw new Error('The remote Macro kernel returned an incomplete checkpoint snapshot.');
  }
  return parsed;
};
