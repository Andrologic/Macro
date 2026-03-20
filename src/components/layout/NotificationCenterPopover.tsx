import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNotificationCenterStore, type NotificationCenterItem } from '../../stores/useNotificationCenterStore';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import {
  calculateNotificationCenterPosition,
  countUnreadNotificationItems,
  formatNotificationRelativeTime,
  type NotificationCenterPosition,
} from './notificationCenterUtils';

interface NotificationCenterPopoverProps {
  isOpen: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

const getNotificationItemTone = (item: NotificationCenterItem) => {
  if (item.level === 'error') {
    return {
      icon: 'alert-circle' as const,
      iconClass: 'text-destructive',
      bubbleClass: 'border-destructive/20 bg-destructive/10',
    };
  }

  if (item.level === 'warning') {
    return {
      icon: 'triangle-alert' as const,
      iconClass: 'text-foreground/85',
      bubbleClass: 'border-border bg-secondary/80',
    };
  }

  return {
    icon: 'circle-dot' as const,
    iconClass: 'text-primary',
    bubbleClass: 'border-primary/20 bg-primary/10',
  };
};

export const NotificationCenterPopover: React.FC<NotificationCenterPopoverProps> = ({
  isOpen,
  anchorRef,
  onClose,
}) => {
  const { t } = useTranslation();
  const items = useNotificationCenterStore((state) => state.items);
  const clearAll = useNotificationCenterStore((state) => state.clearAll);
  const removeItem = useNotificationCenterStore((state) => state.removeItem);
  const unreadCount = useMemo(() => countUnreadNotificationItems(items), [items]);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<NotificationCenterPosition | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
      className="z-[94] flex flex-col overflow-hidden rounded-xl border border-border bg-popover/98 text-popover-foreground shadow-2xl backdrop-blur-sm animate-in fade-in zoom-in-95 duration-100"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/80 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            {t('notifications.centerTitle', 'Notifications')}
          </h2>
          <p className="text-[11px] text-muted-foreground">
            {items.length > 0
              ? unreadCount > 0
                ? t('notifications.unreadCount', '{{count}} unread', { count: unreadCount })
                : t('notifications.allRead', 'All caught up')
              : t('notifications.emptySubtitle', 'Info, warning, and error notifications appear here.')}
          </p>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={items.length === 0}
          onClick={() => clearAll()}
        >
          {t('notifications.clearAll', 'Clear all')}
        </Button>
      </div>

      <div className="min-h-0 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-6 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background/70">
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
          <div className="space-y-2">
            {items.map((item) => {
              const tone = getNotificationItemTone(item);

              return (
                <div
                  key={item.id}
                  className="group flex items-start gap-3 rounded-lg border border-border/70 bg-background/35 px-3 py-3 transition-colors hover:bg-background/50"
                >
                  <div
                    className={cn(
                      'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
                      tone.bubbleClass
                    )}
                  >
                    <Icon name={tone.icon} size={14} className={tone.iconClass} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-5 text-foreground">
                          {item.title}
                        </p>
                        {item.description && (
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {item.description}
                          </p>
                        )}
                      </div>

                      <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">
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
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
