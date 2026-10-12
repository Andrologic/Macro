import type { useCitationsStore } from '../../stores/useCitationsStore';
import type { useConversationArchiveStore } from '../../stores/useConversationArchiveStore';
import type { useProviderStore } from '../../stores/useProviderStore';
import type { useAppStore } from '../../stores/useAppStore';
import type { useChatStore } from '../../stores/useChatStore';
import type { getTaskCommandTargets, getTaskLifecycleCapabilities, useTaskStore } from '../../stores/useTaskStore';

export interface DesktopStorePorts {
  citations?(): ReturnType<typeof useCitationsStore.getState>;
  archives?(): ReturnType<typeof useConversationArchiveStore.getState>;
  providers?(): ReturnType<typeof useProviderStore.getState>;
  app(): ReturnType<typeof useAppStore.getState>;
  chat(): ReturnType<typeof useChatStore.getState>;
  tasks(): ReturnType<typeof useTaskStore.getState>;
  taskLifecycle: typeof getTaskLifecycleCapabilities;
  taskCommandTargets: typeof getTaskCommandTargets;
}
