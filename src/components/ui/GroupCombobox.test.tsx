import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GroupCombobox } from './GroupCombobox';

describe('GroupCombobox', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalGetComputedStyle: typeof window.getComputedStyle;
  let originalInnerHeight: number;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    container = null;
    root = null;
    if (originalGetBoundingClientRect) {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
    if (originalGetComputedStyle) {
      Object.defineProperty(window, 'getComputedStyle', {
        configurable: true,
        value: originalGetComputedStyle,
      });
    }
    if (originalInnerHeight) {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
    document.body.innerHTML = '';
  });

  it('renders the dropdown above scroll containers when there is not enough space below', async () => {
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    originalGetComputedStyle = window.getComputedStyle.bind(window);
    originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
    const onSelect = mock(() => undefined);
    container = document.createElement('div');
    container.style.overflow = 'hidden';
    container.style.overflowY = 'hidden';
    document.body.appendChild(container);
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this === container) {
        return {
          x: 80,
          y: 100,
          top: 100,
          right: 460,
          bottom: 780,
          left: 80,
          width: 380,
          height: 680,
          toJSON: () => undefined,
        };
      }

      return {
        x: 100,
        y: 740,
        top: 740,
        right: 420,
        bottom: 780,
        left: 100,
        width: 320,
        height: 40,
        toJSON: () => undefined,
      };
    };
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        if (element === container) {
          return { overflow: 'hidden', overflowY: 'hidden' } as CSSStyleDeclaration;
        }

        return originalGetComputedStyle(element);
      },
    });
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <GroupCombobox
          projectGroups={[
            { id: 'alpha', name: 'Alpha' },
            { id: 'beta', name: 'Beta' },
          ]}
          selectedGroupId={null}
          onSelect={onSelect}
          placeholder="Choose..."
        />
      );
      await Promise.resolve();
    });

    const input = document.body.querySelector('input');
    expect(input).toBeDefined();

    await act(async () => {
      input?.focus();
      await Promise.resolve();
    });

    const dropdown = Array.from(document.body.querySelectorAll('div')).find((element) =>
      element.className.includes('z-[80]')
    ) as HTMLDivElement | undefined;
    expect(dropdown).toBeDefined();
    expect(dropdown?.parentElement).toBe(document.body);
    expect(dropdown?.className).toContain('fixed');
    const dropdownTop = Number.parseFloat(dropdown?.style.top ?? '0');
    expect(dropdownTop).toBeGreaterThan(680);
    expect(dropdownTop).toBeLessThan(740);
    expect(dropdown?.style.width).toBe('320px');

    const alphaOption = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Alpha'
    );
    expect(alphaOption).toBeDefined();

    await act(async () => {
      alphaOption?.click();
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledWith('alpha');
  });
});
