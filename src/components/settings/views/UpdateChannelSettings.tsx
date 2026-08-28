/* Hallmark · component: update channel settings · genre: modern-minimal · theme: Macro
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: existing Macro theme tokens · pre-emit critique: P5 H5 E5 S5 R5 V5
 */
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
    ? 'text-amber-400'
    : phase === 'ready' || phase === 'upToDate'
      ? 'text-primary'
      : 'text-muted-foreground';
  const channelOptions: Array<{
    value: UpdateChannel;
    label: string;
    description: string;
  }> = [
    {
      value: 'stable',
      label: t('settings.updateChannel.stable', 'Stable'),
      description: t(
        'settings.updateChannel.stableDescription',
        'Receive production releases only.',
      ),
    },
    {
      value: 'preview',
      label: t('settings.updateChannel.preview', 'Preview'),
      description: t(
        'settings.updateChannel.previewDescription',
        'Receive validated nightly and release candidate builds.',
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid items-end gap-4 lg:grid-cols-[minmax(11rem,0.55fr)_minmax(0,1.45fr)] lg:gap-6">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('settings.updateChannel.currentVersion', 'Current version')}
          </div>
          <div className="truncate font-mono text-base font-semibold tabular-nums text-foreground">
            {currentVersion ? `Macro v${currentVersion}` : t('common.loading', 'Loading…')}
          </div>
        </div>

        <fieldset className="min-w-0">
          <legend className="text-xs font-medium text-muted-foreground">
            {t('settings.updateChannel.label', 'Update channel')}
          </legend>
          <div
            className="mt-2 grid grid-cols-2 rounded-lg border border-border/60 bg-muted/20 p-1"
            role="radiogroup"
          >
            {channelOptions.map((option) => {
              const selected = channel === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${option.label}. ${option.description}`}
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
                    'flex h-10 min-w-0 items-center justify-center gap-2 rounded-md px-3 text-center transition-[background-color,color,transform] duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                    'active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50',
                    selected
                      ? 'bg-background text-foreground ring-1 ring-inset ring-border/70'
                      : 'text-muted-foreground hover:bg-accent/35 hover:text-foreground',
                  )}
                >
                  <span className="truncate text-xs font-semibold">{option.label}</span>
                  {saving && selected
                    ? <Icon name="loader" size={12} className="shrink-0 motion-safe:animate-spin" />
                    : selected ? <Icon name="check" size={12} className="shrink-0 text-primary" /> : null}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="flex flex-col gap-3 border-t border-border/60 pt-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Icon
            name={statusIcon}
            size={16}
            className={cn('shrink-0', statusIconClassName, checking && 'motion-safe:animate-spin')}
          />
          <div className="min-w-0 space-y-0.5">
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
                <p className="break-words text-sm font-medium text-foreground">
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
                {error ? <p className="max-w-xl break-words text-xs text-muted-foreground">{error}</p> : null}
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
        <div className="flex shrink-0 items-center gap-2 lg:justify-end">
          {(phase === 'ready' || (phase === 'error' && update)) ? (
            <Button
              type="button"
              size="sm"
              variant={phase === 'ready' ? 'primary' : 'ghost'}
              className={cn(
                'h-9 whitespace-nowrap px-4 active:translate-y-px',
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
            className="h-9 whitespace-nowrap border border-border/70 bg-transparent px-4 hover:bg-accent/50 active:translate-y-px"
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
