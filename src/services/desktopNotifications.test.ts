import { beforeEach, describe, expect, it, mock } from 'bun:test';

type DesktopNotificationPermission = 'default' | 'denied' | 'granted';
type FocusChangedListener = ((event: { payload: boolean }) => void) | null;

interface ListenerTarget {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  emit: (type: string) => void;
}

const createListenerTarget = (): ListenerTarget => {
  const listeners = new Map<string, Set<() => void>>();

  return {
    addEventListener: (type, listener) => {
      const bucket = listeners.get(type) ?? new Set<() => void>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type) => {
      listeners.get(type)?.forEach((listener) => listener());
    },
  };
};

const isPermissionGrantedMock = mock(async () => true);
const requestPermissionMock = mock(async (): Promise<DesktopNotificationPermission> => 'granted');
const sendNotificationMock = mock((_payload?: unknown) => undefined);
let tauriRuntime = true;
let focusChangedListener: FocusChangedListener = null;

mock.module('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: isPermissionGrantedMock,
  requestPermission: requestPermissionMock,
  sendNotification: sendNotificationMock,
}));

mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (listener: NonNullable<FocusChangedListener>) => {
      focusChangedListener = listener;
      return () => {
        focusChangedListener = null;
      };
    },
  }),
}));

mock.module('../utils/isTauriEnvironment', () => ({
  isTauriEnvironment: () => tauriRuntime,
}));

const desktopNotifications = await import('./desktopNotifications');

let windowTarget: ListenerTarget;
let documentTarget: ListenerTarget;
let documentHidden = false;
let documentFocused = true;

const installDomStubs = (platform: string): void => {
  windowTarget = createListenerTarget();
  documentTarget = createListenerTarget();

  const windowStub = {
    addEventListener: windowTarget.addEventListener,
    removeEventListener: windowTarget.removeEventListener,
    location: { protocol: tauriRuntime ? 'tauri:' : 'https:' },
  };

  const documentStub = {
    addEventListener: documentTarget.addEventListener,
    removeEventListener: documentTarget.removeEventListener,
    get hidden() {
      return documentHidden;
    },
    hasFocus: () => documentFocused,
  };

  Object.defineProperty(globalThis, 'window', {
    value: windowStub,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: documentStub,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      platform,
      userAgent: platform,
    },
    configurable: true,
  });
};

describe('desktopNotifications service', () => {
  beforeEach(() => {
    tauriRuntime = true;
    focusChangedListener = null;
    documentHidden = false;
    documentFocused = true;
    installDomStubs('Win32');
    desktopNotifications.__testables.reset();

    isPermissionGrantedMock.mockReset();
    isPermissionGrantedMock.mockImplementation(async () => true);
    requestPermissionMock.mockReset();
    requestPermissionMock.mockImplementation(async () => 'granted');
    sendNotificationMock.mockReset();
    sendNotificationMock.mockImplementation((_payload?: unknown) => undefined);
  });

  it('does not send a desktop notification while the app is foregrounded', async () => {
    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Foreground alert',
      })
    ).resolves.toBe(false);

    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('sends when the app is in the background', async () => {
    await desktopNotifications.initializeDesktopNotifications();
    documentFocused = false;
    windowTarget.emit('blur');

    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Background alert',
        body: 'Important update',
        notificationKey: 'background:test',
      })
    ).resolves.toBe(true);

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: 'Background alert',
      body: 'Important update',
    });
  });

  it('does nothing on unsupported platforms', async () => {
    installDomStubs('Linux x86_64');

    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Unsupported runtime',
      })
    ).resolves.toBe(false);

    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(desktopNotifications.getDesktopNotificationStatus()).toBe('unsupported');
  });

  it('requests permission once and stops retrying after a denial', async () => {
    isPermissionGrantedMock.mockImplementation(async () => false);
    requestPermissionMock.mockImplementation(async () => 'denied');

    await desktopNotifications.initializeDesktopNotifications();
    documentFocused = false;
    windowTarget.emit('blur');

    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Permission prompt',
        notificationKey: 'permission:test',
      })
    ).resolves.toBe(false);
    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Permission prompt retry',
        notificationKey: 'permission:test',
      })
    ).resolves.toBe(false);

    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(desktopNotifications.getDesktopNotificationStatus()).toBe('denied');
  });

  it('deduplicates repeated notification keys while the app stays in the background', async () => {
    await desktopNotifications.initializeDesktopNotifications();
    documentFocused = false;
    windowTarget.emit('blur');

    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Deduped alert',
        notificationKey: 'task:123',
      })
    ).resolves.toBe(true);
    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Deduped alert',
        notificationKey: 'task:123',
      })
    ).resolves.toBe(false);

    documentFocused = true;
    windowTarget.emit('focus');
    documentFocused = false;
    windowTarget.emit('blur');

    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Deduped alert',
        notificationKey: 'task:123',
      })
    ).resolves.toBe(true);

    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
  });

  it('uses the Tauri focus subscription when it reports a background transition', async () => {
    await desktopNotifications.initializeDesktopNotifications();
    focusChangedListener?.({ payload: false });

    await expect(
      desktopNotifications.maybeSendDesktopNotification({
        title: 'Focus subscription alert',
      })
    ).resolves.toBe(true);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('allows debug previews while the app is foregrounded', async () => {
    await expect(
      desktopNotifications.sendDesktopNotificationPreview({
        title: 'Preview alert',
        body: 'Shown from debug tools',
        notificationKey: 'preview:test',
      })
    ).resolves.toBe(true);

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: 'Preview alert',
      body: 'Shown from debug tools',
    });
  });

  it('does not deduplicate repeated debug preview keys', async () => {
    await expect(
      desktopNotifications.sendDesktopNotificationPreview({
        title: 'Preview alert',
        notificationKey: 'preview:test',
      })
    ).resolves.toBe(true);
    await expect(
      desktopNotifications.sendDesktopNotificationPreview({
        title: 'Preview alert',
        notificationKey: 'preview:test',
      })
    ).resolves.toBe(true);

    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
  });

});
