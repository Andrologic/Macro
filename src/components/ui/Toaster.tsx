/**
 * Toast Notifications
 *
 * Wrapper around sonner for consistent toast styling with theme integration.
 */

import { Toaster as SonnerToaster, toast as sonnerToast } from "sonner";
import { useAuthStore } from "../../stores/useAuthStore";
import { useNotificationCenterStore, type NotificationLevel } from "../../stores/useNotificationCenterStore";
import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./Icon";

type SonnerToastApi = typeof sonnerToast;
type ToastMessage = Parameters<SonnerToastApi>[0];
type ToastData = Parameters<SonnerToastApi>[1];
type ToastResult = ReturnType<SonnerToastApi>;
type ToastPromiseInput = Parameters<SonnerToastApi["promise"]>[0];
type ToastPromiseData = Parameters<SonnerToastApi["promise"]>[1];
type ToastPromiseResult = ReturnType<SonnerToastApi["promise"]>;
type TypedToastPromiseInput<ToastPayload> = Promise<ToastPayload> | (() => Promise<ToastPayload>);

const HIDDEN_TOAST_ID = "notifications-disabled";

const areInAppNotificationsEnabled = (): boolean =>
  useAuthStore.getState().user?.preferences.notifications !== false;

const toTrackableToastContent = (
  message: ToastMessage,
  data?: ToastData
): { title: string; description?: string } | null => {
  if (typeof message !== "string") {
    return null;
  }

  if (data?.description !== undefined && typeof data.description !== "string") {
    return null;
  }

  const normalizedTitle = message.trim();
  if (!normalizedTitle) {
    return null;
  }

  return {
    title: normalizedTitle,
    description:
      typeof data?.description === "string" && data.description.trim()
        ? data.description.trim()
        : undefined,
  };
};

const maybeTrackNotification = (
  level: NotificationLevel,
  message: ToastMessage,
  data?: ToastData
): void => {
  const payload = toTrackableToastContent(message, data);
  if (!payload) {
    return;
  }

  useNotificationCenterStore
    .getState()
    .addItem(level, payload.title, payload.description);
};

const emitToast = (
  emitter: (message: ToastMessage, data?: ToastData) => ToastResult,
  message: ToastMessage,
  data?: ToastData
): ToastResult => {
  if (!areInAppNotificationsEnabled()) {
    return HIDDEN_TOAST_ID;
  }

  return emitter(message, data);
};

const emitTrackedToast = (
  level: NotificationLevel,
  emitter: (message: ToastMessage, data?: ToastData) => ToastResult,
  message: ToastMessage,
  data?: ToastData
): ToastResult => {
  if (!areInAppNotificationsEnabled()) {
    return HIDDEN_TOAST_ID;
  }

  maybeTrackNotification(level, message, data);
  return emitter(message, data);
};

const createDisabledPromiseToastResult = <ToastPayload,>(
  promiseInput: ToastPromiseInput
): ToastPromiseResult => {
  const promise =
    typeof promiseInput === "function"
      ? promiseInput()
      : promiseInput;

  return {
    unwrap: () => promise as Promise<ToastPayload>,
  };
};

export const toast = Object.assign(
  (message: ToastMessage, data?: ToastData): ToastResult =>
    emitToast(sonnerToast, message, data),
  {
    success: (message: ToastMessage, data?: ToastData): ToastResult =>
      emitToast(sonnerToast.success, message, data),
    info: (message: ToastMessage, data?: ToastData): ToastResult =>
      emitTrackedToast("info", sonnerToast.info, message, data),
    warning: (message: ToastMessage, data?: ToastData): ToastResult =>
      emitTrackedToast("warning", sonnerToast.warning, message, data),
    error: (message: ToastMessage, data?: ToastData): ToastResult =>
      emitTrackedToast("error", sonnerToast.error, message, data),
    message: (message: ToastMessage, data?: ToastData): ToastResult =>
      emitToast(sonnerToast.message, message, data),
    loading: (message: ToastMessage, data?: ToastData): ToastResult =>
      emitToast(sonnerToast.loading, message, data),
    custom: (jsx: Parameters<SonnerToastApi["custom"]>[0], data?: Parameters<SonnerToastApi["custom"]>[1]) => {
      if (!areInAppNotificationsEnabled()) {
        return HIDDEN_TOAST_ID;
      }

      return sonnerToast.custom(jsx, data);
    },
    promise: <ToastPayload,>(promise: ToastPromiseInput, data?: ToastPromiseData): ToastPromiseResult => {
      if (!areInAppNotificationsEnabled()) {
        return createDisabledPromiseToastResult<ToastPayload>(promise);
      }

      return sonnerToast.promise<ToastPayload>(
        promise as TypedToastPromiseInput<ToastPayload>,
        data
      );
    },
    dismiss: (id?: number | string) => sonnerToast.dismiss(id),
    getHistory: () => sonnerToast.getHistory(),
    getToasts: () => sonnerToast.getToasts(),
  }
);

export const __testables = {
  areInAppNotificationsEnabled,
  toTrackableToastContent,
};

/**
 * Toaster component to be placed at the app root.
 * Uses CSS variables from the theme for consistent styling.
 */
export function Toaster() {
  const { isDark } = useTheme();

  return (
    <SonnerToaster
      className="macro-toaster"
      theme={isDark ? "dark" : "light"}
      position="bottom-right"
      expand={false}
      closeButton
      duration={4000}
      offset={16}
      mobileOffset={{ bottom: 16, left: 16, right: 16 }}
      icons={{
        success: <Icon name="check" size={14} />,
        info: <Icon name="circle-dot" size={14} />,
        warning: <Icon name="triangle-alert" size={14} />,
        error: <Icon name="alert-circle" size={14} />,
        loading: <Icon name="loader" size={14} className="animate-spin" />,
        close: <Icon name="x" size={12} />,
      }}
      toastOptions={{
        classNames: {
          toast: "macro-toast",
          content: "macro-toast-content",
          title: "macro-toast-title",
          description: "macro-toast-description",
          icon: "macro-toast-icon",
          closeButton: "macro-toast-close",
          actionButton: "macro-toast-action",
          cancelButton: "macro-toast-cancel",
          success: "macro-toast-success",
          error: "macro-toast-error",
          warning: "macro-toast-warning",
          info: "macro-toast-info",
          loading: "macro-toast-loading",
          default: "macro-toast-default",
        },
      }}
    />
  );
}
