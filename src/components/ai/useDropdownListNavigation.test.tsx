import { afterEach, describe, expect, it } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDropdownListNavigation } from './useDropdownListNavigation';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useDropdownListNavigation without search', () => {
  it('preserves option focus, arrows, Home, End, Space and Escape', async () => {
    const selected: number[] = [];
    function Dropdown() {
      const [isOpen, setIsOpen] = useState(false);
      const nav = useDropdownListNavigation({ isOpen, setIsOpen, itemCount: 3, selectedIndex: 1, onSelect: (index) => selected.push(index) });
      return <><button ref={nav.triggerRef} onKeyDown={nav.handleTriggerKeyDown}>Open</button>
        {isOpen && <div onKeyDown={nav.handleListKeyDown}>{[0, 1, 2].map((index) =>
          <button key={index} ref={(element) => { nav.optionRefs.current[index] = element; }}>{index}</button>,
        )}</div>}</>;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container!); root.render(<Dropdown />); });
    const trigger = container.querySelector('button')!;
    const key = async (target: Element, value: string) => {
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    };
    await key(trigger, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('1');
    for (const [value, expected] of [['Home', '0'], ['ArrowDown', '1'], ['End', '2'], ['ArrowUp', '1']]) {
      await key(document.activeElement!, value!);
      expect(document.activeElement?.textContent).toBe(expected);
    }
    await key(document.activeElement!, ' ');
    expect(selected).toEqual([1]);
    expect(document.activeElement).toBe(trigger);
    await key(trigger, 'ArrowUp');
    await key(document.activeElement!, 'Escape');
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelectorAll('button').length).toBe(1);
  });
});
