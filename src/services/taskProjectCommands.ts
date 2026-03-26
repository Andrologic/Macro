import * as tauriIpc from './tauriIpc';

const APP_SETTING_TASK_PROJECT_COMMANDS_KEY = 'task_project_commands';
const LEGACY_TASK_PROJECT_COMMANDS_KEY = 'macro_task_project_commands';
const TASK_PROJECT_COMMANDS_VERSION = 2;

export interface TaskProjectCommandEntry {
  projectId: string | null;
  projectName: string;
  projectPath: string;
  command: string;
  openTerminalOnRun: boolean;
  updatedAt: string;
}

export interface TaskProjectCommandRegistry {
  version: number;
  commandsByProjectPath: Record<string, TaskProjectCommandEntry>;
}

export interface TaskProjectCommandDraft {
  projectId: string | null;
  projectName: string;
  projectPath: string;
  command: string;
  openTerminalOnRun: boolean;
}

const defaultRegistry = (): TaskProjectCommandRegistry => ({
  version: TASK_PROJECT_COMMANDS_VERSION,
  commandsByProjectPath: {},
});

export const normalizeTaskProjectCommandPath = (value: string): string =>
  value.trim().replace(/\\/g, '/').replace(/\/+$/, '');

const toNowIso = (): string => new Date().toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeEntry = (
  key: string,
  value: Partial<TaskProjectCommandEntry> | null | undefined
): TaskProjectCommandEntry | null => {
  const projectPath = normalizeTaskProjectCommandPath(value?.projectPath || key);
  const command = typeof value?.command === 'string' ? value.command.trim() : '';
  if (!projectPath || !command) {
    return null;
  }

  return {
    projectId: typeof value?.projectId === 'string' ? value.projectId : null,
    projectName: typeof value?.projectName === 'string' ? value.projectName : '',
    projectPath,
    command,
    openTerminalOnRun:
      typeof value?.openTerminalOnRun === 'boolean' ? value.openTerminalOnRun : true,
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : toNowIso(),
  };
};

const normalizeRegistry = (value: unknown): TaskProjectCommandRegistry => {
  if (!isRecord(value) || !isRecord(value.commandsByProjectPath)) {
    return defaultRegistry();
  }

  const commandsByProjectPath = Object.entries(value.commandsByProjectPath).reduce<
    Record<string, TaskProjectCommandEntry>
  >((acc, [key, entry]) => {
    const normalized = normalizeEntry(key, isRecord(entry) ? entry : null);
    if (!normalized) {
      return acc;
    }
    acc[normalized.projectPath] = normalized;
    return acc;
  }, {});

  return {
    version: TASK_PROJECT_COMMANDS_VERSION,
    commandsByProjectPath,
  };
};

const safeJsonParse = (raw: string | null): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readLegacyRegistry = (): TaskProjectCommandRegistry => {
  if (typeof window === 'undefined') {
    return defaultRegistry();
  }

  return normalizeRegistry(safeJsonParse(window.localStorage.getItem(LEGACY_TASK_PROJECT_COMMANDS_KEY)));
};

const writeLegacyRegistry = (registry: TaskProjectCommandRegistry): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(LEGACY_TASK_PROJECT_COMMANDS_KEY, JSON.stringify(registry));
};

export const mergeTaskProjectCommandRegistry = (
  current: TaskProjectCommandRegistry,
  drafts: TaskProjectCommandDraft[]
): TaskProjectCommandRegistry => {
  const commandsByProjectPath = { ...current.commandsByProjectPath };

  drafts.forEach((draft) => {
    const projectPath = normalizeTaskProjectCommandPath(draft.projectPath);
    if (!projectPath) {
      return;
    }

    const command = draft.command.trim();
    if (!command) {
      delete commandsByProjectPath[projectPath];
      return;
    }

    commandsByProjectPath[projectPath] = {
      projectId: draft.projectId?.trim() || null,
      projectName: draft.projectName.trim(),
      projectPath,
      command,
      openTerminalOnRun: draft.openTerminalOnRun !== false,
      updatedAt: toNowIso(),
    };
  });

  return {
    version: TASK_PROJECT_COMMANDS_VERSION,
    commandsByProjectPath,
  };
};

export const loadTaskProjectCommandRegistry = async (): Promise<TaskProjectCommandRegistry> => {
  if (tauriIpc.isTauriAvailable()) {
    try {
      const record = await tauriIpc.dbGetAppSetting(APP_SETTING_TASK_PROJECT_COMMANDS_KEY);
      if (record?.value_json) {
        return normalizeRegistry(safeJsonParse(record.value_json));
      }
    } catch {
      // Fall through to the local fallback.
    }
  }

  return readLegacyRegistry();
};

export const saveTaskProjectCommandDrafts = async (
  drafts: TaskProjectCommandDraft[]
): Promise<TaskProjectCommandRegistry> => {
  const nextRegistry = mergeTaskProjectCommandRegistry(
    await loadTaskProjectCommandRegistry(),
    drafts
  );

  if (tauriIpc.isTauriAvailable()) {
    try {
      await tauriIpc.dbSetAppSetting({
        key: APP_SETTING_TASK_PROJECT_COMMANDS_KEY,
        valueJson: JSON.stringify(nextRegistry),
      });
      writeLegacyRegistry(nextRegistry);
      return nextRegistry;
    } catch {
      // Fall back to the local cache below.
    }
  }

  writeLegacyRegistry(nextRegistry);
  return nextRegistry;
};

export const getTaskProjectCommand = (
  registry: TaskProjectCommandRegistry,
  projectPath: string | null | undefined
): TaskProjectCommandEntry | null => {
  const normalizedPath = normalizeTaskProjectCommandPath(projectPath || '');
  if (!normalizedPath) {
    return null;
  }

  return registry.commandsByProjectPath[normalizedPath] || null;
};
