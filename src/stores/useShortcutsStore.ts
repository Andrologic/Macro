import { create } from 'zustand';
import { shortcutDefaults, shortcutDefinitions, ShortcutId } from '../shortcuts/catalog';
import { normalizeBinding } from '../shortcuts/utils';
import { loadPreference, PREF_KEYS, savePreference } from '../services/preferences';

type ShortcutBindings = Record<ShortcutId, string | null>;

interface ShortcutsStore {
  bindings: ShortcutBindings;
  isLoaded: boolean;
  initialize: () => Promise<void>;
  setBinding: (id: ShortcutId, binding: string | null) => void;
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

export const useShortcutsStore = create<ShortcutsStore>((set) => ({
  bindings: buildNormalizedDefaults(),
  isLoaded: false,

  initialize: async () => {
    const defaults = buildNormalizedDefaults();
    try {
      const rawStored = await loadPreference<Record<string, unknown>>(PREF_KEYS.SHORTCUT_BINDINGS);
      const stored = rawStored && typeof rawStored === 'object' ? rawStored : {};

      const merged: ShortcutBindings = { ...defaults };
      Object.keys(defaults).forEach((id) => {
        const value = stored[id];
        if (value === null) {
          merged[id as ShortcutId] = null;
        } else if (typeof value === 'string') {
          merged[id as ShortcutId] = normalizeBinding(value);
        }
      });

      set({ bindings: merged, isLoaded: true });
    } catch {
      set({ bindings: defaults, isLoaded: true });
    }
  },

  setBinding: (id, binding) =>
    set((state) => {
      const normalized = binding ? normalizeBinding(binding) : null;
      const nextBindings = {
        ...state.bindings,
        [id]: normalized,
      };
      void persistBindings(nextBindings);
      return { bindings: nextBindings };
    }),

  resetBinding: (id) =>
    set((state) => {
      const nextBindings = {
        ...state.bindings,
        [id]: shortcutDefaults[id] ? normalizeBinding(shortcutDefaults[id] as string) : null,
      };
      void persistBindings(nextBindings);
      return { bindings: nextBindings };
    }),

  resetAll: () => {
    const nextBindings = buildNormalizedDefaults();
    void persistBindings(nextBindings);
    set({ bindings: nextBindings });
  },
}));
