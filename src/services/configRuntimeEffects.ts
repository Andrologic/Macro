import { createLifecycleScope, type LifecycleContext } from './lifecycleScope';
import i18n, { applyConfiguredLanguage, resolveSupportedLanguage } from '../i18n';
import { notify } from '../components/ui/toastService';
import { useAppStore } from '../stores/useAppStore';
import { useConfigStore, selectConfigValue } from '../stores/useConfigStore';
import type { ProvidersCommands, ToolsCommands } from '../domains/contracts';
import { useSkillsStore } from '../stores/useSkillsStore';
import type { ConfigDocumentKind, ConfigSnapshot } from '../types/generated/config';
import { subscribePreferencePersistenceErrors } from './preferences';
import { refreshWebSearchSettings } from './webSearchSettings';

let cleanup: (() => Promise<void>) | null = null;

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

const applySettings = (snapshot: ConfigSnapshot, context: LifecycleContext): Promise<void> => {
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
  return applyConfiguredLanguage(resolveSupportedLanguage(configuredLanguage), context);
};

export const installConfigRuntimeEffects = (dependencies: {
  providers: Pick<ProvidersCommands, 'loadProviderConfigs'>;
  tools: Pick<ToolsCommands, 'loadSettings'>;
}, application?: LifecycleContext): (() => Promise<void>) => {
  if (cleanup) return cleanup;
  application?.assertActive();
  const owner = createLifecycleScope();
  const run = (work: Promise<unknown>) => {
    void owner.track(work).catch((error) => {
      if (owner.isActive()) console.error('Configuration effect failed:', error);
    });
  };
  const stop = () => {
    if (cleanup === stop) cleanup = null;
    let failure: unknown;
    try { owner.stop(); } catch (error) { failure = error; }
    return owner.drain().then(() => { if (failure) throw failure; });
  };
  try {
    owner.own(subscribePreferencePersistenceErrors((error, key) => {
      // Reporting a notification persistence failure would retry the failing write.
      if (!owner.isActive() || key === 'notificationCenterItems') return;
      notify.error(
        i18n.t('settings.configuration.saveFailed', 'Could not save configuration'),
        { description: errorMessage(error) },
      );
    }));
    let previousSnapshot = useConfigStore.getState().snapshot;
    owner.own(useConfigStore.subscribe((state) => {
      if (!owner.isActive()) return;
      const nextSnapshot = state.snapshot;
      if (!nextSnapshot || nextSnapshot === previousSnapshot) return;
      const previous = previousSnapshot;
      previousSnapshot = nextSnapshot;

      if (changed(previous, nextSnapshot, 'settings')) run(applySettings(nextSnapshot, owner));
      if (changed(previous, nextSnapshot, 'providers')) {
        run(dependencies.providers.loadProviderConfigs(owner));
      }
      if (changed(previous, nextSnapshot, 'tools')) {
        run(dependencies.tools.loadSettings(owner));
        run(refreshWebSearchSettings(owner));
      }
      if (changed(previous, nextSnapshot, 'skills')) {
        run(useSkillsStore.getState().refreshSkills(owner));
      }
    }));
    if (application) {
      const revoke = () => { void stop().catch((error) => console.error('Configuration cleanup failed:', error)); };
      application.signal.addEventListener('abort', revoke, { once: true });
      owner.own(() => application.signal.removeEventListener('abort', revoke));
    }
    cleanup = stop;
    return stop;
  } catch (error) {
    void stop().catch((cleanupError) => console.error('Configuration cleanup failed:', cleanupError));
    throw error;
  }
};

export const disposeConfigRuntimeEffectsForTests = (): void => {
  cleanup?.();
};
