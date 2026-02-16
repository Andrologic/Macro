/**
 * Preferences Service
 *
 * Handles persistent storage of user preferences using Tauri Store plugin
 * with localStorage fallback for non-Tauri environments (mock mode).
 */

import { load, Store } from "@tauri-apps/plugin-store";

// Preference keys
export const PREF_KEYS = {
  // Window state
  WINDOW_WIDTH: "windowWidth",
  WINDOW_HEIGHT: "windowHeight",
  WINDOW_X: "windowX",
  WINDOW_Y: "windowY",
  IS_MAXIMIZED: "isMaximized",

  // Panel state
  LEFT_PANEL_WIDTH: "leftPanelWidth",
  RIGHT_PANEL_WIDTH: "rightPanelWidth",
  IS_LEFT_PANEL_OPEN: "isLeftPanelOpen",
  IS_RIGHT_PANEL_OPEN: "isRightPanelOpen",

  // App preferences
  THEME: "theme",
  LANGUAGE: "language",
  UI_ZOOM_MODE: "uiZoomMode",
  UI_ZOOM_LEVEL: "uiZoomLevel",
  SHORTCUT_BINDINGS: "shortcutBindings",
  PROMPT_HISTORY_NAV_MODE: "promptHistoryNavigationMode",
  LAST_SELECTED_GROUP_ID: "lastSelectedGroupId",
  LAST_SELECTED_PROJECT_ID: "lastSelectedProjectId",
} as const;

export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

// Default values
export const PREF_DEFAULTS: Record<PrefKey, unknown> = {
  [PREF_KEYS.WINDOW_WIDTH]: 1200,
  [PREF_KEYS.WINDOW_HEIGHT]: 800,
  [PREF_KEYS.WINDOW_X]: null,
  [PREF_KEYS.WINDOW_Y]: null,
  [PREF_KEYS.IS_MAXIMIZED]: false,
  [PREF_KEYS.LEFT_PANEL_WIDTH]: 280,
  [PREF_KEYS.RIGHT_PANEL_WIDTH]: 320,
  [PREF_KEYS.IS_LEFT_PANEL_OPEN]: true,
  [PREF_KEYS.IS_RIGHT_PANEL_OPEN]: true,
  [PREF_KEYS.THEME]: "macro-dark",
  [PREF_KEYS.LANGUAGE]: "en",
  [PREF_KEYS.UI_ZOOM_MODE]: "auto",
  [PREF_KEYS.UI_ZOOM_LEVEL]: 1,
  [PREF_KEYS.SHORTCUT_BINDINGS]: {},
  [PREF_KEYS.PROMPT_HISTORY_NAV_MODE]: "contextual_arrows",
  [PREF_KEYS.LAST_SELECTED_GROUP_ID]: null,
  [PREF_KEYS.LAST_SELECTED_PROJECT_ID]: null,
};

// Store instance (singleton)
let storeInstance: Store | null = null;
let initPromise: Promise<Store> | null = null;

/**
 * Check if running in Tauri environment
 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Get or create the store instance
 */
async function getStore(): Promise<Store | null> {
  if (!isTauri()) {
    return null;
  }

  if (storeInstance) {
    return storeInstance;
  }

  if (!initPromise) {
    initPromise = load("preferences.json");
  }

  storeInstance = await initPromise;
  return storeInstance;
}

/**
 * Save a preference value
 */
export async function savePreference<T>(key: PrefKey, value: T): Promise<void> {
  try {
    const store = await getStore();
    if (store) {
      await store.set(key, value);
      await store.save();
    } else {
      // Fallback to localStorage
      localStorage.setItem(`macro_${key}`, JSON.stringify(value));
    }
  } catch (error) {
    console.error(`Failed to save preference ${key}:`, error);
    // Fallback to localStorage on error
    localStorage.setItem(`macro_${key}`, JSON.stringify(value));
  }
}

/**
 * Load a preference value
 */
export async function loadPreference<T>(key: PrefKey): Promise<T> {
  const defaultValue = PREF_DEFAULTS[key] as T;

  try {
    const store = await getStore();
    if (store) {
      const value = await store.get<T>(key);
      return value !== null && value !== undefined ? value : defaultValue;
    } else {
      // Fallback to localStorage
      const stored = localStorage.getItem(`macro_${key}`);
      if (stored) {
        return JSON.parse(stored) as T;
      }
      return defaultValue;
    }
  } catch (error) {
    console.error(`Failed to load preference ${key}:`, error);
    return defaultValue;
  }
}

/**
 * Load multiple preferences at once
 */
export async function loadPreferences<T extends Partial<Record<PrefKey, unknown>>>(
  keys: PrefKey[]
): Promise<T> {
  const result: Record<string, unknown> = {};

  await Promise.all(
    keys.map(async (key) => {
      result[key] = await loadPreference(key);
    })
  );

  return result as T;
}

/**
 * Save multiple preferences at once
 */
export async function savePreferences(
  preferences: Partial<Record<PrefKey, unknown>>
): Promise<void> {
  await Promise.all(
    Object.entries(preferences).map(([key, value]) =>
      savePreference(key as PrefKey, value)
    )
  );
}

/**
 * Clear all preferences (reset to defaults)
 */
export async function clearPreferences(): Promise<void> {
  try {
    const store = await getStore();
    if (store) {
      await store.clear();
      await store.save();
    } else {
      // Clear localStorage fallback
      Object.keys(PREF_KEYS).forEach((key) => {
        localStorage.removeItem(`macro_${key}`);
      });
    }
  } catch (error) {
    console.error("Failed to clear preferences:", error);
  }
}
