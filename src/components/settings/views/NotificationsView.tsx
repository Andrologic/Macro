import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getDesktopNotificationStatus,
  initializeDesktopNotifications,
  subscribeDesktopNotificationStatus,
} from '../../../services/desktopNotifications';
import { useAuthStore } from '../../../stores/useAuthStore';
import { useAppStore } from '../../../stores/useAppStore';
import { Switch } from '../../ui/Switch';
import { toast } from '../../ui/Toaster';

export const NotificationsView: React.FC = () => {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const updatePreferences = useAuthStore((state) => state.updatePreferences);
  const desktopNotificationsEnabled = useAppStore((state) => state.desktopNotificationsEnabled);
  const setDesktopNotificationsEnabled = useAppStore(
    (state) => state.setDesktopNotificationsEnabled
  );
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
  const desktopRuntimeLabel = !desktopNotificationsEnabled
    ? t('settings.desktopNotificationsStatusDisabled', 'Disabled')
    : desktopNotificationStatus === 'granted'
      ? t('settings.desktopNotificationsStatusAllowed', 'Allowed')
      : desktopNotificationStatus === 'denied'
        ? t('settings.desktopNotificationsStatusDenied', 'Denied')
        : desktopNotificationStatus === 'unsupported'
          ? t('settings.desktopNotificationsStatusUnsupported', 'Unsupported')
          : t('settings.desktopNotificationsStatusPermissionNeeded', 'Permission needed');

  const desktopRuntimeToneClass = !desktopNotificationsEnabled
    ? 'text-muted-foreground'
    : desktopNotificationStatus === 'granted'
      ? 'text-emerald-400'
      : desktopNotificationStatus === 'denied'
        ? 'text-red-400'
        : desktopNotificationStatus === 'unsupported'
          ? 'text-amber-400'
          : 'text-blue-400';

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
                  'settings.inAppNotificationsDesc',
                  'Show toast notifications inside Macro and keep important alerts in the notification center.'
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

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">
                {t('settings.desktop_notifications', 'Desktop Notifications')}
              </label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'settings.desktop_notifications_desc',
                  'Show native desktop notifications for important events'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('settings.desktopNotificationsRuntime', 'Runtime status')}:{' '}
                <span className={desktopRuntimeToneClass}>{desktopRuntimeLabel}</span>
              </p>
            </div>
            <Switch
              checked={desktopNotificationsEnabled}
              onCheckedChange={setDesktopNotificationsEnabled}
            />
          </div>
        </div>
      </section>
    </div>
  );
};

export default NotificationsView;
