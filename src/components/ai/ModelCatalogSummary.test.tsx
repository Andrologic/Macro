import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { __testables } from '../../services/modelContextCatalog';
import type { AIModel, ProviderConfig } from '../../types';

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (_key: string, fallback: string, values?: Record<string, string>) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => values?.[key] ?? ''),
  }),
}));
const { ModelCatalogSummary } = await import('./ModelCatalogSummary');

const provider: ProviderConfig = {
  id: 'openai', name: 'OpenAI', providerType: 'openai', baseUrl: 'https://api.openai.com/v1',
  hasStoredApiKey: true, isEnabled: true, isLocal: false, nativeToolCalling: true,
};
const model: AIModel = { id: 'gpt-4o', name: 'GPT-4o', provider_id: 'openai' };

describe('ModelCatalogSummary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    __testables.reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (selectedModel = model, selectedProvider = provider) => {
    act(() => root.render(<ModelCatalogSummary model={selectedModel} provider={selectedProvider} />));
  };

  it('shows compact context and known capabilities with an exact context tooltip', () => {
    render();
    expect(container.textContent).toBe('128K context Images Tools');
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe('128,000 token context');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps user/provider context priority and replaces only the Macro fallback', () => {
    render({ ...model, contextWindowTokens: 32000, contextWindowSource: 'user_override' });
    expect(container.textContent).toContain('32K context');
    render({ ...model, contextWindowTokens: 64000, contextWindowSource: 'provider_metadata' });
    expect(container.textContent).toContain('64K context');
    render({ ...model, contextWindowTokens: 64000, contextWindowSource: 'macro_fallback' });
    expect(container.textContent).toContain('128K context');
  });

  it('does not advertise images through Copilot or tools rejected by the configuration/model', () => {
    render(model, { ...provider, providerType: 'copilot' });
    expect(container.textContent).not.toContain('Images');
    render(model, { ...provider, nativeToolCalling: false });
    expect(container.textContent).not.toContain('Tools');
    render({ ...model, nativeToolCalling: false });
    expect(container.textContent).not.toContain('Tools');
  });

  it('renders no claims for unknown metadata, unsupported transports or explicit false', () => {
    render({ ...model, id: 'unknown' });
    expect(container.textContent).toBe('');
    __testables.writeCachedCatalog({ fetchedAt: '2026-10-14', providers: {
      openai: { models: { 'gpt-4o': { id: 'gpt-4o', tool_call: false, modalities: { input: ['text'] } } } },
    } });
    render();
    expect(container.textContent).toBe('');
    __testables.writeCachedCatalog({ fetchedAt: '2026-10-14', providers: {
      anthropic: { models: { 'gpt-4o': { id: 'gpt-4o', tool_call: true, modalities: { input: ['image'] } } } },
    } });
    render(model, { ...provider, id: 'anthropic', providerType: 'anthropic', baseUrl: '', nativeToolCalling: true });
    expect(container.textContent).toBe('');
  });
});
