import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { usePilotStore } from '../../stores/usePilotStore';
import { notify } from '../ui/toastService';
import { CONNECT_ATTENTION_KEY, createConnectionAttentionObserver } from '../../services/macroPilot/connectionAttention';
import { connectionIntervention, connectionScope, vaultRecoveryMessages } from '../../services/macroPilot/connectionPresentation';

// Retain the incident across StrictMode and shell remounts.
const observeAttention = createConnectionAttentionObserver();

export function ConnectAttentionNotifications() {
  const { t } = useTranslation();
  useEffect(() => {
    const update = () => {
      const state = usePilotStore.getState();
      observeAttention(state, reason => {
        const scope = connectionScope(state);
        notify.actionRequired(t('settings.pilot.attentionTitle', 'Macro Connect needs your attention'), {
          notificationKey: CONNECT_ATTENTION_KEY,
          description: reason === 'expired' || reason === 'revoked'
            ? t(`settings.pilot.errors.${reason === 'expired' ? 'unauthorized' : 'session_revoked'}`,
              reason === 'expired' ? 'Your Macro Connect session has expired. Connect with GitHub again. Your local projects and conversations remain available.'
                : 'Access for this device was revoked. Connect with GitHub again to restore it. Your local projects and conversations remain available.')
            : t(`settings.pilot.vaultRecovery.${reason}`, vaultRecoveryMessages[reason]),
          actions: [{
            label: t('settings.pilot.openSettings', 'Open Macro Connect'),
            onClick: () => {
              const current = usePilotStore.getState();
              if (connectionScope(current) === scope && connectionIntervention(current)) useAppStore.getState().openSettings('pilot');
            },
          }],
        });
      }, () => notify.dismiss(CONNECT_ATTENTION_KEY));
    };
    const unsubscribe = usePilotStore.subscribe(update);
    update();
    return unsubscribe;
  }, [t]);
  return null;
}
