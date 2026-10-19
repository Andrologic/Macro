import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarMenu, isSidebarTextInput } from './SidebarMenu';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove(); root = null; container = null;
});

function Scene() {
  const firstTrigger = useRef<HTMLButtonElement>(null);
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  return <>
    <button ref={firstTrigger} onClick={() => setFirst(true)}>First</button>
    <button onClick={() => setSecond(true)}>Second</button>
    <button>Outside</button>
    {first && <SidebarMenu position={{ left: 5000, top: 5000 }} triggerRef={firstTrigger} onClose={() => setFirst(false)} aria-label="First menu">
      <button role="menuitem">Rename</button><button role="menuitem" disabled>Unavailable</button><button role="menuitem">Move</button>
      <details><summary role="menuitem">Other actions</summary><button role="menuitem">Extra action</button></details>
    </SidebarMenu>}
    {second && <SidebarMenu position={{ left: 20, top: 20 }} onClose={() => setSecond(false)} aria-label="Second menu"><button role="menuitemcheckbox" aria-checked={false}>New item</button></SidebarMenu>}
  </>;
}
async function renderScene() {
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Scene />));
}
const button = (text: string) => [...container!.querySelectorAll('button')].find(item => item.textContent === text)!;
const key = async (value: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); });

describe('SidebarMenu', () => {
  it('keeps the popup inside the viewport and navigates enabled actions without activating its row', async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    const geometry = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? new window.DOMRect(0, 0, 208, 176) : original.call(this);
    });
    try {
      await renderScene();
      await act(async () => { button('First').focus(); button('First').click(); });
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
      expect(menu.parentElement).toBe(document.body);
      expect(container!.contains(menu)).toBe(false);
      expect(parseFloat(menu.style.left)).toBe(window.innerWidth - 208 - 8);
      expect(parseFloat(menu.style.top)).toBe(window.innerHeight - 176 - 8);
      expect(document.activeElement?.textContent).toBe('Rename');
      await key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Move');
      await key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Other actions');
      await key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Rename');
      await key('End'); expect(document.activeElement?.textContent).toBe('Other actions');
      await key('Escape'); expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(button('First'));
      await act(async () => button('First').click());
      await key('Tab');
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(button('First'));
    } finally { geometry.mockRestore(); }
  });

  it('allows only one popup and dismisses it when the user clicks outside', async () => {
    await renderScene();
    await act(async () => button('First').click());
    await act(async () => button('Second').click());
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Second menu');
    expect(document.activeElement?.textContent).toBe('New item');
    await act(async () => button('Outside').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('preserves the native editing menu for text fields', () => {
    const field = document.createElement('input');
    const editor = document.createElement('div'); editor.setAttribute('contenteditable', 'true');
    const text = document.createElement('span'); editor.append(text);
    expect(isSidebarTextInput(field)).toBe(true);
    expect(isSidebarTextInput(text)).toBe(true);
    expect(isSidebarTextInput(document.createElement('button'))).toBe(false);
  });
});
