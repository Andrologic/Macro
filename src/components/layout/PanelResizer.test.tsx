import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelResizer } from './PanelResizer';

describe('PanelResizer', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    root = null;
    container = null;
  });

  it('exposes a keyboard-operable separator', () => {
    const onResize = mock((_delta: number) => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<PanelResizer onResize={onResize} ariaLabel="Resize left panel" />);
    });

    const separator = container.querySelector('[role="separator"]') as HTMLDivElement | null;
    expect(separator?.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator?.getAttribute('aria-label')).toBe('Resize left panel');
    expect(separator?.tabIndex).toBe(0);

    act(() => {
      separator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      separator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    });

    expect(onResize.mock.calls).toEqual([[8], [-32]]);
  });

  it('removes a disabled separator from the tab order', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<PanelResizer onResize={() => undefined} disabled />);
    });

    expect((container.querySelector('[role="separator"]') as HTMLDivElement | null)?.tabIndex).toBe(-1);
  });

  it('restores body styles and removes drag listeners when unmounted during a resize', () => {
    const onResize = mock((_delta: number) => undefined);
    document.body.style.userSelect = 'text';
    document.body.style.cursor = 'crosshair';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<PanelResizer onResize={onResize} />);
    });
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement | null;
    act(() => {
      separator?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
      }));
    });
    expect(document.body.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('col-resize');

    act(() => {
      root?.unmount();
    });
    root = null;

    expect(document.body.style.userSelect).toBe('text');
    expect(document.body.style.cursor).toBe('crosshair');
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 140 }));
    expect(onResize).not.toHaveBeenCalled();
  });
});
