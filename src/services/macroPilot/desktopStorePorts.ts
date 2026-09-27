import type { useAppStore } from '../../stores/useAppStore';
import type { useChatStore } from '../../stores/useChatStore';
import type { getTaskCommandTargets, getTaskLifecycleCapabilities, useTaskStore } from '../../stores/useTaskStore';

export interface DesktopStorePorts {
  app(): ReturnType<typeof useAppStore.getState>;
  chat(): ReturnType<typeof useChatStore.getState>;
  tasks(): ReturnType<typeof useTaskStore.getState>;
  taskLifecycle: typeof getTaskLifecycleCapabilities;
  taskCommandTargets: typeof getTaskCommandTargets;
}
