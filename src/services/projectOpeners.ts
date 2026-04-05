import * as tauriIpc from './tauriIpc';
import { loadPreference, PREF_KEYS } from './preferences';
import { getDefaultProjectOpenCommand, type ProjectOpenAction } from './projectOpenDefaults';

export type { ProjectOpenAction } from './projectOpenDefaults';

const PREF_KEY_BY_ACTION: Record<ProjectOpenAction, typeof PREF_KEYS[keyof typeof PREF_KEYS]> = {
  editor: PREF_KEYS.PROJECT_OPEN_EDITOR_COMMAND,
  terminal: PREF_KEYS.PROJECT_OPEN_TERMINAL_COMMAND,
  files: PREF_KEYS.PROJECT_OPEN_FILES_COMMAND,
};

export const getProjectOpenCommandPreference = async (
  action: ProjectOpenAction
): Promise<string> => {
  const storedValue = await loadPreference<string>(PREF_KEY_BY_ACTION[action]);
  const normalized = storedValue.trim();
  return normalized || getDefaultProjectOpenCommand(action);
};

export const openProjectInExternalApp = async (params: {
  targetPath: string;
  action: ProjectOpenAction;
}): Promise<void> => {
  const commandOverride = await getProjectOpenCommandPreference(params.action);
  await tauriIpc.openExternalTarget({
    targetPath: params.targetPath,
    action: params.action,
    commandOverride,
  });
};
