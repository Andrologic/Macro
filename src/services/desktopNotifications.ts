import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { isTauriEnvironment } from '../utils/isTauriEnvironment';

export type DesktopNotificationPermissionStatus =
  | 'unknown'
  | 'granted'
  | 'denied'
  | 'unsupported';

export interface DesktopNotificationInput {
  title: string;
  body?: string;
  notificationKey?: string | null;
}

interface DesktopNotificationDispatchOptions {
  ignoreForeground?: boolean;
  ignoreDeduplication?: boolean;
}

type DesktopNotificationListener = () => void;

let status: DesktopNotificationPermissionStatus = 'unknown';
let initialized = false;
let initPromise: Promise<void> | null = null;
let permissionRequestPromise: Promise<boolean> | null = null;
let hasRequestedPermission = false;
let windowFocused = true;
let documentVisible = true;
let emittedKeysWhileBackgrounded = new Set<string>();
const listeners = new Set<DesktopNotificationListener>();
let cleanupCallbacks: Array<() => void> = [];

const normalizeDesktopNotificationKey = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getPlatformHint = (): string => {
  if (typeof navigator === 'undefined') {
    return '';
  }

  const candidate =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;

  return candidate.toLowerCase();
};

const isSupportedDesktopNotificationPlatform = (): boolean => {
  const platformHint = getPlatformHint();
  return platformHint.includes('win') || platformHint.includes('mac');
};

const isSupportedRuntime = (): boolean =>
  isTauriEnvironment() && isSupportedDesktopNotificationPlatform();

export const isDesktopNotificationRuntimeSupported = (): boolean => isSupportedRuntime();

const notifyListeners = (): void => {
  listeners.forEach((listener) => listener());
};

const setStatus = (nextStatus: DesktopNotificationPermissionStatus): void => {
  if (status === nextStatus) {
    return;
  }

  status = nextStatus;
  notifyListeners();
};

const isAppForeground = (): boolean => windowFocused && documentVisible;

const syncBackgroundDeduplication = (): void => {
  if (isAppForeground()) {
    emittedKeysWhileBackgrounded.clear();
  }
};

const setWindowFocused = (focused: boolean): void => {
  windowFocused = focused;
  syncBackgroundDeduplication();
};

const setDocumentVisible = (visible: boolean): void => {
  documentVisible = visible;
  syncBackgroundDeduplication();
};

const getInitialDocumentVisibleState = (): boolean =>
  typeof document === 'undefined' ? true : document.hidden !== true;

const getInitialWindowFocusedState = (): boolean =>
  typeof document === 'undefined' ? true : document.hasFocus();

const cleanupInitialization = (): void => {
  cleanupCallbacks.forEach((cleanup) => cleanup());
  cleanupCallbacks = [];
};

const refreshPermissionStatus = async (): Promise<void> => {
  if (!isSupportedRuntime()) {
    setStatus('unsupported');
    return;
  }

  try {
    const granted = await isPermissionGranted();
    setStatus(granted ? 'granted' : 'unknown');
  } catch (error) {
    console.warn('Failed to read desktop notification permission state:', error);
    setStatus('unknown');
  }
};

const ensurePermissionGranted = async (): Promise<boolean> => {
  if (!isSupportedRuntime()) {
    setStatus('unsupported');
    return false;
  }

  if (status === 'granted') {
    return true;
  }

  if (status === 'denied' || status === 'unsupported') {
    return false;
  }

  if (permissionRequestPromise) {
    return permissionRequestPromise;
  }

  if (hasRequestedPermission) {
    return false;
  }

  hasRequestedPermission = true;
  permissionRequestPromise = (async () => {
    try {
      const alreadyGranted = await isPermissionGranted();
      if (alreadyGranted) {
        setStatus('granted');
        return true;
      }

      const permission = await requestPermission();
      const granted = permission === 'granted';
      setStatus(granted ? 'granted' : 'denied');
      return granted;
    } catch (error) {
      console.warn('Failed to request desktop notification permission:', error);
      setStatus('unknown');
      return false;
    } finally {
      permissionRequestPromise = null;
    }
  })();

  return permissionRequestPromise;
};

const dispatchDesktopNotification = async (
  input: DesktopNotificationInput,
  options: DesktopNotificationDispatchOptions = {}
): Promise<boolean> => {
  if (!isSupportedRuntime()) {
    setStatus('unsupported');
    return false;
  }

  if (!options.ignoreForeground && isAppForeground()) {
    return false;
  }

  const notificationKey = normalizeDesktopNotificationKey(input.notificationKey);
  if (
    !options.ignoreDeduplication &&
    notificationKey &&
    emittedKeysWhileBackgrounded.has(notificationKey)
  ) {
    return false;
  }

  const granted = await ensurePermissionGranted();
  if (!granted) {
    return false;
  }

  try {
    const payload =
      input.body && input.body.trim().length > 0
        ? { title: input.title, body: input.body.trim() }
        : { title: input.title };
    await Promise.resolve(sendNotification(payload));

    if (notificationKey && !options.ignoreDeduplication) {
      emittedKeysWhileBackgrounded.add(notificationKey);
    }
    return true;
  } catch (error) {
    console.warn('Failed to send desktop notification:', error);
    return false;
  }
};

export const initializeDesktopNotifications = async (): Promise<void> => {
  if (initialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    cleanupInitialization();
    emittedKeysWhileBackgrounded.clear();
    windowFocused = getInitialWindowFocusedState();
    documentVisible = getInitialDocumentVisibleState();

    if (!isSupportedRuntime()) {
      setStatus('unsupported');
      initialized = true;
      return;
    }

    if (typeof window !== 'undefined') {
      const handleWindowFocus = () => setWindowFocused(true);
      const handleWindowBlur = () => setWindowFocused(false);
      window.addEventListener('focus', handleWindowFocus);
      window.addEventListener('blur', handleWindowBlur);
      cleanupCallbacks.push(() => {
        window.removeEventListener('focus', handleWindowFocus);
        window.removeEventListener('blur', handleWindowBlur);
      });
    }

    if (typeof document !== 'undefined') {
      const handleVisibilityChange = () => setDocumentVisible(!document.hidden);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      cleanupCallbacks.push(() =>
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      );
    }

    try {
      const unlistenFocusChanged = await getCurrentWindow().onFocusChanged(({ payload }) => {
        setWindowFocused(payload);
      });
      cleanupCallbacks.push(() => {
        void unlistenFocusChanged();
      });
    } catch (error) {
      console.warn('Failed to subscribe to Tauri focus changes:', error);
    }

    await refreshPermissionStatus();
    initialized = true;
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
};

export const subscribeDesktopNotificationStatus = (
  listener: DesktopNotificationListener
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getDesktopNotificationStatus = (): DesktopNotificationPermissionStatus => status;

export const maybeSendDesktopNotification = async (
  input: DesktopNotificationInput
): Promise<boolean> => {
  await initializeDesktopNotifications();
  return dispatchDesktopNotification(input);
};

export const sendDesktopNotificationPreview = async (
  input: DesktopNotificationInput
): Promise<boolean> => {
  await initializeDesktopNotifications();
  return dispatchDesktopNotification(input, {
    ignoreForeground: true,
    ignoreDeduplication: true,
  });
};

export const __testables = {
  isSupportedDesktopNotificationPlatform,
  isAppForeground,
  reset: () => {
    cleanupInitialization();
    listeners.clear();
    status = 'unknown';
    initialized = false;
    initPromise = null;
    permissionRequestPromise = null;
    hasRequestedPermission = false;
    windowFocused = true;
    documentVisible = true;
    emittedKeysWhileBackgrounded.clear();
  },
};
