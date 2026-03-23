/**
 * Toast Notifications
 *
 * Wrapper around sonner for consistent toast styling with theme integration.
 */

import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';
import { useAuthStore } from '../../stores/useAuthStore';
import {
  useNotificationCenterStore,
  type NotificationLevel,
} from '../../stores/useNotificationCenterStore';

const NOTIFICATIONS_DISABLED_RESULT = 'notifications-disabled';

type ToastMessage = unknown;
type ToastData = unknown;
type SonnerToastArgs = Parameters<typeof sonnerToast>;
type SonnerCustomToastArgs = Parameters<typeof sonnerToast.custom>;

interface TrackableToastContent {
  title: string;
  description?: string;
}

const notificationsEnabled = (): boolean =>
  useAuthStore.getState().user?.preferences.notifications !== false;

const getTrackableDescription = (data: ToastData): unknown => {
  if (!data || typeof data !== 'object' || !('description' in data)) {
    return undefined;
  }

  return data.description;
};

export const toTrackableToastContent = (
  message?: ToastMessage,
  data?: ToastData
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
  content: TrackableToastContent | null
): void => {
  if (!content) {
    return;
  }

  useNotificationCenterStore
    .getState()
    .addItem(level, content.title, content.description);
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

function callTrackedToast<TResult>(
  level: NotificationLevel,
  method: (...args: SonnerToastArgs) => TResult,
  ...args: SonnerToastArgs
): TResult | typeof NOTIFICATIONS_DISABLED_RESULT {
  if (!notificationsEnabled()) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  const result = method(...args);
  persistNotification(level, toTrackableToastContent(args[0], args[1]));
  return result;
}

export const toast = Object.assign(
  ((...args: SonnerToastArgs) =>
    callVisibleToast(sonnerToast, ...args)) as typeof sonnerToast,
  {
    success: (...args: SonnerToastArgs) =>
      callVisibleToast(sonnerToast.success, ...args),
    info: (...args: SonnerToastArgs) =>
      callTrackedToast('info', sonnerToast.info, ...args),
    warning: (...args: SonnerToastArgs) =>
      callTrackedToast('warning', sonnerToast.warning, ...args),
    error: (...args: SonnerToastArgs) =>
      callTrackedToast('error', sonnerToast.error, ...args),
    message: (...args: SonnerToastArgs) =>
      callVisibleToast(sonnerToast.message, ...args),
    loading: (...args: SonnerToastArgs) =>
      callVisibleToast(sonnerToast.loading, ...args),
    custom: (...args: SonnerCustomToastArgs) =>
      callVisibleToast(sonnerToast.custom, ...args),
    promise: (promiseInput: Promise<unknown> | (() => Promise<unknown>), data?: ToastData) => {
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
