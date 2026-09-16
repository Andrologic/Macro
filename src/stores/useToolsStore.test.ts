import { afterEach, describe, expect, it, mock } from 'bun:test';
import { BUILT_IN_TOOLS } from '../services/tools/builtInTools';
import type { MCPServer, Tool } from '../types';

const CHAT_TOOLBOX_IDS = [
  'web_search',
  'web_fetch',
  'question',
  'read_file',
  'terminal_create_session',
  'mark_source_passage',
];

const CHAT_RUNTIME_IDS = [
  ...CHAT_TOOLBOX_IDS,
  'read_sources',
  'edit_source_passage',
  'terminal_run',
  'terminal_read',
  'terminal_kill',
];

const NON_CHAT_TOOLBOX_IDS = [
  'list',
  'read',
  'write',
  'edit',
  'delete',
  'glob',
  'grep',
  'git_status',
  'git_commit',
  'plan_create',
  'strategy_generate',
];

let importCounter = 0;

const buildToolSettings = (): Record<string, Tool> =>
  Object.fromEntries(
    BUILT_IN_TOOLS.map((tool) => [
      tool.id,
      {
        ...tool,
        config: { ...tool.config },
      },
    ]),
  );

const loadUseToolsStore = async () => {
  mock.restore();

  mock.module('../services', () => ({
    services: {
      getToolSettings: mock(async () => ({
        tools: buildToolSettings(),
      })),
      getMCPServerSettings: mock(async () => ({
        servers: {
          github: {
            id: 'github',
            name: 'GitHub',
            category: 'development',
            status: 'online',
            description: 'Connected MCP server',
            icon: 'server',
            config: { enabled: true },
          } satisfies MCPServer,
        },
      })),
      updateToolSettings: mock(async () => undefined),
      updateMCPServerSettings: mock(async () => undefined),
      mcpDiscoverTools: mock(async () => ({
        tools: [
          {
            id: 'mcp__github__list_issues',
            serverId: 'github',
            name: 'list_issues',
            description: 'List issues',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      })),
      mcpCallTool: mock(async () => ({ content: 'ok' })),
      mcpRuntimeGetSnapshot: mock(async () => ({
        generatedAt: '2026-09-05T20:00:00.000Z',
        servers: [],
      })),
      mcpRuntimeConnect: mock(async () => ({
        key: {
          serverId: 'github',
          projectId: null,
          projectIds: [],
          configGeneration: 1,
        },
        state: 'ready',
        protocolEra: 'legacy',
        negotiatedProtocolVersion: '2025-11-25',
      })),
      mcpRuntimeRefreshCatalog: mock(async () => ({
        key: {
          serverId: 'github',
          projectId: null,
          projectIds: [],
          configGeneration: 1,
        },
        tools: [
          {
            id: 'mcp__github__list_issues',
            serverId: 'github',
            name: 'list_issues',
            description: 'List issues',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      })),
      mcpRuntimeCallTool: mock(async () => ({ content: 'ok' })),
      mcpRuntimeCancelOperation: mock(async () => false),
    },
  }));

  importCounter += 1;
  return import(`./useToolsStore.ts?tools-store-test=${importCounter}`);
};

describe('useToolsStore chat toolbox policy', () => {
  afterEach(() => {
    localStorage.clear();
    mock.restore();
  });

  it('shows only Chat policy tools in the Chat toolbox', async () => {
    const { useToolsStore } = await loadUseToolsStore();

    await useToolsStore.getState().loadSettings();

    const visibleChatToolIds = useToolsStore
      .getState()
      .getChatModeTools()
      .map((tool: Tool) => tool.id);

    expect(visibleChatToolIds).toEqual(CHAT_TOOLBOX_IDS);
    for (const toolId of NON_CHAT_TOOLBOX_IDS) {
      expect(visibleChatToolIds).not.toContain(toolId);
    }
    expect(visibleChatToolIds).not.toContain('read_sources');
    expect(visibleChatToolIds).not.toContain('edit_source_passage');

    const enabledRuntimeIds = useToolsStore.getState().getEnabledChatToolIds();
    for (const toolId of CHAT_RUNTIME_IDS) {
      expect(enabledRuntimeIds).toContain(toolId);
    }
    for (const toolId of NON_CHAT_TOOLBOX_IDS) {
      expect(enabledRuntimeIds).not.toContain(toolId);
    }
  });

  it('keeps source helper tools behind the single visible Sources toggle', async () => {
    const { useToolsStore } = await loadUseToolsStore();

    await useToolsStore.getState().loadSettings();
    useToolsStore.getState().toggleChatTool('mark_source_passage');

    expect(useToolsStore.getState().isChatToolEnabled('mark_source_passage')).toBe(false);
    expect(useToolsStore.getState().isChatToolEnabled('read_sources')).toBe(false);
    expect(useToolsStore.getState().isChatToolEnabled('edit_source_passage')).toBe(false);

    useToolsStore.getState().toggleChatTool('read_sources');
    expect(useToolsStore.getState().isChatToolEnabled('mark_source_passage')).toBe(false);
    expect(useToolsStore.getState().isChatToolEnabled('read_sources')).toBe(false);
    expect(useToolsStore.getState().isChatToolEnabled('edit_source_passage')).toBe(false);

    useToolsStore.getState().toggleChatTool('mark_source_passage');
    expect(useToolsStore.getState().isChatToolEnabled('mark_source_passage')).toBe(true);
    expect(useToolsStore.getState().isChatToolEnabled('read_sources')).toBe(true);
    expect(useToolsStore.getState().isChatToolEnabled('edit_source_passage')).toBe(true);
  });

  it('keeps terminal runtime tools behind the single visible Terminal toggle', async () => {
    const { useToolsStore } = await loadUseToolsStore();

    await useToolsStore.getState().loadSettings();
    useToolsStore.getState().toggleChatTool('terminal_create_session');

    for (const toolId of [
      'terminal_create_session',
      'terminal_run',
      'terminal_read',
      'terminal_kill',
    ]) {
      expect(useToolsStore.getState().isChatToolEnabled(toolId)).toBe(false);
    }

    useToolsStore.getState().toggleChatTool('terminal_create_session');
    for (const toolId of [
      'terminal_create_session',
      'terminal_run',
      'terminal_read',
      'terminal_kill',
    ]) {
      expect(useToolsStore.getState().isChatToolEnabled(toolId)).toBe(true);
    }
  });

  it('serializes rapid built-in tool toggles and persists both changes', async () => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    const { services } = await import('../services');
    const updateToolSettings = services.updateToolSettings as typeof services.updateToolSettings & {
      mockImplementationOnce: (implementation: typeof services.updateToolSettings) => void;
      mock: { calls: Array<[{ tools: Record<string, boolean> }]> };
    };
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    updateToolSettings.mockImplementationOnce(async () => firstWrite);

    const firstToggle = useToolsStore.getState().toggleTool('web_search');
    const secondToggle = useToolsStore.getState().toggleTool('question');
    await Promise.resolve();
    await Promise.resolve();

    expect(updateToolSettings.mock.calls).toHaveLength(1);
    releaseFirstWrite?.();
    await Promise.all([firstToggle, secondToggle]);

    expect(updateToolSettings.mock.calls).toHaveLength(2);
    expect(updateToolSettings.mock.calls[1]?.[0].tools).toMatchObject({
      web_search: false,
      question: false,
    });
    expect(useToolsStore.getState().isToolEnabled('web_search')).toBe(false);
    expect(useToolsStore.getState().isToolEnabled('question')).toBe(false);
  });

  it.each(['remove-success', 'remove-failure', 'disable-success', 'disable-failure', 'edit-success', 'edit-failure', 'other-success', 'other-failure'])('ignores a stale catalog after %s', async (scenario) => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    const { services } = await import('../services');
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const original = services.mcpRuntimeRefreshCatalog;
    services.mcpRuntimeRefreshCatalog = mock(async (key) => {
      await gate;
      if (scenario.endsWith('failure')) throw new Error('Catalog unavailable');
      return original(key);
    });
    const refresh = useToolsStore.getState().refreshMCPServerTools('github');
    await Promise.resolve();
    const current = useToolsStore.getState().mcpServers[0]!;
    if (scenario.startsWith('remove')) await useToolsStore.getState().removeMCPServer('github');
    else if (scenario.startsWith('disable')) await useToolsStore.getState().toggleMCPServer('github');
    else await useToolsStore.getState().upsertMCPServer({ ...current,
      id: scenario.startsWith('other') ? 'other' : current.id,
      transport: { type: 'stdio', command: 'new-synthetic-command' },
    });
    const expectedServers = useToolsStore.getState().mcpServers;
    const saves = (services.updateMCPServerSettings as ReturnType<typeof mock>).mock.calls.length;
    finish();
    await refresh;
    expect(useToolsStore.getState().mcpServers).toEqual(expectedServers);
    expect((services.updateMCPServerSettings as ReturnType<typeof mock>).mock.calls.length).toBe(saves);
    expect(useToolsStore.getState().lastError).toBeNull();
    expect(useToolsStore.getState().saving).toBe(false);
  });

  it('keeps the latest catalog when two refreshes finish in reverse order', async () => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    const { services } = await import('../services');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    services.mcpRuntimeRefreshCatalog = mock(async (key) => {
      const index = ++calls;
      if (index === 1) await gate;
      return { key, refreshedAt: 'synthetic', tools: [{
        id: `mcp__github__read_${index}`, serverId: 'github', name: `read_${index}`,
      }] };
    });
    const first = useToolsStore.getState().refreshMCPServerTools('github');
    await Promise.resolve();
    await useToolsStore.getState().refreshMCPServerTools('github');
    release();
    await first;
    expect(useToolsStore.getState().getEnabledMCPToolIds()).toEqual(['mcp__github__read_2']);
    expect(services.updateMCPServerSettings).not.toHaveBeenCalled();
    expect(useToolsStore.getState().saving).toBe(false);
  });

  it('keeps saving visible when an absent server is refreshed during another refresh', async () => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    const { services } = await import('../services');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = services.mcpRuntimeRefreshCatalog;
    services.mcpRuntimeRefreshCatalog = mock(async (key) => { await gate; return original(key); });
    const active = useToolsStore.getState().refreshMCPServerTools('github');
    await Promise.resolve();
    await useToolsStore.getState().refreshMCPServerTools('absent');
    expect(useToolsStore.getState().saving).toBe(true);
    release();
    await active;
    expect(useToolsStore.getState().saving).toBe(false);
  });

  it('merges concurrent catalogs for different servers without saving configuration', async () => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    const github = useToolsStore.getState().mcpServers[0]!;
    useToolsStore.setState({ mcpServers: [github, { ...github, id: 'other' }] });
    const { services } = await import('../services');
    services.mcpRuntimeConnect = mock(async ({ serverId }) => ({ key: {
      serverId, projectId: null, projectIds: [], configGeneration: 1,
    }, status: 'ready' as const, updatedAt: 'synthetic' }));
    services.mcpRuntimeRefreshCatalog = mock(async (key) => ({ key, tools: [{
      id: `mcp__${key.serverId}__read`, serverId: key.serverId, name: 'read',
    }], refreshedAt: 'synthetic' }));
    await Promise.all(['github', 'other'].map((id) => useToolsStore.getState().refreshMCPServerTools(id)));
    expect(useToolsStore.getState().getEnabledMCPToolIds()).toEqual(['mcp__github__read', 'mcp__other__read']);
    expect(services.updateMCPServerSettings).not.toHaveBeenCalled();
  });

  it('discovers and exposes enabled MCP tools by namespaced id', async () => {
    const { useToolsStore } = await loadUseToolsStore();

    await useToolsStore.getState().loadSettings();
    await useToolsStore.getState().refreshMCPServerTools('github');

    expect(useToolsStore.getState().getEnabledMCPToolIds()).toEqual([
      'mcp__github__list_issues',
    ]);
    await expect(
      useToolsStore.getState().callMCPTool('mcp__github__list_issues', {})
    ).resolves.toBe('ok');
  });

  it('propagates MCP tool protocol errors instead of returning a successful-looking result', async () => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    await useToolsStore.getState().refreshMCPServerTools('github');

    const { services } = await import('../services');
    (services.mcpRuntimeCallTool as unknown as {
      mockResolvedValueOnce: (value: {
        content: string;
        isError: boolean;
        rawResult?: unknown;
      }) => void;
    }).mockResolvedValueOnce({
      content: 'Access denied by MCP server',
      isError: true,
      rawResult: { code: 'MCP_ACCESS_DENIED' },
    });

    await expect(
      useToolsStore.getState().callMCPTool('mcp__github__list_issues', {})
    ).rejects.toThrow('Access denied by MCP server');
    expect(useToolsStore.getState().mcpServers[0]?.status).toBe('online');
    expect(useToolsStore.getState().mcpServers[0]?.lastErrorCode).toBe('MCP_ACCESS_DENIED');

    (services.mcpRuntimeGetSnapshot as unknown as {
      mockResolvedValueOnce: (value: unknown) => void;
    }).mockResolvedValueOnce({
      generatedAt: '2026-09-05T20:00:05.000Z',
      servers: [{
        key: {
          serverId: 'github',
          projectId: null,
          projectIds: [],
          configGeneration: 1,
        },
        status: 'ready',
        lastErrorCode: null,
        lastError: null,
        updatedAt: '2026-09-05T20:00:04.000Z',
      }],
    });
    await useToolsStore.getState().refreshMCPRuntimeSnapshot();
    expect(useToolsStore.getState().mcpServers[0]?.lastErrorCode).toBe('MCP_ACCESS_DENIED');
  });

  it('degrades a server only when the persistent runtime reports a transport failure', async () => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    await useToolsStore.getState().refreshMCPServerTools('github');

    const { services } = await import('../services');
    (services.mcpRuntimeCallTool as unknown as {
      mockRejectedValueOnce: (value: { code: string; message: string }) => void;
    }).mockRejectedValueOnce({
      code: 'MCP_RUNTIME_CALL_TOOL_FAILED',
      message: 'Transport closed',
    });

    const call = useToolsStore.getState().callMCPTool('mcp__github__list_issues', {});
    await expect(call).rejects.toMatchObject({
      code: 'MCP_RUNTIME_CALL_TOOL_FAILED',
      message: expect.stringContaining('Transport closed'),
    });
    expect(useToolsStore.getState().mcpServers[0]?.status).toBe('degraded');
    expect(useToolsStore.getState().mcpServers[0]?.lastErrorCode).toBe(
      'MCP_RUNTIME_CALL_TOOL_FAILED'
    );

    (services.mcpRuntimeGetSnapshot as unknown as {
      mockResolvedValueOnce: (value: unknown) => void;
    }).mockResolvedValueOnce({
      generatedAt: '2026-09-05T20:00:05.000Z',
      servers: [{
        key: {
          serverId: 'github',
          projectId: null,
          projectIds: [],
          configGeneration: 1,
        },
        status: 'ready',
        lastErrorCode: null,
        lastError: null,
        updatedAt: '2026-09-05T20:00:04.000Z',
      }],
    });
    await useToolsStore.getState().refreshMCPRuntimeSnapshot();
    expect(useToolsStore.getState().mcpServers[0]?.lastErrorCode).toBeNull();
  });

  it('hydrates autonomous runtime failures and their codes from the MCP snapshot', async () => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    const { services } = await import('../services');
    (services.mcpRuntimeGetSnapshot as unknown as {
      mockResolvedValueOnce: (value: unknown) => void;
    }).mockResolvedValueOnce({
      generatedAt: '2026-09-05T20:00:05.000Z',
      servers: [{
        key: {
          serverId: 'github',
          projectId: null,
          projectIds: [],
          configGeneration: 1,
        },
        status: 'failed',
        lastErrorCode: 'MCP_RUNTIME_RECONNECT_TIMEOUT',
        lastError: 'Reconnect circuit timed out',
        updatedAt: '2026-09-05T20:00:04.000Z',
      }],
    });

    await useToolsStore.getState().refreshMCPRuntimeSnapshot();

    expect(useToolsStore.getState().mcpServers[0]).toMatchObject({
      status: 'degraded',
      lastErrorCode: 'MCP_RUNTIME_RECONNECT_TIMEOUT',
      lastError: 'Reconnect circuit timed out',
    });
  });

  it('clears a recovered legacy runtime error even when its snapshot has no code', async () => {
    const { useToolsStore } = await loadUseToolsStore();
    await useToolsStore.getState().loadSettings();
    const { services } = await import('../services');
    const snapshotMock = services.mcpRuntimeGetSnapshot as unknown as {
      mockResolvedValueOnce: (value: unknown) => void;
    };
    const key = {
      serverId: 'github',
      projectId: null,
      projectIds: [],
      configGeneration: 1,
    };
    snapshotMock.mockResolvedValueOnce({
      generatedAt: '2026-09-05T20:00:05.000Z',
      servers: [{
        key,
        status: 'failed',
        lastError: 'Legacy reconnect failed',
        updatedAt: '2026-09-05T20:00:04.000Z',
      }],
    });
    await useToolsStore.getState().refreshMCPRuntimeSnapshot();
    expect(useToolsStore.getState().mcpServers[0]).toMatchObject({
      status: 'degraded',
      lastErrorCode: null,
      lastError: 'Legacy reconnect failed',
    });

    snapshotMock.mockResolvedValueOnce({
      generatedAt: '2026-09-05T20:00:07.000Z',
      servers: [{
        key,
        status: 'ready',
        updatedAt: '2026-09-05T20:00:06.000Z',
      }],
    });
    await useToolsStore.getState().refreshMCPRuntimeSnapshot();
    expect(useToolsStore.getState().mcpServers[0]).toMatchObject({
      status: 'online',
      lastErrorCode: null,
      lastError: null,
    });
  });
});
