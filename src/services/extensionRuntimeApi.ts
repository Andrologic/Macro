export type MacroExtensionSelectionSource =
  | 'tree'
  | 'graph'
  | 'details'
  | 'table'
  | 'command'
  | 'tool';

export interface MacroExtensionSelectionEnvelope {
  extensionId: string;
  viewId: string;
  kind?: string;
  payload: unknown;
  source?: MacroExtensionSelectionSource;
  timestamp: string;
}

export interface MacroExtensionTreeDataProvider {
  getChildren: (item?: unknown) => unknown[] | Promise<unknown[]>;
}

export interface MacroExtensionGraphDataProvider {
  getGraph: (request?: unknown) => unknown | Promise<unknown>;
}

export interface MacroExtensionDetailsProvider {
  getDetails: (selection?: unknown) => unknown | Promise<unknown>;
}

export interface MacroExtensionTableDataProvider {
  getTable: (request?: unknown) => unknown | Promise<unknown>;
}

export interface ExtensionRuntimeFilesystem {
  fsListDir: (params: {
    path?: string;
    recursive?: boolean;
    includeHidden?: boolean;
    maxDepth?: number;
    workspacePath?: string | null;
  }) => Promise<unknown[]>;
  fsReadFileWithOptions: (params: {
    path: string;
    workspacePath?: string | null;
    allowOutsideWorkspace?: boolean;
  }) => Promise<unknown>;
}

export interface ExtensionRuntimeGit {
  gitDiff: (params: {
    repoPath?: string;
    paths?: string[];
    base?: string;
    head?: string;
  }) => Promise<string>;
  gitStatus: (repoPath: string) => Promise<unknown>;
  gitBranchList: (repoPath: string) => Promise<unknown>;
}

type ViewProvider =
  | MacroExtensionTreeDataProvider
  | MacroExtensionGraphDataProvider
  | MacroExtensionDetailsProvider
  | MacroExtensionTableDataProvider;
type ViewRefreshListener = (extensionId: string, viewId: string) => void;
type SelectionListener = (selection: MacroExtensionSelectionEnvelope) => void | Promise<void>;
type RuntimeListener = () => void;

const treeProviders = new Map<string, MacroExtensionTreeDataProvider>();
const graphProviders = new Map<string, MacroExtensionGraphDataProvider>();
const detailsProviders = new Map<string, MacroExtensionDetailsProvider>();
const tableProviders = new Map<string, MacroExtensionTableDataProvider>();
const selections = new Map<string, MacroExtensionSelectionEnvelope | null>();
const latestSelectionsByExtension = new Map<string, MacroExtensionSelectionEnvelope | null>();
const refreshListeners = new Set<ViewRefreshListener>();
const selectionListeners = new Set<SelectionListener>();
const runtimeListeners = new Set<RuntimeListener>();

let filesystemForTest: ExtensionRuntimeFilesystem | null = null;
let gitForTest: ExtensionRuntimeGit | null = null;

const providerKey = (extensionId: string, viewId: string): string => `${extensionId}:${viewId}`;

const disposable = (dispose: () => void): { dispose: () => void } => ({ dispose });

const registerProvider = <TProvider extends ViewProvider>(
  map: Map<string, TProvider>,
  extensionId: string,
  viewId: string,
  provider: TProvider,
) => {
  const key = providerKey(extensionId, viewId);
  map.set(key, provider);
  emitRuntimeChange();
  return disposable(() => {
    if (map.get(key) === provider) {
      map.delete(key);
      emitRuntimeChange();
    }
  });
};

export const registerExtensionTreeDataProvider = (
  extensionId: string,
  viewId: string,
  provider: MacroExtensionTreeDataProvider,
) => registerProvider(treeProviders, extensionId, viewId, provider);

export const registerExtensionGraphDataProvider = (
  extensionId: string,
  viewId: string,
  provider: MacroExtensionGraphDataProvider,
) => registerProvider(graphProviders, extensionId, viewId, provider);

export const registerExtensionDetailsProvider = (
  extensionId: string,
  viewId: string,
  provider: MacroExtensionDetailsProvider,
) => registerProvider(detailsProviders, extensionId, viewId, provider);

export const registerExtensionTableDataProvider = (
  extensionId: string,
  viewId: string,
  provider: MacroExtensionTableDataProvider,
) => registerProvider(tableProviders, extensionId, viewId, provider);

export const refreshExtensionView = (extensionId: string, viewId: string): void => {
  for (const listener of refreshListeners) {
    listener(extensionId, viewId);
  }
  emitRuntimeChange();
};

export const setExtensionViewSelection = (
  extensionId: string,
  viewId: string,
  selection: unknown,
): MacroExtensionSelectionEnvelope | null => {
  const envelope =
    selection === null
      ? null
      : normalizeSelectionEnvelope(extensionId, viewId, selection, 'command');
  selections.set(providerKey(extensionId, viewId), envelope);
  latestSelectionsByExtension.set(extensionId, envelope);
  emitRuntimeChange();
  return envelope;
};

export const onExtensionViewRefresh = (listener: ViewRefreshListener): { dispose: () => void } => {
  refreshListeners.add(listener);
  return disposable(() => refreshListeners.delete(listener));
};

export const onExtensionSelectionChanged = (
  listener: SelectionListener,
): { dispose: () => void } => {
  selectionListeners.add(listener);
  return disposable(() => selectionListeners.delete(listener));
};

export const notifyExtensionSelectionChanged = async (
  selection: MacroExtensionSelectionEnvelope,
): Promise<{ delivered: boolean; errors: string[] }> => {
  const errors: string[] = [];
  for (const listener of selectionListeners) {
    try {
      await listener(selection);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { delivered: selectionListeners.size > 0, errors };
};

export const getExtensionTreeDataProvider = (
  extensionId: string,
  viewId: string,
): MacroExtensionTreeDataProvider | null => treeProviders.get(providerKey(extensionId, viewId)) ?? null;

export const getExtensionGraphDataProvider = (
  extensionId: string,
  viewId: string,
): MacroExtensionGraphDataProvider | null => graphProviders.get(providerKey(extensionId, viewId)) ?? null;

export const getExtensionDetailsProvider = (
  extensionId: string,
  viewId: string,
): MacroExtensionDetailsProvider | null => detailsProviders.get(providerKey(extensionId, viewId)) ?? null;

export const getExtensionTableDataProvider = (
  extensionId: string,
  viewId: string,
): MacroExtensionTableDataProvider | null => tableProviders.get(providerKey(extensionId, viewId)) ?? null;

export const getExtensionViewSelection = (
  extensionId: string,
  viewId: string,
): MacroExtensionSelectionEnvelope | null => selections.get(providerKey(extensionId, viewId)) ?? null;

export const getLatestExtensionSelection = (
  extensionId: string,
): MacroExtensionSelectionEnvelope | null => latestSelectionsByExtension.get(extensionId) ?? null;

export const subscribeExtensionRuntime = (listener: RuntimeListener): { dispose: () => void } => {
  runtimeListeners.add(listener);
  return disposable(() => runtimeListeners.delete(listener));
};

export const getExtensionRuntimeSnapshot = (): number =>
  treeProviders.size +
  graphProviders.size +
  detailsProviders.size +
  tableProviders.size +
  selections.size +
  latestSelectionsByExtension.size;

export const configureExtensionRuntimeFilesystemForTest = (
  filesystem: ExtensionRuntimeFilesystem,
): { dispose: () => void } => {
  filesystemForTest = filesystem;
  return disposable(() => {
    if (filesystemForTest === filesystem) {
      filesystemForTest = null;
    }
  });
};

export const configureExtensionRuntimeGitForTest = (
  git: ExtensionRuntimeGit,
): { dispose: () => void } => {
  gitForTest = git;
  return disposable(() => {
    if (gitForTest === git) {
      gitForTest = null;
    }
  });
};

export const getConfiguredExtensionRuntimeFilesystem = (): ExtensionRuntimeFilesystem | null =>
  filesystemForTest;

export const getConfiguredExtensionRuntimeGit = (): ExtensionRuntimeGit | null => gitForTest;

export const clearExtensionRuntimeForTest = (): void => {
  treeProviders.clear();
  graphProviders.clear();
  detailsProviders.clear();
  tableProviders.clear();
  selections.clear();
  latestSelectionsByExtension.clear();
  selectionListeners.clear();
  refreshListeners.clear();
  runtimeListeners.clear();
  filesystemForTest = null;
  gitForTest = null;
};

export const normalizeSelectionEnvelope = (
  extensionId: string,
  viewId: string,
  selection: unknown,
  source: MacroExtensionSelectionSource = 'command',
): MacroExtensionSelectionEnvelope => {
  if (
    selection &&
    typeof selection === 'object' &&
    'extensionId' in selection &&
    'viewId' in selection &&
    'payload' in selection
  ) {
    const raw = selection as Partial<MacroExtensionSelectionEnvelope>;
    return {
      extensionId: String(raw.extensionId ?? extensionId),
      viewId: String(raw.viewId ?? viewId),
      kind: typeof raw.kind === 'string' ? raw.kind : undefined,
      payload: raw.payload,
      source: raw.source ?? source,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    };
  }

  return {
    extensionId,
    viewId,
    payload: selection,
    source,
    timestamp: new Date().toISOString(),
  };
};

const emitRuntimeChange = (): void => {
  for (const listener of runtimeListeners) {
    listener();
  }
};
