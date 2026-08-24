import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import type React from 'react';
import { createRoot, type Root } from 'react-dom/client';

const updateProviderConfigMock = mock(
  async (_providerId: string, _updates: Record<string, unknown>) => undefined
);
const updateProviderSettingsMock = mock(async () => undefined);
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
  baseUrl: providerType === 'copilot' ? 'copilot://' : 'https://api.example.test/v1',
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
  }));

  mock.module('../../../../stores/useProviderStore', () => ({
    isLinkedProviderType: (value: string) => value === 'copilot' || value === 'chatgpt',
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
      createProviderConfig: mock(async () => undefined),
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
    }: {
      checked: boolean;
      onCheckedChange: (value: boolean) => void;
    }) => (
      <input
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

  importCounter += 1;
  return import(`./ProvidersSettings.tsx?test=${importCounter}`);
};

describe('ProvidersSettings Copilot timeout', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    updateProviderConfigMock.mockClear();
    updateProviderSettingsMock.mockClear();
    testConnectionMock.mockClear();
    providerType = 'copilot';
    copilotTimeoutMs = 2_700_000;
    providerConfigsOverride = null;
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

  it('shows configured providers first and gives search and add matching visual weight', async () => {
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

    const search = container!.querySelector(
      'input[aria-label="Search providers..."]'
    ) as HTMLInputElement;
    const addButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add Provider'
    );
    expect(search.className).toContain('h-10');
    expect(addButton?.className).toContain('h-10');

    await act(async () => {
      setInputValue(search, 'Needs');
    });
    expect(container!.textContent).not.toContain('Configured providers');
    expect(container!.textContent).toContain('Providers to configure');
    expect(container!.textContent).not.toContain('Ready provider');
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

    expect(container!.querySelector('input[type="checkbox"]')).toBeNull();
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
