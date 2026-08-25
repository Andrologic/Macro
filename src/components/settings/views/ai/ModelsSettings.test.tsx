import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import type React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIModel, ProviderConfig } from '../../../../types';

let importCounter = 0;
let providerConfigs: ProviderConfig[];
let modelsByProvider: Record<string, AIModel[]>;
let metadataModelConfigListeners: Set<(value: unknown) => void>;
let loadMetadataModelConfigMock: ReturnType<typeof mock>;
let saveMetadataModelConfigMock: ReturnType<typeof mock>;
let addManualModelMock: ReturnType<typeof mock>;
let updateManualModelMock: ReturnType<typeof mock>;
const translate = (_key: string, fallback?: string) => fallback ?? _key;

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
      t: translate,
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
      addManualModel: addManualModelMock,
      updateManualModel: updateManualModelMock,
      deleteManualModel: mock(async () => undefined),
      resetProviderModelContextOverflowLimit: mock(async () => undefined),
      setProviderModelContextWindowOverride: mock(async () => undefined),
      updateProviderSettings: mock(async () => undefined),
      scanModelsForProvider: mock(async () => []),
      getAvailableReasoningEfforts: () => [],
    }),
  }));

  mock.module('../../../../services/metadataModelPreference', () => ({
    loadMetadataModelConfig: () => loadMetadataModelConfigMock(),
    saveMetadataModelConfig: (value: unknown) => saveMetadataModelConfigMock(value),
    subscribeMetadataModelConfig: (listener: (value: unknown) => void) => {
      metadataModelConfigListeners.add(listener);
      return () => metadataModelConfigListeners.delete(listener);
    },
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
      isLoading: _isLoading,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => (
      <button type={type} onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
  }));

  mock.module('../../../ui/Input', () => ({
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  }));

  mock.module('../../../ui/Switch', () => ({
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
      'aria-label'?: string;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        {...props}
      />
    ),
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

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('ModelsSettings metadata model config', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    providerConfigs = [provider('provider-a'), provider('provider-b')];
    modelsByProvider = {
      'provider-a': [model('provider-a', 'model-a')],
      'provider-b': [model('provider-b', 'model-b')],
    };
    metadataModelConfigListeners = new Set();
    loadMetadataModelConfigMock = mock(async () => {
      const persisted = window.localStorage.getItem('macro_metadataModelConfig');
      if (persisted !== null) return JSON.parse(persisted);
      const legacy = window.localStorage.getItem('macro_smartCommitModelConfig');
      if (legacy !== null) {
        window.localStorage.setItem('macro_metadataModelConfig', legacy);
        return JSON.parse(legacy);
      }
      return null;
    });
    saveMetadataModelConfigMock = mock(async (value: unknown) => {
      window.localStorage.setItem('macro_metadataModelConfig', JSON.stringify(value));
      for (const listener of metadataModelConfigListeners) {
        listener(value);
      }
      return value;
    });
    addManualModelMock = mock(async () => undefined);
    updateManualModelMock = mock(async () => undefined);
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

  it('migrates and repairs a dedicated legacy commit model before rendering selects', async () => {
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
    expect(container!.querySelector('#metadata-generation-model-settings')).toBeDefined();
    expect(container!.querySelector('[data-settings-section="metadata-generation"]')).toBeDefined();
    expect(container!.textContent).toContain('Metadata generation');
    expect(Array.from(modelSelect?.options ?? []).map((option) => option.value)).toContain('model-a');
    expect(Array.from(modelSelect?.options ?? []).map((option) => option.value)).not.toContain('model-b');
    expect(window.localStorage.getItem('macro_metadataModelConfig')).toContain('provider-a');
  });

  it('falls back to conversation when no dedicated provider has credentials', async () => {
    providerConfigs = [
      provider('provider-a', { hasStoredApiKey: false, apiKey: '', isLocal: false }),
    ];
    window.localStorage.setItem(
      'macro_metadataModelConfig',
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
    const persisted = JSON.parse(window.localStorage.getItem('macro_metadataModelConfig') ?? 'null');
    expect(persisted).toEqual({ mode: 'conversation' });
  });

  it('enables reasoning selection for dedicated metadata models with loaded efforts', async () => {
    modelsByProvider = {
      'provider-a': [
        model('provider-a', 'model-a', {
          reasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
        }),
      ],
      'provider-b': [model('provider-b', 'model-b')],
    };
    window.localStorage.setItem(
      'macro_metadataModelConfig',
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

    const reasoningSelect = Array.from(container!.querySelectorAll('select'))
      .find((select) =>
        Array.from(select.options).some((option) => option.value === 'high')
      );
    expect(reasoningSelect).toBeDefined();
    expect(reasoningSelect?.disabled).toBe(false);
    expect(Array.from(reasoningSelect?.options ?? []).map((option) => option.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
    ]);

    await act(async () => {
      reasoningSelect!.value = 'high';
      reasoningSelect!.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });

    const persisted = JSON.parse(window.localStorage.getItem('macro_metadataModelConfig') ?? 'null');
    expect(persisted).toEqual({
      mode: 'dedicated',
      providerId: 'provider-a',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
  });

  it('greys out reasoning selection when the dedicated model has no supported efforts', async () => {
    window.localStorage.setItem(
      'macro_metadataModelConfig',
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

    const reasoningSelect = container!.querySelector<HTMLSelectElement>(
      'select[aria-label="Reasoning"]'
    );
    expect(reasoningSelect?.disabled).toBe(true);
    expect(reasoningSelect?.className).toContain('disabled:cursor-not-allowed');
    expect(container!.textContent).toContain('Not supported by this model');
  });

  it('shows compact context window metadata for models', async () => {
    modelsByProvider = {
      'provider-a': [
        model('provider-a', 'model-a', {
          contextWindowTokens: 32_768,
          contextWindowSource: 'user_override',
        }),
      ],
      'provider-b': [model('provider-b', 'model-b')],
    };
    const { ModelsSettings } = await loadModelsSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ModelsSettings />);
      await flush();
    });

    expect(container!.textContent).toContain('Context');
    expect(container!.textContent).toContain('33k');
    expect(container!.textContent).toContain('Set');
    expect(container!.textContent).toContain('Edit');
  });

  it('saves ordered standard and custom reasoning levels for a manual model', async () => {
    const { ModelsSettings } = await loadModelsSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ModelsSettings />);
      await flush();
    });

    const addModelButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Add Model');
    act(() => addModelButton?.click());

    const inputs = Array.from(container!.querySelectorAll<HTMLInputElement>('input'));
    const modelIdInput = inputs.find((input) => input.placeholder === 'e.g. gpt-4o-mini');
    const configurableSwitch = inputs.find(
      (input) => input.getAttribute('aria-label') === 'Configurable reasoning'
    );
    await act(async () => {
      setInputValue(modelIdInput!, 'custom-reasoner');
      configurableSwitch!.click();
    });

    const lowCheckbox = Array.from(container!.querySelectorAll<HTMLInputElement>('input'))
      .find((input) => input.parentElement?.textContent?.trim() === 'Low');
    act(() => lowCheckbox?.click());

    const customInput = container!.querySelector<HTMLInputElement>('input[placeholder="e.g. ultra"]');
    await act(async () => {
      setInputValue(customInput!, 'ultra');
    });
    const addCustomButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Add');
    act(() => addCustomButton?.click());

    const defaultSelect = container!.querySelector<HTMLSelectElement>(
      'select[aria-label="Default level"]'
    );
    await act(async () => {
      defaultSelect!.value = 'ultra';
      defaultSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const manualModelModal = container!.querySelector<HTMLDivElement>('div.fixed');
    const saveButton = Array.from(manualModelModal!.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Add Model');
    await act(async () => {
      saveButton?.click();
      await flush();
    });

    expect(addManualModelMock).toHaveBeenCalledWith('provider-a', 'custom-reasoner', 'custom-reasoner', {
      reasoningEfforts: ['low', 'ultra'],
      defaultReasoningEffort: 'ultra',
    });
  });

  it('prefills a manual reasoning override and keeps an unknown level exact', async () => {
    modelsByProvider = {
      'provider-a': [
        model('provider-a', 'model-a', {
          isManual: true,
          reasoningCapability: {
            reasoningEfforts: ['medium', 'vendor-max'],
            defaultReasoningEffort: 'vendor-max',
            transportMode: 'openai_effort',
            configurable: true,
            source: 'manual_override',
          },
        }),
      ],
      'provider-b': [model('provider-b', 'model-b')],
    };
    const { ModelsSettings } = await loadModelsSettings();

    await act(async () => {
      root = createRoot(container!);
      root.render(<ModelsSettings />);
      await flush();
    });

    const actionsButton = container!.querySelector<HTMLButtonElement>('button[title="Model actions"]');
    act(() => actionsButton?.click());
    const editButton = document.body.querySelector<HTMLButtonElement>('[role="menu"] button');
    act(() => editButton?.click());

    const defaultSelect = container!.querySelector<HTMLSelectElement>(
      'select[aria-label="Default level"]'
    );
    expect(defaultSelect?.value).toBe('vendor-max');
    expect(Array.from(defaultSelect?.options ?? []).map((option) => option.value)).toEqual([
      'medium',
      'vendor-max',
    ]);
    expect(container!.textContent).toContain('vendor-max');
  });
});
