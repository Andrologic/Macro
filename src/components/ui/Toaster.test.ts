import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { User } from '../../types';

interface LocalStorageMock {
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
  readonly length: number;
}

const createLocalStorageMock = (): LocalStorageMock => {
  const store = new Map<string, string>();

  return {
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    get length() {
      return store.size;
    },
  };
};

const localStorageMock = createLocalStorageMock();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
  writable: true,
});

const sonnerToastMock = Object.assign(
  mock((_message?: unknown, _data?: unknown) => 'default-id'),
  {
    success: mock((_message?: unknown, _data?: unknown) => 'success-id'),
    info: mock((_message?: unknown, _data?: unknown) => 'info-id'),
    warning: mock((_message?: unknown, _data?: unknown) => 'warning-id'),
    error: mock((_message?: unknown, _data?: unknown) => 'error-id'),
    message: mock((_message?: unknown, _data?: unknown) => 'message-id'),
    loading: mock((_message?: unknown, _data?: unknown) => 'loading-id'),
    custom: mock((_jsx?: unknown, _data?: unknown) => 'custom-id'),
    promise: mock((promiseInput: Promise<unknown> | (() => Promise<unknown>)) => {
      const promise = typeof promiseInput === 'function' ? promiseInput() : promiseInput;
      return {
        unwrap: () => promise,
      };
    }),
    dismiss: mock((_id?: unknown) => 'dismissed-id'),
    getHistory: mock(() => []),
    getToasts: mock(() => []),
  }
);

mock.module('sonner', () => ({
  toast: sonnerToastMock,
  Toaster: () => null,
}));

const maybeSendDesktopNotificationMock = mock(async (_input?: unknown) => true);

mock.module('../../services/desktopNotifications', () => ({
  maybeSendDesktopNotification: maybeSendDesktopNotificationMock,
}));

const { toast, __testables } = await import('./Toaster');
const { useAuthStore } = await import('../../stores/useAuthStore');
const { useNotificationCenterStore } = await import('../../stores/useNotificationCenterStore');

const buildUser = (notifications: boolean): User => ({
  id: 'user-1',
  email: 'user@example.com',
  name: 'Demo User',
  preferences: {
    theme: 'dark',
    language: 'en',
    notifications,
    emailUpdates: false,
  },
  created_at: '2026-03-20T12:00:00.000Z',
  updated_at: '2026-03-20T12:00:00.000Z',
});

const renderLastActionableToast = (): string => {
  const renderActionableToast =
    sonnerToastMock.custom.mock.calls.at(-1)?.[0] as ((id: string | number) => unknown) | undefined;

  if (!renderActionableToast) {
    throw new Error('Expected a custom toast render function.');
  }

  return renderToStaticMarkup(renderActionableToast('actionable-toast') as never);
};

describe('toast wrapper', () => {
  beforeEach(() => {
    localStorageMock.clear();
    useNotificationCenterStore.setState({
      items: [],
      isCenterOpen: false,
    });
    useAuthStore.setState({
      authStatus: 'authenticated',
      user: buildUser(true),
      session: null,
      isLoading: false,
      lastError: null,
    });

    sonnerToastMock.mockReset();
    sonnerToastMock.mockImplementation((_message?: unknown, _data?: unknown) => 'default-id');
    sonnerToastMock.success.mockReset();
    sonnerToastMock.success.mockImplementation((_message?: unknown, _data?: unknown) => 'success-id');
    sonnerToastMock.info.mockReset();
    sonnerToastMock.info.mockImplementation((_message?: unknown, _data?: unknown) => 'info-id');
    sonnerToastMock.warning.mockReset();
    sonnerToastMock.warning.mockImplementation((_message?: unknown, _data?: unknown) => 'warning-id');
    sonnerToastMock.error.mockReset();
    sonnerToastMock.error.mockImplementation((_message?: unknown, _data?: unknown) => 'error-id');
    sonnerToastMock.message.mockReset();
    sonnerToastMock.message.mockImplementation((_message?: unknown, _data?: unknown) => 'message-id');
    sonnerToastMock.loading.mockReset();
    sonnerToastMock.loading.mockImplementation((_message?: unknown, _data?: unknown) => 'loading-id');
    sonnerToastMock.custom.mockReset();
    sonnerToastMock.custom.mockImplementation((_jsx?: unknown, _data?: unknown) => 'custom-id');
    sonnerToastMock.promise.mockReset();
    sonnerToastMock.promise.mockImplementation((promiseInput: Promise<unknown> | (() => Promise<unknown>)) => {
      const promise = typeof promiseInput === 'function' ? promiseInput() : promiseInput;
      return {
        unwrap: () => promise,
      };
    });
    sonnerToastMock.dismiss.mockReset();
    sonnerToastMock.dismiss.mockImplementation((_id?: unknown) => 'dismissed-id');
    maybeSendDesktopNotificationMock.mockReset();
    maybeSendDesktopNotificationMock.mockImplementation(async (_input?: unknown) => true);
  });

  it('stores tracked info, warning, and error toasts in the notification center', () => {
    toast.info('Info title', { description: 'More details' });
    toast.warning('Warning title');
    toast.error('Error title', { description: 'Needs attention' });

    const items = useNotificationCenterStore.getState().items;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ level: 'error', title: 'Error title' });
    expect(items[1]).toMatchObject({ level: 'warning', title: 'Warning title' });
    expect(items[2]).toMatchObject({ level: 'info', title: 'Info title', description: 'More details' });
    expect(sonnerToastMock.info).toHaveBeenCalledTimes(1);
    expect(sonnerToastMock.warning).toHaveBeenCalledTimes(1);
    expect(sonnerToastMock.error).toHaveBeenCalledTimes(1);
    expect(sonnerToastMock.custom).not.toHaveBeenCalled();
  });

  it('renders actionable notifications through the shared custom toast path', () => {
    toast.warning('Base branch missing', {
      description: 'Choose what to do next.',
      actions: [
        {
          label: 'Create',
          onClick: () => undefined,
        },
        {
          label: 'Settings',
          variant: 'secondary',
          onClick: () => undefined,
        },
      ],
    });

    expect(sonnerToastMock.warning).not.toHaveBeenCalled();
    expect(sonnerToastMock.custom).toHaveBeenCalledTimes(1);

    const markup = renderLastActionableToast();
    expect(markup).toContain('Base branch missing');
    expect(markup).toContain('Choose what to do next.');
    expect(markup).toContain('Create');
    expect(markup).toContain('Settings');

    expect(useNotificationCenterStore.getState().items).toHaveLength(1);
    expect(useNotificationCenterStore.getState().items[0]).toMatchObject({
      level: 'warning',
      title: 'Base branch missing',
      description: 'Choose what to do next.',
    });
  });

  it('clamps actionable notifications to at most two buttons', () => {
    toast.info('Too many actions', {
      actions: [
        { label: 'First', onClick: () => undefined },
        { label: 'Second', onClick: () => undefined },
        { label: 'Third', onClick: () => undefined },
      ],
    });

    const markup = renderLastActionableToast();
    expect(markup).toContain('First');
    expect(markup).toContain('Second');
    expect(markup).not.toContain('Third');
  });

  it('upserts tracked notifications when the same notificationKey is reused', () => {
    toast.info('First title', {
      description: 'Initial description',
      notificationKey: 'task:missing-branch',
    });
    toast.info('Updated title', {
      description: 'Updated description',
      notificationKey: 'task:missing-branch',
    });

    expect(useNotificationCenterStore.getState().items).toEqual([
      expect.objectContaining({
        id: 'task:missing-branch',
        level: 'info',
        title: 'Updated title',
        description: 'Updated description',
      }),
    ]);
    expect(sonnerToastMock.info).toHaveBeenNthCalledWith(
      1,
      'First title',
      expect.objectContaining({ id: 'task:missing-branch' })
    );
    expect(sonnerToastMock.info).toHaveBeenNthCalledWith(
      2,
      'Updated title',
      expect.objectContaining({ id: 'task:missing-branch' })
    );
  });

  it('does not store success toasts in the notification center', () => {
    toast.success('Success title');

    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(sonnerToastMock.success).toHaveBeenCalledTimes(1);
  });

  it('routes warning and error toasts to desktop notifications by default', () => {
    toast.warning('Background warning', {
      description: 'Warning details',
      notificationKey: 'warning-key',
    });
    toast.error('Background error', {
      description: 'Error details',
    });

    expect(maybeSendDesktopNotificationMock).toHaveBeenCalledTimes(2);
    expect(maybeSendDesktopNotificationMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: 'Background warning',
        body: 'Warning details',
        notificationKey: 'warning-key',
      })
    );
    expect(maybeSendDesktopNotificationMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: 'Background error',
        body: 'Error details',
        notificationKey: expect.any(String),
      })
    );
  });

  it('limits desktop notifications to explicitly important info and success toasts', () => {
    toast.info('Informational update');
    toast.success('Routine success');
    toast.info('Important info', {
      desktopEligible: true,
      description: 'Needs desktop delivery',
    });
    toast.success('Important success', {
      desktopEligible: true,
      description: 'Background-safe confirmation',
    });

    expect(maybeSendDesktopNotificationMock).toHaveBeenCalledTimes(2);
    expect(maybeSendDesktopNotificationMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: 'Important info',
        body: 'Needs desktop delivery',
      })
    );
    expect(maybeSendDesktopNotificationMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: 'Important success',
        body: 'Background-safe confirmation',
      })
    );
  });

  it('blocks visible toasts and history when in-app notifications are disabled', () => {
    useAuthStore.setState({
      user: buildUser(false),
    });

    expect(toast.info('Muted info')).toBe('notifications-disabled');
    expect(toast.success('Muted success')).toBe('notifications-disabled');
    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(sonnerToastMock.info).not.toHaveBeenCalled();
    expect(sonnerToastMock.success).not.toHaveBeenCalled();
    expect(maybeSendDesktopNotificationMock).not.toHaveBeenCalled();
  });

  it('still attempts desktop delivery for eligible alerts when in-app notifications are disabled', () => {
    useAuthStore.setState({
      user: buildUser(false),
    });

    expect(
      toast.error('Muted but important', {
        description: 'Desktop should still decide whether to deliver this.',
      })
    ).toBe('notifications-disabled');

    expect(sonnerToastMock.error).not.toHaveBeenCalled();
    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(maybeSendDesktopNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Muted but important',
        body: 'Desktop should still decide whether to deliver this.',
      })
    );
  });

  it('keeps tracked non-text payloads visible without persisting them', () => {
    toast.error({ type: 'jsx-like' } as never, {
      description: { type: 'jsx-like' } as never,
    });

    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(sonnerToastMock.error).toHaveBeenCalledTimes(1);
    expect(maybeSendDesktopNotificationMock).not.toHaveBeenCalled();
  });

  it('keeps helper extraction strict to string-only payloads', () => {
    expect(__testables.toTrackableToastContent('Track me', { description: 'Plain text' })).toEqual({
      title: 'Track me',
      description: 'Plain text',
    });
    expect(__testables.toTrackableToastContent({ type: 'node' } as never)).toBeNull();
    expect(__testables.toTrackableToastContent('Track me', { description: { type: 'node' } as never })).toBeNull();
  });

  it('dismisses an actionable toast after a successful action by default', async () => {
    const onClick = mock(async () => undefined);
    const [action] = __testables.normalizeNotificationActions([
      {
        label: 'Create',
        onClick,
      },
    ]);

    await expect(__testables.executeNotificationAction(action, 'toast-1')).resolves.toBe(true);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(sonnerToastMock.dismiss).toHaveBeenCalledWith('toast-1');
  });

  it('keeps the toast open when dismissOnSuccess is false', async () => {
    const [action] = __testables.normalizeNotificationActions([
      {
        label: 'Keep open',
        dismissOnSuccess: false,
        onClick: async () => undefined,
      },
    ]);

    await expect(__testables.executeNotificationAction(action, 'toast-1')).resolves.toBe(true);

    expect(sonnerToastMock.dismiss).not.toHaveBeenCalled();
  });

  it('shows a standard error toast when an actionable callback fails', async () => {
    const [action] = __testables.normalizeNotificationActions([
      {
        label: 'Fail',
        onClick: async () => {
          throw new Error('Action failed');
        },
      },
    ]);

    await expect(__testables.executeNotificationAction(action, 'toast-1')).resolves.toBe(false);

    expect(sonnerToastMock.error).toHaveBeenCalledWith(
      'Action failed',
      expect.objectContaining({ id: expect.any(String) })
    );
    expect(useNotificationCenterStore.getState().items[0]).toMatchObject({
      level: 'error',
      title: 'Action failed',
    });
  });

  it('renders actionable buttons as disabled while an action is pending', () => {
    const actions = __testables.normalizeNotificationActions([
      {
        label: 'Create',
        onClick: () => undefined,
      },
      {
        label: 'Settings',
        variant: 'secondary',
        onClick: () => undefined,
      },
    ]);

    const markup = renderToStaticMarkup(
      __testables.ActionableNotificationToastBody({
        level: 'warning',
        title: 'Base branch missing',
        description: 'Choose what to do next.',
        actions,
        pendingActionIndex: 0,
        onActionClick: () => undefined,
      }) as never
    );

    expect(markup.match(/disabled=""/g)?.length).toBe(2);
    expect(markup).toContain('animate-spin');
  });
});
