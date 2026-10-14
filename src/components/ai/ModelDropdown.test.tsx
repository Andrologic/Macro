import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIModel } from '../../types';

const selectModelMock = mock((_modelId: string) => undefined);
let importCounter = 0;

const models: AIModel[] = [
  {
    id: 'macro-ai',
    name: 'Macro AI Fast',
    provider_id: 'macro-ai',
    description: 'Qwen3.6-35B-A3B',
    isEnabled: true,
  },
  {
    id: 'macro-ai-deep',
    name: 'Macro AI Deep',
    provider_id: 'macro-ai',
    description: 'Qwen3.8-27B',
    isEnabled: true,
  },
  { id: 'disabled', name: 'Hidden model', provider_id: 'macro-ai', isEnabled: false },
  { id: 'accented-id', name: 'Modèle Élite', provider_id: 'macro-ai', description: 'Famille précise' },
];

const loadModelDropdown = async (availableModels = models) => {
  mock.restore();
  selectModelMock.mockClear();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
    }),
  }));
  mock.module('../../stores/useProviderStore', () => ({
    useProviderStore: () => ({
      selectedProviderId: 'macro-ai',
      selectedModelId: 'macro-ai',
      modelsByProvider: { 'macro-ai': availableModels, other: [{ id: 'other', name: 'Other provider', provider_id: 'other' }] },
      selectModel: selectModelMock,
      isLoadingModels: false,
    }),
  }));
  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  importCounter += 1;
  return import(`./ModelDropdown.tsx?test=${importCounter}`);
};

describe('ModelDropdown', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    mock.restore();
  });

  it('shows model descriptions as subtitles in the open selector', async () => {
    const { ModelDropdown } = await loadModelDropdown();

    await act(async () => {
      root = createRoot(container);
      root.render(<ModelDropdown />);
    });

    const trigger = container.querySelector<HTMLButtonElement>('[data-tour-id="model-dropdown"] > button');
    expect(trigger).not.toBeNull();

    act(() => trigger?.click());

    expect(container.textContent).toContain('Qwen3.6-35B-A3B');
    expect(container.textContent).toContain('Qwen3.8-27B');
  });

  it('exposes a named listbox and selects models with the keyboard', async () => {
    const { ModelDropdown } = await loadModelDropdown();

    await act(async () => {
      root = createRoot(container);
      root.render(<ModelDropdown />);
    });

    const trigger = container.querySelector<HTMLButtonElement>('[data-tour-id="model-dropdown"] > button');
    expect(trigger?.getAttribute('aria-label')).toBe('Choose AI model');
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Choose AI model');
    const search = container.querySelector<HTMLInputElement>('[role="combobox"]');
    expect(document.activeElement).toBe(search);

    await act(async () => {
      search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    expect(selectModelMock).toHaveBeenCalledWith('macro-ai-deep');
    expect(document.activeElement).toBe(trigger ?? null);
  });

  const renderOpen = async (availableModels = models) => {
    const { ModelDropdown } = await loadModelDropdown(availableModels);
    await act(async () => {
      root = createRoot(container);
      root.render(<ModelDropdown />);
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-tour-id="model-dropdown"] > button')!;
    await act(async () => {
      trigger.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    return { trigger, search: container.querySelector<HTMLInputElement>('[role="combobox"]')! };
  };

  const typeQuery = (input: HTMLInputElement, value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('filters enabled models of the current provider by name, id and description without case or accents', async () => {
    const { search } = await renderOpen();
    expect(container.textContent).not.toContain('Hidden model');
    expect(container.textContent).not.toContain('Other provider');
    for (const query of ['MODELE ELITE', 'accented-id', 'FAMILLE PRECISE']) {
      typeQuery(search, query);
      const options = container.querySelectorAll('[role="option"]');
      expect(options.length).toBe(1);
      expect(options[0]?.textContent).toContain('Modèle Élite');
      expect(document.activeElement).toBe(search);
      expect(search.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
      expect(selectModelMock).not.toHaveBeenCalled();
    }
    typeQuery(search, 'qWEN3.8');
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Macro AI Deep');
    act(() => container.querySelector<HTMLButtonElement>('[role="option"]')?.click());
    expect(selectModelMock).toHaveBeenCalledWith('macro-ai-deep');
  });

  it('allows text editing keys, handles empty results, clears and resets on reopening', async () => {
    const { trigger, search } = await renderOpen();
    typeQuery(search, 'no result');
    expect(container.textContent).toContain('No matching models.');
    expect(container.querySelector('[role="option"]')).toBeNull();
    expect(search.hasAttribute('aria-activedescendant')).toBe(false);
    for (const key of [' ', 'Home', 'End']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => search.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(selectModelMock).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Clear model search"]')?.click());
    expect(search.value).toBe('');
    expect(container.querySelectorAll('[role="option"]').length).toBe(3);
    typeQuery(search, 'deep');
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => {
      trigger.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(container.querySelector<HTMLInputElement>('[role="combobox"]')?.value).toBe('');
    expect(container.querySelectorAll('[role="option"]').length).toBe(3);
  });

  it('opens an empty enabled catalogue without selecting anything', async () => {
    const { search } = await renderOpen([]);
    expect(document.activeElement).toBe(search);
    expect(container.textContent).toContain('No enabled models.');
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(selectModelMock).not.toHaveBeenCalled();
  });

});
