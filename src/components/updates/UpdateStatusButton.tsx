import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { notify } from '../ui/toastService';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { isAutomaticUpdaterEnabled } from '../../services/appUpdater';
import { useAppUpdateStore, type AppUpdatePhase } from '../../stores/useAppUpdateStore';

interface UpdateButtonPresentation {
  icon: IconName;
  label: string;
  spinning: boolean;
  emphasis: 'neutral' | 'ready' | 'error';
}

const percentage = (downloaded: number, total: number | null): number | null =>
  total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

export const getUpdateButtonPresentation = (
  phase: AppUpdatePhase,
  version: string | null,
  progress: number | null,
  translate: (key: string, fallback: string, options?: Record<string, unknown>) => string,
): UpdateButtonPresentation => {
  switch (phase) {
    case 'checking':
      return {
        icon: 'refresh-cw',
        label: translate('updates.checking', 'Checking for updates'),
        spinning: true,
        emphasis: 'neutral',
      };
    case 'downloading':
      return {
        icon: 'download',
        label: progress === null
          ? translate('updates.downloading', 'Downloading update')
          : translate('updates.downloadingProgress', 'Downloading update: {{progress}}%', { progress }),
        spinning: false,
        emphasis: 'neutral',
      };
    case 'ready':
      return {
        icon: 'download',
        label: translate('updates.restartToUpdate', 'Restart to update to v{{version}}', {
          version: version ?? '',
        }),
        spinning: false,
        emphasis: 'ready',
      };
    case 'installing':
      return {
        icon: 'refresh-cw',
        label: translate('updates.installing', 'Installing update'),
        spinning: true,
        emphasis: 'ready',
      };
    case 'error':
      return {
        icon: 'triangle-alert',
        label: translate('updates.retry', 'Update failed. Retry'),
        spinning: false,
        emphasis: 'error',
      };
    case 'upToDate':
      return {
        icon: 'check',
        label: translate('updates.upToDate', 'Macro is up to date'),
        spinning: false,
        emphasis: 'neutral',
      };
    default:
      return {
        icon: 'download',
        label: translate('updates.check', 'Check for updates'),
        spinning: false,
        emphasis: 'neutral',
      };
  }
};

export const UpdateStatusButton: React.FC = () => {
  const { t } = useTranslation();
  const [phase, update, downloadedBytes, totalBytes, errorOperation, checkForUpdates, openDetails] =
    useAppUpdateStore(
      useShallow((state) => [
        state.phase,
        state.availableUpdate,
        state.downloadedBytes,
        state.totalBytes,
        state.errorOperation,
        state.checkForUpdates,
        state.openDetails,
      ]),
    );

  if (!isAutomaticUpdaterEnabled()) return null;

  const progress = percentage(downloadedBytes, totalBytes);
  const presentation = getUpdateButtonPresentation(
    phase,
    update?.version ?? null,
    progress,
    (key, fallback, options) => t(key, { defaultValue: fallback, ...options }),
  );
  const isBusy = phase === 'checking' || phase === 'installing';

  const handleClick = async () => {
    if (
      phase === 'ready'
      || phase === 'downloading'
      || (phase === 'error' && errorOperation === 'install' && update)
    ) {
      openDetails();
      return;
    }

    const outcome = await checkForUpdates();
    if (outcome === 'upToDate') {
      notify.success(t('updates.upToDate', 'Macro is up to date'));
    } else if (outcome === 'error') {
      notify.error(t('updates.checkFailed', 'Unable to check for updates'), {
        description: useAppUpdateStore.getState().error ?? undefined,
      });
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        'h-6 min-w-6 gap-1 px-1.5 text-[11px]',
        presentation.emphasis === 'ready' && 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15 hover:text-emerald-300',
        presentation.emphasis === 'error' && 'text-amber-400 hover:text-amber-300',
      )}
      aria-label={presentation.label}
      title={presentation.label}
      disabled={isBusy}
      onClick={() => void handleClick()}
      data-tour-id="footer-app-update"
    >
      <Icon
        name={presentation.icon}
        size={12}
        className={cn('shrink-0', presentation.spinning && 'animate-spin')}
      />
      {phase === 'downloading' && progress !== null ? <span>{progress}%</span> : null}
      {phase === 'ready' ? <span className="hidden max-w-36 truncate xl:inline">v{update?.version}</span> : null}
    </Button>
  );
};

export default UpdateStatusButton;
