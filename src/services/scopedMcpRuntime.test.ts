import { describe, expect, it, mock } from 'bun:test';
import type { MCPServer } from '../types';
import type {
  MCPCatalogDto,
  MCPRuntimeKey,
  MCPRuntimeSelector,
  MCPRuntimeServerSnapshot,
} from './contracts/serviceProvider';
import { callScopedMcpTool, resolveScopedMcpRuntime } from './scopedMcpRuntime';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const snapshotFor = (
  selector: MCPRuntimeSelector,
  configGeneration = 1,
): MCPRuntimeServerSnapshot => ({
  key: {
    serverId: selector.serverId,
    projectId: null,
    projectIds: [...selector.projectIds],
    configGeneration,
  },
  status: 'ready',
  requestedProtocolMode: null,
  negotiatedEra: null,
  negotiatedProtocolVersion: null,
  protocolDecisionReason: null,
  lastError: null,
  updatedAt: '2026-08-24T00:00:00Z',
});

const catalogFor = (key: MCPRuntimeKey, toolNames: string[]): MCPCatalogDto => ({
  key,
  tools: toolNames.map((name) => ({
    id: `mcp__${key.serverId}__${name}`,
    serverId: key.serverId,
    name,
    inputSchema: { type: 'object', properties: {} },
    enabled: true,
  })),
  refreshedAt: '2026-08-24T00:00:00Z',
});

const stdioDefinition = {
  enabled: true,
  name: 'Project docs',
  transport: { type: 'stdio', command: 'project-docs' },
};

describe('scoped MCP runtime', () => {
  it('connects through the persistent runtime selector and exposes its catalog', async () => {
    const selector = { serverId: 'project_docs', projectIds: [] };
    const connect = mock(async (received: MCPRuntimeSelector) => {
      expect(received).toEqual(selector);
      return snapshotFor(received);
    });
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['list']));
    const runtime = await resolveScopedMcpRuntime(
      { project_docs: stdioDefinition },
      [],
      { deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog } },
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(runtime.failures).toEqual([]);
    expect(runtime.servers.map((server) => server.status)).toEqual(['online']);
    expect(runtime.tools.map((tool) => tool.id)).toEqual(['mcp__project_docs__list']);
  });

  it('deduplicates concurrent connections for the same selector', async () => {
    const selector = { serverId: 'dedup_server', projectIds: [] };
    let releaseConnection!: (snapshot: MCPRuntimeServerSnapshot) => void;
    const connectionGate = new Promise<MCPRuntimeServerSnapshot>((resolve) => {
      releaseConnection = resolve;
    });
    const connect = mock(() => connectionGate);
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['read']));
    const options = {
      deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog },
    };

    const first = resolveScopedMcpRuntime({ dedup_server: stdioDefinition }, [], options);
    const second = resolveScopedMcpRuntime({ dedup_server: stdioDefinition }, [], options);
    releaseConnection(snapshotFor(selector));

    const [firstRuntime, secondRuntime] = await Promise.all([first, second]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
    expect(firstRuntime.tools).toEqual(secondRuntime.tools);
  });

  it('reconnects once when catalog refresh reports a stale generation', async () => {
    let nextGeneration = 0;
    const connect = mock(async (received: MCPRuntimeSelector) => {
      nextGeneration += 1;
      return snapshotFor(received, nextGeneration);
    });
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => {
      if (key.configGeneration === 1) {
        throw { code: 'MCP_RUNTIME_STALE_GENERATION', message: 'stale' };
      }
      return catalogFor(key, ['read_v2']);
    });
    const options = {
      deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog },
    };
    const runtime = await resolveScopedMcpRuntime({ stale_server: stdioDefinition }, [], options);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(runtime.tools.map((tool) => tool.name)).toEqual(['read_v2']);

    const callTool = mock(async (_data: { key: MCPRuntimeKey }) => ({
      content: 'ok',
      isError: false,
      rawResult: {},
    }));
    await callScopedMcpTool('mcp__stale_server__read_v2', {}, runtime.servers, {
      ...options,
      deps: { ...options.deps, mcpRuntimeCallTool: callTool },
    });
    expect(callTool.mock.calls[0][0].key.configGeneration).toBe(2);
  });

  it('records an explicit unsupported failure instead of reconnecting', async () => {
    const connect = mock(async () => {
      throw {
        code: 'REMOTE_UNSUPPORTED_IN_REMOTE_MODE',
        message: 'mcpRuntimeConnect is unsupported in remote mode.',
      };
    });
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['list']));

    const runtime = await resolveScopedMcpRuntime(
      { remote_only: stdioDefinition },
      [],
      { deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog } },
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(refreshCatalog).not.toHaveBeenCalled();
    expect(runtime.servers).toEqual([]);
    expect(runtime.tools).toEqual([]);
    expect(runtime.failures).toEqual([{
      serverId: 'remote_only',
      code: 'REMOTE_UNSUPPORTED_IN_REMOTE_MODE',
      message: 'mcpRuntimeConnect is unsupported in remote mode.',
    }]);
  });

  it('rejects noncanonical or colliding server ids before any connection', async () => {
    const connect = mock(async (selector: MCPRuntimeSelector) => snapshotFor(selector));
    const options = { deps: { mcpRuntimeConnect: connect } };

    await expect(resolveScopedMcpRuntime({
      github_server: stdioDefinition,
      'GitHub Server': stdioDefinition,
    }, [], options)).rejects.toThrow('is not canonical');
    await expect(callScopedMcpTool('mcp__github_server__read', {}, [{
      id: 'github_server',
      tools: [{ id: 'mcp__github_server__read', serverId: 'github_server', name: 'read' }],
    } as MCPServer, {
      id: 'github_server',
      tools: [{ id: 'mcp__github_server__read', serverId: 'github_server', name: 'read' }],
    } as MCPServer], options)).rejects.toThrow('collide after normalization');
    expect(connect).not.toHaveBeenCalled();
  });

  it('calls tools with the backend key and a UUID operation id', async () => {
    const connect = mock(async (received: MCPRuntimeSelector) => snapshotFor(received));
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['list']));
    const callTool = mock(async (data: {
      key: MCPRuntimeKey;
      toolName: string;
      arguments: Record<string, unknown>;
      operationId: string;
    }) => {
      expect(data.toolName).toBe('list');
      expect(data.arguments).toEqual({ limit: 5 });
      expect(data.operationId).toMatch(UUID_PATTERN);
      expect(data.key.serverId).toBe('caller_server');
      return { content: 'project result', isError: false, rawResult: {} };
    });
    const runtime = await resolveScopedMcpRuntime(
      { caller_server: stdioDefinition },
      [],
      {
        projectIds: ['project-1'],
        deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog },
      },
    );
    expect(connect.mock.calls[0][0].projectIds).toEqual(['project-1']);

    await expect(callScopedMcpTool(
      'mcp__caller_server__list',
      { limit: 5 },
      runtime.servers,
      { deps: { mcpRuntimeCallTool: callTool } },
    )).resolves.toBe('project result');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('surfaces backend tool errors', async () => {
    const connect = mock(async (received: MCPRuntimeSelector) => snapshotFor(received));
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['boom']));
    const callTool = mock(async () => ({
      content: 'backend exploded',
      isError: true,
      rawResult: {},
    }));
    const runtime = await resolveScopedMcpRuntime(
      { failing_server: stdioDefinition },
      [],
      { deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog } },
    );

    await expect(callScopedMcpTool('mcp__failing_server__boom', {}, runtime.servers, {
      deps: { mcpRuntimeCallTool: callTool },
    })).rejects.toThrow('backend exploded');
  });

  it('throws a typed error when the requested tool is absent from the frozen catalog', async () => {
    await expect(callScopedMcpTool('mcp__missing__read', {}, [])).rejects.toMatchObject({
      name: 'ScopedMcpToolReportedError',
      code: 'MCP_TOOL_REPORTED_ERROR',
    });
  });

  it('cancels the backend operation when the abort signal fires mid-call', async () => {
    const connect = mock(async (received: MCPRuntimeSelector) => snapshotFor(received));
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['slow']));
    const cancelOperation = mock(async () => true);
    const runtime = await resolveScopedMcpRuntime(
      { aborting_server: stdioDefinition },
      [],
      { deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog } },
    );

    let releaseCall!: (response: { content: string }) => void;
    const callGate = new Promise<{ content: string }>((resolve) => {
      releaseCall = resolve;
    });
    let capturedOperationId = '';
    const callTool = mock(async (data: { operationId: string }) => {
      capturedOperationId = data.operationId;
      return callGate;
    });
    const controller = new AbortController();
    const pending = callScopedMcpTool('mcp__aborting_server__slow', {}, runtime.servers, {
      signal: controller.signal,
      deps: { mcpRuntimeCallTool: callTool, mcpRuntimeCancelOperation: cancelOperation },
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    releaseCall({ content: 'late result' });
    expect(capturedOperationId).toMatch(UUID_PATTERN);
    expect(cancelOperation).toHaveBeenCalledWith(capturedOperationId);
  });

  it('skips execution entirely when the signal is already aborted', async () => {
    const connect = mock(async (received: MCPRuntimeSelector) => snapshotFor(received));
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['list']));
    const callTool = mock(async () => ({ content: 'must not run', isError: false }));
    const runtime = await resolveScopedMcpRuntime(
      { preaborted_server: stdioDefinition },
      [],
      { deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog } },
    );
    const controller = new AbortController();
    controller.abort();

    await expect(callScopedMcpTool('mcp__preaborted_server__list', {}, runtime.servers, {
      signal: controller.signal,
      deps: { mcpRuntimeCallTool: callTool },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('never replays a tool call after a stale-generation error', async () => {
    const connect = mock(async (selector: MCPRuntimeSelector) => snapshotFor(selector));
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['write']));
    const callTool = mock(async () => {
      throw { code: 'MCP_RUNTIME_STALE_GENERATION', message: 'stale after dispatch' };
    });
    const runtime = await resolveScopedMcpRuntime(
      { no_replay: stdioDefinition },
      [],
      { deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog } },
    );

    await expect(callScopedMcpTool('mcp__no_replay__write', {}, runtime.servers, {
      deps: { mcpRuntimeCallTool: callTool },
    })).rejects.toMatchObject({ code: 'MCP_RUNTIME_STALE_GENERATION' });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('refuses to reuse a frozen runtime key under another project scope', async () => {
    const connect = mock(async (selector: MCPRuntimeSelector) => snapshotFor(selector));
    const refreshCatalog = mock(async (key: MCPRuntimeKey) => catalogFor(key, ['read']));
    const callTool = mock(async () => ({ content: 'must not run' }));
    const runtime = await resolveScopedMcpRuntime(
      { scoped_server: stdioDefinition },
      [],
      {
        projectIds: ['project-a'],
        deps: { mcpRuntimeConnect: connect, mcpRuntimeRefreshCatalog: refreshCatalog },
      },
    );

    await expect(callScopedMcpTool('mcp__scoped_server__read', {}, runtime.servers, {
      projectIds: ['project-b'],
      deps: { mcpRuntimeCallTool: callTool },
    })).rejects.toThrow('runtime scope changed');
    expect(callTool).not.toHaveBeenCalled();
  });
});
