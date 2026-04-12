import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNotificationCenterStore } from '../../stores/useNotificationCenterStore';

let importCounter = 0;

const loadNotificationCenterPopover = async () => {
  mock.restore();
  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
    }),
  }));

  importCounter += 1;
  return import(`./NotificationCenterPopover.tsx?test=${importCounter}`);
};

describe('NotificationCenterPopover', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let anchor: HTMLButtonElement | null = null;

  beforeEach(() => {
    useNotificationCenterStore.setState({
      items: [
        {
          id: 'info-item',
          level: 'info',
          variant: 'informational',
          title: 'Background indexing finished',
          description: 'Everything is up to date.',
          createdAt: '2026-04-12T09:00:00.000Z',
          readAt: null,
        },
        {
          id: 'action-item',
          level: 'warning',
          variant: 'actionable',
          category: 'task_attention_required',
          title: 'Base branch missing',
          description: 'Choose what to do next.',
          createdAt: '2026-04-12T10:00:00.000Z',
          readAt: null,
        },
      ],
      isCenterOpen: false,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    anchor = document.createElement('button');
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => ({
        top: 720,
        right: 380,
      }),
      configurable: true,
    });
    document.body.appendChild(anchor);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });

    anchor?.remove();
    container?.remove();
    anchor = null;
    container = null;
    root = null;
    mock.restore();
  });

  it('renders shared templates and snapshots actionable items without live actions', async () => {
    const { NotificationCenterPopover } = await loadNotificationCenterPopover();

    await act(async () => {
      root?.render(
        <NotificationCenterPopover
          isOpen
          anchorRef={{ current: anchor }}
          onClose={() => undefined}
        />
      );
      await Promise.resolve();
    });

    const surfaces = document.body.querySelectorAll('[data-notification-surface="true"]');
    expect(surfaces).toHaveLength(2);
    expect(document.body.textContent).toContain('Background indexing finished');
    expect(document.body.textContent).toContain('Base branch missing');
    expect(document.body.textContent).toContain('Action required');
  });
});
