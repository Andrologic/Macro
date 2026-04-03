/**
 * Preferences Service
 *
 * Handles persistent storage of user preferences using Tauri Store plugin
 * with localStorage fallback for non-Tauri environments (mock mode).
 */

import { load, Store } from "@tauri-apps/plugin-store";
import { DEFAULT_NOTIFICATION_CHANNEL_MODES } from './notificationChannels';

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
  AGENT_TYPE: "agentType",
  RECENT_PROJECTS: "recentProjects",
  MACRO_ENABLED_PROJECTS: "macroEnabledProjects",
  AI_CONTEXT_SELECTIONS: "aiContextSelections",
  PROMPT_ARCHITECT: "promptArchitect",
  PROMPT_IMPLEMENT: "promptImplement",
  PROMPT_CHAT: "promptChat",
  PROMPT_DEBUG: "promptDebug",
  IMPLEMENT_EXECUTION_MODE: "implementExecutionMode",
  NOTIFICATION_CHANNEL_MODES: "notificationChannelModes",
  ARCHITECT_GIT_BASE_BRANCH: "architectGitBaseBranch",
  ARCHITECT_GIT_MAIN_BRANCH: "architectGitMainBranch",
  ARCHITECT_PLAN_BRANCH_TEMPLATE: "architectPlanBranchTemplate",
  ARCHITECT_FEATURE_BRANCH_TEMPLATE: "architectFeatureBranchTemplate",
  ARCHITECT_STANDALONE_FEATURE_BRANCH_TEMPLATE: "architectStandaloneFeatureBranchTemplate",
  ARCHITECT_RELEASE_BRANCH_TEMPLATE: "architectReleaseBranchTemplate",
  ARCHITECT_HOTFIX_BRANCH_TEMPLATE: "architectHotfixBranchTemplate",
  ARCHITECT_BUGFIX_BRANCH_TEMPLATE: "architectBugfixBranchTemplate",
  ARCHITECT_SYNC_TARGET_BEFORE_FINISH: "architectSyncTargetBeforeFinish",
  METADATA_AUTO_PUSH: "metadataAutoPush",
  TERMINAL_PANEL_HEIGHT: "terminalPanelHeight",
  TERMINAL_ACTIVE_TAB_ID: "terminalActiveTabId",
  TERMINAL_LAST_MANUAL_PROJECT_BY_TASK: "terminalLastManualProjectByTask",
  NOTIFICATION_CENTER_ITEMS: "notificationCenterItems",
  CHAT_ARCHIVED_CONVERSATION_IDS: "chatArchivedConversationIds",
  NATIVE_MACOS_TITLEBAR_BG: "nativeMacosTitlebarBg",
  NATIVE_MACOS_TITLEBAR_THEME: "nativeMacosTitlebarTheme",
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
  [PREF_KEYS.AGENT_TYPE]: 'build',
  [PREF_KEYS.RECENT_PROJECTS]: [],
  [PREF_KEYS.MACRO_ENABLED_PROJECTS]: [],
  [PREF_KEYS.AI_CONTEXT_SELECTIONS]: {
    version: 1,
    modeSelections: {},
    conversationSelections: {},
  },
  [PREF_KEYS.PROMPT_ARCHITECT]: "You are the Architect AI. Your job is to analyze the user's project, identify requirements, and produce structured strategies stored in the `@macro` branch metadata.\n\nIMPORTANT RULES:\n1. Each plan is isolated: one plan has its own conversation, needs, and strategy.\n2. Always ensure a plan is active before strategy actions.\n3. Use `need_add` for each requirement. Do not only describe needs in plain text.\n4. Do not call `strategy_generate` automatically. First discuss and refine needs with the user. Call `strategy_generate` only after an explicit user request to generate or regenerate strategy.\n5. Use `strategy_get` before modifying and `strategy_update` to patch or replace strategy.\n6. Use `strategy_delete` only when explicitly requested and always pass confirm=true.\n7. Never call `plan_create`, `plan_delete`, `plan_restore`, or `plan_set_active` in Architect chat. The AI may only work on existing plans via `plan_list`, `plan_get`, and `plan_update`. If a plan must be created, selected, archived, deleted, or restored, ask the user to do it from the plan selector.\n8. `plan_update` may only change the optional label/title alias and description. It must never change plan status or activate a plan.\n9. New plans still use a generated identifier as canonical title and slug when the user creates them manually. Optional labels and descriptions are secondary metadata only.\n10. Git workflow is strict: each subproject GitFlow profile defines a development target branch plus a main branch, and each new plan integrates on a plan branch rendered from that profile. Planned work branches are rendered per subproject as feature/release/hotfix/bugfix branches. Independent implementation features use a dedicated standalone feature template that is also resolved per subproject. In strategy payloads, prefer `branchType` plus `branchSlug`; concrete branch names are derived later from each subproject's settings.\n11. Never ask the user for a plan title before manual creation. If the user wants a friendlier description on an existing plan, store it as an optional label via `plan_update.label` or the legacy `title` alias.\n12. Never rename the canonical id or slug of a new plan. For new plans, `plan_update.title` and `strategy_generate.plan_title` are only aliases for the optional secondary label.",
  [PREF_KEYS.PROMPT_IMPLEMENT]: "You are the Implementer. Follow the tasks to implement the specific feature.",
  [PREF_KEYS.PROMPT_CHAT]: "You are a helpful AI assistant.",
  [PREF_KEYS.PROMPT_DEBUG]: "You are the Debugger. Use workspace tools to investigate and fix issues.",
  [PREF_KEYS.IMPLEMENT_EXECUTION_MODE]: "semi_auto",
  [PREF_KEYS.NOTIFICATION_CHANNEL_MODES]: DEFAULT_NOTIFICATION_CHANNEL_MODES,
  [PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH]: 'develop',
  [PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH]: 'main',
  [PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE]: 'plan/{planSlug}',
  [PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE]: 'feature/{planSlug}/{featureSlug}',
  [PREF_KEYS.ARCHITECT_STANDALONE_FEATURE_BRANCH_TEMPLATE]: 'feature/{featureSlug}',
  [PREF_KEYS.ARCHITECT_RELEASE_BRANCH_TEMPLATE]: 'release/{releaseSlug}',
  [PREF_KEYS.ARCHITECT_HOTFIX_BRANCH_TEMPLATE]: 'hotfix/{hotfixSlug}',
  [PREF_KEYS.ARCHITECT_BUGFIX_BRANCH_TEMPLATE]: 'bugfix/{bugfixSlug}',
  [PREF_KEYS.ARCHITECT_SYNC_TARGET_BEFORE_FINISH]: true,
  [PREF_KEYS.METADATA_AUTO_PUSH]: false,
  [PREF_KEYS.TERMINAL_PANEL_HEIGHT]: 280,
  [PREF_KEYS.TERMINAL_ACTIVE_TAB_ID]: null,
  [PREF_KEYS.TERMINAL_LAST_MANUAL_PROJECT_BY_TASK]: {},
  [PREF_KEYS.NOTIFICATION_CENTER_ITEMS]: [],
  [PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS]: [],
  [PREF_KEYS.NATIVE_MACOS_TITLEBAR_BG]: "#09090b",
  [PREF_KEYS.NATIVE_MACOS_TITLEBAR_THEME]: "dark",
};

// Store instance (singleton)
let storeInstance: Store | null = null;
let initPromise: Promise<Store> | null = null;
const debouncedSaveTimers = new Map<PrefKey, ReturnType<typeof setTimeout>>();

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

export function savePreferenceDebounced<T>(
  key: PrefKey,
  value: T,
  delayMs: number = 180
): void {
  localStorage.setItem(`macro_${key}`, JSON.stringify(value));

  const existingTimer = debouncedSaveTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    debouncedSaveTimers.delete(key);
    void savePreference(key, value);
  }, delayMs);

  debouncedSaveTimers.set(key, timer);
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
