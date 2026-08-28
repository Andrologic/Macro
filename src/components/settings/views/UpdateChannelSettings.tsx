/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
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
import { notify } from '../../ui/toastService';
import { cn } from '../../../utils/cn';

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
  const statusIcon = checking
    ? 'refresh-cw'
    : downloading
      ? 'download'
      : phase === 'ready' || phase === 'upToDate'
        ? 'check-circle'
        : phase === 'error'
          ? 'alert-circle'
          : 'download';
  const statusIconClassName = phase === 'error'
    ? 'border-amber-400/20 bg-amber-400/10 text-amber-400'
    : phase === 'ready'
      ? 'border-primary/25 bg-primary/10 text-primary'
      : 'border-border/70 bg-card text-muted-foreground';
  const channelOptions: Array<{
    value: UpdateChannel;
    icon: 'shield' | 'sparkles';
    label: string;
    description: string;
  }> = [
    {
      value: 'stable',
      icon: 'shield',
      label: t('settings.updateChannel.stable', 'Stable'),
      description: t(
        'settings.updateChannel.stableDescription',
        'Receive production releases only.',
      ),
    },
    {
      value: 'preview',
      icon: 'sparkles',
      label: t('settings.updateChannel.preview', 'Preview'),
      description: t(
        'settings.updateChannel.previewDescription',
        'Receive validated nightly and release candidate builds.',
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid items-end gap-4 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
        <div className="flex min-h-20 items-center gap-3 rounded-lg border border-border/60 bg-background/45 p-3.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-card text-muted-foreground">
            <Icon name="download" size={15} />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-muted-foreground">
              {t('settings.updateChannel.currentVersion', 'Current version')}
            </div>
            <div className="mt-0.5 truncate font-mono text-sm font-medium text-foreground">
              {currentVersion ? `Macro v${currentVersion}` : t('common.loading', 'Loading…')}
            </div>
          </div>
        </div>

        <fieldset className="min-w-0 space-y-2">
          <legend className="text-[11px] font-medium text-muted-foreground">
            {t('settings.updateChannel.label', 'Update channel')}
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
            {channelOptions.map((option) => {
              const selected = channel === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-describedby="update-channel-description"
                  tabIndex={selected ? 0 : -1}
                  disabled={busy}
                  onClick={() => requestChannelChange(option.value)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                      return;
                    }
                    event.preventDefault();
                    const currentIndex = channelOptions.findIndex(({ value }) => value === option.value);
                    const moveBackward = event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'Home';
                    const nextIndex = event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? channelOptions.length - 1
                        : (currentIndex + (moveBackward ? -1 : 1) + channelOptions.length) % channelOptions.length;
                    const nextOption = channelOptions[nextIndex];
                    const radioButtons = event.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
                    radioButtons?.[nextIndex]?.focus();
                    if (nextOption) requestChannelChange(nextOption.value);
                  }}
                  className={cn(
                    'group flex min-h-16 min-w-0 items-center gap-3 rounded-lg border p-3 text-left transition-[border-color,background-color,box-shadow,transform] duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                    'active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50',
                    selected
                      ? 'border-primary/45 bg-primary/10 shadow-[inset_0_0_0_1px_rgb(var(--primary)/0.08)]'
                      : 'border-border/60 bg-background/45 hover:border-border hover:bg-accent/45',
                  )}
                >
                  <span className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors duration-150',
                    selected
                      ? 'border-primary/30 bg-primary/15 text-primary'
                      : 'border-border/70 bg-card text-muted-foreground group-hover:text-foreground',
                  )}>
                    <Icon name={option.icon} size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground">{option.label}</span>
                      <span className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background',
                      )}>
                        {saving && selected
                          ? <Icon name="loader" size={10} className="motion-safe:animate-spin" />
                          : selected ? <Icon name="check" size={10} /> : null}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p id="update-channel-description" className="min-h-4 text-[10px] leading-4 text-muted-foreground">
            {channelOptions.find((option) => option.value === channel)?.description}
          </p>
        </fieldset>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-background/45 p-3.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border',
            statusIconClassName,
          )}>
            <Icon
              name={statusIcon}
              size={15}
              className={checking ? 'motion-safe:animate-spin' : undefined}
            />
          </div>
          <div className="min-w-0 space-y-1 pt-0.5">
            {checking ? (
              <p className="text-sm font-medium text-foreground">
                {t('updates.checking', 'Checking for updates')}
              </p>
            ) : downloading ? (
              <p className="text-sm font-medium text-foreground">
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
              <p className="text-sm font-medium text-foreground">
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
              <div className="mt-2 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress ?? undefined} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none"
                  style={{ width: `${progress ?? 12}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
          {(phase === 'ready' || (phase === 'error' && update)) ? (
            <Button
              type="button"
              size="sm"
              variant={phase === 'ready' ? 'primary' : 'ghost'}
              className={cn(
                'h-9 whitespace-nowrap px-4',
                phase === 'error' && 'border border-border/70 bg-card hover:bg-accent',
              )}
              leftIcon={<Icon name={phase === 'ready' ? 'download' : 'rotate-ccw'} size={13} />}
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
            variant="ghost"
            className="h-9 whitespace-nowrap border border-border/70 bg-card px-4 hover:bg-accent"
            disabled={busy || phase === 'ready'}
            isLoading={checking || (checkInProgress && !downloading)}
            leftIcon={<Icon name="refresh-cw" size={13} />}
            onClick={() => void check()}
          >
            {t('updates.check', 'Check for updates')}
          </Button>
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
