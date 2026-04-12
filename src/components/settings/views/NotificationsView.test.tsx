import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNotificationCenterStore } from '../../../stores/useNotificationCenterStore';

const createStoreHook = <T,>(getSnapshot: () => T) => {
  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = getSnapshot();
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & { getState: () => T };

  hook.getState = getSnapshot;
  return hook;
};

const defaultNotificationChannelModes = {
  task_attention_required: 'both',
  task_run_completed: 'desktop',
  task_completed: 'both',
  git_sync_completed: 'desktop',
  git_sync_attention_required: 'both',
} as const;

const updatePreferencesMock = mock(async (_preferences: unknown) => undefined);
const setNotificationChannelModeMock = mock(
  (_category: unknown, _mode: unknown) => undefined
);
const emitDebugNotificationPreviewMock = mock(async (_preview: unknown, _channel: unknown) => ({
  inAppSent: true,
  desktopSent: true,
}));
const emitAllDebugNotificationPreviewsMock = mock(async (_channel: unknown) => ({
  total: 1,
  inAppSent: 1,
  desktopSent: 1,
}));
const initializeDesktopNotificationsMock = mock(async () => undefined);

let importCounter = 0;
let authState = {
  user: {
    preferences: {
      notifications: true,
    },
  },
  updatePreferences: updatePreferencesMock,
};
let appState = {
  notificationChannelModes: {
    ...defaultNotificationChannelModes,
  },
  setNotificationChannelMode: setNotificationChannelModeMock,
};

const useAuthStore = createStoreHook(() => authState);
const useAppStore = createStoreHook(() => appState);
const desktopNotificationsMock = {
  getDesktopNotificationStatus: () => 'granted' as const,
  initializeDesktopNotifications: () => initializeDesktopNotificationsMock(),
  subscribeDesktopNotificationStatus: () => () => undefined,
  sendDesktopNotificationPreview: mock(async () => true),
};

const loadNotificationsView = async (devMode: boolean) => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
    }),
  }));

  mock.module('../../../stores/useAuthStore', () => ({
    useAuthStore,
  }));

  mock.module('../../../stores/useAppStore', () => ({
    useAppStore,
  }));

  mock.module('../../../services/desktopNotifications', () => desktopNotificationsMock);
  mock.module('../../../services/desktopNotifications.ts', () => desktopNotificationsMock);

  mock.module('../../../utils/devLogger', () => ({
    isDevelopmentBuild: devMode,
  }));

  mock.module('../../ui/toastService', () => ({
    toast: {
      error: mock(() => undefined),
    },
  }));

  mock.module('../../ui/Select', () => ({
    Select: ({
      children,
      value,
      onChange,
      className,
    }: {
      children: React.ReactNode;
      value: string;
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
      className?: string;
    }) => (
      <select value={value} onChange={onChange} className={className}>
        {children}
      </select>
    ),
  }));

  mock.module('../../ui/Switch', () => ({
    Switch: ({
      checked,
      onCheckedChange,
      disabled,
    }: {
      checked: boolean;
      onCheckedChange: (value: boolean) => void;
      disabled?: boolean;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  }));

  mock.module('../../ui/Button', () => ({
    Button: ({
      children,
      isLoading,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => (
      <button {...props}>{isLoading ? 'Loading' : children}</button>
    ),
  }));

  mock.module('./notificationDebugCatalog', () => ({
    DEBUG_NOTIFICATION_PREVIEWS: [
      {
        id: 'preview-1',
        label: 'Preview 1',
        description: 'Preview description',
        level: 'info',
        message: 'Preview message',
        toastOptions: {},
        supportsDesktop: true,
        variant: 'standard',
      },
    ],
    emitDebugNotificationPreview: (...args: [unknown, unknown]) =>
      emitDebugNotificationPreviewMock(...args),
    emitAllDebugNotificationPreviews: (...args: [unknown]) =>
      emitAllDebugNotificationPreviewsMock(...args),
  }));

  importCounter += 1;
  return import(`./NotificationsView.tsx?test=${importCounter}`);
};

describe('NotificationsView', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    authState = {
      user: {
        preferences: {
          notifications: true,
        },
      },
      updatePreferences: updatePreferencesMock,
    };
    appState = {
      notificationChannelModes: {
        ...defaultNotificationChannelModes,
      },
      setNotificationChannelMode: setNotificationChannelModeMock,
    };

    updatePreferencesMock.mockClear();
    setNotificationChannelModeMock.mockClear();
    emitDebugNotificationPreviewMock.mockClear();
    emitAllDebugNotificationPreviewsMock.mockClear();
    initializeDesktopNotificationsMock.mockClear();
    useNotificationCenterStore.setState({
      items: [],
      isCenterOpen: false,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    container = null;
    root = null;
    mock.restore();
  });

  it('shows the debug section only in development builds', async () => {
    const prodModule = await loadNotificationsView(false);

    await act(async () => {
      root?.render(<prodModule.NotificationsView />);
      await Promise.resolve();
    });

    expect(
      container?.querySelector('[data-testid="notifications-debug-section"]')
    ).toBeNull();

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });

    root = createRoot(container!);
    const devModule = await loadNotificationsView(true);

    await act(async () => {
      root?.render(<devModule.NotificationsView />);
      await Promise.resolve();
    });

    expect(
      container?.querySelector('[data-testid="notifications-debug-section"]')
    ).not.toBeNull();
  });

  it('clears the notification center from the debug section', async () => {
    const { NotificationsView } = await loadNotificationsView(true);

    useNotificationCenterStore.setState({
      items: [
        {
          id: 'debug-item',
          level: 'info',
          title: 'Tracked preview',
          createdAt: '2026-04-12T09:00:00.000Z',
          readAt: null,
        },
      ],
      isCenterOpen: false,
    });

    await act(async () => {
      root?.render(<NotificationsView />);
      await Promise.resolve();
    });

    const clearButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.includes('Clear center (1)')
    );

    expect(clearButton).toBeDefined();

    await act(async () => {
      clearButton?.click();
      await Promise.resolve();
    });

    expect(useNotificationCenterStore.getState().items).toEqual([]);
    expect(container?.textContent).toContain('Clear center (0)');
  });
});
