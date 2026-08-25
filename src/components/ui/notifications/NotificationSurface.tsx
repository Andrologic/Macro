import type { ReactNode } from 'react';
import i18n from '../../../i18n';
import { cn } from '../../../utils/cn';
import { Icon, type IconName } from '../Icon';
import type { NotificationTone } from './types';

interface NotificationSurfaceProps {
  tone: NotificationTone;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  className?: string;
  onDismiss?: () => void;
}

const TONE_PRESENTATION: Record<
  NotificationTone,
  {
    icon: IconName;
    iconClassName: string;
  }
> = {
  info: {
    icon: 'alert-circle',
    iconClassName: 'text-blue-400',
  },
  success: {
    icon: 'check-circle',
    iconClassName: 'text-emerald-400',
  },
  warning: {
    icon: 'triangle-alert',
    iconClassName: 'text-amber-400',
  },
  error: {
    icon: 'circle-x',
    iconClassName: 'text-red-400',
  },
};

export function NotificationSurface({
  tone,
  title,
  description,
  footer,
  className,
  onDismiss,
}: NotificationSurfaceProps) {
  const presentation = TONE_PRESENTATION[tone];
  const dismissLabel = i18n.t('notifications.dismiss', 'Dismiss notification');

  return (
    <div
      data-notification-surface="true"
      className={cn(
        'relative w-full min-w-0 rounded-xl border border-border/60 bg-background px-3 py-3 text-foreground shadow-[0_22px_44px_-36px_rgba(0,0,0,0.35)]',
        className
      )}
    >
      {onDismiss ? (
        <button
          type="button"
          aria-label={dismissLabel}
          title={dismissLabel}
          onClick={onDismiss}
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/75 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="x" size={14} />
        </button>
      ) : null}

      <div
        data-notification-surface-content="true"
        className={cn('flex gap-3', description ? 'items-start' : 'items-center')}
      >
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background shadow-inner',
            description && 'mt-0.5'
          )}
        >
          <Icon name={presentation.icon} size={16} className={presentation.iconClassName} />
        </div>

        <div className={cn('min-w-0 flex-1', !description && 'flex min-h-9 items-center')}>
          <div
            data-notification-title="true"
            className={cn('text-sm font-semibold leading-5 text-foreground break-words', onDismiss && 'pr-8')}
          >
            {title}
          </div>
          {description ? (
            <div data-notification-description="true" className="mt-1 text-xs leading-relaxed text-muted-foreground break-words">
              {description}
            </div>
          ) : null}
        </div>
      </div>

      {footer ? <div data-notification-surface-footer="true" className="mt-3">{footer}</div> : null}
    </div>
  );
}
