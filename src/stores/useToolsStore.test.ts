import { afterEach, describe, expect, it, mock } from 'bun:test';
import { BUILT_IN_TOOLS } from '../services/tools/builtInTools';
import type { MCPServer, Tool } from '../types';

const CHAT_TOOLBOX_IDS = [
  'web_search',
  'web_fetch',
  'question',
  'read_file',
  'mark_source_passage',
];

const CHAT_RUNTIME_IDS = [
  ...CHAT_TOOLBOX_IDS,
  'read_sources',
  'edit_source_passage',
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
  'terminal_run',
  'need_add',
  'need_list',
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
});
