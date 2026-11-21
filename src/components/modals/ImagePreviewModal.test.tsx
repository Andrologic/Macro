import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImagePreviewModal } from './ImagePreviewModal';
import { Dialog } from '../ui/Dialog';

const image = { id: 'fixture', createdAt: '2026-01-01T00:00:00Z', dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', width: 640, height: 480 };
let root: Root | null = null;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  document.body.innerHTML = '';
});

describe('ImagePreviewModal', () => {
  it.each(['keyboard', 'pointer'])('contains focus, protects the draft and restores prior focus after %s opening', async (opening) => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const Fixture = () => {
      const [open, setOpen] = useState(false);
      return <><textarea defaultValue="Draft unchanged" onKeyDown={(event) => {
        if (event.key === 'Tab') event.currentTarget.value += '\t';
      }} /><button onClick={() => setOpen(true)}>Open image</button>
        <ImagePreviewModal isOpen={open} image={image} onClose={() => setOpen(false)} /></>;
    };
    await act(async () => { root!.render(<Fixture />); });
    const trigger = container.querySelector('button')!;
    const returnFocus = opening === 'keyboard' ? trigger : container.querySelector('textarea')!;
    returnFocus.focus();
    await act(async () => { trigger.click(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBeTruthy();
    const close = dialog.querySelector('button')!;
    expect(document.activeElement).toBe(close);
    expect(close.getAttribute('aria-label')).toBeTruthy();
    expect(container.hasAttribute('inert')).toBe(true);
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(image.dataUrl);
    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(close);
    }
    expect(container.querySelector('textarea')!.value).toBe('Draft unchanged');
    await act(async () => { close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(returnFocus);
    expect(container.hasAttribute('inert')).toBe(false);
  });

  it('preserves the opening click guard and closes only on the backdrop after it expires', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const close = mock(() => undefined);
    await act(async () => { root!.render(<ImagePreviewModal isOpen image={image} onClose={close} />); });
    const backdrop = document.querySelector<HTMLElement>('[data-macro-dialog-root]')!;
    await act(async () => { backdrop.click(); });
    expect(close).not.toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    await act(async () => { document.querySelector('img')!.click(); });
    expect(close).not.toHaveBeenCalled();
    await act(async () => { backdrop.click(); });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes a nested preview before its parent dialog', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const Fixture = () => {
      const [open, setOpen] = useState(false);
      return <Dialog title="Parent" onClose={() => { throw new Error('Parent closed'); }}>
        <button onClick={() => setOpen(true)}>Open image</button>
        <ImagePreviewModal isOpen={open} image={image} onClose={() => setOpen(false)} />
      </Dialog>;
    };
    await act(async () => { root!.render(<Fixture />); });
    const trigger = document.querySelector('button')!;
    await act(async () => { trigger.click(); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(trigger);
  });
});
