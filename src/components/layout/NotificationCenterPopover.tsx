import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNotificationCenterStore } from '../../stores/useNotificationCenterStore';
import { Icon } from '../ui/Icon';
import {
  ActionableNotificationTemplate,
  InformationalNotificationTemplate,
} from '../ui/notifications';
import { executeRegisteredNotificationAction } from '../ui/toastService';
import {
  calculateNotificationCenterPosition,
  formatNotificationRelativeTime,
  groupNotificationCenterItemsByDate,
  type NotificationCenterPosition,
} from './notificationCenterUtils';

interface NotificationCenterPopoverProps {
  isOpen: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

export const NotificationCenterPopover: React.FC<NotificationCenterPopoverProps> = ({
  isOpen,
  anchorRef,
  onClose,
}) => {
  const { t, i18n } = useTranslation();
  const items = useNotificationCenterStore((state) => state.items);
  const clearAll = useNotificationCenterStore((state) => state.clearAll);
  const removeItem = useNotificationCenterStore((state) => state.removeItem);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<NotificationCenterPosition | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const groupedItems = groupNotificationCenterItemsByDate(items, {
    now,
    locale: i18n.language,
    labels: {
      lessThanMinute: t(
        'notifications.group.lessThanMinute',
        'Less than a minute ago'
      ),
      thisHour: t('notifications.group.thisHour', 'This hour'),
      today: t('notifications.group.today', 'Today'),
      yesterday: t('notifications.group.yesterday', 'Yesterday'),
    },
  });

  useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      if (!anchorRef.current) {
        return;
      }

      const rect = anchorRef.current.getBoundingClientRect();
      setPosition(
        calculateNotificationCenterPosition(
          {
            top: rect.top,
            right: rect.right,
          },
          {
            width: window.innerWidth,
            height: window.innerHeight,
          }
        )
      );
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    const footer = anchorRef.current?.closest('footer');
    footer?.addEventListener('scroll', updatePosition);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      footer?.removeEventListener('scroll', updatePosition);
    };
  }, [anchorRef, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }

      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setNow(Date.now());
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 60000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isOpen]);

  if (!isOpen || !position || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal={false}
      aria-label={t('notifications.centerTitle', 'Notifications')}
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${position.width}px`,
        maxHeight: `${position.maxHeight}px`,
        transform: 'translateY(-100%)',
      }}
      className="z-[94] flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl animate-in fade-in zoom-in-95 duration-100"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">
            {t('notifications.centerTitle', 'Notifications')}
          </h2>
        </div>

        {items.length > 0 && (
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11px] font-medium text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            onClick={() => clearAll()}
          >
            <Icon name="trash" size={12} />
            <span>{t('notifications.clearAll', 'Clear all')}</span>
          </button>
        )}
      </div>

      <div className="min-h-0 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-6 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card">
              <Icon name="bell" size={16} className="text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {t('notifications.emptyTitle', 'No notifications')}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('notifications.emptySubtitle', 'Info, warning, and error notifications appear here.')}
              </p>
            </div>
          </div>
        ) : (
            <div className="space-y-4">
              {groupedItems.map((group) => (
                <section
                  key={group.id}
                  className="space-y-2"
                  data-testid={`notification-group-${group.id}`}
                >
                  <div className="px-1">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </h3>
                  </div>

                  <div className="space-y-2">
                    {group.items.map((item) => (
                      <div key={item.id} className="group space-y-1.5 rounded-xl px-1 py-1">
                        <div className="flex items-center justify-between gap-3 px-1">
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                            {formatNotificationRelativeTime(item.createdAt, now)}
                          </span>
                          <button
                            type="button"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            aria-label={t('notifications.remove', 'Remove notification')}
                            title={t('notifications.remove', 'Remove notification')}
                            onClick={() => removeItem(item.id)}
                          >
                            <Icon name="x" size={12} />
                          </button>
                        </div>

                        {item.variant === 'actionable' ? (
                          <ActionableNotificationTemplate
                            tone={item.level}
                            title={item.title}
                            description={item.description}
                            actions={item.sessionActions}
                            interactive={Boolean(item.sessionActions?.length)}
                            pendingActionIndex={item.pendingActionIndex ?? null}
                            onActionClick={(actionIndex) => {
                              void executeRegisteredNotificationAction(item.id, actionIndex);
                            }}
                            snapshotLabel={
                              item.sessionActions?.length
                                ? undefined
                                : t('notifications.actionRequired', 'Action required')
                            }
                          />
                        ) : (
                          <InformationalNotificationTemplate
                            tone={item.level}
                            title={item.title}
                            description={item.description}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
      </div>
    </div>,
    document.body
  );
};
