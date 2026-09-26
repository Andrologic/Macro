import { DEFAULT_NOTIFICATION_CHANNEL_MODES, type NotificationChannelModes } from './notificationChannels';

export interface NotificationPreferences {
  inAppNotificationsEnabled: boolean;
  notificationChannelModes: NotificationChannelModes;
}

let readPreferences: (() => NotificationPreferences) | undefined;

/** The owner is installed once by composition; preferences remain in their store. */
export function installNotificationPreferences(reader: () => NotificationPreferences): () => void {
  if (readPreferences && readPreferences !== reader) {
    throw new Error('Notification preferences already installed');
  }
  readPreferences = reader;
  return () => {
    if (readPreferences === reader) readPreferences = undefined;
  };
}

export function getNotificationPreferences(): NotificationPreferences {
  return readPreferences?.() ?? {
    inAppNotificationsEnabled: true,
    notificationChannelModes: DEFAULT_NOTIFICATION_CHANNEL_MODES,
  };
}
