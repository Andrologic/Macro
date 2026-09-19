import { installNotificationNavigation } from '../services/notificationNavigation';
import { openWorkflowNotificationContext } from '../services/openWorkflowNotificationContext';
import { notify } from '../components/ui/toastService';
import { installLanguageNotifications } from '../i18n/languageNotifications';
import { installNotificationPreferences } from '../services/notificationPreferences';
import { useAppStore } from '../stores/useAppStore';

let stop: (() => void) | undefined;

/** Install before configuration/language initialization. Safe to call repeatedly. */
export function startNotificationComposition(): () => void {
  if (stop) return stop;
  const releasePreferences = installNotificationPreferences(() => useAppStore.getState());
  let releaseNavigation: (() => void) | undefined;
  let releaseLanguage: () => void;
  try {
    releaseNavigation = installNotificationNavigation(openWorkflowNotificationContext);
    releaseLanguage = installLanguageNotifications((message) => { notify.success(message); });
  } catch (error) {
    releaseNavigation?.();
    releasePreferences();
    throw error;
  }
  const cleanup = () => {
    if (stop !== cleanup) return;
    releaseLanguage();
    releaseNavigation?.();
    releasePreferences();
    stop = undefined;
  };
  stop = cleanup;
  return cleanup;
}
