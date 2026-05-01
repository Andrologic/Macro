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
    expect(document.body.textContent).toContain('Background indexing finished');
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

  it('renders separate date groups for recent, today, yesterday, and older notifications', async () => {
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
          title: 'This hour',
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
    expect(document.body.textContent).toContain('This hour');
    expect(document.body.textContent).toContain('Today');
    expect(document.body.textContent).toContain('Yesterday');
    expect(document.body.textContent).toContain('April 10');
  });
});
