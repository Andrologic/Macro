import { pathToFileURL } from 'node:url';
import { getRegisteredAppState } from './appStateRuntime';
import { macroContributionRegistry, type MacroExtensionRecord } from './extensions';
import {
  configureExtensionRuntimeFilesystemForTest,
  configureExtensionRuntimeGitForTest,
  getConfiguredExtensionRuntimeFilesystem,
  getConfiguredExtensionRuntimeGit,
  getExtensionDetailsProvider,
  getExtensionGraphDataProvider,
  getExtensionTableDataProvider,
  getExtensionTreeDataProvider,
  onExtensionSelectionChanged,
  notifyExtensionSelectionChanged,
  normalizeSelectionEnvelope,
  refreshExtensionView,
  registerExtensionDetailsProvider,
  registerExtensionGraphDataProvider,
  registerExtensionTableDataProvider,
  registerExtensionTreeDataProvider,
  setExtensionViewSelection,
} from './extensionRuntimeApi';
import type {
  ExtensionRuntimeFilesystem,
  ExtensionRuntimeGit,
  MacroExtensionSelectionEnvelope,
} from './extensionRuntimeApi';
import type { ProjectGroup } from '../types';

export {
  configureExtensionRuntimeFilesystemForTest,
  configureExtensionRuntimeGitForTest,
};

type Disposable = { dispose: () => void };
type ExtensionCommandHandler = (input?: unknown) => unknown | Promise<unknown>;
type ExtensionToolHandler = (input?: unknown, context?: unknown) => unknown | Promise<unknown>;

const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;

interface MacroAppStateLike {
  mode?: string;
  selectedGroupId?: string | null;
  selectedProjectId?: string | null;
  projectGroups?: ProjectGroup[];
}

interface RuntimeProject {
  id: string;
  name: string;
  path: string;
  mountName?: string | null;
  metadata?: Record<string, unknown>;
  workspaceTrusted?: boolean;
  isReadOnly?: boolean;
  groupId?: string | null;
}

export class BunExtensionSidecarHost {
  private readonly commands = new Map<string, ExtensionCommandHandler>();
  private readonly tools = new Map<string, ExtensionToolHandler>();
  private readonly disposables = new Set<Disposable>();
  private readonly workspaceStorage = new Map<string, unknown>();
  private extensionModule: { deactivate?: () => unknown | Promise<unknown> } | null = null;

  async activate(extensionId: string, mainPath: string): Promise<void> {
    const extension = macroContributionRegistry.getExtension(extensionId);
    if (!extension) {
      throw new Error(`Extension "${extensionId}" is not registered.`);
    }

    const moduleUrl = pathToFileURL(mainPath).href;
    const extensionModule = (await import(`${moduleUrl}?macroSidecar=${Date.now()}`)) as {
      activate?: (context: { subscriptions: Disposable[] }, macro: unknown) => unknown | Promise<unknown>;
      deactivate?: () => unknown | Promise<unknown>;
    };
    if (typeof extensionModule.activate !== 'function') {
      throw new Error(`Extension "${extensionId}" does not export activate().`);
    }

    this.extensionModule = extensionModule;
    const subscriptions: Disposable[] = [];
    try {
      await withExtensionTimeout(
        extensionModule.activate({ subscriptions }, this.createMacroApi(extensionId)),
        `activate ${extensionId}`,
      );
      for (const subscription of subscriptions) {
        this.disposables.add(subscription);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  async executeTool(toolId: string, input?: unknown, context?: unknown): Promise<unknown> {
    const handler = this.tools.get(toolId);
    if (!handler) {
      throw new Error(`Extension tool "${toolId}" is not registered.`);
    }
    return await withExtensionTimeout(handler(input, context), `tool ${toolId}`);
  }

  async executeCommand(commandId: string, input?: unknown): Promise<unknown> {
    const handler = this.commands.get(commandId);
    if (!handler) {
      throw new Error(`Extension command "${commandId}" is not registered.`);
    }
    return await withExtensionTimeout(handler(input), `command ${commandId}`);
  }

  async deliverViewMessage(
    extensionId: string,
    viewId: string,
    message: { type?: string; request?: unknown; selection?: unknown; item?: unknown } = {},
  ): Promise<unknown> {
    const graphProvider = getExtensionGraphDataProvider(extensionId, viewId);
    if (graphProvider && (!message.type || message.type === 'graph.getGraph')) {
      return await withExtensionTimeout(graphProvider.getGraph(message.request), `view ${viewId}`);
    }

    const detailsProvider = getExtensionDetailsProvider(extensionId, viewId);
    if (detailsProvider && (!message.type || message.type === 'details.getDetails')) {
      return await withExtensionTimeout(detailsProvider.getDetails(message.selection), `view ${viewId}`);
    }

    const tableProvider = getExtensionTableDataProvider(extensionId, viewId);
    if (tableProvider && (!message.type || message.type === 'table.getTable')) {
      return await withExtensionTimeout(tableProvider.getTable(message.request), `view ${viewId}`);
    }

    const treeProvider = getExtensionTreeDataProvider(extensionId, viewId);
    if (treeProvider && (!message.type || message.type === 'tree.getChildren')) {
      return await withExtensionTimeout(treeProvider.getChildren(message.item), `view ${viewId}`);
    }

    throw new Error(`No native provider is registered for "${extensionId}:${viewId}".`);
  }

  async deliverSelectionChanged(
    extensionId: string,
    viewId: string,
    selection: unknown,
  ): Promise<{ delivered: boolean; errors: string[] }> {
    const envelope = normalizeSelectionEnvelope(extensionId, viewId, selection, 'graph');
    setExtensionViewSelection(extensionId, viewId, envelope);
    return await notifyExtensionSelectionChanged(envelope);
  }

  dispose(): void {
    for (const disposable of [...this.disposables].reverse()) {
      try {
        disposable.dispose();
      } catch {
        // Extension disposal must not make host cleanup fail.
      }
    }
    this.disposables.clear();
    this.commands.clear();
    this.tools.clear();
    void Promise.resolve(this.extensionModule?.deactivate?.()).catch(() => undefined);
    this.extensionModule = null;
  }

  private createMacroApi(extensionId: string) {
    const extension = macroContributionRegistry.getExtension(extensionId);
    if (!extension) {
      throw new Error(`Extension "${extensionId}" is not registered.`);
    }

    return {
      commands: {
        registerCommand: (id: string, handler: ExtensionCommandHandler): Disposable => {
          assertAnyGrantedPermission(extension, [['commands', 'register']], 'command registration');
          assertDeclaredContribution(
            extensionId,
            id,
            extension.manifest.contributes?.commands,
            'command',
          );
          if (typeof handler !== 'function') {
            throw new Error(`Extension command "${id}" handler must be a function.`);
          }
          this.commands.set(id, handler);
          return this.trackDisposable(() => this.commands.delete(id));
        },
      },
      tools: {
        registerTool: (
          definition: { id?: string },
          handler: ExtensionToolHandler,
        ): Disposable => {
          const id = definition.id;
          if (!id) {
            throw new Error('Extension tool definition must include an id.');
          }
          assertAnyGrantedPermission(
            extension,
            [
              ['ai', 'tools'],
              ['tools', 'register'],
            ],
            'tool registration',
          );
          assertDeclaredContribution(
            extensionId,
            id,
            extension.manifest.contributes?.tools,
            'tool',
          );
          if (typeof handler !== 'function') {
            throw new Error(`Extension tool "${id}" handler must be a function.`);
          }
          this.tools.set(id, handler);
          return this.trackDisposable(() => this.tools.delete(id));
        },
      },
      views: {
        registerTreeDataProvider: (viewId: string, provider: never) => {
          assertAnyGrantedPermission(extension, [['ui', 'views']], 'native views');
          return registerExtensionTreeDataProvider(extensionId, viewId, provider);
        },
        registerGraphDataProvider: (viewId: string, provider: never) => {
          assertAnyGrantedPermission(extension, [['ui', 'views']], 'native views');
          return registerExtensionGraphDataProvider(extensionId, viewId, provider);
        },
        registerDetailsProvider: (viewId: string, provider: never) => {
          assertAnyGrantedPermission(extension, [['ui', 'views']], 'native views');
          return registerExtensionDetailsProvider(extensionId, viewId, provider);
        },
        registerTableDataProvider: (viewId: string, provider: never) => {
          assertAnyGrantedPermission(extension, [['ui', 'views']], 'native views');
          return registerExtensionTableDataProvider(extensionId, viewId, provider);
        },
        setSelection: (viewId: string, selection: unknown) => {
          assertAnyGrantedPermission(extension, [['ui', 'views']], 'native view selection');
          return setExtensionViewSelection(extensionId, viewId, selection);
        },
        refresh: (viewId: string) => {
          assertAnyGrantedPermission(extension, [['ui', 'views']], 'native view refresh');
          refreshExtensionView(extensionId, viewId);
        },
        onSelectionChanged: (
          listener: (selection: MacroExtensionSelectionEnvelope) => void | Promise<void>,
        ) => {
          assertAnyGrantedPermission(extension, [['ui', 'views']], 'native view selection');
          return onExtensionSelectionChanged(listener);
        },
      },
      workspace: this.createWorkspaceApi(extension),
      git: this.createGitApi(extension),
      storage: {
        workspace: {
          get: async (key: string) => {
            assertAnyGrantedPermission(extension, [['storage', 'workspace']], 'workspace storage');
            return this.workspaceStorage.get(key) ?? null;
          },
          set: async (key: string, value: unknown) => {
            assertAnyGrantedPermission(extension, [['storage', 'workspace']], 'workspace storage');
            this.workspaceStorage.set(key, value);
          },
          getItem: async (key: string) => {
            assertAnyGrantedPermission(extension, [['storage', 'workspace']], 'workspace storage');
            return this.workspaceStorage.get(key) ?? null;
          },
          setItem: async (key: string, value: unknown) => {
            assertAnyGrantedPermission(extension, [['storage', 'workspace']], 'workspace storage');
            this.workspaceStorage.set(key, value);
          },
        },
      },
      implement: {
        sendPrompt: async (payload: unknown) => {
          if (!hasAnyGrantedPermission(extension, [['implement', 'prompt']])) {
            return {
              accepted: false,
              payload,
              message:
                'Macro Implement prompt bridge is unavailable because this extension has not been granted implement.prompt.',
            };
          }
          return {
            accepted: false,
            payload,
            message: 'Macro Implement prompt bridge is unavailable in the extension sidecar smoke runtime.',
          };
        },
      },
      notifications: {
        info: async () => undefined,
        warn: async () => undefined,
        error: async () => undefined,
      },
    };
  }

  private createWorkspaceApi(extension: MacroExtensionRecord) {
    return {
      getCurrentWorkspaceContext: async () => {
        assertAnyGrantedPermission(extension, [['workspace', 'read']], 'workspace context');
        const state = await getRegisteredAppState<MacroAppStateLike>();
        const group = resolveSelectedGroup(state);
        return {
          mode: state.mode ?? null,
          selectedGroupId: group?.id ?? state.selectedGroupId ?? null,
          selectedProjectId: state.selectedProjectId ?? null,
          group: group
            ? {
                id: group.id,
                name: group.name,
              }
            : null,
          projects: (group?.projects ?? []).map(toRuntimeProject),
        };
      },
      listFiles: async (params: {
        projectId?: string;
        recursive?: boolean;
        includeHidden?: boolean;
        maxDepth?: number;
        extensions?: string[];
      }) => {
        assertAnyGrantedPermission(extension, [['workspace', 'read']], 'workspace file listing');
        const project = await this.resolveProject(params.projectId);
        const filesystem = getConfiguredExtensionRuntimeFilesystem() ?? (await loadDesktopFilesystem());
        const entries = await filesystem.fsListDir({
          path: '',
          recursive: params.recursive ?? true,
          includeHidden: params.includeHidden ?? false,
          maxDepth: params.maxDepth,
          workspacePath: project.path,
        });
        return normalizeFileEntries(entries, params.extensions);
      },
      readFile: async (params: { projectId?: string; path: string }) => {
        assertAnyGrantedPermission(extension, [['workspace', 'read']], 'workspace file read');
        const project = await this.resolveProject(params.projectId);
        const filesystem = getConfiguredExtensionRuntimeFilesystem() ?? (await loadDesktopFilesystem());
        return await filesystem.fsReadFileWithOptions({
          path: params.path,
          workspacePath: project.path,
        });
      },
    };
  }

  private createGitApi(extension: MacroExtensionRecord) {
    return {
      diff: async (params: {
        projectId?: string;
        base?: string;
        head?: string;
        paths?: string[];
      }) => {
        assertAnyGrantedPermission(extension, [['git', 'read']], 'git diff');
        const project = await this.resolveProject(params.projectId);
        const git = getConfiguredExtensionRuntimeGit() ?? (await loadDesktopGit());
        return await git.gitDiff({
          repoPath: project.path,
          base: params.base,
          head: params.head,
          paths: params.paths,
        });
      },
      status: async (params: { projectId?: string }) => {
        assertAnyGrantedPermission(extension, [['git', 'read']], 'git status');
        const project = await this.resolveProject(params.projectId);
        const git = getConfiguredExtensionRuntimeGit() ?? (await loadDesktopGit());
        return await git.gitStatus(project.path);
      },
      branchList: async (params: { projectId?: string }) => {
        assertAnyGrantedPermission(extension, [['git', 'read']], 'git branch list');
        const project = await this.resolveProject(params.projectId);
        const git = getConfiguredExtensionRuntimeGit() ?? (await loadDesktopGit());
        return await git.gitBranchList(project.path);
      },
    };
  }

  private async resolveProject(projectId?: string): Promise<RuntimeProject> {
    const state = await getRegisteredAppState<MacroAppStateLike>();
    const group = resolveSelectedGroup(state);
    const projects = group?.projects ?? state.projectGroups?.flatMap((item) => item.projects) ?? [];
    const project =
      (projectId ? projects.find((candidate) => candidate.id === projectId) : null) ??
      projects.find((candidate) => candidate.id === state.selectedProjectId) ??
      projects[0];
    if (!project) {
      throw new Error('No Macro project is available for extension workspace access.');
    }
    return toRuntimeProject(project);
  }

  private trackDisposable(dispose: () => void): Disposable {
    const tracked = { dispose };
    this.disposables.add(tracked);
    return tracked;
  }
}

const withExtensionTimeout = async <TValue>(
  value: TValue | Promise<TValue>,
  label: string,
): Promise<TValue> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Extension ${label} timed out after ${EXTENSION_HANDLER_TIMEOUT_MS}ms.`));
        }, EXTENSION_HANDLER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const assertDeclaredContribution = (
  extensionId: string,
  contributionId: string,
  contributions: Array<{ id: string }> | undefined,
  label: string,
): void => {
  if (!contributions?.some((contribution) => contribution.id === contributionId)) {
    throw new Error(
      `Extension "${extensionId}" tried to register undeclared ${label} "${contributionId}".`,
    );
  }
};

const assertAnyGrantedPermission = (
  extension: MacroExtensionRecord,
  options: Array<[scope: string, grant: string]>,
  capability: string,
): void => {
  if (hasAnyGrantedPermission(extension, options)) {
    return;
  }

  const required = options.map(([scope, grant]) => `${scope}.${grant}`).join(' or ');
  throw new Error(
    `Extension "${extension.id}" requires ${required} permission for ${capability}.`,
  );
};

const hasAnyGrantedPermission = (
  extension: MacroExtensionRecord,
  options: Array<[scope: string, grant: string]>,
): boolean =>
  extension.permissions.trusted &&
  options.some(([scope, grant]) => extension.permissions.granted[scope]?.includes(grant));

const resolveSelectedGroup = (state: MacroAppStateLike): ProjectGroup | null => {
  const groups = state.projectGroups ?? [];
  return (
    (state.selectedGroupId
      ? groups.find((group) => group.id === state.selectedGroupId)
      : null) ??
    groups.find((group) => group.projects.some((project) => project.id === state.selectedProjectId)) ??
    groups[0] ??
    null
  );
};

const toRuntimeProject = (project: unknown): RuntimeProject => {
  const record = (project ?? {}) as Record<string, unknown>;
  return {
    id: String(record.id ?? record.projectId ?? record.mountName ?? record.name),
    name: String(record.name ?? record.displayName ?? record.id ?? 'Project'),
    path: String(record.path ?? record.workspacePath ?? ''),
    mountName: typeof record.mountName === 'string' ? record.mountName : null,
    metadata:
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : undefined,
    workspaceTrusted: record.workspaceTrusted !== false,
    isReadOnly: Boolean(record.isReadOnly),
    groupId: typeof record.groupId === 'string' ? record.groupId : null,
  };
};

const normalizeFileEntries = (entries: unknown[], extensions?: string[]): unknown[] => {
  const allowed = new Set((extensions ?? []).map((extension) => extension.toLowerCase()));
  return entries
    .map((entry) => normalizeFileEntry(entry))
    .filter((entry) => {
      if (allowed.size === 0) return true;
      const path = entry.relativePath.toLowerCase();
      return [...allowed].some((extension) => path.endsWith(extension));
    });
};

const normalizeFileEntry = (entry: unknown): {
  path: string;
  relativePath: string;
  relative_path: string;
  name: string;
  size?: number;
  language?: string;
} => {
  if (typeof entry === 'string') {
    return {
      path: entry,
      relativePath: entry,
      relative_path: entry,
      name: entry.split('/').at(-1) ?? entry,
    };
  }
  const record = (entry ?? {}) as Record<string, unknown>;
  const relativePath = String(record.relativePath ?? record.relative_path ?? record.path ?? '');
  return {
    path: String(record.path ?? relativePath),
    relativePath,
    relative_path: relativePath,
    name: String(record.name ?? relativePath.split('/').at(-1) ?? relativePath),
    size: typeof record.size === 'number' ? record.size : undefined,
    language: typeof record.language === 'string' ? record.language : undefined,
  };
};

const loadDesktopFilesystem = async (): Promise<ExtensionRuntimeFilesystem> => {
  const tauriIpc = await import('./tauriIpc');
  return {
    fsListDir: async (params) =>
      await tauriIpc.fsListDir({
        path: params.path ?? '',
        recursive: params.recursive,
        includeHidden: params.includeHidden,
        maxDepth: params.maxDepth,
        workspacePath: params.workspacePath,
      }),
    fsReadFileWithOptions: async (params) =>
      await tauriIpc.fsReadFileWithOptions({
        path: params.path,
        workspacePath: params.workspacePath,
        allowOutsideWorkspace: params.allowOutsideWorkspace,
      }),
  };
};

const loadDesktopGit = async (): Promise<ExtensionRuntimeGit> => {
  const tauriIpc = await import('./tauriIpc');
  return {
    gitDiff: async (params) =>
      await tauriIpc.gitDiff({
        repoPath: params.repoPath ?? '',
        base: params.base,
        head: params.head,
        paths: params.paths,
      }),
    gitStatus: async (repoPath) => await tauriIpc.gitStatus(repoPath),
    gitBranchList: async (repoPath) => await tauriIpc.gitBranchList(repoPath),
  };
};
