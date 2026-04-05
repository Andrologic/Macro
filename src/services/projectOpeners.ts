import * as tauriIpc from './tauriIpc';
import { loadPreference, PREF_KEYS, savePreference } from './preferences';
import {
  getEmptyProjectOpenSelection,
  getFallbackProjectOpenApps,
  NONE_PROJECT_OPEN_APP_ID,
  PROJECT_OPEN_ACTIONS,
  sanitizeProjectOpenAppCatalog,
  type ProjectOpenAction,
  type ProjectOpenAppCatalog,
  type ProjectOpenAppOption,
  type ProjectOpenAppSelection,
} from './projectOpenDefaults';

export type {
  ProjectOpenAction,
  ProjectOpenAppCatalog,
  ProjectOpenAppKind,
  ProjectOpenAppOption,
  ProjectOpenAppSelection,
} from './projectOpenDefaults';
export { getEmptyProjectOpenSelection, PROJECT_OPEN_ACTIONS } from './projectOpenDefaults';

const APP_PREF_KEY_BY_ACTION: Record<ProjectOpenAction, typeof PREF_KEYS[keyof typeof PREF_KEYS]> = {
  editor: PREF_KEYS.PROJECT_OPEN_EDITOR_APP,
  terminal: PREF_KEYS.PROJECT_OPEN_TERMINAL_APP,
  files: PREF_KEYS.PROJECT_OPEN_FILES_APP,
};

let appCatalogCache: Promise<ProjectOpenAppCatalog> | null = null;

const LEGACY_APP_ID_PATTERNS: Record<ProjectOpenAction, Array<{ id: string; pattern: RegExp }>> = {
  editor: [
    { id: 'vscode', pattern: /\bcode\b|visual studio code/i },
    { id: 'vscode-insiders', pattern: /code-insiders|visual studio code - insiders|vs code - insiders/i },
    { id: 'vscodium', pattern: /\bcodium\b|vscodium/i },
    { id: 'cursor', pattern: /cursor/i },
    { id: 'windsurf', pattern: /windsurf/i },
    { id: 'zed', pattern: /\bzed\b/i },
    { id: 'antigravity', pattern: /antigravity/i },
    { id: 'sublime-text', pattern: /subl|sublime/i },
    { id: 'bbedit', pattern: /bbedit/i },
    { id: 'nova', pattern: /\bnova\b/i },
    { id: 'textmate', pattern: /textmate/i },
    { id: 'fleet', pattern: /fleet/i },
    { id: 'intellij-idea', pattern: /intellij|idea64|idea\b/i },
    { id: 'pycharm', pattern: /pycharm/i },
    { id: 'webstorm', pattern: /webstorm/i },
    { id: 'phpstorm', pattern: /phpstorm/i },
    { id: 'goland', pattern: /goland/i },
    { id: 'clion', pattern: /clion/i },
    { id: 'rider', pattern: /rider/i },
    { id: 'rubymine', pattern: /rubymine/i },
    { id: 'rustrover', pattern: /rustrover/i },
    { id: 'lapce', pattern: /lapce/i },
    { id: 'kate', pattern: /\bkate\b/i },
    { id: 'geany', pattern: /geany/i },
  ],
  terminal: [
    { id: 'terminal', pattern: /\bterminal\b/i },
    { id: 'ghostty', pattern: /ghostty/i },
    { id: 'wezterm', pattern: /wezterm/i },
    { id: 'alacritty', pattern: /alacritty/i },
    { id: 'kitty', pattern: /kitty/i },
    { id: 'windows-terminal', pattern: /\bwt\b|windows terminal/i },
    { id: 'powershell', pattern: /powershell/i },
    { id: 'pwsh', pattern: /\bpwsh(?:\.exe)?\b|powershell 7/i },
    { id: 'command-prompt', pattern: /\bcmd(?:\.exe)?\b|command prompt/i },
    { id: 'gnome-terminal', pattern: /gnome-terminal/i },
    { id: 'konsole', pattern: /konsole/i },
    { id: 'xfce4-terminal', pattern: /xfce4-terminal/i },
    { id: 'tilix', pattern: /tilix/i },
    { id: 'mate-terminal', pattern: /mate-terminal/i },
  ],
  files: [
    { id: 'finder', pattern: /finder/i },
    { id: 'explorer', pattern: /explorer/i },
    { id: 'xdg-open', pattern: /xdg-open/i },
    { id: 'nautilus', pattern: /nautilus/i },
    { id: 'dolphin', pattern: /dolphin/i },
    { id: 'thunar', pattern: /thunar/i },
    { id: 'nemo', pattern: /nemo/i },
    { id: 'path-finder', pattern: /path finder/i },
    { id: 'forklift', pattern: /forklift/i },
    { id: 'commander-one', pattern: /commander one/i },
    { id: 'caja', pattern: /caja/i },
    { id: 'pcmanfm', pattern: /pcmanfm/i },
  ],
};

const getAppsForAction = (
  catalog: ProjectOpenAppCatalog,
  action: ProjectOpenAction
): ProjectOpenAppOption[] => catalog[action];

const resolveFirstUsableAppId = (
  catalog: ProjectOpenAppCatalog,
  action: ProjectOpenAction
): string =>
  getAppsForAction(catalog, action).find((app) => app.id !== NONE_PROJECT_OPEN_APP_ID)?.id ??
  NONE_PROJECT_OPEN_APP_ID;

export const normalizeProjectOpenAppId = (
  catalog: ProjectOpenAppCatalog,
  action: ProjectOpenAction,
  candidate: string | null | undefined
): string => {
  const normalized = candidate?.trim() || '';
  if (
    normalized &&
    getAppsForAction(catalog, action).some((app) => app.id === normalized)
  ) {
    return normalized;
  }

  return resolveFirstUsableAppId(catalog, action);
};

export const mapLegacyCommandToAppId = (
  action: ProjectOpenAction,
  command: string | null | undefined,
  catalog: ProjectOpenAppCatalog
): string | null => {
  const normalizedCommand = command?.trim() || '';
  if (!normalizedCommand) {
    return null;
  }

  const match = LEGACY_APP_ID_PATTERNS[action].find(({ pattern }) => pattern.test(normalizedCommand));
  if (!match) {
    return null;
  }

  return getAppsForAction(catalog, action).some((app) => app.id === match.id) ? match.id : null;
};

export const listProjectOpenApps = async (
  options?: { forceRefresh?: boolean }
): Promise<ProjectOpenAppCatalog> => {
  if (options?.forceRefresh) {
    appCatalogCache = null;
  }

  if (!appCatalogCache) {
    appCatalogCache = (async () => {
      if (!tauriIpc.isTauriAvailable()) {
        return sanitizeProjectOpenAppCatalog(getFallbackProjectOpenApps());
      }

      try {
        return sanitizeProjectOpenAppCatalog(await tauriIpc.listExternalApps());
      } catch {
        return sanitizeProjectOpenAppCatalog(getFallbackProjectOpenApps());
      }
    })();
  }

  return appCatalogCache;
};

export const loadProjectOpenSettings = async (): Promise<{
  appsByAction: ProjectOpenAppCatalog;
  selectedAppIdsByAction: ProjectOpenAppSelection;
}> => {
  const appsByAction = await listProjectOpenApps();
  const storedValues = await Promise.all([
    loadPreference<string | null>(PREF_KEYS.PROJECT_OPEN_EDITOR_APP),
    loadPreference<string | null>(PREF_KEYS.PROJECT_OPEN_TERMINAL_APP),
    loadPreference<string | null>(PREF_KEYS.PROJECT_OPEN_FILES_APP),
    loadPreference<string | null>(PREF_KEYS.PROJECT_OPEN_EDITOR_COMMAND),
    loadPreference<string | null>(PREF_KEYS.PROJECT_OPEN_TERMINAL_COMMAND),
    loadPreference<string | null>(PREF_KEYS.PROJECT_OPEN_FILES_COMMAND),
  ]);

  const storedByAction: Record<ProjectOpenAction, string | null> = {
    editor: storedValues[0],
    terminal: storedValues[1],
    files: storedValues[2],
  };
  const legacyByAction: Record<ProjectOpenAction, string | null> = {
    editor: storedValues[3],
    terminal: storedValues[4],
    files: storedValues[5],
  };

  const nextSelection = getEmptyProjectOpenSelection();

  await Promise.all(
    PROJECT_OPEN_ACTIONS.map(async (action) => {
      const storedAppId = storedByAction[action]?.trim() || '';
      const migratedAppId = mapLegacyCommandToAppId(action, legacyByAction[action], appsByAction);
      const resolvedAppId = storedAppId
        ? normalizeProjectOpenAppId(appsByAction, action, storedAppId)
        : migratedAppId
          ? normalizeProjectOpenAppId(appsByAction, action, migratedAppId)
          : resolveFirstUsableAppId(appsByAction, action);

      nextSelection[action] = resolvedAppId;

      if (storedAppId !== resolvedAppId) {
        await savePreference(APP_PREF_KEY_BY_ACTION[action], resolvedAppId);
      }
    })
  );

  return {
    appsByAction,
    selectedAppIdsByAction: nextSelection,
  };
};

export const saveProjectOpenAppPreference = async (
  action: ProjectOpenAction,
  appId: string
): Promise<void> => {
  await savePreference(APP_PREF_KEY_BY_ACTION[action], appId);
};

export const shouldRenderProjectOpenAction = (
  selection: ProjectOpenAppSelection,
  action: ProjectOpenAction
): boolean => selection[action] !== NONE_PROJECT_OPEN_APP_ID;

export const openProjectInExternalApp = async (params: {
  targetPath: string;
  action: ProjectOpenAction;
  appId?: string | null;
}): Promise<void> => {
  const resolvedAppId =
    params.appId?.trim() ||
    (await loadProjectOpenSettings()).selectedAppIdsByAction[params.action];

  if (!resolvedAppId || resolvedAppId === NONE_PROJECT_OPEN_APP_ID) {
    return;
  }

  await tauriIpc.openExternalTarget({
    targetPath: params.targetPath,
    action: params.action,
    appId: resolvedAppId,
  });
};
