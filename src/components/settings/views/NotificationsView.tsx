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
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { toast } from '../../ui/toastService';
import {
  DEBUG_NOTIFICATION_PREVIEWS,
  emitAllDebugNotificationPreviews,
  emitDebugNotificationPreview,
  type DebugNotificationBatchResult,
  type DebugNotificationEmitResult,
  type DebugNotificationPreview,
  type DebugNotificationPreviewChannel,
} from './notificationDebugCatalog';

const formatPreviewToken = (value: string): string =>
  value.replace(/_/g, ' ');

const getPreviewToneClasses = (preview: DebugNotificationPreview): string => {
  if (preview.level === 'error') {
    return 'border-red-500/30 bg-red-500/10 text-red-200';
  }

  if (preview.level === 'warning') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-100';
  }

  if (preview.level === 'success') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100';
  }

  return 'border-blue-500/30 bg-blue-500/10 text-blue-100';
};

const getPreviewLevelLabel = (preview: DebugNotificationPreview): string =>
  preview.level === 'success'
    ? 'success'
    : preview.level === 'warning'
      ? 'warning'
      : preview.level === 'error'
        ? 'error'
        : 'info';

const summarizePreviewResult = (
  preview: DebugNotificationPreview,
  channel: DebugNotificationPreviewChannel,
  result: DebugNotificationEmitResult
): string => {
  if (channel === 'in_app') {
    return result.inAppSent
      ? `${preview.label}: in-app preview emitted.`
      : `${preview.label}: in-app preview was blocked by the current notification settings.`;
  }

  if (channel === 'desktop') {
    return result.desktopSent
      ? `${preview.label}: desktop preview sent.`
      : `${preview.label}: desktop preview could not be sent with the current runtime or permission state.`;
  }

  return `${preview.label}: in-app ${result.inAppSent ? 'ok' : 'blocked'}, desktop ${
    result.desktopSent ? 'ok' : 'blocked'
  }.`;
};

const summarizeBatchResult = (
  channel: DebugNotificationPreviewChannel,
  result: DebugNotificationBatchResult
): string => {
  if (channel === 'in_app') {
    return `Debug batch finished: ${result.inAppSent}/${result.total} in-app previews emitted.`;
  }

  if (channel === 'desktop') {
    return `Debug batch finished: ${result.desktopSent}/${result.total} desktop previews sent.`;
  }

  return `Debug batch finished: ${result.inAppSent}/${result.total} in-app previews and ${result.desktopSent}/${result.total} desktop previews sent.`;
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
      toast.error(
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

  const handlePreview = useCallback(
    async (
      preview: DebugNotificationPreview,
      channel: DebugNotificationPreviewChannel
    ) => {
      await runDebugAction(`${preview.id}:${channel}`, async () => {
        const result = await emitDebugNotificationPreview(preview, channel);
        return summarizePreviewResult(preview, channel, result);
      });
    },
    [runDebugAction]
  );

  const handlePreviewAll = useCallback(
    async (channel: DebugNotificationPreviewChannel) => {
      await runDebugAction(`batch:${channel}`, async () => {
        const result = await emitAllDebugNotificationPreviews(channel);
        return summarizeBatchResult(channel, result);
      });
    },
    [runDebugAction]
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
                Notification previews
              </label>
              <p className="text-xs text-muted-foreground">
                Use this debug-only panel to preview the canonical notification styles used across Macro.
              </p>
              <p className="text-xs text-muted-foreground">
                Desktop previews bypass the usual foreground restriction so you can validate OS notifications without backgrounding the app.
              </p>
              <p className="text-xs text-muted-foreground">
                Current desktop runtime status:{' '}
                <span className={desktopRuntimeToneClass}>{desktopRuntimeLabel}</span>
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                isLoading={pendingDebugActionId === 'batch:in_app'}
                disabled={pendingDebugActionId !== null}
                onClick={() => void handlePreviewAll('in_app')}
              >
                Show all (in-app)
              </Button>
              <Button
                size="sm"
                variant="secondary"
                isLoading={pendingDebugActionId === 'batch:desktop'}
                disabled={pendingDebugActionId !== null}
                onClick={() => void handlePreviewAll('desktop')}
              >
                Show all (desktop)
              </Button>
              <Button
                size="sm"
                variant="primary"
                isLoading={pendingDebugActionId === 'batch:all'}
                disabled={pendingDebugActionId !== null}
                onClick={() => void handlePreviewAll('all')}
              >
                Show all (all channels)
              </Button>
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

            {debugStatusMessage && (
              <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
                {debugStatusMessage}
              </div>
            )}

            <div className="space-y-3">
              {DEBUG_NOTIFICATION_PREVIEWS.map((preview) => (
                <div
                  key={preview.id}
                  className="rounded-lg border border-border/50 bg-background/40 px-3 py-3"
                >
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          {preview.label}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {preview.description}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getPreviewToneClasses(preview)}`}
                        >
                          {getPreviewLevelLabel(preview)}
                        </span>
                        <span className="inline-flex items-center rounded-full border border-border/60 bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {formatPreviewToken(preview.variant)}
                        </span>
                        {preview.notificationCategory && (
                          <span className="inline-flex items-center rounded-full border border-border/60 bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {formatPreviewToken(preview.notificationCategory)}
                          </span>
                        )}
                        <span className="inline-flex items-center rounded-full border border-border/60 bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          toast
                        </span>
                        {preview.level !== 'success' && (
                          <span className="inline-flex items-center rounded-full border border-border/60 bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            center
                          </span>
                        )}
                        {preview.supportsDesktop && (
                          <span className="inline-flex items-center rounded-full border border-border/60 bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            desktop
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        isLoading={pendingDebugActionId === `${preview.id}:in_app`}
                        disabled={pendingDebugActionId !== null}
                        onClick={() => void handlePreview(preview, 'in_app')}
                      >
                        In-app
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        isLoading={pendingDebugActionId === `${preview.id}:desktop`}
                        disabled={pendingDebugActionId !== null}
                        onClick={() => void handlePreview(preview, 'desktop')}
                      >
                        Desktop
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        isLoading={pendingDebugActionId === `${preview.id}:all`}
                        disabled={pendingDebugActionId !== null}
                        onClick={() => void handlePreview(preview, 'all')}
                      >
                        All channels
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default NotificationsView;
