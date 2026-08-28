import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { isAutomaticUpdaterEnabled } from '../../../services/appUpdater';
import {
  loadUpdateChannel,
  saveUpdateChannel,
  type UpdateChannel,
} from '../../../services/updateChannels';
import { useAppUpdateStore } from '../../../stores/useAppUpdateStore';
import { Button } from '../../ui/Button';
import { ConfirmPromptModal } from '../../ui/ConfirmPromptModal';
import { Icon } from '../../ui/Icon';
import { Select } from '../../ui/Select';
import { notify } from '../../ui/toastService';

const getProgress = (downloadedBytes: number, totalBytes: number | null): number | null =>
  totalBytes && totalBytes > 0
    ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
    : null;

export const UpdateChannelSettings: React.FC = () => {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [saving, setSaving] = useState(false);
  const [pendingStableConfirmation, setPendingStableConfirmation] = useState(false);
  const [
    phase,
    currentVersion,
    update,
    downloadedBytes,
    totalBytes,
    checkInProgress,
    error,
    initialize,
    checkForUpdates,
    openDetails,
    reset,
  ] = useAppUpdateStore(useShallow((state) => [
    state.phase,
    state.currentVersion,
    state.availableUpdate,
    state.downloadedBytes,
    state.totalBytes,
    state.checkInProgress,
    state.error,
    state.initialize,
    state.checkForUpdates,
    state.openDetails,
    state.reset,
  ]));

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadUpdateChannel(), initialize()]).then(([value]) => {
      if (!cancelled) setChannel(value);
    });
    return () => { cancelled = true; };
  }, [initialize]);

  const changeChannel = async (nextChannel: UpdateChannel) => {
    if (nextChannel === channel || saving) return;
    const previousChannel = channel;
    setChannel(nextChannel);
    setSaving(true);
    try {
      await saveUpdateChannel(nextChannel);
      await reset();
      if (isAutomaticUpdaterEnabled()) {
        await checkForUpdates({ explicit: true });
      }
    } catch (changeError) {
      setChannel(previousChannel);
      notify.error(t('settings.configuration.saveFailed', 'Could not save configuration'), {
        description: changeError instanceof Error ? changeError.message : String(changeError),
      });
    } finally {
      setSaving(false);
    }
  };

  const requestChannelChange = (nextChannel: UpdateChannel) => {
    if (nextChannel === 'stable' && channel === 'preview') {
      setPendingStableConfirmation(true);
      return;
    }
    void changeChannel(nextChannel);
  };

  const check = async () => {
    const outcome = await checkForUpdates({ explicit: true });
    if (outcome === 'error') {
      notify.error(t('updates.checkFailed', 'Unable to check for updates'), {
        description: useAppUpdateStore.getState().error ?? undefined,
      });
    }
  };

  const redownload = async () => {
    await reset();
    await check();
  };

  const progress = getProgress(downloadedBytes, totalBytes);
  const checking = phase === 'checking';
  const downloading = phase === 'downloading';
  const busy = checkInProgress || checking || downloading || saving || phase === 'installing';

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('settings.updateChannel.currentVersion', 'Current version')}
          </div>
          <div className="text-sm font-medium text-foreground">
            {currentVersion ? `Macro v${currentVersion}` : t('common.loading', 'Loading…')}
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="update-channel" className="text-xs font-medium text-muted-foreground">
            {t('settings.updateChannel.label', 'Update channel')}
          </label>
          <Select
            id="update-channel"
            value={channel}
            disabled={busy}
            onChange={(event) => requestChannelChange(event.target.value as UpdateChannel)}
          >
            <option value="stable">{t('settings.updateChannel.stable', 'Stable')}</option>
            <option value="preview">{t('settings.updateChannel.preview', 'Preview')}</option>
          </Select>
        </div>
      </div>

      <div className="border-t border-border/50 pt-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            {checking ? (
              <p className="flex items-center gap-2 text-sm text-foreground">
                <Icon name="refresh-cw" size={14} className="motion-safe:animate-spin" />
                {t('updates.checking', 'Checking for updates')}
              </p>
            ) : downloading ? (
              <p className="text-sm text-foreground">
                {progress === null
                  ? t('updates.downloading', 'Downloading update')
                  : t('updates.downloadingProgress', 'Downloading update: {{progress}}%', { progress })}
              </p>
            ) : phase === 'ready' && update ? (
              <>
                <p className="text-sm font-medium text-foreground">
                  {t('updates.readyVersion', 'Macro v{{version}} is ready', { version: update.version })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('updates.installsNextLaunch', 'It will be installed the next time Macro opens.')}
                </p>
              </>
            ) : phase === 'upToDate' ? (
              <p className="text-sm text-muted-foreground">
                {t('updates.upToDate', 'Macro is up to date')}
              </p>
            ) : phase === 'error' ? (
              <>
                <p className="text-sm font-medium text-amber-400">
                  {t('updates.updateFailed', 'The update could not be completed')}
                </p>
                {error ? <p className="max-w-xl text-xs text-muted-foreground">{error}</p> : null}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {channel === 'preview'
                  ? t('settings.updateChannel.previewDescription', 'Receive validated nightly and release candidate builds.')
                  : t('settings.updateChannel.stableDescription', 'Receive production releases only.')}
              </p>
            )}
            {downloading ? (
              <div className="mt-2 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                  style={{ width: `${progress ?? 12}%` }}
                />
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2">
            {(phase === 'ready' || (phase === 'error' && update)) ? (
              <Button
                type="button"
                size="sm"
                variant={phase === 'ready' ? 'primary' : 'ghost'}
                onClick={phase === 'ready' ? openDetails : () => void redownload()}
              >
                {phase === 'ready'
                  ? t('updates.installNow', 'Install now')
                  : t('updates.downloadAgain', 'Download again')}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || phase === 'ready'}
              onClick={() => void check()}
            >
              {t('updates.check', 'Check for updates')}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmPromptModal
        isOpen={pendingStableConfirmation}
        title={t('settings.updateChannel.stableConfirmationTitle', 'Switch to Stable?')}
        description={t(
          'settings.updateChannel.stableConfirmationDescription',
          'If the latest Stable version is older than this Preview, Macro will prepare that signed version.',
        )}
        confirmLabel={t('settings.updateChannel.switchToStable', 'Switch to Stable')}
        cancelLabel={t('common.cancel', 'Cancel')}
        isSubmitting={saving}
        onCancel={() => setPendingStableConfirmation(false)}
        onConfirm={() => {
          setPendingStableConfirmation(false);
          void changeChannel('stable');
        }}
      />
    </div>
  );
};
