import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  getDesktopNotificationStatus,
  initializeDesktopNotifications,
  subscribeDesktopNotificationStatus,
} from '../../../services/desktopNotifications';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_DEFINITIONS,
  getAllowedNotificationChannelModes,
  type NotificationChannelMode,
} from '../../../services/notificationChannels';
import { useAuthStore } from '../../../stores/useAuthStore';
import { useAppStore } from '../../../stores/useAppStore';
import { useNotificationCenterStore } from '../../../stores/useNotificationCenterStore';
import { isDevelopmentBuild } from '../../../utils/devLogger';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import {
  ActionableNotificationTemplate,
  InformationalNotificationTemplate,
} from '../../ui/notifications';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { Textarea } from '../../ui/Textarea';
import { notify } from '../../ui/toastService';
import {
  DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT,
  DEFAULT_INFORMATIONAL_NOTIFICATION_BLUEPRINT_DRAFT,
  emitActionableNotificationBlueprint,
  emitInformationalNotificationBlueprint,
  getActionableNotificationBlueprintPreviewActions,
  simulateNotificationBlueprintAction,
  type ActionableNotificationBlueprintDraft,
  type InformationalNotificationBlueprintDraft,
  type NotificationBlueprintChannel,
  type NotificationBlueprintEmitResult,
} from './notificationDebugCatalog';

const DEBUG_BLUEPRINT_FRAME_CLASS_NAME =
  'flex min-h-[220px] items-start rounded-xl border border-border/60 bg-background/60 p-4';

const summarizeBlueprintResult = (
  label: string,
  channel: NotificationBlueprintChannel,
  result: NotificationBlueprintEmitResult
): string => {
  if (channel === 'in_app') {
    return result.inAppSent
      ? `${label}: in-app preview emitted.`
      : `${label}: in-app preview was blocked by the current notification settings.`;
  }

  if (channel === 'desktop') {
    return result.desktopSent
      ? `${label}: desktop preview sent.`
      : `${label}: desktop preview could not be sent with the current runtime or permission state.`;
  }

  return `${label}: in-app ${result.inAppSent ? 'ok' : 'blocked'}, desktop ${
    result.desktopSent ? 'ok' : 'blocked'
  }.`;
};

export const NotificationsView: React.FC = () => {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const updatePreferences = useAuthStore((state) => state.updatePreferences);
  const notificationChannelModes = useAppStore((state) => state.notificationChannelModes);
  const setNotificationChannelMode = useAppStore((state) => state.setNotificationChannelMode);
  const notificationCenterItems = useNotificationCenterStore((state) => state.items);
  const clearNotificationCenter = useNotificationCenterStore((state) => state.clearAll);
  const desktopNotificationStatus = useSyncExternalStore(
    subscribeDesktopNotificationStatus,
    getDesktopNotificationStatus,
    getDesktopNotificationStatus
  );
  const [isUpdatingInAppNotifications, setIsUpdatingInAppNotifications] = useState(false);
  const [pendingDebugActionId, setPendingDebugActionId] = useState<string | null>(null);
  const [debugStatusMessage, setDebugStatusMessage] = useState<string | null>(null);
  const [informationalDraft, setInformationalDraft] =
    useState<InformationalNotificationBlueprintDraft>(() => ({
      ...DEFAULT_INFORMATIONAL_NOTIFICATION_BLUEPRINT_DRAFT,
    }));
  const [actionableDraft, setActionableDraft] =
    useState<ActionableNotificationBlueprintDraft>(() => ({
      ...DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT,
    }));
  const [actionablePreviewPendingActionIndex, setActionablePreviewPendingActionIndex] =
    useState<number | null>(null);

  useEffect(() => {
    void initializeDesktopNotifications();
  }, []);

  const inAppNotificationsEnabled = user?.preferences.notifications !== false;
  const desktopRuntimeLabel = desktopNotificationStatus === 'granted'
    ? t('settings.desktopNotificationsStatusAllowed', 'Allowed')
    : desktopNotificationStatus === 'denied'
      ? t('settings.desktopNotificationsStatusDenied', 'Denied')
      : desktopNotificationStatus === 'unsupported'
        ? t('settings.desktopNotificationsStatusUnsupported', 'Unsupported')
        : t('settings.desktopNotificationsStatusPermissionNeeded', 'Permission needed');

  const desktopRuntimeToneClass = desktopNotificationStatus === 'granted'
    ? 'text-emerald-400'
    : desktopNotificationStatus === 'denied'
      ? 'text-red-400'
      : desktopNotificationStatus === 'unsupported'
        ? 'text-amber-400'
        : 'text-blue-400';

  const categoryRows = useMemo(
    () =>
      NOTIFICATION_CATEGORIES.map((category) => ({
        category,
        title: t(NOTIFICATION_CATEGORY_DEFINITIONS[category].titleKey),
        description: t(NOTIFICATION_CATEGORY_DEFINITIONS[category].descriptionKey),
        mode: notificationChannelModes[category],
        allowedModes: getAllowedNotificationChannelModes(category),
      })),
    [notificationChannelModes, t]
  );

  const handleInAppNotificationsChange = async (checked: boolean) => {
    if (!user) {
      return;
    }

    setIsUpdatingInAppNotifications(true);
    try {
      await updatePreferences({ notifications: checked });
    } catch (error) {
      notify.error(
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

  const runDebugAction = useCallback(
    async (actionId: string, work: () => Promise<string>) => {
      if (pendingDebugActionId) {
        return;
      }

      setPendingDebugActionId(actionId);
      try {
        setDebugStatusMessage(await work());
      } finally {
        setPendingDebugActionId(null);
      }
    },
    [pendingDebugActionId]
  );

  const actionablePreviewActions = useMemo(
    () => getActionableNotificationBlueprintPreviewActions(actionableDraft),
    [actionableDraft]
  );

  const updateInformationalDraft = useCallback(
    (patch: Partial<InformationalNotificationBlueprintDraft>) => {
      setInformationalDraft((current) => ({
        ...current,
        ...patch,
      }));
    },
    []
  );

  const updateActionableDraft = useCallback(
    (patch: Partial<ActionableNotificationBlueprintDraft>) => {
      setActionableDraft((current) => ({
        ...current,
        ...patch,
      }));
    },
    []
  );

  const handleInformationalBlueprintEmit = useCallback(
    async (channel: NotificationBlueprintChannel) => {
      await runDebugAction(`informational:${channel}`, async () => {
        const result = await emitInformationalNotificationBlueprint(
          informationalDraft,
          channel
        );
        return summarizeBlueprintResult('Informational blueprint', channel, result);
      });
    },
    [informationalDraft, runDebugAction]
  );

  const handleActionableBlueprintEmit = useCallback(
    async (channel: NotificationBlueprintChannel) => {
      await runDebugAction(`actionable:${channel}`, async () => {
        const result = await emitActionableNotificationBlueprint(
          actionableDraft,
          channel
        );
        return summarizeBlueprintResult('Actionable blueprint', channel, result);
      });
    },
    [actionableDraft, runDebugAction]
  );

  const handleActionablePreviewAction = useCallback(
    (index: number) => {
      if (actionablePreviewPendingActionIndex !== null) {
        return;
      }

      setActionablePreviewPendingActionIndex(index);
      void simulateNotificationBlueprintAction().finally(() => {
        setActionablePreviewPendingActionIndex(null);
      });
    },
    [actionablePreviewPendingActionIndex]
  );

  const handleClearNotificationCenter = useCallback(async () => {
    await runDebugAction('clear:center', async () => {
      clearNotificationCenter();
      return 'Notification center cleared.';
    });
  }, [clearNotificationCenter, runDebugAction]);

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
                  'settings.inAppNotificationsScopedDesc',
                  'Control uncategorized in-app notifications that are not covered by the channel rules below.'
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

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">
              {t('settings.notificationChannels', 'Notification channels')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.notificationChannelsDesc',
                'Choose how each important workflow event should be delivered: toast, desktop, both, or off.'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('settings.desktopNotificationsRuntime', 'Runtime status')}:{' '}
              <span className={desktopRuntimeToneClass}>{desktopRuntimeLabel}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.desktopNotificationsPermissionHint',
                'Macro asks for desktop notification permission the first time an eligible background notification is sent.'
              )}
            </p>
          </div>

          <div className="space-y-3 pt-2">
            {categoryRows.map((row) => (
              <div
                key={row.category}
                className="flex items-start justify-between gap-4 rounded-lg border border-border/50 bg-background/40 px-3 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-sm font-medium text-foreground">
                    {row.title}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.description}
                  </p>
                </div>
                <div className="w-40 shrink-0">
                  <Select
                    value={row.mode}
                    onChange={(event) =>
                      setNotificationChannelMode(
                        row.category,
                        event.target.value as NotificationChannelMode
                      )
                    }
                    className="h-9 py-1.5"
                  >
                    {row.allowedModes.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`settings.notificationChannelMode.${mode}`)}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {isDevelopmentBuild && (
        <section className="space-y-4" data-testid="notifications-debug-section">
          <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
            Debug
          </h4>

          <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">
                Notification blueprints
              </label>
              <p className="text-xs text-muted-foreground">
                Use this debug-only panel to tune the two shared notification blueprints used across Macro.
              </p>
              <p className="text-xs text-muted-foreground">
                Desktop previews bypass the usual foreground restriction so you can validate OS notifications without backgrounding the app.
              </p>
              <p className="text-xs text-muted-foreground">
                Current desktop runtime status:{' '}
                <span className={desktopRuntimeToneClass}>{desktopRuntimeLabel}</span>
              </p>
            </div>

            {debugStatusMessage && (
              <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
                {debugStatusMessage}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                isLoading={pendingDebugActionId === 'clear:center'}
                disabled={pendingDebugActionId !== null}
                onClick={() => void handleClearNotificationCenter()}
              >
                Clear center ({notificationCenterItems.length})
              </Button>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <div
                className="grid gap-4 rounded-xl border border-border/50 bg-background/40 p-4"
                data-testid="notification-blueprint-panel-informational"
              >
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">
                    Informational blueprint
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Preview the shared non-actionable notification template across info, success, warning, and error tones.
                  </p>
                </div>

                <div
                  className={DEBUG_BLUEPRINT_FRAME_CLASS_NAME}
                  data-testid="notification-blueprint-frame"
                >
                  <InformationalNotificationTemplate
                    tone={informationalDraft.tone}
                    title={informationalDraft.title}
                    description={informationalDraft.description || undefined}
                    className="w-full"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label
                      htmlFor="informational-blueprint-tone"
                      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Tone
                    </label>
                    <Select
                      id="informational-blueprint-tone"
                      data-testid="informational-blueprint-tone"
                      value={informationalDraft.tone}
                      onChange={(event) =>
                        updateInformationalDraft({
                          tone: event.target.value as InformationalNotificationBlueprintDraft['tone'],
                        })
                      }
                      onInput={(event) =>
                        updateInformationalDraft({
                          tone: (event.target as HTMLSelectElement).value as InformationalNotificationBlueprintDraft['tone'],
                        })
                      }
                    >
                      <option value="info">info</option>
                      <option value="success">success</option>
                      <option value="warning">warning</option>
                      <option value="error">error</option>
                    </Select>
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <label
                      htmlFor="informational-blueprint-title"
                      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Title
                    </label>
                    <Input
                      id="informational-blueprint-title"
                      data-testid="informational-blueprint-title"
                      value={informationalDraft.title}
                      onChange={(event) =>
                        updateInformationalDraft({ title: event.target.value })
                      }
                      onInput={(event) =>
                        updateInformationalDraft({
                          title: (event.target as HTMLInputElement).value,
                        })
                      }
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <label
                      htmlFor="informational-blueprint-description"
                      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Description
                    </label>
                    <Textarea
                      id="informational-blueprint-description"
                      data-testid="informational-blueprint-description"
                      rows={3}
                      value={informationalDraft.description}
                      onChange={(event) =>
                        updateInformationalDraft({ description: event.target.value })
                      }
                      onInput={(event) =>
                        updateInformationalDraft({
                          description: (event.target as HTMLTextAreaElement).value,
                        })
                      }
                      className="resize-y border-border/50 focus:border-primary focus:ring-primary"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="informational-blueprint-in-app"
                    isLoading={pendingDebugActionId === 'informational:in_app'}
                    disabled={pendingDebugActionId !== null}
                    onClick={() => void handleInformationalBlueprintEmit('in_app')}
                  >
                    In-app
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="informational-blueprint-desktop"
                    isLoading={pendingDebugActionId === 'informational:desktop'}
                    disabled={pendingDebugActionId !== null}
                    onClick={() => void handleInformationalBlueprintEmit('desktop')}
                  >
                    Desktop
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    data-testid="informational-blueprint-all"
                    isLoading={pendingDebugActionId === 'informational:all'}
                    disabled={pendingDebugActionId !== null}
                    onClick={() => void handleInformationalBlueprintEmit('all')}
                  >
                    All channels
                  </Button>
                </div>
              </div>

              <div
                className="grid gap-4 rounded-xl border border-border/50 bg-background/40 p-4"
                data-testid="notification-blueprint-panel-actionable"
              >
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">
                    Actionable blueprint
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Preview the shared actionable template with one or two simulated actions and matching tones.
                  </p>
                </div>

                <div
                  className={DEBUG_BLUEPRINT_FRAME_CLASS_NAME}
                  data-testid="notification-blueprint-frame"
                >
                  <ActionableNotificationTemplate
                    tone={actionableDraft.tone}
                    title={actionableDraft.title}
                    description={actionableDraft.description || undefined}
                    actions={actionablePreviewActions}
                    pendingActionIndex={actionablePreviewPendingActionIndex}
                    onActionClick={handleActionablePreviewAction}
                    className="w-full"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label
                      htmlFor="actionable-blueprint-tone"
                      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Tone
                    </label>
                    <Select
                      id="actionable-blueprint-tone"
                      data-testid="actionable-blueprint-tone"
                      value={actionableDraft.tone}
                      onChange={(event) =>
                        updateActionableDraft({
                          tone: event.target.value as ActionableNotificationBlueprintDraft['tone'],
                        })
                      }
                      onInput={(event) =>
                        updateActionableDraft({
                          tone: (event.target as HTMLSelectElement).value as ActionableNotificationBlueprintDraft['tone'],
                        })
                      }
                    >
                      <option value="info">info</option>
                      <option value="warning">warning</option>
                      <option value="error">error</option>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="actionable-blueprint-action-count"
                      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Actions
                    </label>
                    <Select
                      id="actionable-blueprint-action-count"
                      data-testid="actionable-blueprint-action-count"
                      value={String(actionableDraft.actionCount)}
                      onChange={(event) =>
                        updateActionableDraft({
                          actionCount: event.target.value === '2' ? 2 : 1,
                        })
                      }
                      onInput={(event) =>
                        updateActionableDraft({
                          actionCount:
                            (event.target as HTMLSelectElement).value === '2' ? 2 : 1,
                        })
                      }
                    >
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </Select>
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <label
                      htmlFor="actionable-blueprint-title"
                      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Title
                    </label>
                    <Input
                      id="actionable-blueprint-title"
                      data-testid="actionable-blueprint-title"
                      value={actionableDraft.title}
                      onChange={(event) =>
                        updateActionableDraft({ title: event.target.value })
                      }
                      onInput={(event) =>
                        updateActionableDraft({
                          title: (event.target as HTMLInputElement).value,
                        })
                      }
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <label
                      htmlFor="actionable-blueprint-description"
                      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Description
                    </label>
                    <Textarea
                      id="actionable-blueprint-description"
                      data-testid="actionable-blueprint-description"
                      rows={3}
                      value={actionableDraft.description}
                      onChange={(event) =>
                        updateActionableDraft({ description: event.target.value })
                      }
                      onInput={(event) =>
                        updateActionableDraft({
                          description: (event.target as HTMLTextAreaElement).value,
                        })
                      }
                      className="resize-y border-border/50 focus:border-primary focus:ring-primary"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="actionable-blueprint-primary-action"
                      className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Primary action
                    </label>
                    <Input
                      id="actionable-blueprint-primary-action"
                      data-testid="actionable-blueprint-primary-action"
                      value={actionableDraft.primaryActionLabel}
                      onChange={(event) =>
                        updateActionableDraft({
                          primaryActionLabel: event.target.value,
                        })
                      }
                      onInput={(event) =>
                        updateActionableDraft({
                          primaryActionLabel: (event.target as HTMLInputElement).value,
                        })
                      }
                    />
                  </div>

                  {actionableDraft.actionCount === 2 && (
                    <div className="space-y-1">
                      <label
                        htmlFor="actionable-blueprint-secondary-action"
                        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                      >
                        Secondary action
                      </label>
                      <Input
                        id="actionable-blueprint-secondary-action"
                        data-testid="actionable-blueprint-secondary-action"
                        value={actionableDraft.secondaryActionLabel}
                        onChange={(event) =>
                          updateActionableDraft({
                            secondaryActionLabel: event.target.value,
                          })
                        }
                        onInput={(event) =>
                          updateActionableDraft({
                            secondaryActionLabel: (event.target as HTMLInputElement).value,
                          })
                        }
                      />
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="actionable-blueprint-in-app"
                    isLoading={pendingDebugActionId === 'actionable:in_app'}
                    disabled={pendingDebugActionId !== null}
                    onClick={() => void handleActionableBlueprintEmit('in_app')}
                  >
                    In-app
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="actionable-blueprint-desktop"
                    isLoading={pendingDebugActionId === 'actionable:desktop'}
                    disabled={pendingDebugActionId !== null}
                    onClick={() => void handleActionableBlueprintEmit('desktop')}
                  >
                    Desktop
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    data-testid="actionable-blueprint-all"
                    isLoading={pendingDebugActionId === 'actionable:all'}
                    disabled={pendingDebugActionId !== null}
                    onClick={() => void handleActionableBlueprintEmit('all')}
                  >
                    All channels
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default NotificationsView;
