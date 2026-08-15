import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelHeaderIconButton } from './PanelHeaderIconButton';

describe('PanelHeaderIconButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps the action icon-only while exposing a stable accessible label and toggle state', async () => {
    await act(async () => {
      root.render(
        <PanelHeaderIconButton
          icon="archive"
          label="Archives"
          pressed
        />,
      );
    });

    const button = container.querySelector('button');
    expect(button?.textContent).toBe('');
    expect(button?.getAttribute('aria-label')).toBe('Archives');
    expect(button?.getAttribute('title')).toBe('Archives');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.className).toContain('h-7 w-7');
  });

  it('disables the action while its spinner is displayed', async () => {
    await act(async () => {
      root.render(
        <PanelHeaderIconButton
          icon="plus"
          label="Create"
          isLoading
        />,
      );
    });

    const button = container.querySelector('button');
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(button?.querySelector('[data-spinner-icon="true"]')).not.toBeNull();
  });
});
