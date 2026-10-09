import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { getTaskCommandTargets, getTaskLifecycleCapabilities, useTaskStore } from '../stores/useTaskStore';
import { createDesktopActions } from '../services/macroPilot/desktopActions';
import { PilotRuntime } from '../services/macroPilot/runtime';
import type { DesktopStorePorts } from '../services/macroPilot/desktopStorePorts';

export const desktopStorePorts: DesktopStorePorts = {
  app: () => useAppStore.getState(),
  chat: () => useChatStore.getState(),
  tasks: () => useTaskStore.getState(),
  taskLifecycle: getTaskLifecycleCapabilities,
  taskCommandTargets: getTaskCommandTargets,
};

export const desktopActions = createDesktopActions(desktopStorePorts);
export const macroPilotRuntime = new PilotRuntime(undefined, undefined, desktopStorePorts);

// A development refresh must release the existing producer before replacing it.
if (import.meta.hot) import.meta.hot.dispose(() => { void macroPilotRuntime.stop(); });
