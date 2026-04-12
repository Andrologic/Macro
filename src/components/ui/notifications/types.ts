import type { ReactNode } from 'react';
import type { NotificationCategory } from '../../../services/notificationChannels';

export type NotificationTone = 'info' | 'success' | 'warning' | 'error';
export type ActionableNotificationTone = Exclude<NotificationTone, 'success'>;
export type NotificationVariant = 'informational' | 'actionable';
export type NotificationActionButtonVariant = 'primary' | 'secondary';

export interface NotificationTemplateActionSpec {
  label: string;
  variant?: NotificationActionButtonVariant;
  onClick: () => void | Promise<void>;
  dismissOnSuccess?: boolean;
}

export interface NotificationTemplateContent {
  tone: NotificationTone;
  variant: NotificationVariant;
  title: ReactNode;
  description?: ReactNode;
  category?: NotificationCategory;
}

export interface NotificationTemplateSnapshot {
  variant: NotificationVariant;
  title: string;
  description?: string;
  category?: NotificationCategory;
}

export interface InformationalNotificationInput {
  title: string;
  description?: string;
  category?: NotificationCategory;
  notificationKey?: string;
  desktopTitle?: string;
  desktopBody?: string;
  duration?: number;
  closeButton?: boolean;
}

export interface ActionableNotificationInput
  extends Omit<InformationalNotificationInput, 'title'> {
  title: string;
  tone?: ActionableNotificationTone;
  actions: NotificationTemplateActionSpec[];
}
