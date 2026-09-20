import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createLifecycleScope } from '../services/lifecycleScope';

const preferences = await import('../services/preferences');
afterEach(() => mock.restore());

describe('useShortcutsStore initialization lifetime', () => {
  it('preserves a user mutation and ignores a hydration completed after stop', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mock.module('../services/preferences', () => ({
      ...preferences,
      loadPreference: async (key: string) => {
        await pending;
        return key === preferences.PREF_KEYS.SHORTCUT_BINDINGS ? {} : 'steer';
      },
      savePreference: async () => undefined,
    }));
    const modulePath = './useShortcutsStore.ts?lifecycle-test';
    const { useShortcutsStore } = await import(modulePath);
    const scope = createLifecycleScope();
    const initializing = useShortcutsStore.getState().initialize(scope).catch((error: unknown) => error);
    useShortcutsStore.getState().setActiveTurnSendBehavior('queue');
    scope.stop();
    release();
    expect((await initializing).name).toBe('LifecycleStoppedError');
    expect(useShortcutsStore.getState().activeTurnSendBehavior).toBe('queue');
    expect(useShortcutsStore.getState().isLoaded).toBe(false);
  });
});
