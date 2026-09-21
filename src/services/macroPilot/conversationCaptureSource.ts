import { desktopPilotTasks } from './desktopTaskCatalog';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import {
  dbCompareAndSwapAppSetting, dbGetAppSetting, getConversation, listConversations,
  listMessages,
} from '../tauriIpc';
import type { ConversationCaptureSource } from './conversationCaptures';
import type { KernelStorage } from './kernel';
import { assistantProvenance } from './assistantProvenance';

/** Persisted reads deliberately bypass the optional transcript cache. Store reads
 * supply the same branch-qualified task catalog as supervision and current activity; no selection, lazy loading, or source writes. */
export function desktopConversationCaptureSource(): ConversationCaptureSource {
  return {
    projects: async () => {
      const { standaloneProjects, projectGroups } = useAppStore.getState();
      const projects = new Map(standaloneProjects.map(project => [project.id, project]));
      for (const group of projectGroups) for (const project of group.projects) projects.set(project.id, project);
      return [...projects.values()].map(project => ({ id: project.id, name: project.name }));
    },
    tasks: async () => desktopPilotTasks().map(task => ({ id: task.id, project_id: task.project_id, conversation_id: task.conversation_id })),
    listConversations,
    getConversation,
    listMessages,
    finalProvenance: message => assistantProvenance().readFinal(message.id, message.content),
    activity: conversationId => {
      const runtime = useChatStore.getState().conversationRuntimeById[conversationId];
      if (!runtime) return { activity: 'unknown', generatingMessageId: null };
      const busy = runtime.phase !== 'idle' && runtime.phase !== 'error';
      return { activity: busy ? 'busy' : runtime.phase === 'error' ? 'error' : 'idle', generatingMessageId: runtime.assistantMessageId ?? null };
    },
  };
}

/** Durable fingerprints/revisions use existing metadata CAS, never transcripts
 * or secrets. The namespace is independent of v1 supervision state. */
export function conversationCaptureStorage(configurationId: string, instanceId: string): KernelStorage {
  const key = `macroPilot:conversation-captures:v1:${JSON.stringify([configurationId, instanceId])}`;
  return {
    load: async () => (await dbGetAppSetting(key))?.value_json ?? null,
    compareAndSwap: async (previous, next) => (await dbCompareAndSwapAppSetting({ key, expectedValueJson: previous, valueJson: next })).applied,
  };
}
