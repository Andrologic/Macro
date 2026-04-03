import { useState, type ReactNode } from 'react';
import { toast as sonnerToast, type ExternalToast } from 'sonner';
import { maybeSendDesktopNotification } from '../../services/desktopNotifications';
import {
  DEFAULT_NOTIFICATION_CHANNEL_MODES,
  isDesktopChannelMode,
  isToastChannelMode,
  sanitizeNotificationChannelMode,
  type NotificationCategory,
} from '../../services/notificationChannels';
import { useAppStore } from '../../stores/useAppStore';
import { useAuthStore } from '../../stores/useAuthStore';
import {
  useNotificationCenterStore,
  type NotificationLevel,
} from '../../stores/useNotificationCenterStore';
import { cn } from '../../utils/cn';
import { Button } from './Button';

const NOTIFICATIONS_DISABLED_RESULT = 'notifications-disabled';
const MAX_NOTIFICATION_ACTIONS = 2;
const DEFAULT_NOTIFICATION_ACTION_ERROR_MESSAGE = 'An error occurred';

type ToastMessage = Parameters<typeof sonnerToast>[0];
type SonnerToastArgs = Parameters<typeof sonnerToast>;
type SonnerCustomToastArgs = Parameters<typeof sonnerToast.custom>;
type ToastId = string | number;
type EmittableNotificationLevel = NotificationLevel | 'success';
type NotificationToastMethod = (
  message: ToastMessage,
  options?: NotificationOptions
) => ToastId | typeof NOTIFICATIONS_DISABLED_RESULT;

export interface NotificationActionSpec {
  label: string;
  variant?: 'primary' | 'secondary';
  onClick: () => void | Promise<void>;
  dismissOnSuccess?: boolean;
}

export interface NotificationOptions extends ExternalToast {
  actions?: NotificationActionSpec[];
  notificationKey?: string;
  notification?: {
    category: NotificationCategory;
    title?: string;
    body?: string;
  };
}

interface TrackableToastContent {
  title: string;
  description?: string;
}

interface NormalizedNotificationActionSpec {
  label: string;
  variant: 'primary' | 'secondary';
  onClick: () => void | Promise<void>;
  dismissOnSuccess: boolean;
}

interface ActionableNotificationToastBodyProps {
  level: EmittableNotificationLevel;
  title: ReactNode;
  description?: ReactNode;
  actions: NormalizedNotificationActionSpec[];
  pendingActionIndex: number | null;
  onActionClick: (index: number) => void;
}

interface ActionableNotificationToastProps {
  level: EmittableNotificationLevel;
  toastId: ToastId;
  title: ReactNode;
  description?: ReactNode;
  actions: NormalizedNotificationActionSpec[];
}

let generatedNotificationCounter = 0;

const uncategorizedNotificationsEnabled = (): boolean =>
  useAuthStore.getState().user?.preferences.notifications !== false;

const getTrackableDescription = (data: NotificationOptions | undefined): unknown =>
  data?.description;

const nextGeneratedNotificationId = (): string => {
  generatedNotificationCounter += 1;
  return `notification-${Date.now()}-${generatedNotificationCounter}`;
};

const resolveNotificationKey = (value?: string): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const resolveExplicitToastId = (options?: NotificationOptions): ToastId | null => {
  const notificationKey = resolveNotificationKey(options?.notificationKey);
  if (notificationKey) {
    return notificationKey;
  }

  if (typeof options?.id === 'string' || typeof options?.id === 'number') {
    return options.id;
  }

  return null;
};

const resolveToastIdentity = (
  options?: NotificationOptions
): { toastId: ToastId; historyId: string } => {
  const explicitToastId = resolveExplicitToastId(options);
  if (typeof explicitToastId === 'string') {
    return {
      toastId: explicitToastId,
      historyId: explicitToastId,
    };
  }

  if (typeof explicitToastId === 'number') {
    return {
      toastId: explicitToastId,
      historyId: String(explicitToastId),
    };
  }

  const generatedId = nextGeneratedNotificationId();
  return {
    toastId: generatedId,
    historyId: generatedId,
  };
};

const toSonnerToastOptions = (
  options: NotificationOptions | undefined,
  toastId: ToastId
): ExternalToast => {
  if (!options) {
    return { id: toastId };
  }

  const {
    actions: _actions,
    notificationKey: _notificationKey,
    notification: _notification,
    ...sonnerOptions
  } = options;
  return {
    ...sonnerOptions,
    id: toastId,
  };
};

const resolveToastNode = (value: unknown): ReactNode => {
  if (typeof value === 'function') {
    return (value as () => ReactNode)();
  }

  return value as ReactNode;
};

const getNotificationActionErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return DEFAULT_NOTIFICATION_ACTION_ERROR_MESSAGE;
};

const getNotificationChannelMode = (options?: NotificationOptions) => {
  const category = options?.notification?.category;
  if (!category) {
    return null;
  }

  return sanitizeNotificationChannelMode(
    category,
    useAppStore.getState().notificationChannelModes[category] ??
      DEFAULT_NOTIFICATION_CHANNEL_MODES[category]
  );
};

const isToastEnabledForNotification = (options?: NotificationOptions): boolean => {
  const mode = getNotificationChannelMode(options);
  if (mode) {
    return isToastChannelMode(mode);
  }

  return uncategorizedNotificationsEnabled();
};

const isDesktopEnabledForNotification = (options?: NotificationOptions): boolean => {
  const mode = getNotificationChannelMode(options);
  if (!mode) {
    return false;
  }

  return isDesktopChannelMode(mode);
};

export const toTrackableToastContent = (
  message?: ToastMessage,
  data?: NotificationOptions
): TrackableToastContent | null => {
  if (typeof message !== 'string') {
    return null;
  }

  const description = getTrackableDescription(data);
  if (description === undefined) {
    return {
      title: message,
    };
  }

  if (typeof description !== 'string') {
    return null;
  }

  return {
    title: message,
    description,
  };
};

const resolveDesktopNotificationContent = (
  message?: ToastMessage,
  options?: NotificationOptions
): { title: string; body?: string } | null => {
  const configuredTitle = options?.notification?.title?.trim();
  const configuredBody = options?.notification?.body?.trim();
  const fallbackTitle = typeof message === 'string' ? message.trim() : '';
  const fallbackBody =
    typeof options?.description === 'string' ? options.description.trim() : '';
  const title = configuredTitle || fallbackTitle;

  if (!title) {
    return null;
  }

  const body = configuredBody || fallbackBody;
  return body ? { title, body } : { title };
};

const persistNotification = (
  level: NotificationLevel,
  notificationId: string,
  content: TrackableToastContent | null
): void => {
  if (!content) {
    return;
  }

  const createdAt = new Date().toISOString();
  const readAt = useNotificationCenterStore.getState().isCenterOpen ? createdAt : null;

  useNotificationCenterStore.getState().upsertItem({
    id: notificationId,
    level,
    title: content.title,
    description: content.description,
    createdAt,
    readAt,
  });
};

const getLevelMethod = (level: EmittableNotificationLevel) => {
  switch (level) {
    case 'success':
      return sonnerToast.success;
    case 'info':
      return sonnerToast.info;
    case 'warning':
      return sonnerToast.warning;
    case 'error':
      return sonnerToast.error;
    default:
      return sonnerToast;
  }
};

export const normalizeNotificationActions = (
  actions?: NotificationActionSpec[]
): NormalizedNotificationActionSpec[] =>
  (actions ?? [])
    .filter(
      (action): action is NotificationActionSpec =>
        Boolean(action) &&
        typeof action.label === 'string' &&
        action.label.trim().length > 0 &&
        typeof action.onClick === 'function'
    )
    .slice(0, MAX_NOTIFICATION_ACTIONS)
    .map((action) => ({
      label: action.label.trim(),
      variant: action.variant === 'secondary' ? 'secondary' : 'primary',
      onClick: action.onClick,
      dismissOnSuccess: action.dismissOnSuccess !== false,
    }));

const emitDesktopNotification = (
  message: ToastMessage,
  historyId: string,
  options?: NotificationOptions
): void => {
  if (!isDesktopEnabledForNotification(options)) {
    return;
  }

  const content = resolveDesktopNotificationContent(message, options);
  if (!content) {
    return;
  }

  void maybeSendDesktopNotification({
    ...content,
    notificationKey: resolveNotificationKey(options?.notificationKey) ?? historyId,
  });
};

const emitToastChannel = (
  level: EmittableNotificationLevel,
  message: ToastMessage,
  toastId: ToastId,
  options?: NotificationOptions
): ToastId => {
  const sonnerOptions = toSonnerToastOptions(options, toastId);
  const actions = normalizeNotificationActions(options?.actions);

  if (actions.length === 0) {
    return getLevelMethod(level)(message, sonnerOptions);
  }

  return sonnerToast.custom(
    (currentToastId) => (
      <ActionableNotificationToast
        level={level}
        toastId={currentToastId}
        title={resolveToastNode(message)}
        description={resolveToastNode(options?.description)}
        actions={actions}
      />
    ),
    sonnerOptions
  );
};

const emitNotification = (
  level: EmittableNotificationLevel,
  message: ToastMessage,
  options: NotificationOptions | undefined,
  tracked: boolean
): ToastId | typeof NOTIFICATIONS_DISABLED_RESULT => {
  const toastEnabled = isToastEnabledForNotification(options);
  const desktopEnabled = isDesktopEnabledForNotification(options);

  if (!toastEnabled && !desktopEnabled) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  const { toastId, historyId } = resolveToastIdentity(options);
  let result: ToastId = historyId;

  if (toastEnabled) {
    result = emitToastChannel(level, message, toastId, options);
    if (tracked && level !== 'success') {
      persistNotification(level, historyId, toTrackableToastContent(message, options));
    }
  }

  emitDesktopNotification(message, historyId, options);
  return result;
};

const emitVisibleToast = (
  method: (message: ToastMessage, options?: ExternalToast) => ToastId,
  message: ToastMessage,
  options?: NotificationOptions
): ToastId | typeof NOTIFICATIONS_DISABLED_RESULT => {
  if (!uncategorizedNotificationsEnabled()) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  const { toastId } = resolveToastIdentity(options);
  return method(message, toSonnerToastOptions(options, toastId));
};

function callVisibleToast<TArgs extends unknown[], TResult>(
  method: (...args: TArgs) => TResult,
  ...args: TArgs
): TResult | typeof NOTIFICATIONS_DISABLED_RESULT {
  if (!uncategorizedNotificationsEnabled()) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  return method(...args);
}

export const executeNotificationAction = async (
  action: NormalizedNotificationActionSpec,
  toastId: ToastId,
  onError: (message: string) => void = (message) => {
    emitNotification('error', message, undefined, true);
  }
): Promise<boolean> => {
  try {
    await action.onClick();
    if (action.dismissOnSuccess) {
      sonnerToast.dismiss(toastId);
    }
    return true;
  } catch (error) {
    onError(getNotificationActionErrorMessage(error));
    return false;
  }
};

function ActionableNotificationToastBody({
  level,
  title,
  description,
  actions,
  pendingActionIndex,
  onActionClick,
}: ActionableNotificationToastBodyProps) {
  return (
    <div
      className={cn(
        'w-full min-w-0 rounded-lg border p-3 text-foreground shadow-lg',
        level === 'success' && 'border-emerald-500/30 bg-emerald-500/10',
        level === 'warning' && 'border-amber-500/30 bg-amber-500/10',
        level === 'error' && 'border-red-500/30 bg-red-500/10',
        level === 'info' && 'border-blue-500/30 bg-blue-500/10'
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium break-words">{title}</div>
        {description ? (
          <div className="mt-1 text-xs text-muted-foreground break-words">{description}</div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {actions.map((action, index) => (
          <Button
            key={`${action.label}-${index}`}
            size="sm"
            variant={action.variant}
            className="w-full justify-center"
            disabled={pendingActionIndex !== null}
            isLoading={pendingActionIndex === index}
            onClick={() => onActionClick(index)}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ActionableNotificationToast({
  level,
  toastId,
  title,
  description,
  actions,
}: ActionableNotificationToastProps) {
  const [pendingActionIndex, setPendingActionIndex] = useState<number | null>(null);

  const handleActionClick = (actionIndex: number) => {
    if (pendingActionIndex !== null) {
      return;
    }

    const action = actions[actionIndex];
    if (!action) {
      return;
    }

    setPendingActionIndex(actionIndex);

    void executeNotificationAction(action, toastId).finally(() => {
      setPendingActionIndex(null);
    });
  };

  return (
    <ActionableNotificationToastBody
      level={level}
      title={title}
      description={description}
      actions={actions}
      pendingActionIndex={pendingActionIndex}
      onActionClick={handleActionClick}
    />
  );
}

export const toast = Object.assign(
  ((...args: SonnerToastArgs) =>
    callVisibleToast(sonnerToast, ...args)) as typeof sonnerToast,
  {
    success: ((message: ToastMessage, options?: NotificationOptions) =>
      options?.notification
        ? emitNotification('success', message, options, false)
        : emitVisibleToast(sonnerToast.success, message, options)) as NotificationToastMethod,
    info: (message: ToastMessage, options?: NotificationOptions) =>
      emitNotification('info', message, options, true),
    warning: (message: ToastMessage, options?: NotificationOptions) =>
      emitNotification('warning', message, options, true),
    error: (message: ToastMessage, options?: NotificationOptions) =>
      emitNotification('error', message, options, true),
    message: (...args: SonnerToastArgs) =>
      callVisibleToast(sonnerToast.message, ...args),
    loading: (...args: SonnerToastArgs) =>
      callVisibleToast(sonnerToast.loading, ...args),
    custom: (...args: SonnerCustomToastArgs) =>
      callVisibleToast(sonnerToast.custom, ...args),
    promise: (promiseInput: Promise<unknown> | (() => Promise<unknown>), data?: unknown) => {
      if (!uncategorizedNotificationsEnabled()) {
        return NOTIFICATIONS_DISABLED_RESULT as ReturnType<typeof sonnerToast.promise>;
      }

      return sonnerToast.promise(promiseInput, data as never);
    },
    dismiss: sonnerToast.dismiss,
    getHistory: sonnerToast.getHistory,
    getToasts: sonnerToast.getToasts,
  }
);

export const __testables = {
  ActionableNotificationToastBody,
  executeNotificationAction,
  getNotificationChannelMode,
  normalizeNotificationActions,
  resolveDesktopNotificationContent,
  toTrackableToastContent,
};
