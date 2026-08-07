import i18n from '../../../i18n';
import { sendDesktopNotificationPreview } from '../../../services/desktopNotifications';
import { notify, type NotificationActionSpec } from '../../ui/toastService';

export type NotificationBlueprintChannel = 'in_app' | 'desktop' | 'all';

export interface NotificationBlueprintEmitResult {
  inAppSent: boolean;
  desktopSent: boolean;
}

export interface InformationalNotificationBlueprintDraft {
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description: string;
}

export interface ActionableNotificationBlueprintDraft {
  tone: 'info' | 'warning' | 'error';
  title: string;
  description: string;
  actions: ActionableNotificationBlueprintActionDraft[];
}

export interface ActionableNotificationBlueprintActionDraft {
  label: string;
  variant: 'primary' | 'secondary';
  dismissOnSuccess: boolean;
}

export interface ActionableNotificationBlueprintPreviewAction {
  label: string;
  variant: 'primary' | 'secondary';
}

export const DEBUG_NOTIFICATION_BLUEPRINT_ACTION_DELAY_MS = 320;

const getPrimaryActionLabel = (): string =>
  i18n.t('settings.notificationsDebug.defaults.actionable.actions.primary', 'Primary action');

const getSecondaryActionLabel = (): string =>
  i18n.t(
    'settings.notificationsDebug.defaults.actionable.actions.secondary',
    'Secondary action'
  );

export const DEFAULT_INFORMATIONAL_NOTIFICATION_BLUEPRINT_DRAFT: InformationalNotificationBlueprintDraft = {
  tone: 'info',
  title: i18n.t(
    'settings.notificationsDebug.defaults.informational.title',
    'Background work finished'
  ),
  description: i18n.t(
    'settings.notificationsDebug.defaults.informational.description',
    'Everything is up to date.'
  ),
};

export const DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT: ActionableNotificationBlueprintDraft = {
  tone: 'warning',
  title: i18n.t(
    'settings.notificationsDebug.defaults.actionable.title',
    'Base branch missing'
  ),
  description: i18n.t(
    'settings.notificationsDebug.defaults.actionable.description',
    'Choose what to do next to continue safely.'
  ),
  actions: [
    {
      label: i18n.t(
        'settings.notificationsDebug.defaults.actionable.actions.create',
        'Create'
      ),
      variant: 'primary',
      dismissOnSuccess: true,
    },
    {
      label: i18n.t(
        'settings.notificationsDebug.defaults.actionable.actions.openSettings',
        'Open settings'
      ),
      variant: 'secondary',
      dismissOnSuccess: true,
    },
  ],
};

const wait = async (durationMs: number): Promise<void> => {
  if (durationMs <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
};

const normalizeActionLabel = (
  value: string,
  fallback: string
): string => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const toDesktopPreviewInput = (
  blueprintId: 'informational' | 'actionable',
  title: string,
  description: string
) => ({
  title,
  body: description.trim().length > 0 ? description : undefined,
  notificationKey: `debug-blueprint:${blueprintId}`,
});

const emitDesktopBlueprintPreview = async (
  blueprintId: 'informational' | 'actionable',
  title: string,
  description: string
): Promise<boolean> =>
  sendDesktopNotificationPreview(
    toDesktopPreviewInput(blueprintId, title, description)
  );

export const simulateNotificationBlueprintAction = async (): Promise<void> => {
  await wait(DEBUG_NOTIFICATION_BLUEPRINT_ACTION_DELAY_MS);
};

export const getActionableNotificationBlueprintPreviewActions = (
  draft: ActionableNotificationBlueprintDraft
): ActionableNotificationBlueprintPreviewAction[] => {
  return draft.actions.slice(0, 2).map((action, index) => ({
    label: normalizeActionLabel(
      action.label,
      index === 0 ? getPrimaryActionLabel() : getSecondaryActionLabel()
    ),
    variant: action.variant === 'secondary' ? 'secondary' : 'primary',
  }));
};

const createActionableNotificationBlueprintActions = (
  draft: ActionableNotificationBlueprintDraft
): NotificationActionSpec[] =>
  draft.actions.slice(0, 2).map((action, index) => ({
    label: normalizeActionLabel(
      action.label,
      index === 0 ? getPrimaryActionLabel() : getSecondaryActionLabel()
    ),
    variant: action.variant === 'secondary' ? 'secondary' : 'primary',
    dismissOnSuccess: action.dismissOnSuccess !== false,
    onClick: async () => {
      await simulateNotificationBlueprintAction();
    },
  }));

export const emitInformationalNotificationBlueprint = async (
  draft: InformationalNotificationBlueprintDraft,
  channel: NotificationBlueprintChannel
): Promise<NotificationBlueprintEmitResult> => {
  let inAppSent = false;
  let desktopSent = false;

  if (channel !== 'desktop') {
    const result =
      draft.tone === 'success'
        ? notify.success(draft.title, {
            description: draft.description || undefined,
          })
        : draft.tone === 'warning'
          ? notify.warning(draft.title, {
              description: draft.description || undefined,
            })
          : draft.tone === 'error'
            ? notify.error(draft.title, {
                description: draft.description || undefined,
              })
            : notify.info(draft.title, {
                description: draft.description || undefined,
              });

    inAppSent = result !== 'notifications-disabled';
  }

  if (channel !== 'in_app') {
    desktopSent = await emitDesktopBlueprintPreview(
      'informational',
      draft.title,
      draft.description
    );
  }

  return {
    inAppSent,
    desktopSent,
  };
};

export const emitActionableNotificationBlueprint = async (
  draft: ActionableNotificationBlueprintDraft,
  channel: NotificationBlueprintChannel
): Promise<NotificationBlueprintEmitResult> => {
  let inAppSent = false;
  const desktopSent = false;

  if (channel !== 'desktop') {
    const result = notify.actionRequired(draft.title, {
      tone: draft.tone,
      description: draft.description || undefined,
      actions: createActionableNotificationBlueprintActions(draft),
    });

    inAppSent = result !== 'notifications-disabled';
  }

  return {
    inAppSent,
    desktopSent,
  };
};
