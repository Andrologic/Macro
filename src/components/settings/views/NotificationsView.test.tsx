import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNotificationCenterStore } from '../../../stores/useNotificationCenterStore';

const createStoreHook = <T,>(getSnapshot: () => T) => {
  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = getSnapshot();
    return selector ? selector(snapshot) : snapshot;
  }) as ((selector?: (state: T) => unknown) => unknown) & {
    getState: () => T;
    setState: (patch: Partial<T>) => void;
    subscribe: () => () => void;
  };

  hook.getState = getSnapshot;
  hook.setState = (patch) => Object.assign(getSnapshot() as object, patch);
  hook.subscribe = () => () => undefined;
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
const emitInformationalNotificationBlueprintMock = mock(async (_draft: unknown, _channel: unknown) => ({
  inAppSent: true,
  desktopSent: true,
}));
const emitActionableNotificationBlueprintMock = mock(async (_draft: unknown, _channel: unknown) => ({
  inAppSent: true,
  desktopSent: true,
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

type SelectMockProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  children: React.ReactNode;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onInput?: (event: React.FormEvent<HTMLSelectElement>) => void;
  className?: string;
  'data-testid'?: string;
};

type InputMockProps = React.InputHTMLAttributes<HTMLInputElement> & {
  'data-testid'?: string;
};

type TextareaMockProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  'data-testid'?: string;
};

const controlHandlers = new Map<
  string,
  {
    onChange?: (event: { target: { value: string } }) => void;
    onInput?: (event: { target: { value: string } }) => void;
  }
>();

const updateMockControl = async (testId: string, value: string) => {
  const handlers = controlHandlers.get(testId);
  handlers?.onInput?.({ target: { value } });
  handlers?.onChange?.({ target: { value } });
  await Promise.resolve();
};

const loadNotificationsView = async (devMode: boolean) => {
  mock.restore();

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (
        _key: string,
        fallback?: string,
        options?: Record<string, string | number>
      ) => {
        const template = fallback ?? _key;
        if (!options) {
          return template;
        }

        return Object.entries(options).reduce(
          (result, [name, value]) =>
            result.replaceAll(`{{${name}}}`, String(value)),
          template
        );
      },
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
    notify: {
      error: mock(() => undefined),
    },
  }));

  mock.module('../../ui/Select', () => ({
    Select: ({
      children,
      value,
      onChange,
      onInput,
      className,
      'data-testid': testId,
      ...props
    }: SelectMockProps) => (
      (() => {
        if (typeof testId === 'string') {
          controlHandlers.set(testId, {
            onChange: onChange as never,
            onInput: onInput as never,
          });
        }

        return (
          <select
            value={value}
            onChange={onChange}
            onInput={onInput}
            className={className}
            data-testid={testId}
            {...props}
          >
            {children}
          </select>
        );
      })()
    ),
  }));

  mock.module('../../ui/Input', () => ({
    Input: ({
      onChange,
      onInput,
      'data-testid': testId,
      ...props
    }: InputMockProps) => {
      if (typeof testId === 'string') {
        controlHandlers.set(testId, {
          onChange: onChange as never,
          onInput: onInput as never,
        });
      }

      return <input data-testid={testId} onChange={onChange} onInput={onInput} {...props} />;
    },
  }));

  mock.module('../../ui/Textarea', () => ({
    Textarea: ({
      onChange,
      onInput,
      'data-testid': testId,
      ...props
    }: TextareaMockProps) => {
      if (typeof testId === 'string') {
        controlHandlers.set(testId, {
          onChange: onChange as never,
          onInput: onInput as never,
        });
      }

      return (
        <textarea
          data-testid={testId}
          onChange={onChange}
          onInput={onInput}
          {...props}
        />
      );
    },
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
    DEFAULT_INFORMATIONAL_NOTIFICATION_BLUEPRINT_DRAFT: {
      tone: 'info',
      title: 'Background indexing finished',
      description: 'Everything is up to date.',
    },
    DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT: {
      tone: 'warning',
      title: 'Base branch missing',
      description: 'Choose what to do next to continue safely.',
      actions: [
        {
          label: 'Create',
          variant: 'primary',
          dismissOnSuccess: true,
        },
        {
          label: 'Open settings',
          variant: 'secondary',
          dismissOnSuccess: true,
        },
      ],
    },
    emitInformationalNotificationBlueprint: (...args: [unknown, unknown]) =>
      emitInformationalNotificationBlueprintMock(...args),
    emitActionableNotificationBlueprint: (...args: [unknown, unknown]) =>
      emitActionableNotificationBlueprintMock(...args),
    getActionableNotificationBlueprintPreviewActions: (draft: {
      actions: Array<{
        label: string;
        variant: 'primary' | 'secondary';
      }>;
    }) => [
      ...draft.actions.map((action) => ({
        label: action.label || 'Action',
        variant: action.variant,
      })),
    ],
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
    emitInformationalNotificationBlueprintMock.mockClear();
    emitActionableNotificationBlueprintMock.mockClear();
    initializeDesktopNotificationsMock.mockClear();
    controlHandlers.clear();
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

  it('renders only the two blueprint panels with matching preview frame shells', async () => {
    const { NotificationsView } = await loadNotificationsView(true);

    await act(async () => {
      root?.render(<NotificationsView />);
      await Promise.resolve();
    });

    expect(
      container?.querySelector('[data-testid="notification-blueprint-panel-informational"]')
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="notification-blueprint-panel-actionable"]')
    ).not.toBeNull();

    const frames = Array.from(
      container?.querySelectorAll('[data-testid="notification-blueprint-frame"]') ?? []
    ) as HTMLElement[];

    expect(frames).toHaveLength(2);
    expect(frames[0]?.className).toBe(frames[1]?.className);
  });

  it('updates the live preview immediately when debug fields change', async () => {
    const { NotificationsView } = await loadNotificationsView(true);

    await act(async () => {
      root?.render(<NotificationsView />);
      await Promise.resolve();
    });

    const informationalTitle = container?.querySelector(
      '[data-testid="informational-blueprint-title"]'
    ) as HTMLInputElement | null;
    const informationalDescription = container?.querySelector(
      '[data-testid="informational-blueprint-description"]'
    ) as HTMLTextAreaElement | null;
    const informationalTone = container?.querySelector(
      '[data-testid="informational-blueprint-tone"]'
    ) as HTMLSelectElement | null;

    expect(informationalTitle).not.toBeNull();
    expect(informationalDescription).not.toBeNull();
    expect(informationalTone).not.toBeNull();

    await act(async () => {
      await updateMockControl('informational-blueprint-title', 'Custom informational title');
      await updateMockControl(
        'informational-blueprint-description',
        'A much longer debug description.'
      );
      await updateMockControl('informational-blueprint-tone', 'error');
    });

    const informationalPanel = container?.querySelector(
      '[data-testid="notification-blueprint-panel-informational"]'
    ) as HTMLElement | null;
    const surface = informationalPanel?.querySelector(
      '[data-notification-surface="true"]'
    ) as HTMLElement | null;

    expect(informationalPanel?.textContent).toContain('Custom informational title');
    expect(informationalPanel?.textContent).toContain('A much longer debug description.');
    expect(surface?.className).toContain('bg-background');
  });

  it('emits the current blueprint drafts through the dedicated helper functions', async () => {
    const { NotificationsView } = await loadNotificationsView(true);

    await act(async () => {
      root?.render(<NotificationsView />);
      await Promise.resolve();
    });

    await act(async () => {
      await updateMockControl('actionable-blueprint-title', 'Needs attention');
      await updateMockControl('actionable-blueprint-action-count', '1');
      await updateMockControl('actionable-blueprint-primary-action', 'Retry now');
      await updateMockControl('actionable-blueprint-primary-variant', 'secondary');
    });

    const informationalAllButton = container?.querySelector(
      '[data-testid="informational-blueprint-all"]'
    ) as HTMLButtonElement | null;
    const actionableInAppButton = container?.querySelector(
      '[data-testid="actionable-blueprint-in-app"]'
    ) as HTMLButtonElement | null;

    await act(async () => {
      informationalAllButton?.click();
      await Promise.resolve();
    });

    await act(async () => {
      actionableInAppButton?.click();
      await Promise.resolve();
    });

    expect(emitInformationalNotificationBlueprintMock).toHaveBeenCalledWith(
      {
        tone: 'info',
        title: 'Background indexing finished',
        description: 'Everything is up to date.',
      },
      'all'
    );
    expect(emitActionableNotificationBlueprintMock).toHaveBeenCalledWith(
      {
        tone: 'warning',
        title: 'Needs attention',
        description: 'Choose what to do next to continue safely.',
        actions: [
          {
            label: 'Retry now',
            variant: 'secondary',
            dismissOnSuccess: true,
          },
        ],
      },
      'in_app'
    );
  });

  it('disables actionable desktop-only controls because desktop previews cannot validate custom buttons', async () => {
    const { NotificationsView } = await loadNotificationsView(true);

    await act(async () => {
      root?.render(<NotificationsView />);
      await Promise.resolve();
    });

    const actionableDesktopButton = container?.querySelector(
      '[data-testid="actionable-blueprint-desktop"]'
    ) as HTMLButtonElement | null;
    const actionableAllButton = container?.querySelector(
      '[data-testid="actionable-blueprint-all"]'
    ) as HTMLButtonElement | null;

    expect(actionableDesktopButton?.disabled).toBe(true);
    expect(actionableAllButton?.disabled).toBe(true);
  });

  it('clears the notification center from the debug section', async () => {
    const { NotificationsView } = await loadNotificationsView(true);

    useNotificationCenterStore.setState({
      items: [
        {
          id: 'debug-item',
          level: 'info',
          variant: 'informational',
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
