import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let availableEfforts: string[];
let selectedEffort: string | null;
const selectReasoningEffortMock = mock((effort: string) => {
  selectedEffort = effort;
});
let importCounter = 0;

const loadReasoningDropdown = async () => {
  mock.restore();
  selectReasoningEffortMock.mockClear();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (key: string, fallback?: string) => {
        if (key === 'models.reasoningLevelHigh') return 'Élevé';
        return fallback ?? key;
      },
    }),
  }));
  mock.module('../../stores/useProviderStore', () => ({
    useProviderStore: () => ({
      selectedProviderId: 'provider-a',
      selectedModelId: 'model-a',
      selectedReasoningEffort: selectedEffort,
      getAvailableReasoningEfforts: () => availableEfforts,
      selectReasoningEffort: selectReasoningEffortMock,
    }),
  }));
  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  importCounter += 1;
  return import(`./ReasoningDropdown.tsx?test=${importCounter}`);
};

describe('ReasoningDropdown', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    availableEfforts = [];
    selectedEffort = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    mock.restore();
  });

  it('stays hidden when no reliable levels are available', async () => {
    const { ReasoningDropdown } = await loadReasoningDropdown();

    await act(async () => {
      root = createRoot(container);
      root.render(<ReasoningDropdown />);
    });

    expect(container.querySelector('[data-tour-id="reasoning-dropdown"]')).toBeNull();
  });

  it('translates known levels and preserves unknown values exactly', async () => {
    availableEfforts = ['high', 'ultra'];
    selectedEffort = 'ultra';
    const { ReasoningDropdown } = await loadReasoningDropdown();

    await act(async () => {
      root = createRoot(container);
      root.render(<ReasoningDropdown />);
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-tour-id="reasoning-dropdown"] > button'
    );
    expect(trigger?.textContent).toContain('ultra');

    act(() => trigger?.click());

    expect(container.textContent).toContain('Élevé');
    expect(container.textContent).toContain('ultra');

    const highOption = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Élevé');
    act(() => highOption?.click());
    expect(selectReasoningEffortMock).toHaveBeenCalledWith('high');
  });
});
