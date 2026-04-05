import { getDesktopPlatform, type DesktopPlatform } from '../utils/desktopPlatform';

export type ProjectOpenAction = 'editor' | 'terminal' | 'files';
export type ProjectOpenAppKind = 'none' | 'builtin' | 'detected';
export const PROJECT_OPEN_ACTIONS: ProjectOpenAction[] = ['editor', 'terminal', 'files'];

export interface ProjectOpenAppOption {
  id: string;
  label: string;
  action: ProjectOpenAction;
  kind: ProjectOpenAppKind;
}

export interface ProjectOpenAppCatalog {
  editor: ProjectOpenAppOption[];
  terminal: ProjectOpenAppOption[];
  files: ProjectOpenAppOption[];
}

export type ProjectOpenAppSelection = Record<ProjectOpenAction, string>;

export const NONE_PROJECT_OPEN_APP_ID = 'none';

const option = (
  id: string,
  label: string,
  action: ProjectOpenAction,
  kind: ProjectOpenAppKind
): ProjectOpenAppOption => ({
  id,
  label,
  action,
  kind,
});

export const getEmptyProjectOpenSelection = (): ProjectOpenAppSelection => ({
  editor: NONE_PROJECT_OPEN_APP_ID,
  terminal: NONE_PROJECT_OPEN_APP_ID,
  files: NONE_PROJECT_OPEN_APP_ID,
});

const ensureNoneOption = (
  action: ProjectOpenAction,
  apps: ProjectOpenAppOption[]
): ProjectOpenAppOption[] => {
  const deduped = apps.filter(
    (app, index) => apps.findIndex((candidate) => candidate.id === app.id) === index
  );

  if (deduped.some((app) => app.id === NONE_PROJECT_OPEN_APP_ID)) {
    return deduped;
  }

  return [option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', action, 'none'), ...deduped];
};

export const getFallbackProjectOpenApps = (
  platform: DesktopPlatform = getDesktopPlatform()
): ProjectOpenAppCatalog => {
  switch (platform) {
    case 'macos':
      return {
        editor: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'editor', 'none'),
          option('vscode', 'Visual Studio Code', 'editor', 'detected'),
        ],
        terminal: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'terminal', 'none'),
          option('terminal', 'Terminal', 'terminal', 'builtin'),
        ],
        files: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'files', 'none'),
          option('finder', 'Finder', 'files', 'builtin'),
        ],
      };
    case 'windows':
      return {
        editor: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'editor', 'none'),
          option('vscode', 'Visual Studio Code', 'editor', 'detected'),
        ],
        terminal: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'terminal', 'none'),
          option('windows-terminal', 'Windows Terminal', 'terminal', 'detected'),
          option('powershell', 'PowerShell', 'terminal', 'builtin'),
        ],
        files: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'files', 'none'),
          option('explorer', 'File Explorer', 'files', 'builtin'),
        ],
      };
    case 'linux':
      return {
        editor: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'editor', 'none'),
          option('vscode', 'Visual Studio Code', 'editor', 'detected'),
        ],
        terminal: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'terminal', 'none'),
          option('x-terminal-emulator', 'System Terminal', 'terminal', 'builtin'),
        ],
        files: [
          option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'files', 'none'),
          option('xdg-open', 'System File Browser', 'files', 'builtin'),
        ],
      };
    default:
      return {
        editor: [option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'editor', 'none')],
        terminal: [option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'terminal', 'none')],
        files: [option(NONE_PROJECT_OPEN_APP_ID, 'Do nothing', 'files', 'none')],
      };
  }
};

export const sanitizeProjectOpenAppCatalog = (
  catalog: ProjectOpenAppCatalog
): ProjectOpenAppCatalog => ({
  editor: ensureNoneOption('editor', catalog.editor),
  terminal: ensureNoneOption('terminal', catalog.terminal),
  files: ensureNoneOption('files', catalog.files),
});

export const getDefaultProjectOpenCommand = (
  action: ProjectOpenAction,
  platform: DesktopPlatform = getDesktopPlatform()
): string => {
  switch (platform) {
    case 'macos':
      if (action === 'editor') {
        return 'open -a "Visual Studio Code"';
      }
      if (action === 'terminal') {
        return 'open -a Terminal';
      }
      return 'open -a Finder';
    case 'windows':
      if (action === 'editor') {
        return 'code';
      }
      if (action === 'terminal') {
        return 'wt -d';
      }
      return 'explorer';
    case 'linux':
      if (action === 'editor') {
        return 'code';
      }
      if (action === 'terminal') {
        return 'x-terminal-emulator --working-directory';
      }
      return 'xdg-open';
    default:
      if (action === 'editor') {
        return 'code';
      }
      if (action === 'terminal') {
        return 'open -a Terminal';
      }
      return 'open';
  }
};
