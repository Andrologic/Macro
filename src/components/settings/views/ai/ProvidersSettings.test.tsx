import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import type React from 'react';
import { createRoot, type Root } from 'react-dom/client';

const updateProviderConfigMock = mock(
  async (_providerId: string, _updates: Record<string, unknown>) => undefined
);
const updateProviderSettingsMock = mock(async () => undefined);
const createProviderConfigMock = mock(async () => undefined);
const testConnectionMock = mock(async () => ({ success: true, message: 'ok' }));

type ProviderType = 'copilot' | 'openai';

const makeProvider = (
  providerType: ProviderType,
  overrides: Partial<{
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    hasStoredApiKey: boolean;
    apiKeyLoaded: boolean;
    isEnabled: boolean;
    isLocal: boolean;
    authStatus: string | undefined;
  }> = {}
) => ({
  id: providerType,
  name: providerType === 'copilot' ? 'GitHub Copilot' : 'OpenAI Compatible',
  baseUrl: providerType === 'copilot' ? 'copilot://cli' : 'https://api.example.test/v1',
  apiKey: '',
  hasStoredApiKey: false,
  apiKeyLoaded: false,
  isEnabled: true,
  isLocal: false,
  providerType,
  authStatus: providerType === 'copilot' ? 'connected' : undefined,
  ...overrides,
});

let providerType: ProviderType = 'copilot';
let copilotTimeoutMs: number | null = 2_700_000;
let providerConfigsOverride: ReturnType<typeof makeProvider>[] | null = null;
let settingsSearchQuery = '';
let importCounter = 0;

const click = (element: Element) => {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

const loadProvidersSettings = async () => {
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
    initReactI18next: {
      type: '3rdParty',
      init: () => undefined,
    },
  }));

  mock.module('../../../../stores/useProviderStore', () => ({
    isLinkedProviderType: (value: string) => value === 'copilot' || value === 'chatgpt',
    providerHasCredentials: (provider: { isEnabled: boolean; isLocal: boolean; apiKey?: string; hasStoredApiKey: boolean }) =>
      provider.isEnabled && (provider.isLocal || !!provider.apiKey || provider.hasStoredApiKey),
    providerHasAuthSession: (provider: { authStatus?: string }) =>
      provider.authStatus === 'connected',
    useProviderStore: () => ({
      providerConfigs: providerConfigsOverride ?? [makeProvider(providerType)],
      providerReachabilityById: {},
      copilotStatusByProvider: {
        copilot: {
          runtime_status: 'ready',
          auth_status: 'connected',
          auth_source: 'oauth',
        },
      },
      copilotDownloadStateByProvider: {},
      copilotAuthStateByProvider: {},
      providerSettingsById: {
        copilot: {
          providerId: 'copilot',
          filterFreeModels: false,
          copilotSendTimeoutMs: copilotTimeoutMs,
        },
      },
      updateProviderConfig: updateProviderConfigMock,
      updateProviderSettings: updateProviderSettingsMock,
      createProviderConfig: createProviderConfigMock,
      deleteProviderConfig: mock(async () => undefined),
      startChatGptAuth: mock(async () => undefined),
      startCopilotRuntimeDownload: mock(async () => undefined),
      cancelCopilotRuntimeDownload: mock(async () => undefined),
      startCopilotAuth: mock(async () => undefined),
      cancelCopilotAuth: mock(async () => undefined),
      authErrorsByProvider: {},
      disconnectProviderAuth: mock(async () => undefined),
      testConnection: testConnectionMock,
      resolveProviderApiKey: mock(async () => ''),
    }),
  }));

  mock.module('../../../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../../../ui/Button', () => ({
    Button: ({
      children,
      onClick,
      disabled,
      isLoading: _isLoading,
      type = 'button',
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => (
      <button type={type} onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
  }));

  mock.module('../../../ui/Input', () => ({
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

  mock.module('../../../ui/Switch', () => ({
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked: boolean;
      onCheckedChange: (value: boolean) => void;
    } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'>) => (
      <input
        {...props}
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  }));

  mock.module('../../../ui/ConfirmPromptModal', () => ({
    ConfirmPromptModal: () => null,
  }));

  mock.module('../../../ui/toastService', () => ({
    notify: {
      success: mock(() => undefined),
      error: mock(() => undefined),
    },
  }));

  mock.module('../../../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }));

  mock.module('../../search/SettingsSearch', () => ({
    useSettingsSearch: () => ({
      query: settingsSearchQuery,
      setQuery: () => undefined,
      matches: (...values: Array<string | false | null | undefined>) => {
        const query = settingsSearchQuery.toLowerCase();
        return !query || values.filter(Boolean).join(' ').toLowerCase().includes(query);
      },
    }),
    SettingsCollectionHeader: ({ action }: { action?: React.ReactNode }) => <div>{action}</div>,
    SettingsSearchEmpty: ({ message }: { message?: React.ReactNode }) => (
      <div>{message ?? 'No matching providers'}</div>
    ),
  }));

  importCounter += 1;
  return import(`./ProvidersSettings.tsx?test=${importCounter}`);
};

describe('ProvidersSettings Copilot timeout', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    updateProviderConfigMock.mockClear();
    updateProviderSettingsMock.mockClear();
    createProviderConfigMock.mockClear();
    testConnectionMock.mockClear();
    providerType = 'copilot';
    copilotTimeoutMs = 2_700_000;
    providerConfigsOverride = null;
    settingsSearchQuery = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    container = null;
    root = null;
    mock.restore();
  });

  it('shows the timeout field for Copilot providers and saves minutes as milliseconds', async () => {
    const { ProvidersSettings } = await loadProvidersSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ProvidersSettings />);
    });

    const editButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit'
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      click(editButton!);
    });

    expect(container!.textContent).toContain('Copilot response timeout');
    const timeoutInput = container!.querySelector('input[type="number"]') as HTMLInputElement;
    expect(timeoutInput.value).toBe('45');

    await act(async () => {
      setInputValue(timeoutInput, '2.4');
      click(
        Array.from(container!.querySelectorAll('button')).find(
          (button) => button.textContent === 'Save Provider'
        )!
      );
    });

    expect(updateProviderSettingsMock).toHaveBeenCalledWith('copilot', {
      copilotSendTimeoutMs: 120_000,
    });
    expect(updateProviderConfigMock).toHaveBeenCalledWith(
      'copilot',
      expect.objectContaining({ baseUrl: 'copilot://cli', providerType: 'copilot' })
    );
  });

  it('does not show the timeout field for OpenAI-compatible providers', async () => {
    providerType = 'openai';
    const { ProvidersSettings } = await loadProvidersSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ProvidersSettings />);
    });

    const editButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit'
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      click(editButton!);
    });

    expect(container!.textContent).not.toContain('Copilot response timeout');
  });

  it('shows configured providers first and keeps the add action', async () => {
    providerConfigsOverride = [
      makeProvider('openai', {
        id: 'needs-key',
        name: 'Needs a key',
      }),
      makeProvider('openai', {
        id: 'ready',
        name: 'Ready provider',
        hasStoredApiKey: true,
      }),
    ];
    const { ProvidersSettings } = await loadProvidersSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ProvidersSettings />);
    });

    const text = container!.textContent ?? '';
    expect(text).toContain('Configured providers');
    expect(text).toContain('Providers to configure');
    expect(text.indexOf('Configured providers')).toBeLessThan(
      text.indexOf('Providers to configure')
    );
    expect(text.indexOf('Ready provider')).toBeLessThan(text.indexOf('Needs a key'));

    const addButton = container!.querySelector<HTMLButtonElement>('button[aria-label="Add Provider"]');
    expect(addButton?.className).toContain('h-9');
    expect(addButton?.className).toContain('w-9');
    expect(container!.querySelector('input[aria-label="Search providers..."]')).toBeNull();
  });

  it('filters providers with the shared page search', async () => {
    providerConfigsOverride = [
      makeProvider('openai', { id: 'needs-key', name: 'Needs a key' }),
      makeProvider('openai', { id: 'ready', name: 'Ready provider', hasStoredApiKey: true }),
    ];
    settingsSearchQuery = 'needs';
    const { ProvidersSettings } = await loadProvidersSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ProvidersSettings />);
    });

    expect(container!.textContent).not.toContain('Configured providers');
    expect(container!.textContent).toContain('Providers to configure');
    expect(container!.textContent).not.toContain('Ready provider');
  });

  it('keeps an empty provider draft open and focuses inline validation', async () => {
    providerConfigsOverride = [];
    const { ProvidersSettings } = await loadProvidersSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ProvidersSettings />);
    });

    await act(async () => {
      click(Array.from(container!.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Add Provider')
      )!);
    });
    expect(container!.querySelector<HTMLInputElement>('[placeholder="https://api.openai.com/v1"]')?.value)
      .toBe('https://api.openai.com/v1');
    await act(async () => {
      click(Array.from(container!.querySelectorAll('button')).find(
        (button) => button.textContent === 'Save Provider'
      )!);
    });

    expect(createProviderConfigMock).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('Provider name is required.');
    expect(container!.textContent).not.toContain('Base URL is required.');
    expect(document.activeElement).toBe(container!.querySelector('input[aria-invalid="true"]'));
  });

  it('saves an API key without rendering a provider enabled switch', async () => {
    providerType = 'openai';
    const { ProvidersSettings } = await loadProvidersSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ProvidersSettings />);
    });

    await act(async () => {
      click(
        Array.from(container!.querySelectorAll('button')).find(
          (button) => button.textContent === 'Edit'
        )!
      );
    });

    expect(container!.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    const apiKeyInput = container!.querySelector('input[type="password"]') as HTMLInputElement;

    await act(async () => {
      setInputValue(apiKeyInput, 'new-api-key');
      click(
        Array.from(container!.querySelectorAll('button')).find(
          (button) => button.textContent === 'Save Provider'
        )!
      );
    });

    expect(updateProviderConfigMock).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ apiKey: 'new-api-key' })
    );
    expect(updateProviderConfigMock.mock.calls[0]?.[1]).not.toHaveProperty('isEnabled');
  });

  it('allows a generic provider running locally to use HTTP', async () => {
    providerConfigsOverride = [];
    const { ProvidersSettings } = await loadProvidersSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ProvidersSettings />);
    });
    await act(async () => {
      click(Array.from(container!.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Add Provider')
      )!);
    });

    const textInputs = container!.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"]):not([type="password"])');
    const nameInput = textInputs[0];
    const baseUrlInput = textInputs[1];
    const localEndpointSwitch = container!.querySelector<HTMLInputElement>(
      '#provider-local-endpoint'
    );

    await act(async () => {
      setInputValue(nameInput, 'Local gateway');
      setInputValue(baseUrlInput, 'http://127.0.0.1:1234/v1');
      click(localEndpointSwitch!);
      click(Array.from(container!.querySelectorAll('button')).find(
        (button) => button.textContent === 'Save Provider'
      )!);
    });

    expect(createProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Local gateway',
        baseUrl: 'http://127.0.0.1:1234/v1',
        isLocal: true,
        providerType: 'openai',
      })
    );
  });

  it('uses an icon-only refresh action on Copilot provider cards', async () => {
    const { ProvidersSettings } = await loadProvidersSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ProvidersSettings />);
    });

    expect(container!.textContent).not.toContain('Re-check status');
    expect(
      container!.querySelector('button[aria-label="Re-check status"] [data-icon="refresh-cw"]')
    ).toBeTruthy();
  });
});
