import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNotificationCenterStore } from '../../stores/useNotificationCenterStore';

let importCounter = 0;
const executeRegisteredNotificationActionMock = mock(
  async (_notificationId: string, _actionIndex: number) => true
);

const loadNotificationCenterPopover = async () => {
  mock.restore();
  importCounter += 1;
  const toastServiceModule = await import(
    `../ui/toastService.tsx?notification-center-popover-toast-service-test=${importCounter}`
  );

  mock.module('react-i18next', () => ({
    initReactI18next: {
      type: '3rdParty',
      init: () => undefined,
    },
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
      i18n: {
        language: 'en-US',
        changeLanguage: mock(async () => undefined),
      },
    }),
  }));
  mock.module('../ui/toastService', () => ({
    ...toastServiceModule,
    executeRegisteredNotificationAction: (
      notificationId: string,
      actionIndex: number
    ) => executeRegisteredNotificationActionMock(notificationId, actionIndex),
  }));

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
          title: 'Background work finished',
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
          sessionActions: [
            {
              label: 'Create',
              variant: 'primary',
              dismissOnSuccess: true,
              onClick: async () => undefined,
            },
            {
              label: 'Open settings',
              variant: 'secondary',
              dismissOnSuccess: false,
              onClick: async () => undefined,
            },
          ],
        },
      ],
      isCenterOpen: false,
    });
    executeRegisteredNotificationActionMock.mockReset();
    executeRegisteredNotificationActionMock.mockImplementation(
      async (_notificationId: string, _actionIndex: number) => true
    );

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    anchor = document.createElement('button');
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => ({
        top: 720,
        bottom: 752,
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

  it('renders shared templates and interactive actionable items when session actions are available', async () => {
    const { NotificationCenterPopover } = await loadNotificationCenterPopover();
    const originalDateNow = Date.now;
    Date.now = () => new Date('2026-04-13T12:30:00.000Z').getTime();

    try {
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
    } finally {
      Date.now = originalDateNow;
    }

    const surfaces = document.body.querySelectorAll('[data-notification-surface="true"]');
    expect(surfaces).toHaveLength(2);
    expect(document.body.textContent).toContain('Background work finished');
    expect(document.body.textContent).toContain('Base branch missing');
    expect(document.body.textContent).toContain('Create');
    expect(document.body.textContent).toContain('Open settings');
    expect(document.body.textContent).toContain('Yesterday');

    const createButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Create'
    );
    expect(createButton).toBeDefined();

    await act(async () => {
      createButton?.click();
      await Promise.resolve();
    });

    expect(executeRegisteredNotificationActionMock).toHaveBeenCalledWith(
      'action-item',
      0
    );
  });

  it('renders an Open button for a restored workflow descriptor without session closures', async () => {
    const { NotificationCenterPopover } = await loadNotificationCenterPopover();
    useNotificationCenterStore.setState({ items: [{
      id: 'restored-workflow', level: 'info', variant: 'actionable',
      category: 'task_attention_required', title: 'Question waiting',
      createdAt: '2026-04-12T10:00:00.000Z', readAt: null,
      workflowNavigation: { kind: 'conversation', requestKind: 'questionnaire', conversationId: 'conversation-1' },
    }] });
    await act(async () => {
      root?.render(<NotificationCenterPopover isOpen anchorRef={{ current: anchor }} onClose={() => undefined} />);
    });
    const button = Array.from(document.body.querySelectorAll('button')).find((candidate) => candidate.textContent === 'Open');
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    await act(async () => { button?.click(); });
    expect(executeRegisteredNotificationActionMock).toHaveBeenCalledWith('restored-workflow', 0);
  });

  it('falls back to a snapshot label when an actionable item was restored without session actions', async () => {
    const { NotificationCenterPopover } = await loadNotificationCenterPopover();

    useNotificationCenterStore.setState({
      items: [
        {
          id: 'action-item',
          level: 'warning',
          variant: 'actionable',
          title: 'Restored actionable',
          description: 'This item came from storage.',
          createdAt: '2026-04-12T10:00:00.000Z',
          readAt: null,
        },
      ],
      isCenterOpen: false,
    });

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

    expect(document.body.textContent).toContain('Action required');
    expect(document.body.textContent).not.toContain('Create');
  });

  it('renders a single linear time scale without per-item timestamps', async () => {
    const { NotificationCenterPopover } = await loadNotificationCenterPopover();

    useNotificationCenterStore.setState({
      items: [
        {
          id: 'just-now',
          level: 'info',
          variant: 'informational',
          title: 'Just now',
          createdAt: '2026-04-13T12:29:45.000Z',
          readAt: null,
        },
        {
          id: 'this-hour',
          level: 'info',
          variant: 'informational',
          title: 'Recent item',
          createdAt: '2026-04-13T12:05:00.000Z',
          readAt: null,
        },
        {
          id: 'today',
          level: 'info',
          variant: 'informational',
          title: 'Earlier today',
          createdAt: '2026-04-13T09:00:00.000Z',
          readAt: null,
        },
        {
          id: 'yesterday',
          level: 'warning',
          variant: 'informational',
          title: 'Yesterday item',
          createdAt: '2026-04-12T10:00:00.000Z',
          readAt: null,
        },
        {
          id: 'older',
          level: 'error',
          variant: 'informational',
          title: 'Older item',
          createdAt: '2026-04-10T10:00:00.000Z',
          readAt: null,
        },
      ],
      isCenterOpen: false,
    });

    const originalDateNow = Date.now;
    Date.now = () => new Date('2026-04-13T12:30:00.000Z').getTime();

    try {
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
    } finally {
      Date.now = originalDateNow;
    }

    expect(document.body.textContent).toContain('Less than a minute ago');
    expect(document.body.textContent).toContain('25 min. ago');
    expect(document.body.textContent).toContain('3 hr. ago');
    expect(document.body.textContent).not.toContain('Today');
    expect(document.body.textContent).toContain('Yesterday');
    expect(document.body.textContent).toContain('April 10');
    expect(document.body.textContent).not.toContain('1d');
  });

  it('closes on Escape and outside pointer down without closing from inside the panel', async () => {
    const { NotificationCenterPopover } = await loadNotificationCenterPopover();
    const onClose = mock(() => undefined);

    await act(async () => {
      root?.render(
        <NotificationCenterPopover
          isOpen
          anchorRef={{ current: anchor }}
          onClose={onClose}
        />
      );
      await Promise.resolve();
    });

    const panel = document.body.querySelector('[role="dialog"]');
    expect(panel).toBeDefined();

    await act(async () => {
      panel?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('removes single items and clears all notifications', async () => {
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

    const dismissButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss notification"]'
    );
    expect(dismissButton).toBeDefined();

    await act(async () => {
      dismissButton?.click();
      await Promise.resolve();
    });

    expect(useNotificationCenterStore.getState().items).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Background work finished');

    const clearAllButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Clear all'
    );
    expect(clearAllButton).toBeDefined();

    await act(async () => {
      clearAllButton?.click();
      await Promise.resolve();
    });

    expect(useNotificationCenterStore.getState().items).toHaveLength(0);
    expect(document.body.textContent).toContain('No notifications');
  });

  it('uses below placement when the anchor is near the top of the viewport', async () => {
    const { NotificationCenterPopover } = await loadNotificationCenterPopover();
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => ({
        top: 36,
        bottom: 68,
        right: 120,
      }),
      configurable: true,
    });

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

    const panel = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.style.top).toBe('78px');
    expect(panel?.style.transform).toBe('');
  });
});
