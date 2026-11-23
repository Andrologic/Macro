import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasUnreadNotifications, useNotificationCenterStore } from '../../stores/useNotificationCenterStore';
import { isTauriAvailable } from '../../services/tauriIpc';
import { listen } from '../../services/tauriRuntimeBridge';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { NotificationCenterPopover } from './NotificationCenterPopover';

const UpdateStatusButton = React.lazy(() =>
  import('../updates/UpdateStatusButton').then((module) => ({
    default: module.UpdateStatusButton,
  })),
);

export const Footer: React.FC = () => {
  const { t } = useTranslation();
  const [migration, setMigration] = useState<{ completed: number; total: number } | null>(null);
  useEffect(() => {
    if (!isTauriAvailable()) return;
    let active = true;
    const subscription = listen<typeof migration>('architect:cutover-progress', ({ payload }) => {
      if (active) setMigration(payload);
    });
    void subscription.catch(console.error);
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten(), () => {});
    };
  }, []);
  const hasUnread = useNotificationCenterStore((state) => hasUnreadNotifications(state.items));
  const isNotificationCenterOpen = useNotificationCenterStore((state) => state.isCenterOpen);
  const setNotificationCenterOpen = useNotificationCenterStore((state) => state.setCenterOpen);
  const notificationCenterButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <footer
        className="h-8 overflow-hidden border-t border-border bg-card px-3 text-[11px] text-muted-foreground"
        data-tour-id="footer-status-bar"
      >
        <div className="flex h-full items-center justify-end gap-1.5">
          {migration && <span role="status" className="mr-auto truncate">
            {t('startup.architectCutoverProgress', migration)}
          </span>}
          <React.Suspense fallback={<span className="h-7 min-w-7" aria-hidden="true" />}>
            <UpdateStatusButton />
          </React.Suspense>
          <Button
            ref={notificationCenterButtonRef}
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t('notifications.centerTitle', 'Notifications')}
            title={t('notifications.centerTitle', 'Notifications')}
            aria-haspopup="dialog"
            aria-expanded={isNotificationCenterOpen}
            aria-controls="notification-center-popover"
            className={cn('relative h-6 w-6 shrink-0 px-0 text-[11px]', isNotificationCenterOpen && 'bg-accent text-foreground hover:bg-accent')}
            onClick={() => setNotificationCenterOpen(!isNotificationCenterOpen)}
            data-tour-id="notification-center"
          >
            <Icon name="bell" size={12} />
            {hasUnread && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full border border-card bg-primary" />}
          </Button>
        </div>
      </footer>

      <NotificationCenterPopover
        isOpen={isNotificationCenterOpen}
        anchorRef={notificationCenterButtonRef}
        onClose={() => setNotificationCenterOpen(false)}
      />
    </>
  );
};
