import type { ReactNode } from 'react';
import { cn } from '../../../utils/cn';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { NotificationSurface } from './NotificationSurface';
import type {
  NotificationActionButtonVariant,
  NotificationTone,
} from './types';

interface ActionableNotificationTemplateAction {
  label: string;
  variant: NotificationActionButtonVariant;
}

interface ActionableNotificationTemplateProps {
  tone: NotificationTone;
  title: ReactNode;
  description?: ReactNode;
  actions?: ActionableNotificationTemplateAction[];
  interactive?: boolean;
  pendingActionIndex?: number | null;
  onActionClick?: (index: number) => void;
  snapshotLabel?: string;
  className?: string;
  onDismiss?: () => void;
}

export function ActionableNotificationTemplate({
  tone,
  title,
  description,
  actions = [],
  interactive = true,
  pendingActionIndex = null,
  onActionClick,
  snapshotLabel,
  className,
  onDismiss,
}: ActionableNotificationTemplateProps) {
  const footer = interactive ? (
    actions.length > 0 ? (
      <div className="flex flex-col gap-2">
        {actions.map((action, index) => (
          <Button
            key={`${action.label}-${index}`}
            size="sm"
            variant={action.variant}
            className="w-full justify-center"
            disabled={pendingActionIndex !== null}
            isLoading={pendingActionIndex === index}
            onClick={() => onActionClick?.(index)}
          >
            {action.label}
          </Button>
        ))}
      </div>
    ) : null
  ) : snapshotLabel ? (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium',
        tone === 'error'
          ? 'border-red-400/20 bg-red-500/10 text-red-100'
          : tone === 'success'
            ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
          : tone === 'warning'
            ? 'border-amber-400/20 bg-amber-500/10 text-amber-100'
            : 'border-blue-400/20 bg-blue-500/10 text-blue-100'
      )}
    >
      <Icon name="chevron-right" size={12} />
      <span>{snapshotLabel}</span>
    </div>
  ) : null;

  return (
    <NotificationSurface
      tone={tone}
      title={title}
      description={description}
      footer={footer}
      className={className}
      onDismiss={onDismiss}
    />
  );
}
