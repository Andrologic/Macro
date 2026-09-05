import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { usePersistenceHealth } from '../../services/persistenceHealth';
import { useAppStore } from '../../stores/useAppStore';
import { notify } from '../ui/toastService';

export function PersistenceHealthNotifications() {
  const { t } = useTranslation();
  useEffect(() => {
    const announced = new Map<string, string>();
    const report = ({ issues }: ReturnType<typeof usePersistenceHealth.getState>) => {
      for (const [key, message] of Object.entries(issues)) {
        if (announced.get(key) === message) continue;
        announced.set(key, message);
        notify.actionRequired(t('backup.recovery', 'Recovery required. Original data preserved.'), {
          description: message,
          notificationKey: `persistence:${key}`,
          actions: [{ label: t('settings.title', 'Settings'), onClick: () => useAppStore.getState().openSettings('general') }],
        });
      }
      for (const key of announced.keys()) if (!(key in issues)) announced.delete(key);
    };
    report(usePersistenceHealth.getState());
    return usePersistenceHealth.subscribe(report);
  }, [t]);
  return null;
}
