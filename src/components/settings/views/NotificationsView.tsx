import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getDesktopNotificationStatus,
  initializeDesktopNotifications,
  subscribeDesktopNotificationStatus,
} from '../../../services/desktopNotifications';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_DEFINITIONS,
  getAllowedNotificationChannelModes,
  type NotificationChannelMode,
} from '../../../services/notificationChannels';
import { useAuthStore } from '../../../stores/useAuthStore';
import { useAppStore } from '../../../stores/useAppStore';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { toast } from '../../ui/Toaster';

export const NotificationsView: React.FC = () => {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const updatePreferences = useAuthStore((state) => state.updatePreferences);
  const notificationChannelModes = useAppStore((state) => state.notificationChannelModes);
  const setNotificationChannelMode = useAppStore((state) => state.setNotificationChannelMode);
  const desktopNotificationStatus = useSyncExternalStore(
    subscribeDesktopNotificationStatus,
    getDesktopNotificationStatus,
    getDesktopNotificationStatus
  );
  const [isUpdatingInAppNotifications, setIsUpdatingInAppNotifications] = useState(false);

  useEffect(() => {
    void initializeDesktopNotifications();
  }, []);

  const inAppNotificationsEnabled = user?.preferences.notifications !== false;
  const desktopRuntimeLabel = desktopNotificationStatus === 'granted'
    ? t('settings.desktopNotificationsStatusAllowed', 'Allowed')
    : desktopNotificationStatus === 'denied'
      ? t('settings.desktopNotificationsStatusDenied', 'Denied')
      : desktopNotificationStatus === 'unsupported'
        ? t('settings.desktopNotificationsStatusUnsupported', 'Unsupported')
        : t('settings.desktopNotificationsStatusPermissionNeeded', 'Permission needed');

  const desktopRuntimeToneClass = desktopNotificationStatus === 'granted'
    ? 'text-emerald-400'
    : desktopNotificationStatus === 'denied'
      ? 'text-red-400'
      : desktopNotificationStatus === 'unsupported'
        ? 'text-amber-400'
        : 'text-blue-400';

  const categoryRows = useMemo(
    () =>
      NOTIFICATION_CATEGORIES.map((category) => ({
        category,
        title: t(NOTIFICATION_CATEGORY_DEFINITIONS[category].titleKey),
        description: t(NOTIFICATION_CATEGORY_DEFINITIONS[category].descriptionKey),
        mode: notificationChannelModes[category],
        allowedModes: getAllowedNotificationChannelModes(category),
      })),
    [notificationChannelModes, t]
  );

  const handleInAppNotificationsChange = async (checked: boolean) => {
    if (!user) {
      return;
    }

    setIsUpdatingInAppNotifications(true);
    try {
      await updatePreferences({ notifications: checked });
    } catch (error) {
      toast.error(
        error instanceof Error && error.message.trim()
          ? error.message
          : t(
              'settings.inAppNotificationsUpdateFailed',
              'Failed to update in-app notification preferences'
            )
      );
    } finally {
      setIsUpdatingInAppNotifications(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <section className="space-y-4">
        <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
          {t('settings.notificationsDelivery', 'Delivery')}
        </h4>

        <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">
                {t('settings.inAppNotifications', 'In-app Notifications')}
              </label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'settings.inAppNotificationsScopedDesc',
                  'Control uncategorized in-app notifications that are not covered by the channel rules below.'
                )}
              </p>
            </div>
            <Switch
              checked={inAppNotificationsEnabled}
              onCheckedChange={(checked) => void handleInAppNotificationsChange(checked)}
              disabled={!user || isUpdatingInAppNotifications}
            />
          </div>

          <div className="h-px bg-border/50" />

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">
              {t('settings.notificationChannels', 'Notification channels')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.notificationChannelsDesc',
                'Choose how each important workflow event should be delivered: toast, desktop, both, or off.'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('settings.desktopNotificationsRuntime', 'Runtime status')}:{' '}
              <span className={desktopRuntimeToneClass}>{desktopRuntimeLabel}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.desktopNotificationsPermissionHint',
                'Macro asks for desktop notification permission the first time an eligible background notification is sent.'
              )}
            </p>
          </div>

          <div className="space-y-3 pt-2">
            {categoryRows.map((row) => (
              <div
                key={row.category}
                className="flex items-start justify-between gap-4 rounded-lg border border-border/50 bg-background/40 px-3 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-sm font-medium text-foreground">
                    {row.title}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.description}
                  </p>
                </div>
                <div className="w-40 shrink-0">
                  <Select
                    value={row.mode}
                    onChange={(event) =>
                      setNotificationChannelMode(
                        row.category,
                        event.target.value as NotificationChannelMode
                      )
                    }
                    className="h-9 py-1.5"
                  >
                    {row.allowedModes.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`settings.notificationChannelMode.${mode}`)}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

export default NotificationsView;
