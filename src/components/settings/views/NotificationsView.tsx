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
  isDesktopNotificationRuntimeSupported,
  initializeDesktopNotifications,
  subscribeDesktopNotificationStatus,
} from '../../../services/desktopNotifications';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_DEFINITIONS,
  getAllowedNotificationChannelModes,
  type NotificationChannelMode,
} from '../../../services/notificationChannels';
import { useAppStore } from '../../../stores/useAppStore';
import { useNotificationCenterStore } from '../../../stores/useNotificationCenterStore';
import { isDevelopmentBuild } from '../../../utils/devLogger';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { ActionableNotificationTemplate } from '../../ui/notifications/ActionableNotificationTemplate';
import { InformationalNotificationTemplate } from '../../ui/notifications/InformationalNotificationTemplate';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { Textarea } from '../../ui/Textarea';
import { SettingsSectionHeader } from '../SettingsSectionHeader';
import {
  DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT,
  DEFAULT_INFORMATIONAL_NOTIFICATION_BLUEPRINT_DRAFT,
  emitActionableNotificationBlueprint,
  emitInformationalNotificationBlueprint,
  getActionableNotificationBlueprintPreviewActions,
  type ActionableNotificationBlueprintActionDraft,
  type ActionableNotificationBlueprintDraft,
  type InformationalNotificationBlueprintDraft,
  type NotificationBlueprintChannel,
  type NotificationBlueprintEmitResult,
} from './notificationDebugCatalog';

const DEBUG_BLUEPRINT_FRAME_CLASS_NAME =
  'flex min-h-[236px] items-center justify-center rounded-2xl border border-border/60 bg-background/80 p-4 shadow-inner';
const DEBUG_PANEL_CLASS_NAME =
  'overflow-hidden rounded-2xl border border-border/60 bg-card/50 shadow-[0_20px_60px_-48px_rgba(0,0,0,0.55)]';
const DEBUG_PANEL_SECTION_CLASS_NAME = 'border-t border-border/50 px-4 py-4 sm:px-5';
const DEBUG_PANEL_FIELD_GROUP_CLASS_NAME =
  'rounded-xl border border-border/50 bg-background/55 p-4';
const DEBUG_PANEL_LABEL_CLASS_NAME =
  'text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground';
const DEBUG_PANEL_ACTION_ROW_CLASS_NAME =
  'grid gap-2 sm:grid-cols-3';
const DEBUG_PANEL_SWITCH_ROW_CLASS_NAME =
  'flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/55 px-3 py-3';

const summarizeBlueprintResult = (
  t: (key: string, fallback: string, options?: Record<string, unknown>) => string,
  label: string,
  channel: NotificationBlueprintChannel,
  result: NotificationBlueprintEmitResult
): string => {
  if (channel === 'in_app') {
    return result.inAppSent
      ? t('settings.notificationsDebug.summary.inAppSent', '{{label}}: in-app preview emitted.', {
          label,
        })
      : t(
          'settings.notificationsDebug.summary.inAppBlocked',
          '{{label}}: in-app preview was blocked by the current notification settings.',
          { label }
        );
  }

  if (channel === 'desktop') {
    return result.desktopSent
      ? t(
          'settings.notificationsDebug.summary.desktopSent',
          '{{label}}: desktop preview sent.',
          { label }
        )
      : t(
          'settings.notificationsDebug.summary.desktopBlocked',
          '{{label}}: desktop preview could not be sent with the current runtime or permission state.',
          { label }
        );
  }

  return t(
    'settings.notificationsDebug.summary.allChannels',
    '{{label}}: in-app {{inAppStatus}}, desktop {{desktopStatus}}.',
    {
      label,
      inAppStatus: result.inAppSent
        ? t('settings.notificationsDebug.summary.ok', 'ok')
        : t('settings.notificationsDebug.summary.blocked', 'blocked'),
      desktopStatus: result.desktopSent
        ? t('settings.notificationsDebug.summary.ok', 'ok')
        : t('settings.notificationsDebug.summary.blocked', 'blocked'),
    }
  );
};

export const NotificationsView: React.FC = () => {
  const { t } = useTranslation();
  const inAppNotificationsEnabled = useAppStore(
    (state) => state.inAppNotificationsEnabled
  );
  const setInAppNotificationsEnabled = useAppStore(
    (state) => state.setInAppNotificationsEnabled
  );
  const notificationChannelModes = useAppStore((state) => state.notificationChannelModes);
  const setNotificationChannelMode = useAppStore((state) => state.setNotificationChannelMode);
  const notificationCenterItems = useNotificationCenterStore((state) => state.items);
  const clearNotificationCenter = useNotificationCenterStore((state) => state.clearAll);
  const desktopNotificationStatus = useSyncExternalStore(
    subscribeDesktopNotificationStatus,
    getDesktopNotificationStatus,
    getDesktopNotificationStatus
  );
  const [pendingDebugActionId, setPendingDebugActionId] = useState<string | null>(null);
  const [debugStatusMessage, setDebugStatusMessage] = useState<string | null>(null);
  const [informationalDraft, setInformationalDraft] =
    useState<InformationalNotificationBlueprintDraft>(() => ({
      ...DEFAULT_INFORMATIONAL_NOTIFICATION_BLUEPRINT_DRAFT,
    }));
  const [actionableDraft, setActionableDraft] =
    useState<ActionableNotificationBlueprintDraft>(() => ({
      ...DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT,
      actions: DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT.actions.map((action) => ({
        ...action,
      })),
    }));

  useEffect(() => {
    void initializeDesktopNotifications();
  }, [t]);

  const desktopRuntimeSupported = isDesktopNotificationRuntimeSupported();
  const desktopDeliveryAvailable =
    desktopRuntimeSupported && desktopNotificationStatus !== 'denied';
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
        allowedModes: getAllowedNotificationChannelModes(category).filter(
          (mode) => desktopDeliveryAvailable || (mode !== 'desktop' && mode !== 'both')
        ),
        displayedMode:
          !desktopDeliveryAvailable &&
          (notificationChannelModes[category] === 'desktop' ||
            notificationChannelModes[category] === 'both')
            ? 'toast'
            : notificationChannelModes[category],
      })),
    [desktopDeliveryAvailable, notificationChannelModes, t]
  );

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

  const updateActionableDraftActionCount = useCallback((actionCount: 1 | 2) => {
    setActionableDraft((current) => {
      if (actionCount === current.actions.length) {
        return current;
      }

      if (actionCount < current.actions.length) {
        return {
          ...current,
          actions: current.actions.slice(0, actionCount),
        };
      }

      const nextActions = [...current.actions];
      const defaultAction =
        DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT.actions[nextActions.length] ?? {
          label:
            nextActions.length === 0
              ? t(
                  'settings.notificationsDebug.defaults.actionable.actions.primary',
                  'Primary action'
                )
              : t(
                  'settings.notificationsDebug.defaults.actionable.actions.secondary',
                  'Secondary action'
                ),
          variant: nextActions.length === 0 ? 'primary' : 'secondary',
          dismissOnSuccess: true,
        };

      nextActions.push({ ...defaultAction });

      return {
        ...current,
        actions: nextActions,
      };
    });
  }, [t]);

  const updateActionableDraftAction = useCallback(
    (
      actionIndex: number,
      patch: Partial<ActionableNotificationBlueprintActionDraft>
    ) => {
      setActionableDraft((current) => ({
        ...current,
        actions: current.actions.map((action, index) =>
          index === actionIndex
            ? {
                ...action,
                ...patch,
              }
            : action
        ),
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
        return summarizeBlueprintResult(
          t,
          t(
            'settings.notificationsDebug.labels.informational',
            'Informational blueprint'
          ),
          channel,
          result
        );
      });
    },
    [informationalDraft, runDebugAction, t]
  );

  const handleActionableBlueprintEmit = useCallback(
    async (channel: NotificationBlueprintChannel) => {
      await runDebugAction(`actionable:${channel}`, async () => {
        const result = await emitActionableNotificationBlueprint(
          actionableDraft,
          channel
        );
        return summarizeBlueprintResult(
          t,
          t('settings.notificationsDebug.labels.actionable', 'Actionable blueprint'),
          channel,
          result
        );
      });
    },
    [actionableDraft, runDebugAction, t]
  );

  const handleClearNotificationCenter = useCallback(async () => {
    await runDebugAction('clear:center', async () => {
      if (typeof clearNotificationCenter === 'function') {
        clearNotificationCenter();
      } else {
        useNotificationCenterStore.setState({ items: [] });
      }
      return t(
        'settings.notificationsDebug.clearCenterResult',
        'Notification center cleared.'
      );
    });
  }, [clearNotificationCenter, runDebugAction, t]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <section className="space-y-4">
        <SettingsSectionHeader title={t('settings.notificationsDelivery', 'Delivery')} />

        <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="in-app-notifications" className="text-sm font-medium text-foreground">
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
              id="in-app-notifications"
              checked={inAppNotificationsEnabled}
              aria-label={t('settings.inAppNotifications', 'In-app Notifications')}
              onCheckedChange={setInAppNotificationsEnabled}
            />
          </div>

          <div className="h-px bg-border/50" />

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">
              {t('settings.notificationChannels', 'Notification channels')}
            </label>
            <p className="text-xs text-muted-foreground">
                {t(
                  desktopRuntimeSupported
                    ? 'settings.notificationChannelsDesc'
                    : 'settings.notificationChannelsUnsupportedDesc',
                  desktopRuntimeSupported
                    ? 'Choose how each important workflow event should be delivered: toast, desktop, both, or off.'
                    : 'Desktop delivery is unavailable in this runtime. Choose in-app toast or off.'
                )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('settings.desktopNotificationsRuntime', 'Runtime status')}:{' '}
              <span className={desktopRuntimeToneClass}>{desktopRuntimeLabel}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                desktopRuntimeSupported
                  ? 'settings.desktopNotificationsPermissionHint'
                  : 'settings.desktopNotificationsUnsupportedHint',
                desktopRuntimeSupported
                  ? 'Macro asks for desktop notification permission the first time an eligible background notification is sent.'
                  : 'Desktop notifications are unavailable in this runtime. Notification delivery falls back to in-app toasts.'
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
                    value={row.displayedMode}
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
          <SettingsSectionHeader title={t('settings.notificationsDebug.sectionTitle', 'Debug')} />

          <div className={DEBUG_PANEL_CLASS_NAME}>
            <div className="flex flex-col gap-4 px-4 py-4 sm:px-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1 space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  {t('settings.notificationsDebug.title', 'Notification blueprints')}
                </label>
                <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                  {t(
                    'settings.notificationsDebug.description',
                    'Use this debug-only panel to tune the two shared notification blueprints used across Macro.'
                  )}
                </p>
                <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                  {t(
                    'settings.notificationsDebug.desktopHint',
                    'Desktop previews are a best-effort smoke test. On macOS, previews may not appear while Macro is in the foreground; the reliable path is desktop notifications when the app is in the background.'
                  )}
                </p>
              </div>

              <div className="flex w-full shrink-0 flex-col gap-3 lg:w-[280px]">
                <div className="rounded-xl border border-border/50 bg-background/60 px-3 py-3">
                  <div className={DEBUG_PANEL_LABEL_CLASS_NAME}>
                    {t(
                      'settings.notificationsDebug.runtimeStatus',
                      'Current desktop runtime status'
                    )}
                  </div>
                  <div className="mt-1 text-sm font-medium text-foreground">
                    <span className={desktopRuntimeToneClass}>{desktopRuntimeLabel}</span>
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="ghost"
                  className="justify-center"
                  isLoading={pendingDebugActionId === 'clear:center'}
                  disabled={pendingDebugActionId !== null}
                  onClick={() => void handleClearNotificationCenter()}
                >
                  {t('settings.notificationsDebug.clearCenter', 'Clear center ({{count}})', {
                    count: notificationCenterItems.length,
                  })}
                </Button>
              </div>
            </div>

            {debugStatusMessage && (
              <div className="border-t border-border/50 px-4 py-3 sm:px-5">
                <div className="rounded-xl border border-border/50 bg-background/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {debugStatusMessage}
                </div>
              </div>
            )}

            <div className="border-t border-border/50 px-4 py-4 sm:px-5">
              <div className="grid gap-4 xl:grid-cols-2">
              <div
                className="flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/45 shadow-[0_16px_40px_-36px_rgba(0,0,0,0.45)]"
                data-testid="notification-blueprint-panel-informational"
              >
                <div className="px-4 py-4 sm:px-5">
                  <div className="text-sm font-medium text-foreground">
                    {t(
                      'settings.notificationsDebug.labels.informational',
                      'Informational blueprint'
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t(
                      'settings.notificationsDebug.informationalDescription',
                      'Preview the shared non-actionable notification template across info, success, warning, and error tones.'
                    )}
                  </p>
                </div>

                <div className={DEBUG_PANEL_SECTION_CLASS_NAME}>
                  <div
                    className={DEBUG_BLUEPRINT_FRAME_CLASS_NAME}
                    data-testid="notification-blueprint-frame"
                  >
                    <InformationalNotificationTemplate
                      tone={informationalDraft.tone}
                      title={informationalDraft.title}
                      description={informationalDraft.description || undefined}
                      className="w-full max-w-[440px]"
                    />
                  </div>
                </div>

                <div className={DEBUG_PANEL_SECTION_CLASS_NAME}>
                  <div className={DEBUG_PANEL_FIELD_GROUP_CLASS_NAME}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="informational-blueprint-tone"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t('settings.notificationsDebug.fields.tone', 'Tone')}
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
                          <option value="info">
                            {t('settings.notificationsDebug.tones.info', 'info')}
                          </option>
                          <option value="success">
                            {t('settings.notificationsDebug.tones.success', 'success')}
                          </option>
                          <option value="warning">
                            {t('settings.notificationsDebug.tones.warning', 'warning')}
                          </option>
                          <option value="error">
                            {t('settings.notificationsDebug.tones.error', 'error')}
                          </option>
                        </Select>
                      </div>

                      <div className="space-y-1.5 sm:col-span-2">
                        <label
                          htmlFor="informational-blueprint-title"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t('settings.notificationsDebug.fields.title', 'Title')}
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

                      <div className="space-y-1.5 sm:col-span-2">
                        <label
                          htmlFor="informational-blueprint-description"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t(
                            'settings.notificationsDebug.fields.description',
                            'Description'
                          )}
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
                  </div>
                </div>

                <div className={DEBUG_PANEL_SECTION_CLASS_NAME}>
                  <div className={DEBUG_PANEL_ACTION_ROW_CLASS_NAME}>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full"
                      data-testid="informational-blueprint-in-app"
                      isLoading={pendingDebugActionId === 'informational:in_app'}
                      disabled={pendingDebugActionId !== null}
                      onClick={() => void handleInformationalBlueprintEmit('in_app')}
                    >
                      {t('settings.notificationsDebug.channels.inApp', 'In-app')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full"
                      data-testid="informational-blueprint-desktop"
                      isLoading={pendingDebugActionId === 'informational:desktop'}
                      disabled={pendingDebugActionId !== null}
                      onClick={() => void handleInformationalBlueprintEmit('desktop')}
                    >
                      {t('settings.notificationsDebug.channels.desktop', 'Desktop')}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      className="w-full"
                      data-testid="informational-blueprint-all"
                      isLoading={pendingDebugActionId === 'informational:all'}
                      disabled={pendingDebugActionId !== null}
                      onClick={() => void handleInformationalBlueprintEmit('all')}
                    >
                      {t(
                        'settings.notificationsDebug.channels.allChannels',
                        'All channels'
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              <div
                className="flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/45 shadow-[0_16px_40px_-36px_rgba(0,0,0,0.45)]"
                data-testid="notification-blueprint-panel-actionable"
              >
                <div className="px-4 py-4 sm:px-5">
                  <div className="text-sm font-medium text-foreground">
                    {t(
                      'settings.notificationsDebug.labels.actionable',
                      'Actionable blueprint'
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t(
                      'settings.notificationsDebug.actionableDescription',
                      'Preview the shared actionable template with one or two simulated actions and matching tones.'
                    )}
                  </p>
                </div>

                <div className={DEBUG_PANEL_SECTION_CLASS_NAME}>
                  <div
                    className={DEBUG_BLUEPRINT_FRAME_CLASS_NAME}
                    data-testid="notification-blueprint-frame"
                  >
                    <ActionableNotificationTemplate
                      tone={actionableDraft.tone}
                      title={actionableDraft.title}
                      description={actionableDraft.description || undefined}
                      actions={actionablePreviewActions}
                      actionsDisabled
                      className="w-full max-w-[440px]"
                    />
                  </div>
                </div>

                <div className={DEBUG_PANEL_SECTION_CLASS_NAME}>
                  <div className={DEBUG_PANEL_FIELD_GROUP_CLASS_NAME}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="actionable-blueprint-tone"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t('settings.notificationsDebug.fields.tone', 'Tone')}
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
                          <option value="info">
                            {t('settings.notificationsDebug.tones.info', 'info')}
                          </option>
                          <option value="warning">
                            {t('settings.notificationsDebug.tones.warning', 'warning')}
                          </option>
                          <option value="error">
                            {t('settings.notificationsDebug.tones.error', 'error')}
                          </option>
                        </Select>
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="actionable-blueprint-action-count"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t('settings.notificationsDebug.fields.actions', 'Actions')}
                        </label>
                        <Select
                          id="actionable-blueprint-action-count"
                          data-testid="actionable-blueprint-action-count"
                          value={String(actionableDraft.actions.length)}
                          onChange={(event) =>
                            updateActionableDraftActionCount(
                              event.target.value === '2' ? 2 : 1
                            )
                          }
                          onInput={(event) =>
                            updateActionableDraftActionCount(
                              (event.target as HTMLSelectElement).value === '2' ? 2 : 1
                            )
                          }
                        >
                          <option value="1">1</option>
                          <option value="2">2</option>
                        </Select>
                      </div>

                      <div className="space-y-1.5 sm:col-span-2">
                        <label
                          htmlFor="actionable-blueprint-title"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t('settings.notificationsDebug.fields.title', 'Title')}
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

                      <div className="space-y-1.5 sm:col-span-2">
                        <label
                          htmlFor="actionable-blueprint-description"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t(
                            'settings.notificationsDebug.fields.description',
                            'Description'
                          )}
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

                      <div className="space-y-1.5">
                        <label
                          htmlFor="actionable-blueprint-primary-action"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t(
                            'settings.notificationsDebug.fields.primaryAction',
                            'Primary action'
                          )}
                        </label>
                        <Input
                          id="actionable-blueprint-primary-action"
                          data-testid="actionable-blueprint-primary-action"
                          value={actionableDraft.actions[0]?.label ?? ''}
                          onChange={(event) =>
                            updateActionableDraftAction(0, { label: event.target.value })
                          }
                          onInput={(event) =>
                            updateActionableDraftAction(0, {
                              label: (event.target as HTMLInputElement).value,
                            })
                          }
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="actionable-blueprint-primary-variant"
                          className={DEBUG_PANEL_LABEL_CLASS_NAME}
                        >
                          {t(
                            'settings.notificationsDebug.fields.primaryVariant',
                            'Primary variant'
                          )}
                        </label>
                        <Select
                          id="actionable-blueprint-primary-variant"
                          data-testid="actionable-blueprint-primary-variant"
                          value={actionableDraft.actions[0]?.variant ?? 'primary'}
                          onChange={(event) =>
                            updateActionableDraftAction(0, {
                              variant:
                                event.target.value === 'secondary' ? 'secondary' : 'primary',
                            })
                          }
                          onInput={(event) =>
                            updateActionableDraftAction(0, {
                              variant:
                                (event.target as HTMLSelectElement).value === 'secondary'
                                  ? 'secondary'
                                  : 'primary',
                            })
                          }
                        >
                          <option value="primary">
                            {t('settings.notificationsDebug.variants.primary', 'primary')}
                          </option>
                          <option value="secondary">
                            {t(
                              'settings.notificationsDebug.variants.secondary',
                              'secondary'
                            )}
                          </option>
                        </Select>
                      </div>

                      <div
                        className={`${DEBUG_PANEL_SWITCH_ROW_CLASS_NAME} sm:col-span-2`}
                      >
                        <div className="space-y-0.5">
                          <div className={DEBUG_PANEL_LABEL_CLASS_NAME}>
                            {t(
                              'settings.notificationsDebug.fields.primaryDismissOnSuccess',
                              'Primary dismiss on success'
                            )}
                          </div>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {t(
                              'settings.notificationsDebug.fields.primaryDismissDescription',
                              'Close the toast and remove the center item after a successful primary action.'
                            )}
                          </p>
                        </div>
                        <Switch
                          checked={actionableDraft.actions[0]?.dismissOnSuccess !== false}
                          aria-label={t(
                            'settings.notificationsDebug.fields.primaryDismissOnSuccess',
                            'Primary dismiss on success'
                          )}
                          onCheckedChange={(checked) =>
                            updateActionableDraftAction(0, { dismissOnSuccess: checked })
                          }
                        />
                      </div>

                      {actionableDraft.actions.length === 2 && (
                        <>
                          <div className="space-y-1.5">
                            <label
                              htmlFor="actionable-blueprint-secondary-action"
                              className={DEBUG_PANEL_LABEL_CLASS_NAME}
                            >
                              {t(
                                'settings.notificationsDebug.fields.secondaryAction',
                                'Secondary action'
                              )}
                            </label>
                            <Input
                              id="actionable-blueprint-secondary-action"
                              data-testid="actionable-blueprint-secondary-action"
                              value={actionableDraft.actions[1]?.label ?? ''}
                              onChange={(event) =>
                                updateActionableDraftAction(1, { label: event.target.value })
                              }
                              onInput={(event) =>
                                updateActionableDraftAction(1, {
                                  label: (event.target as HTMLInputElement).value,
                                })
                              }
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label
                              htmlFor="actionable-blueprint-secondary-variant"
                              className={DEBUG_PANEL_LABEL_CLASS_NAME}
                            >
                              {t(
                                'settings.notificationsDebug.fields.secondaryVariant',
                                'Secondary variant'
                              )}
                            </label>
                            <Select
                              id="actionable-blueprint-secondary-variant"
                              data-testid="actionable-blueprint-secondary-variant"
                              value={actionableDraft.actions[1]?.variant ?? 'secondary'}
                              onChange={(event) =>
                                updateActionableDraftAction(1, {
                                  variant:
                                    event.target.value === 'secondary'
                                      ? 'secondary'
                                      : 'primary',
                                })
                              }
                              onInput={(event) =>
                                updateActionableDraftAction(1, {
                                  variant:
                                    (event.target as HTMLSelectElement).value === 'secondary'
                                      ? 'secondary'
                                      : 'primary',
                                })
                              }
                            >
                              <option value="primary">
                                {t('settings.notificationsDebug.variants.primary', 'primary')}
                              </option>
                              <option value="secondary">
                                {t(
                                  'settings.notificationsDebug.variants.secondary',
                                  'secondary'
                                )}
                              </option>
                            </Select>
                          </div>

                          <div
                            className={`${DEBUG_PANEL_SWITCH_ROW_CLASS_NAME} sm:col-span-2`}
                          >
                            <div className="space-y-0.5">
                              <div className={DEBUG_PANEL_LABEL_CLASS_NAME}>
                                {t(
                                  'settings.notificationsDebug.fields.secondaryDismissOnSuccess',
                                  'Secondary dismiss on success'
                                )}
                              </div>
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                {t(
                                  'settings.notificationsDebug.fields.secondaryDismissDescription',
                                  'Close the toast and remove the center item after a successful secondary action.'
                                )}
                              </p>
                            </div>
                            <Switch
                              checked={actionableDraft.actions[1]?.dismissOnSuccess !== false}
                              aria-label={t(
                                'settings.notificationsDebug.fields.secondaryDismissOnSuccess',
                                'Secondary dismiss on success'
                              )}
                              onCheckedChange={(checked) =>
                                updateActionableDraftAction(1, { dismissOnSuccess: checked })
                              }
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className={DEBUG_PANEL_SECTION_CLASS_NAME}>
                  <p className="rounded-xl border border-dashed border-border/60 bg-background/40 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                    {t(
                      'settings.notificationsDebug.actionableDesktopHint',
                      "Actionable blueprints are validated in-app only. Desktop notifications do not render Macro's custom buttons."
                    )}
                  </p>
                </div>

                <div className={DEBUG_PANEL_SECTION_CLASS_NAME}>
                  <div className={DEBUG_PANEL_ACTION_ROW_CLASS_NAME}>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full"
                      data-testid="actionable-blueprint-in-app"
                      isLoading={pendingDebugActionId === 'actionable:in_app'}
                      disabled={pendingDebugActionId !== null}
                      onClick={() => void handleActionableBlueprintEmit('in_app')}
                    >
                      {t('settings.notificationsDebug.channels.inApp', 'In-app')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full"
                      data-testid="actionable-blueprint-desktop"
                      disabled
                    >
                      {t('settings.notificationsDebug.channels.desktop', 'Desktop')}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      className="w-full"
                      data-testid="actionable-blueprint-all"
                      disabled
                    >
                      {t(
                        'settings.notificationsDebug.channels.allChannels',
                        'All channels'
                      )}
                    </Button>
                  </div>
                </div>
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
