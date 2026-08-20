import { applyConfiguredLanguage, resolveSupportedLanguage } from '../i18n';
import { useAppStore } from '../stores/useAppStore';
import { useConfigStore, selectConfigValue } from '../stores/useConfigStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useSkillsStore } from '../stores/useSkillsStore';
import { useToolsStore } from '../stores/useToolsStore';
import type { ConfigDocumentKind, ConfigSnapshot } from '../types/generated/config';
import { refreshWebSearchSettings } from './webSearchSettings';

let unsubscribe: (() => void) | null = null;

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
  if (unsubscribe) return unsubscribe;
  let previousSnapshot = useConfigStore.getState().snapshot;
  unsubscribe = useConfigStore.subscribe((state) => {
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
  return unsubscribe;
};

export const disposeConfigRuntimeEffectsForTests = (): void => {
  unsubscribe?.();
  unsubscribe = null;
};
