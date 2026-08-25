import i18n, { applyConfiguredLanguage, resolveSupportedLanguage } from '../i18n';
import { notify } from '../components/ui/toastService';
import { useAppStore } from '../stores/useAppStore';
import { useConfigStore, selectConfigValue } from '../stores/useConfigStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useSkillsStore } from '../stores/useSkillsStore';
import { useToolsStore } from '../stores/useToolsStore';
import type { ConfigDocumentKind, ConfigSnapshot } from '../types/generated/config';
import { subscribePreferencePersistenceErrors } from './preferences';
import { refreshWebSearchSettings } from './webSearchSettings';

let unsubscribeStore: (() => void) | null = null;
let unsubscribePersistenceErrors: (() => void) | null = null;
let cleanup: (() => void) | null = null;

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
};

const documentFingerprint = (
  snapshot: ConfigSnapshot | null,
  kind: ConfigDocumentKind,
): string => JSON.stringify(snapshot?.effective[kind] ?? null);

const changed = (
  previous: ConfigSnapshot | null,
  next: ConfigSnapshot | null,
  kind: ConfigDocumentKind,
): boolean => documentFingerprint(previous, kind) !== documentFingerprint(next, kind);

const applySettings = (snapshot: ConfigSnapshot): void => {
  const state = useAppStore.getState();
  const activeThemeId = selectConfigValue(snapshot, 'settings', ['appearance', 'theme'], state.activeThemeId);
  const uiZoomMode = selectConfigValue(snapshot, 'settings', ['appearance', 'zoomMode'], state.uiZoomMode);
  const uiZoomLevel = selectConfigValue(snapshot, 'settings', ['appearance', 'zoomLevel'], state.uiZoomLevel);
  const codeOverflowMode = selectConfigValue(snapshot, 'settings', ['code', 'overflowMode'], state.codeOverflowMode);
  const inAppNotificationsEnabled = selectConfigValue(
    snapshot,
    'settings',
    ['notifications', 'inAppEnabled'],
    state.inAppNotificationsEnabled,
  );
  const notificationChannelModes = selectConfigValue(
    snapshot,
    'settings',
    ['notifications', 'channelModes'],
    state.notificationChannelModes,
  );
  useAppStore.setState({
    activeThemeId,
    uiZoomMode,
    uiZoomLevel,
    codeOverflowMode,
    inAppNotificationsEnabled,
    notificationChannelModes,
  });

  const configuredLanguage = selectConfigValue(snapshot, 'settings', ['language'], 'en');
  void applyConfiguredLanguage(resolveSupportedLanguage(configuredLanguage));
};

export const installConfigRuntimeEffects = (): (() => void) => {
  if (cleanup) return cleanup;
  unsubscribePersistenceErrors = subscribePreferencePersistenceErrors((error) => {
    notify.error(
      i18n.t('settings.configuration.saveFailed', 'Could not save configuration'),
      { description: errorMessage(error) },
    );
  });
  let previousSnapshot = useConfigStore.getState().snapshot;
  unsubscribeStore = useConfigStore.subscribe((state) => {
    const nextSnapshot = state.snapshot;
    if (!nextSnapshot || nextSnapshot === previousSnapshot) return;
    const previous = previousSnapshot;
    previousSnapshot = nextSnapshot;

    if (changed(previous, nextSnapshot, 'settings')) applySettings(nextSnapshot);
    if (changed(previous, nextSnapshot, 'providers')) {
      void useProviderStore.getState().loadProviderConfigs();
    }
    if (changed(previous, nextSnapshot, 'tools')) {
      void useToolsStore.getState().loadSettings();
      void refreshWebSearchSettings();
    }
    if (changed(previous, nextSnapshot, 'skills')) {
      void useSkillsStore.getState().refreshSkills();
    }
  });
  cleanup = () => {
    unsubscribeStore?.();
    unsubscribeStore = null;
    unsubscribePersistenceErrors?.();
    unsubscribePersistenceErrors = null;
    cleanup = null;
  };
  return cleanup;
};

export const disposeConfigRuntimeEffectsForTests = (): void => {
  cleanup?.();
};
