import type { ReactNode } from 'react';
import { NotificationSurface } from './NotificationSurface';
import type { NotificationTone } from './types';

interface InformationalNotificationTemplateProps {
  tone: NotificationTone;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  onDismiss?: () => void;
}

export function InformationalNotificationTemplate({
  tone,
  title,
  description,
  className,
  onDismiss,
}: InformationalNotificationTemplateProps) {
  return (
    <NotificationSurface
      tone={tone}
      title={title}
      description={description}
      className={className}
      onDismiss={onDismiss}
    />
  );
}
