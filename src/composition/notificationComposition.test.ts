import { expect, it, mock } from 'bun:test';

const seen: string[] = [];
const state = { inAppNotificationsEnabled: false, notificationChannelModes: {} };
mock.module('../components/ui/toastService', () => ({ notify: { success: (message: string) => seen.push(message) } }));
mock.module('../stores/useAppStore', () => ({ useAppStore: { getState: () => state } }));
const { startNotificationComposition } = await import('./notificationComposition');
const { reportLanguageChange } = await import('../i18n/languageNotifications');
const { getNotificationPreferences } = await import('../services/notificationPreferences');

it('starts idempotently, reads live preferences and reconnects pending language notices', () => {
  const stop = startNotificationComposition();
  expect(startNotificationComposition()).toBe(stop);
  expect(getNotificationPreferences().inAppNotificationsEnabled).toBe(false);
  state.inAppNotificationsEnabled = true;
  expect(getNotificationPreferences().inAppNotificationsEnabled).toBe(true);
  reportLanguageChange('Français');
  stop();
  stop();
  reportLanguageChange('English');
  expect(seen).toEqual(['Français']);
  const restarted = startNotificationComposition();
  expect(seen).toEqual(['Français', 'English']);
  stop();
  reportLanguageChange('日本語');
  expect(seen).toEqual(['Français', 'English', '日本語']);
  restarted();
});
