/**
 * Preferences Service
 *
 * Handles persistent storage of user preferences using Tauri Store plugin
 * with localStorage fallback for non-Tauri environments (mock mode).
 */

import { load, Store } from "@tauri-apps/plugin-store";
import type { AppMode, ToolRiskLevel } from "../types";
import { DEFAULT_NOTIFICATION_CHANNEL_MODES } from './notificationChannels';
import { getDefaultProjectOpenCommand } from './projectOpenDefaults';
import {
  DEFAULT_TOOL_RISK_LEVEL,
  TOOL_RISK_LEVELS,
} from './toolSecurityPolicy';

// Preference keys
export const PREF_KEYS = {
  // Window state
  WINDOW_WIDTH: "windowWidth",
  WINDOW_HEIGHT: "windowHeight",
  WINDOW_X: "windowX",
  WINDOW_Y: "windowY",
  IS_MAXIMIZED: "isMaximized",
  WINDOW_BOOTSTRAP_VERSION: "windowBootstrapVersion",

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
  CODE_OVERFLOW_MODE: "codeOverflowMode",
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
  PROMPT_PLAN_EXPLORER: "promptPlanExplorer",
  PROMPT_TASK_REVIEWER: "promptTaskReviewer",
  PROMPT_REPO_AUDITOR: "promptRepoAuditor",
  TOOL_RISK_LEVEL: "toolRiskLevel",
  IMPLEMENT_DIFF_PRESENTATION_MODE: "implementDiffPresentationMode",
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
  PROJECT_OPEN_EDITOR_APP: "projectOpenEditorApp",
  PROJECT_OPEN_TERMINAL_APP: "projectOpenTerminalApp",
  PROJECT_OPEN_FILES_APP: "projectOpenFilesApp",
  PROJECT_OPEN_EDITOR_COMMAND: "projectOpenEditorCommand",
  PROJECT_OPEN_TERMINAL_COMMAND: "projectOpenTerminalCommand",
  PROJECT_OPEN_FILES_COMMAND: "projectOpenFilesCommand",
} as const;

export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

const DEFAULT_MODE_PROMPTS = {
  [PREF_KEYS.PROMPT_ARCHITECT]:
    "You are the Architect AI. Your job is to analyze the user's project, capture requirements on the active plan, and produce structured strategies stored in the `@macro` branch metadata.\n\nIMPORTANT RULES:\n1. Each plan is isolated: one plan has its own conversation, needs, and strategy.\n2. All `need_*` tools operate on the active plan only. Use them to add, inspect, list, and refine needs instead of only describing requirements in plain text.\n3. Respect the current Macro tool security level. Some tools may require approval or be unavailable, and destructive Architect actions such as `need_delete` and `strategy_delete` still require `confirm=true` when they are allowed.\n4. Do not call `strategy_generate` automatically. First discuss and refine needs with the user. Call `strategy_generate` only after an explicit user request to generate or regenerate strategy.\n5. Use `strategy_get` before modifying and `strategy_update` to patch or replace strategy.\n6. The Architect chat surface includes `plan_list`, `plan_get`, and `plan_update`, but plan lifecycle actions stay UI-only in this iteration.\n7. Never call `plan_create`, `plan_delete`, `plan_restore`, or `plan_set_active` in Architect chat. If a plan must be created, selected, archived, deleted, or restored, ask the user to do it from the plan selector.\n8. `plan_update` may only change the optional label/title alias, description, and the logical plan slug while the plan is still a mutable draft. It must never change plan status or activate a plan.\n9. New plans have an immutable technical id plus a logical plan slug. The slug can stay mutable while the plan is still a draft with no started work, then it becomes locked.\n10. Git workflow is strict: each subproject GitFlow profile defines a development target branch plus a main branch, and each new plan integrates on a plan branch rendered from that profile. Planned work branches are rendered per subproject from the logical plan slug plus each node's logical `featureSlug`. Independent implementation features use a dedicated standalone feature template that is also resolved per subproject. In strategy payloads, prefer `plan_slug` and `featureSlug`; concrete Git branch names are derived later from each subproject's settings.\n11. A node is not the same thing as a branch. Multiple sequential nodes may share the same `featureSlug` when they stay on the same logical branch. Split into multiple branches only when the work can run in parallel.\n12. Never ask the user for a plan title before manual creation. If the user wants a friendlier description on an existing plan, store it as an optional label via `plan_update.label` or the legacy `title` alias.\n13. If a strategy tool reports frozen-node conflicts and requests a repair retry, immediately call the same strategy tool once with a corrected full strategy that preserves the frozen nodes exactly. If the tool stages a preview or blocks, stop retrying and explain that the user must review the preview.\n14. After using an Architect tool, always produce a short natural-language recap of what changed, what you learned, and the next useful step. Do not stop at tool calls only.",
  [PREF_KEYS.PROMPT_IMPLEMENT]:
    "You are the Implementer. Follow the tasks to implement the specific feature.",
  [PREF_KEYS.PROMPT_CHAT]:
    "You are a helpful AI assistant.",
} as const;

const DEFAULT_INTERNAL_PROFILE_PROMPTS = {
  [PREF_KEYS.PROMPT_PLAN_EXPLORER]:
    "Internal agent profile is PLAN_EXPLORER. Inspect the existing plan context, structure what matters, and propose the next useful planning step. Stay exploration-first and avoid code-execution behavior outside the dedicated planning and read-only inspection tools.",
  [PREF_KEYS.PROMPT_TASK_REVIEWER]:
    "Internal agent profile is TASK_REVIEWER. Review changes critically from diffs, touched files, and verification results. Prefer minimal, targeted fixes and keep the task review easy for a human to validate.",
  [PREF_KEYS.PROMPT_REPO_AUDITOR]:
    "Internal agent profile is REPO_AUDITOR. Diagnose repository, worktree, merge, and finalization blockers carefully. Focus on safe remediation of the reported Git issues only, and do not broaden the change scope.",
} as const;

export const PROMPT_PREFERENCE_KEYS = [
  PREF_KEYS.PROMPT_ARCHITECT,
  PREF_KEYS.PROMPT_IMPLEMENT,
  PREF_KEYS.PROMPT_CHAT,
  PREF_KEYS.PROMPT_PLAN_EXPLORER,
  PREF_KEYS.PROMPT_TASK_REVIEWER,
  PREF_KEYS.PROMPT_REPO_AUDITOR,
] as const;

export type PromptPreferenceKey = (typeof PROMPT_PREFERENCE_KEYS)[number];

export type PromptPreferenceDefinition = {
  key: PromptPreferenceKey;
  label: string;
  description: string;
  scope: "mode" | "internal_profile";
};

export const MODE_PROMPT_KEYS_BY_MODE: Record<AppMode, PromptPreferenceKey> = {
  Architect: PREF_KEYS.PROMPT_ARCHITECT,
  Implement: PREF_KEYS.PROMPT_IMPLEMENT,
  Chat: PREF_KEYS.PROMPT_CHAT,
};

export const INTERNAL_AGENT_PROFILE_PROMPT_KEYS = {
  plan_explorer: PREF_KEYS.PROMPT_PLAN_EXPLORER,
  task_reviewer: PREF_KEYS.PROMPT_TASK_REVIEWER,
  repo_auditor: PREF_KEYS.PROMPT_REPO_AUDITOR,
} as const;

export type PromptBackedInternalAgentProfile =
  keyof typeof INTERNAL_AGENT_PROFILE_PROMPT_KEYS;

const PROMPT_DEFAULTS = {
  ...DEFAULT_MODE_PROMPTS,
  ...DEFAULT_INTERNAL_PROFILE_PROMPTS,
} as const satisfies Record<PromptPreferenceKey, string>;

export const PROMPT_PREFERENCE_DEFINITIONS: PromptPreferenceDefinition[] = [
  {
    key: PREF_KEYS.PROMPT_ARCHITECT,
    label: "Architect Mode",
    description: "Base system prompt for Architect conversations.",
    scope: "mode",
  },
  {
    key: PREF_KEYS.PROMPT_IMPLEMENT,
    label: "Implement Mode",
    description: "Base system prompt for Implement conversations.",
    scope: "mode",
  },
  {
    key: PREF_KEYS.PROMPT_CHAT,
    label: "Chat Mode",
    description: "Base system prompt for general chat conversations.",
    scope: "mode",
  },
  {
    key: PREF_KEYS.PROMPT_PLAN_EXPLORER,
    label: "Plan Explorer Profile",
    description: "Extra guidance injected for Architect planning and exploration flows.",
    scope: "internal_profile",
  },
  {
    key: PREF_KEYS.PROMPT_TASK_REVIEWER,
    label: "Task Reviewer Profile",
    description: "Extra guidance injected while reviewing an Implement task in review.",
    scope: "internal_profile",
  },
  {
    key: PREF_KEYS.PROMPT_REPO_AUDITOR,
    label: "Repo Auditor Profile",
    description: "Extra guidance injected for Git conflict, finalization, and repository audit flows.",
    scope: "internal_profile",
  },
];

export const getDefaultPromptForPreferenceKey = (
  key: PromptPreferenceKey
): string => PROMPT_DEFAULTS[key];

// Default values
export const PREF_DEFAULTS: Record<PrefKey, unknown> = {
  [PREF_KEYS.WINDOW_WIDTH]: 1200,
  [PREF_KEYS.WINDOW_HEIGHT]: 800,
  [PREF_KEYS.WINDOW_X]: null,
  [PREF_KEYS.WINDOW_Y]: null,
  [PREF_KEYS.IS_MAXIMIZED]: false,
  [PREF_KEYS.WINDOW_BOOTSTRAP_VERSION]: 0,
  [PREF_KEYS.LEFT_PANEL_WIDTH]: 280,
  [PREF_KEYS.RIGHT_PANEL_WIDTH]: 320,
  [PREF_KEYS.IS_LEFT_PANEL_OPEN]: true,
  [PREF_KEYS.IS_RIGHT_PANEL_OPEN]: true,
  [PREF_KEYS.THEME]: "macro-dark",
  [PREF_KEYS.LANGUAGE]: "en",
  [PREF_KEYS.UI_ZOOM_MODE]: "auto",
  [PREF_KEYS.UI_ZOOM_LEVEL]: 1,
  [PREF_KEYS.CODE_OVERFLOW_MODE]: "wrap",
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
  [PREF_KEYS.PROMPT_ARCHITECT]: PROMPT_DEFAULTS[PREF_KEYS.PROMPT_ARCHITECT],
  [PREF_KEYS.PROMPT_IMPLEMENT]: PROMPT_DEFAULTS[PREF_KEYS.PROMPT_IMPLEMENT],
  [PREF_KEYS.PROMPT_CHAT]: PROMPT_DEFAULTS[PREF_KEYS.PROMPT_CHAT],
  [PREF_KEYS.PROMPT_PLAN_EXPLORER]: PROMPT_DEFAULTS[PREF_KEYS.PROMPT_PLAN_EXPLORER],
  [PREF_KEYS.PROMPT_TASK_REVIEWER]: PROMPT_DEFAULTS[PREF_KEYS.PROMPT_TASK_REVIEWER],
  [PREF_KEYS.PROMPT_REPO_AUDITOR]: PROMPT_DEFAULTS[PREF_KEYS.PROMPT_REPO_AUDITOR],
  [PREF_KEYS.TOOL_RISK_LEVEL]:
    DEFAULT_TOOL_RISK_LEVEL satisfies ToolRiskLevel,
  [PREF_KEYS.IMPLEMENT_DIFF_PRESENTATION_MODE]: "focused",
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
  [PREF_KEYS.PROJECT_OPEN_EDITOR_APP]: null,
  [PREF_KEYS.PROJECT_OPEN_TERMINAL_APP]: null,
  [PREF_KEYS.PROJECT_OPEN_FILES_APP]: null,
  [PREF_KEYS.PROJECT_OPEN_EDITOR_COMMAND]: getDefaultProjectOpenCommand('editor'),
  [PREF_KEYS.PROJECT_OPEN_TERMINAL_COMMAND]: getDefaultProjectOpenCommand('terminal'),
  [PREF_KEYS.PROJECT_OPEN_FILES_COMMAND]: getDefaultProjectOpenCommand('files'),
};

// Store instance (singleton)
let storeInstance: Store | null = null;
let initPromise: Promise<Store> | null = null;
const debouncedSaveTimers = new Map<PrefKey, ReturnType<typeof setTimeout>>();
const LEGACY_IMPLEMENT_EXECUTION_MODE_KEY = "implementExecutionMode";
const LEGACY_ARCHITECT_TOOL_AUTONOMY_PROFILE_KEY =
  "architectToolAutonomyProfile";

const isToolRiskLevel = (value: unknown): value is ToolRiskLevel =>
  typeof value === "string" &&
  (TOOL_RISK_LEVELS as readonly string[]).includes(value);

const migrateLegacyArchitectToolAutonomyProfile = (
  value: unknown,
): ToolRiskLevel | null => {
  if (value === "guarded") {
    return "strict";
  }
  if (value === "full") {
    return "balanced";
  }
  return null;
};

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

const removePersistedPreferenceKey = async (key: string): Promise<void> => {
  localStorage.removeItem(`macro_${key}`);

  try {
    const store = await getStore();
    if (store) {
      await store.delete(key);
      await store.save();
    }
  } catch (error) {
    console.error(`Failed to remove preference ${key}:`, error);
  }
};

export async function purgeLegacyImplementExecutionModePreference(): Promise<void> {
  await removePersistedPreferenceKey(LEGACY_IMPLEMENT_EXECUTION_MODE_KEY);
}

const loadLegacyArchitectToolAutonomyProfilePreference = async (): Promise<
  ToolRiskLevel | null
> => {
  try {
    const localValue = localStorage.getItem(
      `macro_${LEGACY_ARCHITECT_TOOL_AUTONOMY_PROFILE_KEY}`
    );
    if (localValue !== null) {
      const migrated = migrateLegacyArchitectToolAutonomyProfile(
        JSON.parse(localValue)
      );
      if (migrated) {
        return migrated;
      }
    }

    const store = await getStore();
    if (store) {
      const persisted = await store.get<unknown>(
        LEGACY_ARCHITECT_TOOL_AUTONOMY_PROFILE_KEY
      );
      return migrateLegacyArchitectToolAutonomyProfile(persisted);
    }
  } catch (error) {
    console.error(
      "Failed to load legacy architect autonomy preference:",
      error
    );
  }

  return null;
};

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
      const parsed = JSON.parse(localValue) as T;
      if (key !== PREF_KEYS.TOOL_RISK_LEVEL || isToolRiskLevel(parsed)) {
        return parsed;
      }
    }

    const store = await getStore();
    if (store) {
      const value = await store.get<T>(key);
      if (
        value !== null &&
        value !== undefined &&
        (key !== PREF_KEYS.TOOL_RISK_LEVEL || isToolRiskLevel(value))
      ) {
        return value;
      }
    }

    if (key === PREF_KEYS.TOOL_RISK_LEVEL) {
      const migratedValue =
        await loadLegacyArchitectToolAutonomyProfilePreference();
      if (migratedValue && isToolRiskLevel(migratedValue)) {
        await savePreference(PREF_KEYS.TOOL_RISK_LEVEL, migratedValue);
        await removePersistedPreferenceKey(
          LEGACY_ARCHITECT_TOOL_AUTONOMY_PROFILE_KEY
        );
        return migratedValue as T;
      }
    }

    return defaultValue;
  } catch (error) {
    console.error(`Failed to load preference ${key}:`, error);
    return defaultValue;
  }
}

/**
 * Load a persisted preference value without falling back to defaults.
 */
export async function loadPersistedPreference<T>(
  key: PrefKey
): Promise<T | undefined> {
  const localStorageKey = `macro_${key}`;

  try {
    const localValue = localStorage.getItem(localStorageKey);
    if (localValue !== null) {
      return JSON.parse(localValue) as T;
    }

    const store = await getStore();
    if (store) {
      const value = await store.get<T>(key);
      return value !== null && value !== undefined ? value : undefined;
    }

    return undefined;
  } catch (error) {
    console.error(`Failed to load persisted preference ${key}:`, error);
    return undefined;
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
