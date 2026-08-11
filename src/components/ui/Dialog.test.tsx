import { afterEach, describe, expect, it } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Dialog } from './Dialog';

describe('Dialog', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    root = null;
    container = null;
    document.body.innerHTML = '';
  });

  it('portals past a transformed ancestor, supports a dialog stack, traps focus, and restores focus', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const transformedAncestor = document.createElement('div');
    transformedAncestor.style.transform = 'translateZ(0)';
    container = document.createElement('div');
    transformedAncestor.appendChild(container);
    document.body.appendChild(transformedAncestor);
    root = createRoot(container);
    const DialogStack = () => {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <>
          {outerOpen && (
            <Dialog title="Outer dialog" onClose={() => setOuterOpen(false)}>
              <div>
                <button type="button" onClick={() => setInnerOpen(true)}>Open inner</button>
                <button type="button">Outer last</button>
              </div>
            </Dialog>
          )}
          {innerOpen && (
            <Dialog title="Inner dialog" onClose={() => setInnerOpen(false)}>
              <div><button type="button">Inner first</button><button type="button">Inner last</button></div>
            </Dialog>
          )}
        </>
      );
    };

    await act(async () => {
      root?.render(<DialogStack />);
      await Promise.resolve();
    });

    const outerDialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const outerButtons = outerDialog?.querySelectorAll<HTMLButtonElement>('button');
    expect(document.activeElement).toBe(outerButtons?.[0] ?? null);

    await act(async () => {
      outerButtons?.[0].focus();
      outerButtons?.[0].click();
      await Promise.resolve();
    });

    const dialogs = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
    const innerButtons = dialogs[1]?.querySelectorAll<HTMLButtonElement>('button');
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1]?.getAttribute('aria-modal')).toBe('true');
    expect(dialogs[1]?.className).toContain('w-full');
    expect(dialogs[1]?.parentElement?.parentElement).toBe(document.body);
    expect(transformedAncestor.contains(dialogs[1]!)).toBe(false);
    expect(document.body.querySelector('[inert]')).not.toBeNull();
    expect(dialogs[0]?.parentElement?.hasAttribute('inert')).toBe(true);
    expect(dialogs[0]?.parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(dialogs[1]?.parentElement?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(innerButtons?.[0]);

    innerButtons?.[1].focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(innerButtons?.[0]);

    innerButtons?.[0].focus();
    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(innerButtons?.[1]);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      document.dispatchEvent(escape);
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(outerButtons?.[0] ?? null);
    expect(document.body.querySelector('[data-macro-dialog-root]')?.hasAttribute('inert')).toBe(false);
    expect(document.body.querySelector('[inert]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector('[inert]')).toBeNull();
  });
});
