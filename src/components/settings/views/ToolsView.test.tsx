import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const loadPreferenceMock = mock(async (_key?: string): Promise<unknown> => 'balanced');
const loadSettingsMock = mock(async () => undefined);
const toggleToolMock = mock(async () => undefined);
const toggleMcpServerMock = mock(() => undefined);
const upsertMcpServerMock = mock(async () => undefined);
const removeMcpServerMock = mock(async () => undefined);
const refreshMcpServerToolsMock = mock(async () => undefined);
const saveWebSearchSettingsMock = mock((_value?: unknown) => undefined);

let importCounter = 0;
let appState = { mode: 'Chat' as const };
let providerState = {
  selectedSupportsNativeToolCalling: () => true,
};

const internalTools = {
  web_search: {
    id: 'web_search',
    name: 'Web Search',
    description: 'Search the web',
    category: 'web',
    icon: 'search',
    status: 'enabled',
  },
};

const mcpServers: Array<{
  id: string;
  name: string;
  status: 'online' | 'offline' | 'unconfigured' | 'degraded';
  description: string;
  website?: string;
  transport?: {
    type: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
  tools?: Array<{
    id: string;
    serverId: string;
    name: string;
    inputSchema: Record<string, unknown>;
    enabled: boolean;
  }>;
  config?: { enabled?: boolean };
  lastError?: string | null;
  discoveredAt?: string | null;
}> = [];

const loadToolsView = async () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (
        _key: string,
        fallbackOrOptions?: string | { defaultValue?: string },
        maybeOptions?: { defaultValue?: string }
      ) => {
        if (typeof fallbackOrOptions === 'string') {
          return fallbackOrOptions;
        }
        return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? _key;
      },
    }),
  }));

  mock.module('../../../stores/useToolsStore', () => ({
    useToolsStore: () => ({
      internalTools,
      mcpServers,
      loadSettings: loadSettingsMock,
      toggleTool: toggleToolMock,
      toggleMCPServer: toggleMcpServerMock,
      upsertMCPServer: upsertMcpServerMock,
      removeMCPServer: removeMcpServerMock,
      refreshMCPServerTools: refreshMcpServerToolsMock,
      isToolEnabled: () => true,
    }),
  }));

  mock.module('../../../stores/useAppStore', () => ({
    useAppStore: (selector?: (state: typeof appState) => unknown) =>
      selector ? selector(appState) : appState,
  }));

  mock.module('../../../stores/useProviderStore', () => ({
    useProviderStore: (selector?: (state: typeof providerState) => unknown) =>
      selector ? selector(providerState) : providerState,
  }));

  mock.module('../../../services/toolModePolicy', () => ({
    getToolModePolicy: (mode: 'Chat' | 'Architect' | 'Implement') => ({
      allowedToolIds:
        mode === 'Chat'
          ? ['web_search']
          : ['web_search', 'write', 'edit', 'terminal_run'],
      enforceMacroOnlyWrites: mode === 'Architect',
    }),
  }));

  const actualPreferences = await import(
    `../../../services/preferences.ts?tools-view-test=${importCounter + 1}`
  );

  mock.module('../../../services/preferences', () => ({
    ...actualPreferences,
    loadPreference: (key: string) => loadPreferenceMock(key),
  }));

  const webSearchSettings = {
    provider: 'tavily' as const,
    enabled: true,
    fetchEnabled: true,
    hasTavilySecret: true,
    hasBraveSecret: false,
  };
  const webSearchSettingsModule = {
    getWebSearchSettings: () => webSearchSettings,
    refreshWebSearchSettings: mock(async () => webSearchSettings),
    saveWebSearchSettings: async (value: typeof webSearchSettings) => {
      saveWebSearchSettingsMock(value);
      return value;
    },
    setWebSearchApiKey: mock(async () => webSearchSettings),
  };
  mock.module('../../../services/webSearchSettings', () => webSearchSettingsModule);
  mock.module('../../../services/webSearchSettings.ts', () => webSearchSettingsModule);

  mock.module('../../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../../ui/toastService', () => ({
    notify: {
      success: mock(() => undefined),
      error: mock(() => undefined),
      warning: mock(() => undefined),
      info: mock(() => undefined),
      actionRequired: mock(() => undefined),
      dismiss: mock(() => undefined),
    },
  }));

  mock.module('../../ui/Input', () => ({
    Input: ({
      onChange,
      ...props
    }: React.InputHTMLAttributes<HTMLInputElement>) => (
      <input
        {...props}
        onChange={onChange}
        onInput={(event) => onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>)}
      />
    ),
  }));

  mock.module('../../ui/Switch', () => ({
    Switch: ({
      checked,
      onCheckedChange,
      disabled,
      id,
    }: {
      checked: boolean;
      onCheckedChange: (value: boolean) => void;
      disabled?: boolean;
      id?: string;
    }) => (
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  }));

  mock.module('../../ui/Tabs', () => ({
    Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    TabsTrigger: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
    TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }));

  mock.module('../../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }));

  importCounter += 1;
  return import(`./ToolsView.tsx?test=${importCounter}`);
};

describe('ToolsView', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    loadPreferenceMock.mockClear();
    loadSettingsMock.mockClear();
    toggleToolMock.mockClear();
    toggleMcpServerMock.mockClear();
    upsertMcpServerMock.mockClear();
    removeMcpServerMock.mockClear();
    refreshMcpServerToolsMock.mockClear();
    saveWebSearchSettingsMock.mockClear();
    mcpServers.length = 0;
    appState = { mode: 'Chat' };
    providerState = {
      selectedSupportsNativeToolCalling: () => true,
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    root = null;
    container = null;
    mock.restore();
  });

  it('renders tool configuration without duplicating the approval selector', async () => {
    loadPreferenceMock.mockImplementation(async () => 'strict');
    const { ToolsView } = await loadToolsView();

    await act(async () => {
      root?.render(<ToolsView />);
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Web Search');
    expect(container?.textContent).toContain('Built-in Tools');
    expect(container?.textContent).not.toContain('Max agent turns');
    expect(container?.textContent).not.toContain('Security & approvals');
    expect(container?.textContent).not.toContain('Architect Tool Autonomy');
    expect(loadSettingsMock).toHaveBeenCalledTimes(1);
  });

  it('saves stdio MCP server configuration from the settings form', async () => {
    const { ToolsView } = await loadToolsView();

    await act(async () => {
      root?.render(<ToolsView />);
      await Promise.resolve();
    });

    const setValue = async (selector: string, value: string) => {
      const input = container?.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
      expect(input).toBeTruthy();
      await act(async () => {
        const prototype =
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
        input!.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
    };

    await setValue('input[placeholder="Server name"]', 'Filesystem MCP');
    await setValue('input[placeholder="Command, e.g. npx"]', 'npx');
    await setValue(
      'input[placeholder="Args, e.g. -y @modelcontextprotocol/server-filesystem ."]',
      '["-y","@modelcontextprotocol/server-filesystem","."]'
    );
    await setValue('textarea[placeholder="ENV_NAME=value"]', 'API_TOKEN=secret-token');

    const addButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Add')
    );
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(upsertMcpServerMock).toHaveBeenCalledTimes(1);
    const savedServer = (upsertMcpServerMock.mock.calls as unknown as Array<[any]>)[0]?.[0];
    expect(savedServer).toBeTruthy();
    expect(savedServer.id).toBe('filesystem_mcp');
    expect(savedServer.transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { API_TOKEN: 'secret-token' },
    });
    expect(savedServer.config.enabled).toBe(true);
  });

  it('masks existing MCP secrets in the editor while preserving stored references', async () => {
    mcpServers.push({
      id: 'secret_server',
      name: 'Secret Server',
      description: 'Custom MCP stdio server',
      status: 'online',
      transport: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {
          API_TOKEN: 'macro-secret://mcp-env/secret_server/API_TOKEN',
          DEBUG: '1',
        },
      },
      tools: [],
      config: { enabled: true },
      lastError: null,
      discoveredAt: null,
    });
    const { ToolsView } = await loadToolsView();

    await act(async () => {
      root?.render(<ToolsView />);
      await Promise.resolve();
    });

    const editButton = Array.from(container?.querySelectorAll('button[title="Edit"]') ?? [])[0];
    expect(editButton).toBeTruthy();
    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const envInput = container?.querySelector(
      'textarea[placeholder="ENV_NAME=value"]'
    ) as HTMLTextAreaElement | null;
    expect(envInput?.value).toContain('API_TOKEN=********');
    expect(envInput?.value).toContain('DEBUG=1');

    const saveButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Save')
    );
    expect(saveButton).toBeTruthy();
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const savedServer = (upsertMcpServerMock.mock.calls as unknown as Array<[any]>)[0]?.[0];
    expect(savedServer).toBeTruthy();
    expect(savedServer.transport.env.API_TOKEN).toBe(
      'macro-secret://mcp-env/secret_server/API_TOKEN'
    );
  });
});
