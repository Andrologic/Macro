import { getEffectiveConfigDocument, patchUserConfigTopLevel } from './configDocuments';
const TASK_PROJECT_COMMANDS_VERSION = 3;

export interface TaskProjectCommandEntry {
  projectId: string | null;
  projectName: string;
  projectPath: string;
  command: string;
  worktreeSetupCommand: string;
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
  worktreeSetupCommand?: string;
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
  const worktreeSetupCommand =
    typeof value?.worktreeSetupCommand === 'string'
      ? value.worktreeSetupCommand.trim()
      : '';
  if (!projectPath || (!command && !worktreeSetupCommand)) {
    return null;
  }

  return {
    projectId: typeof value?.projectId === 'string' ? value.projectId : null,
    projectName: typeof value?.projectName === 'string' ? value.projectName : '',
    projectPath,
    command,
    worktreeSetupCommand,
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

interface ToolsProjectCommandsDocument extends Record<string, unknown> {
  projectCommands?: Record<string, TaskProjectCommandEntry>;
}

let transientRegistry = defaultRegistry();

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
    const worktreeSetupCommand = (draft.worktreeSetupCommand ?? '').trim();
    if (!command && !worktreeSetupCommand) {
      delete commandsByProjectPath[projectPath];
      return;
    }

    commandsByProjectPath[projectPath] = {
      projectId: draft.projectId?.trim() || null,
      projectName: draft.projectName.trim(),
      projectPath,
      command,
      worktreeSetupCommand,
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
  const document = await getEffectiveConfigDocument<ToolsProjectCommandsDocument>('tools');
  transientRegistry = normalizeRegistry({
    version: TASK_PROJECT_COMMANDS_VERSION,
    commandsByProjectPath: document.projectCommands ?? {},
  });
  return transientRegistry;
};

export const saveTaskProjectCommandDrafts = async (
  drafts: TaskProjectCommandDraft[]
): Promise<TaskProjectCommandRegistry> => {
  const nextRegistry = mergeTaskProjectCommandRegistry(
    await loadTaskProjectCommandRegistry(),
    drafts
  );

  await patchUserConfigTopLevel(
    'tools',
    'projectCommands',
    nextRegistry.commandsByProjectPath,
  );
  transientRegistry = nextRegistry;
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
