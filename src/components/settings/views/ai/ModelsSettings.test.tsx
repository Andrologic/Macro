import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import type React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIModel, ProviderConfig } from '../../../../types';

let importCounter = 0;
let providerConfigs: ProviderConfig[];
let modelsByProvider: Record<string, AIModel[]>;

const provider = (id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id,
  name: id === 'provider-a' ? 'Provider A' : 'Provider B',
  providerType: 'openai',
  baseUrl: `https://${id}.example.test/v1`,
  hasStoredApiKey: true,
  isEnabled: true,
  isLocal: false,
  ...overrides,
});

const model = (providerId: string, id: string, overrides: Partial<AIModel> = {}): AIModel => ({
  id,
  name: id === 'model-a' ? 'Model A' : 'Model B',
  provider_id: providerId,
  isEnabled: true,
  ...overrides,
});

const loadModelsSettings = async () => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
    }),
  }));

  mock.module('../../../../stores/useProviderStore', () => ({
    providerHasCredentials: (provider: ProviderConfig) =>
      !!provider.isEnabled && (!!provider.isLocal || !!provider.apiKey || !!provider.hasStoredApiKey),
    useProviderStore: () => ({
      providerConfigs,
      modelsByProvider,
      providerSettingsById: {},
      setProviderModelEnabled: mock(async () => undefined),
      setAllProviderModelsEnabled: mock(async () => undefined),
      addManualModel: mock(async () => undefined),
      updateManualModel: mock(async () => undefined),
      deleteManualModel: mock(async () => undefined),
      updateProviderSettings: mock(async () => undefined),
      scanModelsForProvider: mock(async () => []),
      getAvailableReasoningEfforts: () => [],
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
      type = 'button',
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type={type} onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
  }));

  mock.module('../../../ui/Input', () => ({
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  }));

  mock.module('../../../ui/Switch', () => ({
    Switch: () => <input type="checkbox" />,
  }));

  mock.module('../../../ui/ConfirmPromptModal', () => ({
    ConfirmPromptModal: () => null,
  }));

  mock.module('../../../ui/Accordion', () => ({
    Accordion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AccordionItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AccordionTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
    AccordionContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }));

  mock.module('../../../ui/toastService', () => ({
    notify: {
      success: mock(() => undefined),
      error: mock(() => undefined),
    },
  }));

  mock.module('../../../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
  }));

  importCounter += 1;
  return import(`./ModelsSettings.tsx?test=${importCounter}`);
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('ModelsSettings smart commit model config', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    providerConfigs = [provider('provider-a'), provider('provider-b')];
    modelsByProvider = {
      'provider-a': [model('provider-a', 'model-a')],
      'provider-b': [model('provider-b', 'model-b')],
    };
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    mock.restore();
    window.localStorage.clear();
  });

  it('repairs a dedicated model that belongs to another provider before rendering selects', async () => {
    window.localStorage.setItem(
      'macro_smartCommitModelConfig',
      JSON.stringify({
        mode: 'dedicated',
        providerId: 'provider-a',
        modelId: 'model-b',
        reasoningEffort: null,
      })
    );
    const { ModelsSettings } = await loadModelsSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ModelsSettings />);
      await flush();
    });

    const selects = Array.from(container!.querySelectorAll('select'));
    const providerSelect = selects.find((select) =>
      Array.from(select.options).some((option) => option.value === 'provider-a')
    );
    const modelSelect = selects.find((select) =>
      Array.from(select.options).some((option) => option.value === 'model-a')
    );

    expect(providerSelect?.value).toBe('provider-a');
    expect(modelSelect?.value).toBe('model-a');
    expect(container!.querySelector('#commit-message-model-settings')).toBeDefined();
    expect(container!.querySelector('[data-settings-section="commit-messages"]')).toBeDefined();
    expect(Array.from(modelSelect?.options ?? []).map((option) => option.value)).toContain('model-a');
    expect(Array.from(modelSelect?.options ?? []).map((option) => option.value)).not.toContain('model-b');
  });

  it('falls back to conversation when no dedicated provider has credentials', async () => {
    providerConfigs = [
      provider('provider-a', { hasStoredApiKey: false, apiKey: '', isLocal: false }),
    ];
    window.localStorage.setItem(
      'macro_smartCommitModelConfig',
      JSON.stringify({
        mode: 'dedicated',
        providerId: 'provider-a',
        modelId: 'model-a',
        reasoningEffort: null,
      })
    );
    const { ModelsSettings } = await loadModelsSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ModelsSettings />);
      await flush();
    });

    expect(container!.textContent).toContain('Use conversation model');
    const persisted = JSON.parse(window.localStorage.getItem('macro_smartCommitModelConfig') ?? 'null');
    expect(persisted).toEqual({ mode: 'conversation' });
  });
});
