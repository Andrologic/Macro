import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNotificationCenterStore } from '../../stores/useNotificationCenterStore';
import { installReactI18nextMock } from '../../test-utils/reactI18nextMock';

describe('Footer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installReactI18nextMock();
    mock.module('../updates/UpdateStatusButton', () => ({
      UpdateStatusButton: () => <button type="button">Update available</button>,
    }));

    useNotificationCenterStore.setState({ items: [], isCenterOpen: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useNotificationCenterStore.setState({ items: [], isCenterOpen: false });
    mock.restore();
  });

  it('keeps updates and notifications as the only footer controls', async () => {
    const { Footer } = await import('./Footer');
    await act(async () => root.render(<Footer />));

    const footer = container.querySelector('footer[data-tour-id="footer-status-bar"]');
    expect(footer).not.toBeNull();
    const controls = footer!.querySelectorAll('button, select, a, input');
    expect(Array.from(controls, (control) => control.getAttribute('aria-label') ?? control.textContent))
      .toEqual(['Update available', 'Notifications']);
    expect(footer!.textContent).toBe('Update available');
  });

  it('opens the notification dialog from its accessible control and marks items read', async () => {
    useNotificationCenterStore.setState({
      items: [{
        id: 'notice',
        level: 'info',
        variant: 'informational',
        title: 'Background work finished',
        createdAt: new Date().toISOString(),
        readAt: null,
      }],
    });
    const { Footer } = await import('./Footer');
    await act(async () => root.render(<Footer />));

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Notifications"]')!;
    expect(button.title).toBe('Notifications');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.querySelector('.bg-primary')).not.toBeNull();

    await act(async () => button.click());

    const dialog = document.getElementById(button.getAttribute('aria-controls')!);
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.textContent).toContain('Background work finished');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(useNotificationCenterStore.getState().items[0]?.readAt).not.toBeNull();
    expect(button.querySelector('.bg-primary')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(dialog!.id)).toBeNull();
  });
});
