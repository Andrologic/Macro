import { useState, type ReactNode } from 'react';
import { toast as sonnerToast, type ExternalToast } from 'sonner';
import { maybeSendDesktopNotification } from '../../services/desktopNotifications';
import {
  DEFAULT_NOTIFICATION_CHANNEL_MODES,
  isDesktopChannelMode,
  isToastChannelMode,
  sanitizeNotificationChannelMode,
  type NotificationCategory,
} from '../../services/notificationChannels';
import { useAppStore } from '../../stores/useAppStore';
import { useAuthStore } from '../../stores/useAuthStore';
import {
  useNotificationCenterStore,
  type NotificationLevel,
} from '../../stores/useNotificationCenterStore';
import { cn } from '../../utils/cn';
import {
  ActionableNotificationTemplate,
  InformationalNotificationTemplate,
  type ActionableNotificationInput,
  type InformationalNotificationInput,
  type NotificationTemplateActionSpec,
  type NotificationTone,
  type NotificationVariant,
} from './notifications';
import {
  clearToastBatch,
  registerToastInBatch,
  setToastBatchExpiryHandler,
  unregisterToastFromBatch,
} from './toastBatchController';

const NOTIFICATIONS_DISABLED_RESULT = 'notifications-disabled';
const MAX_NOTIFICATION_ACTIONS = 2;
const DEFAULT_NOTIFICATION_ACTION_ERROR_MESSAGE = 'An error occurred';

type ToastMessage = Parameters<typeof sonnerToast>[0];
type SonnerCustomToastArgs = Parameters<typeof sonnerToast.custom>;
type ToastId = string | number;
type NotificationToastMethod = (
  message: ToastMessage,
  options?: NotificationOptions
) => ToastId | typeof NOTIFICATIONS_DISABLED_RESULT;
type NotifyInformationalMethod = (
  title: string,
  options?: Omit<InformationalNotificationInput, 'title'>
) => ToastId | typeof NOTIFICATIONS_DISABLED_RESULT;
type NotifyActionableMethod = (
  title: string,
  options: Omit<ActionableNotificationInput, 'title'>
) => ToastId | typeof NOTIFICATIONS_DISABLED_RESULT;

export type NotificationActionSpec = NotificationTemplateActionSpec;

export interface NotificationOptions extends ExternalToast {
  actions?: NotificationActionSpec[];
  notificationKey?: string;
  notification?: {
    category?: NotificationCategory;
    title?: string;
    body?: string;
  };
}

interface TrackableToastContent {
  title: string;
  description?: string;
}

interface PersistableNotificationContent extends TrackableToastContent {
  variant: NotificationVariant;
  category?: NotificationCategory;
}

interface NormalizedNotificationActionSpec {
  label: string;
  variant: 'primary' | 'secondary';
  onClick: () => void | Promise<void>;
  dismissOnSuccess: boolean;
}

interface ActionableNotificationToastBodyProps {
  tone: NotificationTone;
  title: ReactNode;
  description?: ReactNode;
  actions: NormalizedNotificationActionSpec[];
  pendingActionIndex: number | null;
  onActionClick: (index: number) => void;
  interactive?: boolean;
  snapshotLabel?: string;
  onDismiss?: () => void;
}

interface ActionableNotificationToastProps {
  tone: NotificationTone;
  toastId: ToastId;
  title: ReactNode;
  description?: ReactNode;
  actions: NormalizedNotificationActionSpec[];
  showDismissButton?: boolean;
}

interface InformationalNotificationToastBodyProps {
  tone: NotificationTone;
  title: string;
  description?: string;
  onDismiss?: () => void;
}

interface TemplatedNotificationPayload {
  tone: NotificationTone;
  variant: NotificationVariant;
  title: string;
  description?: string;
  category?: NotificationCategory;
  actions?: NormalizedNotificationActionSpec[];
  notificationKey?: string;
  desktopTitle?: string;
  desktopBody?: string;
  duration?: number;
  closeButton?: boolean;
}

let generatedNotificationCounter = 0;

setToastBatchExpiryHandler((toastIds) => {
  toastIds.forEach((toastId) => {
    sonnerToast.dismiss(toastId);
  });
});

const uncategorizedNotificationsEnabled = (): boolean =>
  useAuthStore.getState().user?.preferences.notifications !== false;

const getTrackableDescription = (data: NotificationOptions | undefined): unknown =>
  data?.description;

const nextGeneratedNotificationId = (): string => {
  generatedNotificationCounter += 1;
  return `notification-${Date.now()}-${generatedNotificationCounter}`;
};

const resolveNotificationKey = (value?: string): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const resolveExplicitToastId = (options?: NotificationOptions): ToastId | null => {
  const notificationKey = resolveNotificationKey(options?.notificationKey);
  if (notificationKey) {
    return notificationKey;
  }

  if (typeof options?.id === 'string' || typeof options?.id === 'number') {
    return options.id;
  }

  return null;
};

const resolveToastIdentity = (
  options?: NotificationOptions
): { toastId: ToastId; historyId: string } => {
  const explicitToastId = resolveExplicitToastId(options);
  if (typeof explicitToastId === 'string') {
    return {
      toastId: explicitToastId,
      historyId: explicitToastId,
    };
  }

  if (typeof explicitToastId === 'number') {
    return {
      toastId: explicitToastId,
      historyId: String(explicitToastId),
    };
  }

  const generatedId = nextGeneratedNotificationId();
  return {
    toastId: generatedId,
    historyId: generatedId,
  };
};

const toSonnerToastOptions = (
  options: NotificationOptions | undefined,
  toastId: ToastId
): ExternalToast => {
  if (!options) {
    return { id: toastId };
  }

  const {
    actions: _actions,
    notificationKey: _notificationKey,
    notification: _notification,
    ...sonnerOptions
  } = options;
  return {
    ...sonnerOptions,
    id: toastId,
  };
};

const chainToastHandler = <TArgs extends unknown[]>(
  first: ((...args: TArgs) => void) | undefined,
  second: ((...args: TArgs) => void) | undefined
): ((...args: TArgs) => void) | undefined => {
  if (!first && !second) {
    return undefined;
  }

  return (...args: TArgs) => {
    first?.(...args);
    second?.(...args);
  };
};

const toBatchManagedToastOptions = (
  options: NotificationOptions | undefined,
  toastId: ToastId
): ExternalToast => {
  const baseOptions = toSonnerToastOptions(options, toastId);

  return {
    ...baseOptions,
    duration: Infinity,
    onDismiss: chainToastHandler(baseOptions.onDismiss, () => {
      unregisterToastFromBatch(toastId);
    }),
  };
};

const toCustomToastOptions = (
  options: NotificationOptions | undefined,
  toastId: ToastId
): ExternalToast => {
  const baseOptions = toBatchManagedToastOptions(options, toastId);
  const {
    description: _description,
    closeButton: _closeButton,
    ...customOptions
  } = baseOptions;

  return customOptions;
};

const toTemplatedSonnerToastOptions = (
  options: NotificationOptions | undefined,
  toastId: ToastId
): ExternalToast => {
  const baseOptions = toCustomToastOptions(options, toastId);

  return {
    ...baseOptions,
    className: cn('bg-transparent border-0 shadow-none p-0', baseOptions.className),
    style: {
      background: 'transparent',
      border: 'none',
      boxShadow: 'none',
      padding: 0,
      ...(baseOptions.style ?? {}),
    },
  };
};

const resolveToastNode = (value: unknown): ReactNode => {
  if (typeof value === 'function') {
    return (value as () => ReactNode)();
  }

  return value as ReactNode;
};

const getNotificationActionErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return DEFAULT_NOTIFICATION_ACTION_ERROR_MESSAGE;
};

const getNotificationChannelMode = (options?: NotificationOptions) => {
  const category = options?.notification?.category;
  if (!category) {
    return null;
  }

  return sanitizeNotificationChannelMode(
    category,
    useAppStore.getState().notificationChannelModes[category] ??
      DEFAULT_NOTIFICATION_CHANNEL_MODES[category]
  );
};

const isToastEnabledForNotification = (options?: NotificationOptions): boolean => {
  const mode = getNotificationChannelMode(options);
  if (mode) {
    return isToastChannelMode(mode);
  }

  return uncategorizedNotificationsEnabled();
};

const isDesktopEnabledForNotification = (options?: NotificationOptions): boolean => {
  const mode = getNotificationChannelMode(options);
  if (!mode) {
    return false;
  }

  return isDesktopChannelMode(mode);
};

export const toTrackableToastContent = (
  message?: ToastMessage,
  data?: NotificationOptions
): TrackableToastContent | null => {
  if (typeof message !== 'string') {
    return null;
  }

  const description = getTrackableDescription(data);
  if (description === undefined) {
    return {
      title: message,
    };
  }

  if (typeof description !== 'string') {
    return null;
  }

  return {
    title: message,
    description,
  };
};

const toPersistableToastContent = (
  message?: ToastMessage,
  data?: NotificationOptions
): PersistableNotificationContent | null => {
  const baseContent = toTrackableToastContent(message, data);
  if (!baseContent) {
    return null;
  }

  return {
    ...baseContent,
    variant:
      normalizeNotificationActions(data?.actions).length > 0
        ? 'actionable'
        : 'informational',
    category: data?.notification?.category,
  };
};

const resolveDesktopNotificationContent = (
  message?: ToastMessage,
  options?: NotificationOptions
): { title: string; body?: string } | null => {
  const configuredTitle = options?.notification?.title?.trim();
  const configuredBody = options?.notification?.body?.trim();
  const fallbackTitle = typeof message === 'string' ? message.trim() : '';
  const fallbackBody =
    typeof options?.description === 'string' ? options.description.trim() : '';
  const title = configuredTitle || fallbackTitle;

  if (!title) {
    return null;
  }

  const body = configuredBody || fallbackBody;
  return body ? { title, body } : { title };
};

const persistNotification = (
  level: NotificationLevel,
  notificationId: string,
  content: PersistableNotificationContent | null
): void => {
  if (!content) {
    return;
  }

  const createdAt = new Date().toISOString();
  const readAt = useNotificationCenterStore.getState().isCenterOpen ? createdAt : null;

  useNotificationCenterStore.getState().upsertItem({
    id: notificationId,
    level,
    variant: content.variant,
    category: content.category,
    title: content.title,
    description: content.description,
    createdAt,
    readAt,
  });
};

const getLevelMethod = (level: NotificationTone) => {
  switch (level) {
    case 'success':
      return sonnerToast.success;
    case 'info':
      return sonnerToast.info;
    case 'warning':
      return sonnerToast.warning;
    case 'error':
      return sonnerToast.error;
    default:
      return sonnerToast;
  }
};

const toNotificationLevel = (tone: Exclude<NotificationTone, 'success'>): NotificationLevel => {
  if (tone === 'warning') {
    return 'warning';
  }

  if (tone === 'error') {
    return 'error';
  }

  return 'info';
};

export const normalizeNotificationActions = (
  actions?: NotificationActionSpec[]
): NormalizedNotificationActionSpec[] =>
  (actions ?? [])
    .filter(
      (action): action is NotificationActionSpec =>
        Boolean(action) &&
        typeof action.label === 'string' &&
        action.label.trim().length > 0 &&
        typeof action.onClick === 'function'
    )
    .slice(0, MAX_NOTIFICATION_ACTIONS)
    .map((action) => ({
      label: action.label.trim(),
      variant: action.variant === 'secondary' ? 'secondary' : 'primary',
      onClick: action.onClick,
      dismissOnSuccess: action.dismissOnSuccess !== false,
    }));

const emitDesktopNotification = (
  message: ToastMessage,
  historyId: string,
  options?: NotificationOptions
): void => {
  if (!isDesktopEnabledForNotification(options)) {
    return;
  }

  const content = resolveDesktopNotificationContent(message, options);
  if (!content) {
    return;
  }

  void maybeSendDesktopNotification({
    ...content,
    notificationKey: resolveNotificationKey(options?.notificationKey) ?? historyId,
  });
};

function InformationalNotificationToastBody({
  tone,
  title,
  description,
  onDismiss,
}: InformationalNotificationToastBodyProps) {
  return (
    <InformationalNotificationTemplate
      tone={tone}
      title={title}
      description={description}
      onDismiss={onDismiss}
    />
  );
}

function ActionableNotificationToastBody({
  tone,
  title,
  description,
  actions,
  pendingActionIndex,
  onActionClick,
  interactive = true,
  snapshotLabel,
  onDismiss,
}: ActionableNotificationToastBodyProps) {
  return (
    <ActionableNotificationTemplate
      tone={tone}
      title={title}
      description={description}
      actions={actions}
      interactive={interactive}
      pendingActionIndex={pendingActionIndex}
      onActionClick={onActionClick}
      snapshotLabel={snapshotLabel}
      onDismiss={onDismiss}
    />
  );
}

export const executeNotificationAction = async (
  action: NormalizedNotificationActionSpec,
  toastId: ToastId,
  onError: (message: string) => void = (message) => {
    emitTemplatedNotification({
      tone: 'error',
      variant: 'informational',
      title: message,
    });
  }
): Promise<boolean> => {
  try {
    await action.onClick();
    if (action.dismissOnSuccess) {
      sonnerToast.dismiss(toastId);
    }
    return true;
  } catch (error) {
    onError(getNotificationActionErrorMessage(error));
    return false;
  }
};

function ActionableNotificationToast({
  tone,
  toastId,
  title,
  description,
  actions,
  showDismissButton = true,
}: ActionableNotificationToastProps) {
  const [pendingActionIndex, setPendingActionIndex] = useState<number | null>(null);

  const handleActionClick = (actionIndex: number) => {
    if (pendingActionIndex !== null) {
      return;
    }

    const action = actions[actionIndex];
    if (!action) {
      return;
    }

    setPendingActionIndex(actionIndex);

    void executeNotificationAction(action, toastId).finally(() => {
      setPendingActionIndex(null);
    });
  };

  return (
    <ActionableNotificationToastBody
      tone={tone}
      title={title}
      description={description}
      actions={actions}
      pendingActionIndex={pendingActionIndex}
      onActionClick={handleActionClick}
      onDismiss={showDismissButton ? () => sonnerToast.dismiss(toastId) : undefined}
    />
  );
}

const emitToastChannel = (
  level: NotificationTone,
  message: ToastMessage,
  toastId: ToastId,
  options?: NotificationOptions
): ToastId => {
  const sonnerOptions = toCustomToastOptions(options, toastId);
  const actions = normalizeNotificationActions(options?.actions);
  const showDismissButton = options?.closeButton !== false;

  if (actions.length === 0) {
    return getLevelMethod(level)(message, sonnerOptions);
  }

  return sonnerToast.custom(
    (currentToastId) => (
      <ActionableNotificationToast
        tone={level}
        toastId={currentToastId}
        title={resolveToastNode(message)}
        description={resolveToastNode(options?.description)}
        actions={actions}
        showDismissButton={showDismissButton}
      />
    ),
    sonnerOptions
  );
};

const emitNotification = (
  level: NotificationTone,
  message: ToastMessage,
  options: NotificationOptions | undefined,
  tracked: boolean
): ToastId | typeof NOTIFICATIONS_DISABLED_RESULT => {
  const toastEnabled = isToastEnabledForNotification(options);
  const desktopEnabled = isDesktopEnabledForNotification(options);

  if (!toastEnabled && !desktopEnabled) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  const { toastId, historyId } = resolveToastIdentity(options);
  let result: ToastId = historyId;

  if (toastEnabled) {
    registerToastInBatch(toastId);
    result = emitToastChannel(level, message, toastId, options);
    if (tracked && level !== 'success') {
      persistNotification(level as NotificationLevel, historyId, toPersistableToastContent(message, options));
    }
  }

  emitDesktopNotification(message, historyId, options);
  return result;
};

const emitVisibleToast = (
  method: (message: ToastMessage, options?: ExternalToast) => ToastId,
  message: ToastMessage,
  options?: NotificationOptions
): ToastId | typeof NOTIFICATIONS_DISABLED_RESULT => {
  if (!uncategorizedNotificationsEnabled()) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  const { toastId } = resolveToastIdentity(options);
  registerToastInBatch(toastId);
  return method(message, toBatchManagedToastOptions(options, toastId));
};

const emitVisibleCustomToast = (
  renderToast: SonnerCustomToastArgs[0],
  options?: NotificationOptions
): ToastId | typeof NOTIFICATIONS_DISABLED_RESULT => {
  if (!uncategorizedNotificationsEnabled()) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  const { toastId } = resolveToastIdentity(options);
  registerToastInBatch(toastId);
  return sonnerToast.custom(renderToast, toBatchManagedToastOptions(options, toastId));
};

const buildTemplatedNotificationOptions = (
  payload: TemplatedNotificationPayload
): NotificationOptions => ({
  description: payload.description,
  notificationKey: payload.notificationKey,
  duration: payload.duration,
  closeButton: payload.closeButton,
  notification:
    payload.category || payload.desktopTitle || payload.desktopBody
      ? {
          ...(payload.category ? { category: payload.category } : {}),
          ...(payload.desktopTitle ? { title: payload.desktopTitle } : {}),
          ...(payload.desktopBody ? { body: payload.desktopBody } : {}),
        }
      : undefined,
});

const emitTemplatedToastChannel = (
  payload: TemplatedNotificationPayload,
  toastId: ToastId,
  options: NotificationOptions
): ToastId =>
  sonnerToast.custom(
    (currentToastId) =>
      payload.variant === 'actionable' ? (
        <ActionableNotificationToast
          tone={payload.tone}
          toastId={currentToastId}
          title={payload.title}
          description={payload.description}
          actions={payload.actions ?? []}
        />
      ) : (
        <InformationalNotificationToastBody
          tone={payload.tone}
          title={payload.title}
          description={payload.description}
          onDismiss={
            payload.closeButton !== false
              ? () => sonnerToast.dismiss(currentToastId)
              : undefined
          }
        />
      ),
    toTemplatedSonnerToastOptions(options, toastId)
  );

const emitTemplatedNotification = (
  payload: TemplatedNotificationPayload
): ToastId | typeof NOTIFICATIONS_DISABLED_RESULT => {
  const options = buildTemplatedNotificationOptions(payload);
  const toastEnabled = isToastEnabledForNotification(options);
  const desktopEnabled = isDesktopEnabledForNotification(options);

  if (!toastEnabled && !desktopEnabled) {
    return NOTIFICATIONS_DISABLED_RESULT;
  }

  const { toastId, historyId } = resolveToastIdentity(options);
  let result: ToastId = historyId;

  if (toastEnabled) {
    registerToastInBatch(toastId);
    result = emitTemplatedToastChannel(payload, toastId, options);
    if (payload.tone !== 'success') {
      persistNotification(toNotificationLevel(payload.tone), historyId, {
        title: payload.title,
        description: payload.description,
        variant: payload.variant,
        category: payload.category,
      });
    }
  }

  emitDesktopNotification(payload.title, historyId, options);
  return result;
};

const buildInformationalPayload = (
  tone: NotificationTone,
  title: string,
  options?: Omit<InformationalNotificationInput, 'title'>
): TemplatedNotificationPayload => ({
  tone,
  variant: 'informational',
  title,
  description: options?.description,
  category: options?.category,
  notificationKey: options?.notificationKey,
  desktopTitle: options?.desktopTitle,
  desktopBody: options?.desktopBody,
  duration: options?.duration,
  closeButton: options?.closeButton,
});

const buildActionablePayload = (
  title: string,
  options: Omit<ActionableNotificationInput, 'title'>
): TemplatedNotificationPayload => ({
  tone: options.tone ?? 'warning',
  variant: 'actionable',
  title,
  description: options.description,
  category: options.category,
  actions: normalizeNotificationActions(options.actions),
  notificationKey: options.notificationKey,
  desktopTitle: options.desktopTitle,
  desktopBody: options.desktopBody,
  duration: options.duration,
  closeButton: options.closeButton,
});

export const toast = Object.assign(
  ((message: ToastMessage, options?: NotificationOptions) =>
    emitVisibleToast(sonnerToast, message, options)) as typeof sonnerToast,
  {
    success: ((message: ToastMessage, options?: NotificationOptions) =>
      options?.notification
        ? emitNotification('success', message, options, false)
        : emitVisibleToast(sonnerToast.success, message, options)) as NotificationToastMethod,
    info: (message: ToastMessage, options?: NotificationOptions) =>
      emitNotification('info', message, options, true),
    warning: (message: ToastMessage, options?: NotificationOptions) =>
      emitNotification('warning', message, options, true),
    error: (message: ToastMessage, options?: NotificationOptions) =>
      emitNotification('error', message, options, true),
    message: ((message: ToastMessage, options?: NotificationOptions) =>
      emitVisibleToast(sonnerToast.message, message, options)) as typeof sonnerToast.message,
    loading: ((message: ToastMessage, options?: NotificationOptions) =>
      emitVisibleToast(sonnerToast.loading, message, options)) as typeof sonnerToast.loading,
    custom: ((renderToast: SonnerCustomToastArgs[0], options?: NotificationOptions) =>
      emitVisibleCustomToast(renderToast, options)) as typeof sonnerToast.custom,
    promise: (promiseInput: Promise<unknown> | (() => Promise<unknown>), data?: unknown) => {
      if (!uncategorizedNotificationsEnabled()) {
        return NOTIFICATIONS_DISABLED_RESULT as ReturnType<typeof sonnerToast.promise>;
      }

      return sonnerToast.promise(promiseInput, data as never);
    },
    dismiss: ((toastId?: ToastId) => {
      if (toastId === undefined) {
        clearToastBatch();
        return sonnerToast.dismiss();
      }

      unregisterToastFromBatch(toastId);
      return sonnerToast.dismiss(toastId);
    }) as typeof sonnerToast.dismiss,
    getHistory: sonnerToast.getHistory,
    getToasts: sonnerToast.getToasts,
  }
);

export const notify = {
  info: ((title: string, options?: Omit<InformationalNotificationInput, 'title'>) =>
    emitTemplatedNotification(buildInformationalPayload('info', title, options))) as NotifyInformationalMethod,
  success: ((title: string, options?: Omit<InformationalNotificationInput, 'title'>) =>
    emitTemplatedNotification(buildInformationalPayload('success', title, options))) as NotifyInformationalMethod,
  warning: ((title: string, options?: Omit<InformationalNotificationInput, 'title'>) =>
    emitTemplatedNotification(buildInformationalPayload('warning', title, options))) as NotifyInformationalMethod,
  error: ((title: string, options?: Omit<InformationalNotificationInput, 'title'>) =>
    emitTemplatedNotification(buildInformationalPayload('error', title, options))) as NotifyInformationalMethod,
  actionRequired: ((title: string, options: Omit<ActionableNotificationInput, 'title'>) =>
    emitTemplatedNotification(buildActionablePayload(title, options))) as NotifyActionableMethod,
  dismiss: toast.dismiss,
};

export const __testables = {
  ActionableNotificationToastBody,
  InformationalNotificationToastBody,
  executeNotificationAction,
  getNotificationChannelMode,
  normalizeNotificationActions,
  resolveDesktopNotificationContent,
  toTrackableToastContent,
};
