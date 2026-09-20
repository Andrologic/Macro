import type { AppMode } from '../types';
import type { IconName } from '../types/icon';
import { ContributionRegistry, type Contribution } from '../domains/shell/contributionRegistry';
import { workspaceDefinitions, type WorkspaceId, type WorkspaceViewId, type WorkspaceSession } from '../domains/shell/workspace';
import { createModePanelLoader, type ModePanelLoader, type ModePanelSlot, type ModePanelPreloadResult } from '../components/layout/panelLoader';

const DEFAULT_PRELOAD_TIMEOUT_MS = 450;
const strategyGraphLoader = createModePanelLoader({
  id: 'architect:right:strategy-graph',
  label: 'Strategy graph',
  mode: 'Architect',
  panel: 'right',
  importComponent: async () => (await import('../components/plan/StrategyGraph')).default,
});

const architectProjectNavigatorLoader = createModePanelLoader({
  id: 'architect:left:project-navigator',
  label: 'Project navigator',
  mode: 'Architect',
  panel: 'left',
  importComponent: async () =>
    (await import('../components/architect/ArchitectProjectNavigator')).default,
});

const taskQueueLoader = createModePanelLoader({
  id: 'implement:left:task-queue',
  label: 'Task queue',
  mode: 'Implement',
  panel: 'left',
  importComponent: async () => (await import('../components/tasks/TaskQueue')).default,
});

const fileChangesPanelLoader = createModePanelLoader({
  id: 'implement:right:file-changes',
  label: 'File changes',
  mode: 'Implement',
  panel: 'right',
  importComponent: async () => (await import('../components/implement/FileChangesPanel')).default,
});

const implementCenterLoader = createModePanelLoader({
  id: 'implement:center:workspace',
  label: 'Implement workspace',
  mode: 'Implement',
  panel: 'center',
  importComponent: async () => (await import('../components/implement/ImplementCenter')).default,
});

const conversationArchiveLoader = createModePanelLoader({
  id: 'chat:left:conversation-archive',
  label: 'Conversation archive',
  mode: 'Chat',
  panel: 'left',
  importComponent: async () => (await import('../components/chat/ConversationArchive')).default,
});

const contextToolboxLoader = createModePanelLoader({
  id: 'chat:right:context-toolbox',
  label: 'Context toolbox',
  mode: 'Chat',
  panel: 'right',
  importComponent: async () => (await import('../components/chat/ContextToolbox')).default,
});

const chatZoneLoader = createModePanelLoader({
  id: 'shared:center:chat-zone',
  label: 'Chat',
  mode: 'Chat',
  panel: 'center',
  importComponent: async () => (await import('../components/chat/ChatZone')).default,
});

export type ModePanelConfiguration = Partial<Record<ModePanelSlot, ModePanelLoader>>;

const builtinPanels: Record<AppMode, ModePanelConfiguration> = {
  Architect: {
    left: architectProjectNavigatorLoader,
    center: chatZoneLoader,
    right: strategyGraphLoader,
  },
  Implement: {
    left: taskQueueLoader,
    center: implementCenterLoader,
    right: fileChangesPanelLoader,
  },
  Chat: {
    left: conversationArchiveLoader,
    center: chatZoneLoader,
    right: contextToolboxLoader,
  },
};

export interface WorkspaceViewContribution extends Contribution<WorkspaceSession> {
  readonly id: WorkspaceViewId;
  readonly workspaceId: WorkspaceId;
  readonly labelKey: string;
  readonly label: string;
  readonly icon: IconName;
  readonly panels: ModePanelConfiguration;
  /** Integrated domains own their state lifetime; new views isolate local React state by session. */
  readonly stateScope?: 'session' | 'domain';
  readonly leftWidthPreference?: 'architect';
}

export const workspaceViews = new ContributionRegistry<WorkspaceViewContribution, WorkspaceSession>();

const presentation: Record<AppMode, { icon: IconName; labelKey: string }> = {
  Architect: { icon: 'compass', labelKey: 'header.architect' },
  Implement: { icon: 'code', labelKey: 'header.implement' },
  Chat: { icon: 'message-circle', labelKey: 'header.chat' },
};
Object.values(workspaceDefinitions).forEach((definition, order) => {
  workspaceViews.register({
    id: definition.defaultViewId, owner: 'macro.shell', order,
    workspaceId: definition.id, label: definition.semanticMode,
    ...presentation[definition.semanticMode],
    panels: builtinPanels[definition.semanticMode], stateScope: 'domain',
    ...(definition.semanticMode === 'Architect' ? { leftWidthPreference: 'architect' as const } : {}),
  });
});

/** Resolve a selection without granting the selected view an agent policy. */
export const resolveWorkspaceView = (session: WorkspaceSession, selectedViewId?: WorkspaceViewId) => {
  const definition = workspaceDefinitions[session.agentProfile.mode];
  const selected = selectedViewId ? workspaceViews.get(selectedViewId, session) : undefined;
  if (selected?.workspaceId === session.workspaceId) return selected;
  const preferred = workspaceViews.get(definition.defaultViewId, session);
  if (preferred?.workspaceId === session.workspaceId) return preferred;
  return workspaceViews.list(session).find((view) => view.workspaceId === session.workspaceId);
};

// Compatibility for existing callers that address the default view by semantic mode.
// Live getters ensure activation and withdrawal are also reflected in old entry points.
const defaultSession = (mode: AppMode): WorkspaceSession => ({
  id: 'default', workspaceId: workspaceDefinitions[mode].id,
  scope: { kind: 'selection', groupId: null, projectId: null },
  agentProfile: { mode, agentType: 'build' },
  executionTarget: { kind: 'local', scope: { kind: 'selection', groupId: null, projectId: null } },
});
const getModePanels = (mode: AppMode): ModePanelConfiguration => resolveWorkspaceView(defaultSession(mode))?.panels ?? {};
export const modePanelLoaders = Object.fromEntries(Object.keys(workspaceDefinitions).map((mode) => [mode, {}])) as Record<AppMode, ModePanelConfiguration>;
for (const mode of Object.keys(workspaceDefinitions) as AppMode[]) {
  Object.defineProperty(modePanelLoaders, mode, { enumerable: true, get: () => getModePanels(mode) });
}
export const hasModePanel = (mode: AppMode, panel: ModePanelSlot): boolean => Boolean(getModePanels(mode)[panel]);

const getVisiblePanelSlots = (options: {
  includeLeft?: boolean;
  includeRight?: boolean;
} = {}): ModePanelSlot[] => {
  const slots: ModePanelSlot[] = ['center'];

  if (options.includeLeft !== false) {
    slots.push('left');
  }

  if (options.includeRight !== false) {
    slots.push('right');
  }

  return slots;
};

const wait = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => {
    globalThis.setTimeout(() => resolve('timeout'), ms);
  });

export const preloadModePanels = async (
  mode: AppMode,
  options: {
    includeLeft?: boolean;
    includeRight?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<ModePanelPreloadResult> => {
  const loaders = getVisiblePanelSlots(options)
    .map((panel) => getModePanels(mode)[panel])
    .filter((loader): loader is ModePanelLoader => Boolean(loader));
  const loaded: string[] = [];
  const failed: Array<{ id: string; error: unknown }> = [];

  const preload = Promise.all(
    loaders.map(async (loader) => {
      try {
        await loader.load();
        loaded.push(loader.id);
      } catch (error) {
        failed.push({ id: loader.id, error });
      }
    }),
  ).then(() => 'done' as const);

  const timeoutMs = options.timeoutMs ?? DEFAULT_PRELOAD_TIMEOUT_MS;
  const result =
    timeoutMs > 0 ? await Promise.race([preload, wait(timeoutMs)]) : await preload;

  return {
    loaded,
    failed,
    timedOut: result === 'timeout',
  };
};

export const resetModePanelLoader = (loader: ModePanelLoader): void => {
  loader.reset();
};
