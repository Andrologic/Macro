import type React from 'react';
import type { AppMode } from '../../types';

export type ModePanelSlot = 'left' | 'center' | 'right';
export type ModePanelComponent = React.ComponentType;

export interface ModePanelLoader {
  id: string;
  label: string;
  mode: AppMode;
  panel: ModePanelSlot;
  load: () => Promise<ModePanelComponent>;
  reset: () => void;
  getCachedComponent: () => ModePanelComponent | null;
}

interface CreateModePanelLoaderOptions {
  id: string;
  label: string;
  mode: AppMode;
  panel: ModePanelSlot;
  importComponent: () => Promise<ModePanelComponent>;
}

export interface ModePanelPreloadResult {
  loaded: string[];
  failed: Array<{ id: string; error: unknown }>;
  timedOut: boolean;
}

const DEFAULT_PRELOAD_TIMEOUT_MS = 450;

export const createModePanelLoader = ({
  id,
  label,
  mode,
  panel,
  importComponent,
}: CreateModePanelLoaderOptions): ModePanelLoader => {
  let component: ModePanelComponent | null = null;
  let pending: Promise<ModePanelComponent> | null = null;

  return {
    id,
    label,
    mode,
    panel,
    load: () => {
      if (component) {
        return Promise.resolve(component);
      }

      if (!pending) {
        pending = importComponent()
          .then((loadedComponent) => {
            component = loadedComponent;
            return loadedComponent;
          })
          .catch((error) => {
            pending = null;
            throw error;
          });
      }

      return pending;
    },
    reset: () => {
      component = null;
      pending = null;
    },
    getCachedComponent: () => component,
  };
};

const strategyGraphLoader = createModePanelLoader({
  id: 'architect:right:strategy-graph',
  label: 'Strategy graph',
  mode: 'Architect',
  panel: 'right',
  importComponent: async () => (await import('../plan/StrategyGraph')).default,
});

const architectProjectNavigatorLoader = createModePanelLoader({
  id: 'architect:left:project-navigator',
  label: 'Project navigator',
  mode: 'Architect',
  panel: 'left',
  importComponent: async () =>
    (await import('../architect/ArchitectProjectNavigator')).default,
});

const taskQueueLoader = createModePanelLoader({
  id: 'implement:left:task-queue',
  label: 'Task queue',
  mode: 'Implement',
  panel: 'left',
  importComponent: async () => (await import('../tasks/TaskQueue')).default,
});

const fileChangesPanelLoader = createModePanelLoader({
  id: 'implement:right:file-changes',
  label: 'File changes',
  mode: 'Implement',
  panel: 'right',
  importComponent: async () => (await import('../implement/FileChangesPanel')).default,
});

const implementCenterLoader = createModePanelLoader({
  id: 'implement:center:workspace',
  label: 'Implement workspace',
  mode: 'Implement',
  panel: 'center',
  importComponent: async () => (await import('../implement/ImplementCenter')).default,
});

const conversationArchiveLoader = createModePanelLoader({
  id: 'chat:left:conversation-archive',
  label: 'Conversation archive',
  mode: 'Chat',
  panel: 'left',
  importComponent: async () => (await import('../chat/ConversationArchive')).default,
});

const contextToolboxLoader = createModePanelLoader({
  id: 'chat:right:context-toolbox',
  label: 'Context toolbox',
  mode: 'Chat',
  panel: 'right',
  importComponent: async () => (await import('../chat/ContextToolbox')).default,
});

const chatZoneLoader = createModePanelLoader({
  id: 'shared:center:chat-zone',
  label: 'Chat',
  mode: 'Chat',
  panel: 'center',
  importComponent: async () => (await import('../chat/ChatZone')).default,
});

export type ModePanelConfiguration = Partial<Record<ModePanelSlot, ModePanelLoader>>;

export const modePanelLoaders: Record<AppMode, ModePanelConfiguration> = {
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

export const hasModePanel = (mode: AppMode, panel: ModePanelSlot): boolean =>
  Boolean(modePanelLoaders[mode][panel]);

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
    .map((panel) => modePanelLoaders[mode][panel])
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
