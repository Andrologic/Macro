import type { MCPServer, MCPTool } from '../types';
import type {
  MCPCatalogDto,
  MCPRuntimeKey,
  MCPRuntimeSelector,
  MCPRuntimeServerSnapshot,
} from './contracts/serviceProvider';
import { toServiceError } from './contracts/errors';
import { services } from './index';
import { isMCPServerEnabled, normalizeMCPServer, normalizeMCPServerTools } from './mcp';
import { normalizeMCPIdentifier } from './mcp/identifiers';

export interface ScopedMcpRuntimeFailure {
  serverId: string;
  code: string;
  message: string;
}

export interface ScopedMcpRuntime {
  servers: MCPServer[];
  tools: MCPTool[];
  /**
   * Servers excluded from this resolution with the backend reason. Remote
   * sessions surface `REMOTE_UNSUPPORTED_IN_REMOTE_MODE` here instead of a
   * silent degradation or a non-authoritative frontend catalog.
   */
  failures: ScopedMcpRuntimeFailure[];
}

export interface ScopedMcpRuntimeDeps {
  mcpRuntimeConnect: (selector: MCPRuntimeSelector) => Promise<MCPRuntimeServerSnapshot>;
  mcpRuntimeRefreshCatalog: typeof services.mcpRuntimeRefreshCatalog;
  mcpRuntimeCallTool: typeof services.mcpRuntimeCallTool;
  mcpRuntimeCancelOperation: typeof services.mcpRuntimeCancelOperation;
}

export interface ResolveScopedMcpRuntimeOptions {
  /** Effective multi-project scope for the runtime selectors; empty targets global configuration. */
  projectIds?: readonly string[];
  deps?: Partial<ScopedMcpRuntimeDeps>;
}

export interface CallScopedMcpToolOptions {
  projectIds?: readonly string[];
  /** Aborting cancels the backend operation via `mcpRuntimeCancelOperation`. */
  signal?: AbortSignal;
  deps?: Partial<ScopedMcpRuntimeDeps>;
}

const DEFAULT_DEPS: ScopedMcpRuntimeDeps = {
  mcpRuntimeConnect: (selector) => services.mcpRuntimeConnect(selector),
  mcpRuntimeRefreshCatalog: (key) => services.mcpRuntimeRefreshCatalog(key),
  mcpRuntimeCallTool: (data) => services.mcpRuntimeCallTool(data),
  mcpRuntimeCancelOperation: (operationId) => services.mcpRuntimeCancelOperation(operationId),
};

const resolveDeps = (overrides?: Partial<ScopedMcpRuntimeDeps>): ScopedMcpRuntimeDeps =>
  overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;

// Errors meaning catalog discovery raced a backend generation change. Connect
// plus catalog refresh can be retried safely because no tool was dispatched.
const STALE_LEASE_ERROR_CODES = new Set([
  'MCP_RUNTIME_STALE_GENERATION',
  'MCP_RUNTIME_NOT_CONNECTED',
  'MCP_RUNTIME_CONFIG_CHANGED',
]);

const isStaleLeaseError = (error: unknown): boolean =>
  STALE_LEASE_ERROR_CODES.has(toServiceError(error).code);

const MAX_CONNECT_ATTEMPTS = 2;

const normalizeProjectScope = (projectIds?: readonly string[]): string[] =>
  Array.from(new Set((projectIds ?? []).map((id) => id.trim()).filter(Boolean))).sort();

const selectorCacheKey = (serverId: string, projectIds: readonly string[]): string =>
  `${serverId}@${projectIds.join(',')}`;

const runtimeKey = Symbol('scopedMcpRuntimeKey');
type RuntimeBoundMcpServer = MCPServer & { [runtimeKey]?: MCPRuntimeKey };

// Only in-flight connects are deduplicated. Completed runtime keys stay bound
// to the resolved turn objects; the backend remains the sole catalog cache.
const pendingConnectionsByConnector = new WeakMap<
  ScopedMcpRuntimeDeps['mcpRuntimeConnect'],
  Map<string, Promise<MCPRuntimeServerSnapshot>>
>();

const connectSelector = (
  selector: MCPRuntimeSelector,
  deps: ScopedMcpRuntimeDeps,
): Promise<MCPRuntimeServerSnapshot> => {
  let pendingConnections = pendingConnectionsByConnector.get(deps.mcpRuntimeConnect);
  if (!pendingConnections) {
    pendingConnections = new Map();
    pendingConnectionsByConnector.set(deps.mcpRuntimeConnect, pendingConnections);
  }
  const cacheKey = selectorCacheKey(selector.serverId, selector.projectIds);
  const pending = pendingConnections.get(cacheKey);
  if (pending) return pending;
  const connection = deps
    .mcpRuntimeConnect({ serverId: selector.serverId, projectIds: [...selector.projectIds] })
    .finally(() => {
      pendingConnections.delete(cacheKey);
    });
  pendingConnections.set(cacheKey, connection);
  return connection;
};

const ensureScopedServerCatalog = async (
  serverId: string,
  projectIds: readonly string[],
  deps: ScopedMcpRuntimeDeps,
): Promise<MCPCatalogDto> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await connectSelector({ serverId, projectIds: [...projectIds] }, deps);
      return await deps.mcpRuntimeRefreshCatalog(snapshot.key);
    } catch (error) {
      lastError = error;
      if (!isStaleLeaseError(error)) throw error;
    }
  }
  throw lastError;
};

const assertCanonicalUniqueServerIds = (serverIds: readonly string[]): void => {
  const owners = new Map<string, string>();
  for (const serverId of serverIds) {
    const normalized = normalizeMCPIdentifier(serverId);
    if (serverId !== normalized) {
      throw new Error(`MCP server id ${serverId} is not canonical.`);
    }
    const owner = owners.get(normalized);
    if (owner) {
      throw new Error(`MCP server ids ${owner} and ${serverId} collide after normalization.`);
    }
    owners.set(normalized, serverId);
  }
};

const toRuntimeServer = (id: string, definition: Record<string, unknown>): MCPServer =>
  normalizeMCPServer({
    id,
    name: typeof definition.name === 'string' ? definition.name : id,
    description: typeof definition.description === 'string' ? definition.description : '',
    category: typeof definition.category === 'string'
      ? definition.category as MCPServer['category']
      : 'other',
    icon: typeof definition.icon === 'string' ? definition.icon as MCPServer['icon'] : 'server',
    website: typeof definition.website === 'string' ? definition.website : undefined,
    transport: definition.transport as MCPServer['transport'],
    config: { enabled: definition.enabled === true },
  });

const bindRuntimeKey = (server: MCPServer, key: MCPRuntimeKey): RuntimeBoundMcpServer => {
  Object.defineProperty(server, runtimeKey, { value: key, enumerable: false });
  return server;
};

let operationCounter = 0;
const createOperationId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  operationCounter += 1;
  return `mcp-${Date.now().toString(36)}-${operationCounter.toString(36)}`;
};

const abortError = (): Error => {
  const error = new Error('The MCP operation was aborted.');
  error.name = 'AbortError';
  return error;
};

export const resolveScopedMcpRuntime = async (
  definitions: Readonly<Record<string, Record<string, unknown>>>,
  // Retained positionally for existing call sites; the persistent runtime
  // owns connection state, so no frontend online/fallback reuse happens here.
  _fallbackServers: readonly MCPServer[] = [],
  options: ResolveScopedMcpRuntimeOptions = {},
): Promise<ScopedMcpRuntime> => {
  assertCanonicalUniqueServerIds(Object.keys(definitions));
  const deps = resolveDeps(options.deps);
  const projectIds = normalizeProjectScope(options.projectIds);
  const configured = Object.entries(definitions)
    .map(([id, definition]) => toRuntimeServer(id, definition))
    .filter(isMCPServerEnabled);

  const settled = await Promise.all(
    configured.map(async (server): Promise<{
      server: MCPServer | null;
      failure: ScopedMcpRuntimeFailure | null;
    }> => {
      try {
        const catalog = await ensureScopedServerCatalog(server.id, projectIds, deps);
        const online = normalizeMCPServer({ ...server, status: 'online', tools: catalog.tools });
        return {
          server: bindRuntimeKey(
            { ...online, tools: normalizeMCPServerTools(online) },
            catalog.key,
          ),
          failure: null,
        };
      } catch (error) {
        const normalized = toServiceError(error);
        return {
          server: null,
          failure: {
            serverId: server.id,
            code: normalized.code,
            message: normalized.message,
          },
        };
      }
    }),
  );
  const servers = settled.flatMap((result) => result.server ? [result.server] : []);
  return {
    servers,
    tools: servers.flatMap((server) =>
      normalizeMCPServerTools(server).filter((tool) => tool.enabled !== false)
    ),
    failures: settled.flatMap((result) => result.failure ? [result.failure] : []),
  };
};

export const callScopedMcpTool = async (
  toolId: string,
  args: Record<string, unknown>,
  servers: readonly MCPServer[],
  options: CallScopedMcpToolOptions = {},
): Promise<string> => {
  assertCanonicalUniqueServerIds(servers.map((server) => server.id));
  const deps = resolveDeps(options.deps);
  const projectIds = normalizeProjectScope(options.projectIds);
  for (const server of servers) {
    const tool = normalizeMCPServerTools(server).find((candidate) => candidate.id === toolId);
    if (!tool) continue;

    if (options.signal?.aborted) throw abortError();

    let lease = (server as RuntimeBoundMcpServer)[runtimeKey];
    if (lease && options.projectIds !== undefined) {
      const leaseProjectIds = normalizeProjectScope(lease.projectIds);
      if (leaseProjectIds.join('\0') !== projectIds.join('\0')) {
        throw new Error(
          `MCP runtime scope changed for server ${server.id}; refusing to reuse its frozen key.`,
        );
      }
    }
    if (!lease || lease.serverId !== server.id) {
      const catalog = await ensureScopedServerCatalog(server.id, projectIds, deps);
      lease = catalog.key;
    }

    if (options.signal?.aborted) throw abortError();
    const operationId = createOperationId();
    let rejectAborted: ((error: Error) => void) | null = null;
    const cancelCurrentOperation = (): void => {
      void deps.mcpRuntimeCancelOperation(operationId).catch(() => undefined);
      rejectAborted?.(abortError());
    };
    options.signal?.addEventListener('abort', cancelCurrentOperation, { once: true });
    try {
      const call = deps.mcpRuntimeCallTool({
        key: lease,
        toolName: tool.name,
        arguments: args,
        operationId,
      });
      const response = options.signal
        ? await Promise.race([
            call,
            new Promise<never>((_resolve, reject) => {
              rejectAborted = reject;
            }),
          ])
        : await call;
      if (response.isError) {
        throw new Error(response.content || `MCP tool ${tool.name} reported an error.`);
      }
      return response.content;
    } finally {
      options.signal?.removeEventListener('abort', cancelCurrentOperation);
    }
  }
  return `MCP tool ${toolId} is not configured for this turn.`;
};
