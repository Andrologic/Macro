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
  LAST_OPEN_PROJECT_PATH: "lastOpenProjectPath",
  LAST_ACTIVE_MODE: "lastActiveMode",
  RECENT_PROJECTS: "recentProjects",
  MACRO_ENABLED_PROJECTS: "macroEnabledProjects",
  AI_CONTEXT_SELECTIONS: "aiContextSelections",
  PROMPT_ARCHITECT: "promptArchitect",
  PROMPT_IMPLEMENT: "promptImplement",
  PROMPT_CHAT: "promptChat",
  PROMPT_DEBUG: "promptDebug",
  ARCHITECT_GIT_BASE_BRANCH: "architectGitBaseBranch",
  ARCHITECT_PLAN_BRANCH_TEMPLATE: "architectPlanBranchTemplate",
  ARCHITECT_FEATURE_BRANCH_TEMPLATE: "architectFeatureBranchTemplate",
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
  [PREF_KEYS.LAST_OPEN_PROJECT_PATH]: null,
  [PREF_KEYS.LAST_ACTIVE_MODE]: 'Implement',
  [PREF_KEYS.RECENT_PROJECTS]: [],
  [PREF_KEYS.MACRO_ENABLED_PROJECTS]: [],
  [PREF_KEYS.AI_CONTEXT_SELECTIONS]: {
    version: 1,
    modeSelections: {},
    conversationSelections: {},
  },
  [PREF_KEYS.PROMPT_ARCHITECT]: "You are the Architect AI. Your job is to analyze the user's project, identify requirements, and produce structured strategies stored in the `.macro` branch metadata.\n\nIMPORTANT RULES:\n1. Each plan is isolated: one plan has its own conversation, needs, and strategy.\n2. Always ensure a plan is active before strategy actions.\n3. Use `need_add` for each requirement. Do not only describe needs in plain text.\n4. Do not call `strategy_generate` automatically. First discuss and refine needs with the user. Call `strategy_generate` only after an explicit user request to generate/regenerate strategy.\n5. Use `strategy_get` before modifying and `strategy_update` to patch or replace strategy.\n6. Use `strategy_delete` only when explicitly requested and always pass confirm=true.\n7. Use plan management tools for plan lifecycle: `plan_create`, `plan_list`, `plan_get`, `plan_update`, `plan_delete`, `plan_restore`, `plan_set_active`.\n8. Git workflow is strict: each plan integrates on `plan/<plan-slug>` created from `develop`; task/feature branches must be `feature/<plan-slug>/<feature-slug>` and merge into `plan/<plan-slug>` in dependency order.\n9. Plan names/slugs are unique and cannot be reused, even if a plan was deleted.\n10. A default plan named 'New Plan' may be active. When the user first describes their project or when context changes significantly, write a message proposing a concise updated title and description, then call `plan_update` to apply them. Never update plan metadata silently — always announce the proposed changes in your message before calling the tool.",
  [PREF_KEYS.PROMPT_IMPLEMENT]: "You are the Implementer. Follow the tasks to implement the specific feature.",
  [PREF_KEYS.PROMPT_CHAT]: "You are a helpful AI assistant.",
  [PREF_KEYS.PROMPT_DEBUG]: "You are the Debugger. Use workspace tools to investigate and fix issues.",
  [PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH]: 'develop',
  [PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE]: 'plan/{planSlug}',
  [PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE]: 'feature/{planSlug}/{featureSlug}',
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
  // Always mirror to localStorage synchronously for crash/close resilience
  localStorage.setItem(`macro_${key}`, JSON.stringify(value));

  try {
    const store = await getStore();
    if (store) {
      await store.set(key, value);
      await store.save();
    }
  } catch (error) {
    console.error(`Failed to save preference ${key}:`, error);
  }
}

/**
 * Load a preference value
 */
export async function loadPreference<T>(key: PrefKey): Promise<T> {
  const defaultValue = PREF_DEFAULTS[key] as T;
  const localStorageKey = `macro_${key}`;

  try {
    const localValue = localStorage.getItem(localStorageKey);
    if (localValue) {
      return JSON.parse(localValue) as T;
    }

    const store = await getStore();
    if (store) {
      const value = await store.get<T>(key);
      return value !== null && value !== undefined ? value : defaultValue;
    }

    return defaultValue;
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
