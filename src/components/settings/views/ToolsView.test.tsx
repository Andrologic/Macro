import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const loadPreferenceMock = mock(async (_key?: string) => 'balanced');
const loadSettingsMock = mock(async () => undefined);
const toggleToolMock = mock(async () => undefined);
const toggleMcpServerMock = mock(() => undefined);
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
  status: 'online' | 'offline';
  description: string;
  website?: string;
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
  const actualWebSearchSettings = await import(
    `../../../services/webSearchSettings.ts?tools-view-test=${importCounter + 1}`
  );

  mock.module('../../../services/preferences', () => ({
    ...actualPreferences,
    loadPreference: (key: string) => loadPreferenceMock(key),
  }));

  const webSearchSettingsModule = {
    ...actualWebSearchSettings,
    getWebSearchSettings: () => ({
      provider: 'tavily',
      tavilyApiKey: 'tvly-key',
      braveApiKey: '',
      enabled: true,
      fetchEnabled: true,
    }),
    saveWebSearchSettings: (value: unknown) => saveWebSearchSettingsMock(value),
  };
  mock.module('../../../services/webSearchSettings', () => webSearchSettingsModule);
  mock.module('../../../services/webSearchSettings.ts', () => webSearchSettingsModule);

  mock.module('../../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../../ui/Input', () => ({
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
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
    saveWebSearchSettingsMock.mockClear();
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
    expect(container?.textContent).not.toContain('Security & approvals');
    expect(container?.textContent).not.toContain('Architect Tool Autonomy');
    expect(loadSettingsMock).toHaveBeenCalledTimes(1);
  });
});
