import { afterEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AsyncPanel } from './ModeRouter';
import {
  createModePanelLoader,
  hasModePanel,
} from './modePanelLoaders';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ModeRouter AsyncPanel', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container = null;
  });

  const renderPanel = (element: React.ReactNode) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  };

  it('shows the fallback while loading and renders the loaded panel', async () => {
    let resolveLoader: ((component: React.ComponentType) => void) | null = null;
    const loader = createModePanelLoader({
      id: 'test:center:slow',
      label: 'Slow panel',
      mode: 'Chat',
      panel: 'center',
      importComponent: () =>
        new Promise((resolve) => {
          resolveLoader = resolve;
        }),
    });

    const target = renderPanel(
      <AsyncPanel loader={loader} fallback={<div>Loading panel</div>} />,
    );

    expect(target.textContent).toContain('Loading panel');

    await act(async () => {
      resolveLoader?.(() => <div>Loaded panel</div>);
      await flushPromises();
    });

    expect(target.textContent).toContain('Loaded panel');
  });

  it('keeps chunk failures local and retries the loader', async () => {
    const consoleError = console.error;
    console.error = mock(() => undefined) as unknown as typeof console.error;
    let attempts = 0;
    const loader = createModePanelLoader({
      id: 'test:center:retry',
      label: 'Retry panel',
      mode: 'Implement',
      panel: 'center',
      importComponent: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('chunk failed');
        }
        return () => <div>Recovered panel</div>;
      },
    });

    try {
      const target = renderPanel(
        <AsyncPanel loader={loader} fallback={<div>Loading panel</div>} />,
      );

      await act(async () => {
        await flushPromises();
      });

      expect(target.textContent).toContain('Retry panel could not load.');
      expect(target.textContent).toContain('chunk failed');

      const retryButton = Array.from(target.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Retry'),
      );
      expect(retryButton).not.toBeNull();

      await act(async () => {
        retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushPromises();
      });

      expect(target.textContent).toContain('Recovered panel');
      expect(attempts).toBe(2);
    } finally {
      console.error = consoleError;
    }
  });
});

describe('mode panel configuration', () => {
  it('provides navigation and work surfaces for every Architect slot', () => {
    expect(hasModePanel('Architect', 'left')).toBe(true);
    expect(hasModePanel('Architect', 'center')).toBe(true);
    expect(hasModePanel('Architect', 'right')).toBe(true);
    expect(hasModePanel('Chat', 'left')).toBe(true);
    expect(hasModePanel('Implement', 'left')).toBe(true);
  });
});
