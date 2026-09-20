import { create } from 'zustand';
import { ShortcutId } from '../shortcuts/catalog';
import { normalizeBinding } from '../shortcuts/utils';
import { commandRegistry, shortcutsCanConflict } from '../shortcuts/runtime';
import { loadPreference, PREF_KEYS, savePreference } from '../services/preferences';

type ShortcutBindings = Record<ShortcutId, string | null>;
export type PromptHistoryNavigationMode = 'contextual_arrows' | 'shortcut_only';
export type ActiveTurnSendBehavior = 'steer' | 'queue';

interface ShortcutsStore {
  bindings: ShortcutBindings;
  promptHistoryNavigationMode: PromptHistoryNavigationMode;
  activeTurnSendBehavior: ActiveTurnSendBehavior;
  isLoaded: boolean;
  initialize: () => Promise<void>;
  setBinding: (id: ShortcutId, binding: string | null) => void;
  setPromptHistoryNavigationMode: (mode: PromptHistoryNavigationMode) => void;
  setActiveTurnSendBehavior: (behavior: ActiveTurnSendBehavior) => void;
  resetBinding: (id: ShortcutId) => void;
  resetAll: () => void;
}

const buildNormalizedDefaults = (): ShortcutBindings => {
  const normalized: Partial<ShortcutBindings> = {};
  commandRegistry.all().forEach(({ id, definition }) => {
    normalized[id] = definition.defaultBinding
      ? normalizeBinding(definition.defaultBinding)
      : null;
  });
  return normalized as ShortcutBindings;
};

const persistBindings = async (bindings: ShortcutBindings) => {
  await savePreference(PREF_KEYS.SHORTCUT_BINDINGS, bindings);
};

const hasBindingConflict = (bindings: ShortcutBindings, id: ShortcutId, binding: string | null): boolean =>
  Boolean(binding) && commandRegistry.all().some((other) =>
    other.id !== id &&
    bindings[other.id] === binding &&
    shortcutsCanConflict(id, other.id)
  );

export const useShortcutsStore = create<ShortcutsStore>((set) => {
  let mutationVersion = 0;

  return {
    bindings: buildNormalizedDefaults(),
    promptHistoryNavigationMode: 'contextual_arrows',
    activeTurnSendBehavior: 'steer',
    isLoaded: false,

    initialize: async () => {
      const defaults = buildNormalizedDefaults();
      const hydrationVersion = mutationVersion;
      try {
        const [rawStored, rawNavigationMode, rawActiveTurnSendBehavior] = await Promise.all([
          loadPreference<Record<string, unknown>>(PREF_KEYS.SHORTCUT_BINDINGS),
          loadPreference<string>(PREF_KEYS.PROMPT_HISTORY_NAV_MODE),
          loadPreference<string>(PREF_KEYS.ACTIVE_TURN_SEND_BEHAVIOR),
        ]);
        if (hydrationVersion !== mutationVersion) {
          set({ isLoaded: true });
          return;
        }
        const stored = rawStored && typeof rawStored === 'object' ? rawStored : {};
        const promptHistoryNavigationMode: PromptHistoryNavigationMode =
          rawNavigationMode === 'shortcut_only' ? 'shortcut_only' : 'contextual_arrows';
        const activeTurnSendBehavior: ActiveTurnSendBehavior =
          rawActiveTurnSendBehavior === 'queue' ? 'queue' : 'steer';

        const merged: ShortcutBindings = buildNormalizedDefaults();
        Object.keys(stored).forEach((id) => {
          const value = stored[id];
          if (value === null) {
            merged[id as ShortcutId] = null;
          } else if (typeof value === 'string') {
            merged[id as ShortcutId] = normalizeBinding(value);
          }
        });

        set({ bindings: merged, promptHistoryNavigationMode, activeTurnSendBehavior, isLoaded: true });
      } catch {
        if (hydrationVersion === mutationVersion) {
          set({ bindings: defaults, promptHistoryNavigationMode: 'contextual_arrows', isLoaded: true });
        } else {
          set({ isLoaded: true });
        }
      }
    },

    setBinding: (id, binding) => {
      if (!commandRegistry.all().some((entry) => entry.id === id)) return;
      mutationVersion += 1;
      set((state) => {
        const normalized = binding ? normalizeBinding(binding) : null;
        if (hasBindingConflict(state.bindings, id, normalized)) {
          return state;
        }
        const nextBindings = {
          ...state.bindings,
          [id]: normalized,
        };
        void persistBindings(nextBindings);
        return { bindings: nextBindings };
      });
    },

    setPromptHistoryNavigationMode: (mode) => {
      mutationVersion += 1;
      void savePreference(PREF_KEYS.PROMPT_HISTORY_NAV_MODE, mode);
      set({ promptHistoryNavigationMode: mode });
    },

    setActiveTurnSendBehavior: (behavior) => {
      mutationVersion += 1;
      void savePreference(PREF_KEYS.ACTIVE_TURN_SEND_BEHAVIOR, behavior);
      set({ activeTurnSendBehavior: behavior });
    },

    resetBinding: (id) => {
      if (!commandRegistry.all().some((entry) => entry.id === id)) return;
      mutationVersion += 1;
      set((state) => {
        const defaultBinding = commandRegistry.all().find((entry) => entry.id === id)?.definition.defaultBinding;
        const nextBinding = defaultBinding ? normalizeBinding(defaultBinding) : null;
        if (hasBindingConflict(state.bindings, id, nextBinding)) {
          return state;
        }
        const nextBindings = {
          ...state.bindings,
          [id]: nextBinding,
        };
        void persistBindings(nextBindings);
        return { bindings: nextBindings };
      });
    },

    resetAll: () => {
      mutationVersion += 1;
      const nextBindings = { ...useShortcutsStore.getState().bindings, ...buildNormalizedDefaults() };
      void Promise.all([
        persistBindings(nextBindings),
        savePreference(PREF_KEYS.PROMPT_HISTORY_NAV_MODE, 'contextual_arrows'),
        savePreference(PREF_KEYS.ACTIVE_TURN_SEND_BEHAVIOR, 'steer'),
      ]);
      set({ bindings: nextBindings, promptHistoryNavigationMode: 'contextual_arrows', activeTurnSendBehavior: 'steer' });
    },
  };
});

// Keep custom bindings across removal/re-registration, including explicit nulls.
commandRegistry.subscribe(() => {
  const { bindings } = useShortcutsStore.getState();
  useShortcutsStore.setState({ bindings: { ...buildNormalizedDefaults(), ...bindings } });
});
