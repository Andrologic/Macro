import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GroupCombobox } from './GroupCombobox';
import { Dialog } from './Dialog';

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

    const dropdown = document.body.querySelector<HTMLDivElement>('[data-macro-dialog-portal]');
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

  it.each(['select', 'clear', 'create-button', 'create-enter'] as const)(
    'restores input focus without reopening after %s inside a dialog', async (action) => {
      const onSelect = mock((_id: string | null) => undefined);
      const onCreate = mock((_name: string) => undefined);
      const onClose = mock(() => undefined);
      const Harness = () => {
        const [selected, setSelected] = useState<string | null>('alpha');
        const [groups, setGroups] = useState([{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]);
        return <Dialog title="Groups" onClose={onClose}>
          <GroupCombobox projectGroups={groups} selectedGroupId={selected}
            onSelect={(id) => { onSelect(id); setSelected(id); }}
            onCreateGroup={(name) => {
              onCreate(name);
              setGroups([...groups, { id: 'created', name }]);
              setSelected('created');
            }} />
          <button>Neighbor</button>
        </Dialog>;
      };
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => { root?.render(<Harness />); });
      const input = document.body.querySelector<HTMLInputElement>('input')!;
      await act(async () => { input.focus(); });
      if (action.startsWith('create')) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, 'Gamma');
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
      }
      await act(async () => {
        if (action === 'create-enter') {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        } else {
          const options = document.body.querySelectorAll<HTMLButtonElement>('[data-macro-dialog-portal] button');
          const option = action === 'clear' ? options[0] : options[options.length - 1];
          // Native buttons dispatch click for pointer and keyboard activation.
          // Focus explicitly: happy-dom does not emulate pointer focus or native key activation.
          option.focus();
          option.click();
        }
      });
      expect(document.activeElement).toBe(input);
      expect(document.body.querySelector('[data-macro-dialog-portal]')).toBeNull();
      expect(input.value).toBe(action === 'select' ? 'Beta' : action === 'clear' ? '' : 'Gamma');
      if (action.startsWith('create')) {
        expect(onCreate).toHaveBeenCalledTimes(1);
        expect(onCreate).toHaveBeenCalledWith('Gamma');
        expect(onSelect).not.toHaveBeenCalled();
      } else {
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(action === 'select' ? 'beta' : null);
        expect(onCreate).not.toHaveBeenCalled();
      }
      expect(onClose).not.toHaveBeenCalled();
      expect(container.hasAttribute('inert')).toBe(true);
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['Escape', () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })],
    ['an outside click', () => new MouseEvent('mousedown', { bubbles: true })],
  ])('restores the selected group after abandoning search with %s', async (_action, createEvent) => {
    const onSelect = mock(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <GroupCombobox
          projectGroups={[{ id: 'alpha', name: 'Alpha' }]}
          selectedGroupId="alpha"
          onSelect={onSelect}
        />
      );
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>('input');
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      input?.focus();
      valueSetter?.call(input, 'Alp');
      input?.dispatchEvent(new window.Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(input?.value).toBe('Alp');
    await act(async () => {
      if (createEvent().type === 'mousedown') {
        document.body.dispatchEvent(createEvent());
      } else {
        input?.dispatchEvent(createEvent());
      }
      await Promise.resolve();
    });

    expect(input?.value).toBe('Alpha');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
