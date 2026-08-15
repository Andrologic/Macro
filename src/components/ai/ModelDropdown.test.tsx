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
    description: 'Qwen3.6-35B-A3B · Chemin rapide',
    isEnabled: true,
  },
  {
    id: 'macro-ai-deep',
    name: 'Macro AI Deep',
    provider_id: 'macro-ai',
    description: 'Qwen3.8-27B · Raisonnement approfondi',
    isEnabled: true,
  },
];

const loadModelDropdown = async () => {
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
      modelsByProvider: { 'macro-ai': models },
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

    expect(container.textContent).toContain('Qwen3.6-35B-A3B · Chemin rapide');
    expect(container.textContent).toContain('Qwen3.8-27B · Raisonnement approfondi');
  });
});
