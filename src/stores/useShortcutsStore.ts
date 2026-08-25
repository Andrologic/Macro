import { create } from 'zustand';
import { shortcutDefaults, shortcutDefinitions, ShortcutId } from '../shortcuts/catalog';
import { normalizeBinding } from '../shortcuts/utils';
import { shortcutsCanConflict } from '../shortcuts/runtime';
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
  shortcutDefinitions.forEach((definition) => {
    normalized[definition.id] = definition.defaultBinding
      ? normalizeBinding(definition.defaultBinding)
      : null;
  });
  return normalized as ShortcutBindings;
};

const persistBindings = async (bindings: ShortcutBindings) => {
  await savePreference(PREF_KEYS.SHORTCUT_BINDINGS, bindings);
};

const hasBindingConflict = (bindings: ShortcutBindings, id: ShortcutId, binding: string | null): boolean =>
  Boolean(binding) && shortcutDefinitions.some((other) =>
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

        const merged: ShortcutBindings = { ...defaults };
        Object.keys(defaults).forEach((id) => {
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
      mutationVersion += 1;
      set((state) => {
        const nextBinding = shortcutDefaults[id]
          ? normalizeBinding(shortcutDefaults[id] as string)
          : null;
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
      const nextBindings = buildNormalizedDefaults();
      void Promise.all([
        persistBindings(nextBindings),
        savePreference(PREF_KEYS.PROMPT_HISTORY_NAV_MODE, 'contextual_arrows'),
        savePreference(PREF_KEYS.ACTIVE_TURN_SEND_BEHAVIOR, 'steer'),
      ]);
      set({ bindings: nextBindings, promptHistoryNavigationMode: 'contextual_arrows', activeTurnSendBehavior: 'steer' });
    },
  };
});
