/**
 * Toast Notifications
 *
 * Wrapper around sonner for consistent toast styling with theme integration.
 */

import { useState, type ReactNode } from 'react';
import {
  Toaster as SonnerToaster,
  toast as sonnerToast,
  type ExternalToast,
} from 'sonner';
import { maybeSendDesktopNotification } from '../../services/desktopNotifications';
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
type DesktopEligibleNotificationLevel = NotificationLevel | 'success';

export interface NotificationActionSpec {
  label: string;
  variant?: 'primary' | 'secondary';
  onClick: () => void | Promise<void>;
  dismissOnSuccess?: boolean;
}

export interface NotificationOptions extends ExternalToast {
  actions?: NotificationActionSpec[];
  notificationKey?: string;
  desktopEligible?: boolean;
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
  level: NotificationLevel;
  title: ReactNode;
  description?: ReactNode;
  actions: NormalizedNotificationActionSpec[];
  pendingActionIndex: number | null;
  onActionClick: (index: number) => void;
}

interface ActionableNotificationToastProps {
  level: NotificationLevel;
  toastId: ToastId;
  title: ReactNode;
  description?: ReactNode;
  actions: NormalizedNotificationActionSpec[];
}

let generatedNotificationCounter = 0;

const notificationsEnabled = (): boolean =>
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
    desktopEligible: _desktopEligible,
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

const getLevelMethod = (level: NotificationLevel) => {
  switch (level) {
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

const isDesktopNotificationEligible = (
  level: DesktopEligibleNotificationLevel,
  options?: NotificationOptions
): boolean => {
  if (level === 'warning' || level === 'error') {
    return true;
  }

  return options?.desktopEligible === true;
};

const maybeEmitDesktopNotification = (
  level: DesktopEligibleNotificationLevel,
  message: ToastMessage,
  options: NotificationOptions | undefined,
  toastIdentity: { toastId: ToastId; historyId: string }
): void => {
  if (!isDesktopNotificationEligible(level, options)) {
    return;
  }

  const content = toTrackableToastContent(message, options);
  if (!content) {
    return;
  }

  void maybeSendDesktopNotification({
    title: content.title,
    body: content.description,
    notificationKey: resolveNotificationKey(options?.notificationKey) ?? toastIdentity.historyId,
  });
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

const emitTrackedToast = (
  level: NotificationLevel,
  message: ToastMessage,
  options?: NotificationOptions
): ToastId | typeof NOTIFICATIONS_DISABLED_RESULT => {
  const toastIdentity = resolveToastIdentity(options);
  maybeEmitDesktopNotification(level, message, options, toastIdentity);

  if (!notificationsEnabled()) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  const sonnerOptions = toSonnerToastOptions(options, toastIdentity.toastId);
  const actions = normalizeNotificationActions(options?.actions);
  const result =
    actions.length === 0
      ? getLevelMethod(level)(message, sonnerOptions)
      : sonnerToast.custom(
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

  persistNotification(level, toastIdentity.historyId, toTrackableToastContent(message, options));
  return result;
};

const emitVisibleSuccessToast = (
  message: ToastMessage,
  options?: NotificationOptions
): ToastId | typeof NOTIFICATIONS_DISABLED_RESULT => {
  const toastIdentity = resolveToastIdentity(options);
  maybeEmitDesktopNotification('success', message, options, toastIdentity);

  if (!notificationsEnabled()) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  return sonnerToast.success(message, toSonnerToastOptions(options, toastIdentity.toastId));
};

function callVisibleToast<TArgs extends unknown[], TResult>(
  method: (...args: TArgs) => TResult,
  ...args: TArgs
): TResult | typeof NOTIFICATIONS_DISABLED_RESULT {
  if (!notificationsEnabled()) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  return method(...args);
}

export const executeNotificationAction = async (
  action: NormalizedNotificationActionSpec,
  toastId: ToastId,
  onError: (message: string) => void = (message) => {
    emitTrackedToast('error', message);
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
    success: (message: ToastMessage, options?: NotificationOptions) =>
      emitVisibleSuccessToast(message, options),
    info: (message: ToastMessage, options?: NotificationOptions) =>
      emitTrackedToast('info', message, options),
    warning: (message: ToastMessage, options?: NotificationOptions) =>
      emitTrackedToast('warning', message, options),
    error: (message: ToastMessage, options?: NotificationOptions) =>
      emitTrackedToast('error', message, options),
    message: (...args: SonnerToastArgs) =>
      callVisibleToast(sonnerToast.message, ...args),
    loading: (...args: SonnerToastArgs) =>
      callVisibleToast(sonnerToast.loading, ...args),
    custom: (...args: SonnerCustomToastArgs) =>
      callVisibleToast(sonnerToast.custom, ...args),
    promise: (promiseInput: Promise<unknown> | (() => Promise<unknown>), data?: unknown) => {
      if (!notificationsEnabled()) {
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
  normalizeNotificationActions,
  toTrackableToastContent,
};

/**
 * Toaster component to be placed at the app root.
 * Uses CSS variables from the theme for consistent styling.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      expand={false}
      richColors
      closeButton
      duration={4000}
      toastOptions={{
        style: {
          background: 'hsl(var(--card))',
          border: '1px solid hsl(var(--border))',
          color: 'hsl(var(--foreground))',
        },
        classNames: {
          toast: 'rounded-lg shadow-lg',
          title: 'text-sm font-medium',
          description: 'text-xs text-muted-foreground',
          closeButton:
            'bg-transparent border-border hover:bg-accent text-muted-foreground',
          success: 'border-emerald-500/30 bg-emerald-500/10',
          error: 'border-red-500/30 bg-red-500/10',
          warning: 'border-amber-500/30 bg-amber-500/10',
          info: 'border-blue-500/30 bg-blue-500/10',
        },
      }}
    />
  );
}
