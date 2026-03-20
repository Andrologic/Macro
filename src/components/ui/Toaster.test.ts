import { beforeEach, describe, expect, it, mock } from 'bun:test';
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
  });

  it('does not store success toasts in the notification center', () => {
    toast.success('Success title');

    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(sonnerToastMock.success).toHaveBeenCalledTimes(1);
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
  });

  it('keeps tracked non-text payloads visible without persisting them', () => {
    toast.error({ type: 'jsx-like' } as never, {
      description: { type: 'jsx-like' } as never,
    });

    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(sonnerToastMock.error).toHaveBeenCalledTimes(1);
  });

  it('keeps helper extraction strict to string-only payloads', () => {
    expect(__testables.toTrackableToastContent('Track me', { description: 'Plain text' })).toEqual({
      title: 'Track me',
      description: 'Plain text',
    });
    expect(__testables.toTrackableToastContent({ type: 'node' } as never)).toBeNull();
    expect(__testables.toTrackableToastContent('Track me', { description: { type: 'node' } as never })).toBeNull();
  });
});
