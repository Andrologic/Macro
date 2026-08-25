import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAutomaticUpdaterEnabled } from '../../../services/appUpdater';
import {
  loadUpdateChannel,
  saveUpdateChannel,
  type UpdateChannel,
} from '../../../services/updateChannels';
import { useAppUpdateStore } from '../../../stores/useAppUpdateStore';
import { Select } from '../../ui/Select';
import { ConfirmPromptModal } from '../../ui/ConfirmPromptModal';
import { notify } from '../../ui/toastService';

export const UpdateChannelSettings: React.FC = () => {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [saving, setSaving] = useState(false);
  const [pendingStableConfirmation, setPendingStableConfirmation] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadUpdateChannel().then((value) => {
      if (!cancelled) setChannel(value);
    });
    return () => { cancelled = true; };
  }, []);

  const changeChannel = async (nextChannel: UpdateChannel) => {
    if (nextChannel === channel || saving) return;
    const previousChannel = channel;
    setChannel(nextChannel);
    setSaving(true);
    try {
      await saveUpdateChannel(nextChannel);
      await useAppUpdateStore.getState().reset();
      if (isAutomaticUpdaterEnabled()) {
        const outcome = await useAppUpdateStore.getState().checkForUpdates();
        if (outcome === 'upToDate') {
          notify.success(t('settings.updateChannel.upToDate', 'Macro is up to date on the selected channel.'));
        } else if (outcome === 'error') {
          notify.error(t('updates.checkFailed', 'Unable to check for updates'), {
            description: useAppUpdateStore.getState().error ?? undefined,
          });
        }
      }
    } catch (error) {
      setChannel(previousChannel);
      notify.error(t('settings.configuration.saveFailed', 'Could not save configuration'), {
        description: error instanceof Error ? error.message : String(error),
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

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <label htmlFor="update-channel" className="text-sm font-medium text-foreground">
          {t('settings.updateChannel.label', 'Update channel')}
        </label>
        <p className="max-w-xl text-xs text-muted-foreground">
          {channel === 'preview'
            ? t('settings.updateChannel.previewDescription', 'Receive validated nightly and release candidate builds. Switching back to Stable may install an older version.')
            : t('settings.updateChannel.stableDescription', 'Receive production releases only.')}
        </p>
      </div>
      <div className="w-full sm:w-[220px]">
        <Select
          id="update-channel"
          value={channel}
          disabled={saving}
          onChange={(event) => requestChannelChange(event.target.value as UpdateChannel)}
        >
          <option value="stable">{t('settings.updateChannel.stable', 'Stable')}</option>
          <option value="preview">{t('settings.updateChannel.preview', 'Preview (nightly)')}</option>
        </Select>
      </div>
      <ConfirmPromptModal
        isOpen={pendingStableConfirmation}
        title={t('settings.updateChannel.stableConfirmationTitle', 'Switch to Stable?')}
        description={t(
          'settings.updateChannel.stableConfirmationDescription',
          'If the latest Stable version is older than this Preview, Macro will offer to install that older signed version.',
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
