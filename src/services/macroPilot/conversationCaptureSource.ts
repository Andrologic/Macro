import { desktopPilotTasks } from './desktopTaskCatalog';
import type { DesktopStorePorts } from './desktopStorePorts';
import {
  dbCompareAndSwapAppSetting, dbGetAppSetting, getConversation, listConversations,
  listMessages, listMessagesBounded, conversationMetadata, conversationResponseVersion, conversationAcknowledge, conversationAction, searchMessages, getMessage,
} from '../tauriIpc';
import { ConversationCaptureError, type ConversationCaptureSource } from './conversationCaptures';
import type { KernelStorage } from './kernel';
import type { ConversationManagementSource } from './conversationManager';
import { assistantTurnRequiresUserReply } from '../chatDbMappers';
import { assistantProvenance } from './assistantProvenance';

/** Persisted reads deliberately bypass the optional transcript cache. Store reads
 * supply the same branch-qualified task catalog as supervision and current activity; no selection, lazy loading, or source writes. */
export function desktopConversationCaptureSource(ports: DesktopStorePorts): ConversationCaptureSource {
  return {
    projects: async () => {
      const { standaloneProjects, projectGroups } = ports.app();
      const projects = new Map(standaloneProjects.map(project => [project.id, project]));
      for (const group of projectGroups) for (const project of group.projects) projects.set(project.id, project);
      return [...projects.values()].map(project => ({ id: project.id, name: project.name }));
    },
    tasks: async () => desktopPilotTasks(ports).map(task => ({ id: task.id, project_id: task.project_id, conversation_id: task.conversation_id })),
    listConversations,
    catalogMetadata: conversationMetadata,
    getConversation,
    listMessages,
    finalProvenance: message => assistantProvenance().readFinal(message.id, message.content),
    activity: conversationId => {
      const chat = ports.chat();
      const runtime = chat.conversationRuntimeById[conversationId];
      const approval = chat.pendingToolApprovalByConversationId[conversationId];
      if (approval && approval.recoveryState !== 'interrupted') return { activity: 'idle', generatingMessageId: null, attention: 'tool_approval' };
      if (chat.getActiveQuestionnaire?.(conversationId)?.mode === 'pending_reply') return { activity: 'idle', generatingMessageId: null, attention: 'user_request' };
      if (!runtime) return { activity: 'unknown', generatingMessageId: null };
      const busy = runtime.phase !== 'idle' && runtime.phase !== 'error';
      return { activity: busy ? 'busy' : runtime.phase === 'error' ? 'error' : 'idle', generatingMessageId: runtime.assistantMessageId ?? null,
        ...(runtime.phase === 'error' && runtime.lastErrorOrigin === 'provider' ? { providerFailure: runtime.providerFailure ?? { category: 'unknown', message: 'provider_failed', recovery: 'review_before_retry' } } : {}) };
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

export function desktopConversationManagementSource(ports: DesktopStorePorts): ConversationManagementSource {
  const persistedAttention = new Map<string, 'tool_approval' | 'user_request' | 'error'>();
  const capture = desktopConversationCaptureSource(ports);
  return { ...capture,
    listMessages: async id => {
      try { return await listMessagesBounded(id); }
      catch (error) {
        if (error && typeof error === 'object' && 'message' in error && error.message === 'resource_limit') throw new ConversationCaptureError('resource_limit');
        throw new ConversationCaptureError('unavailable');
      }
    },
    activity: id => {
      const current = capture.activity(id);
      const attention = persistedAttention.get(id);
      if (current.activity === 'busy' || current.attention || current.activity === 'error' || !attention) return current;
      return attention === 'error' ? { ...current, activity: 'error', providerFailure: { category: 'unknown', message: 'provider_failed', recovery: 'review_before_retry' } } : { ...current, attention };
    },
    metadata: async () => {
      await ports.chat().hydrateConversationManagementArchives();
      const metadata = await conversationMetadata();
      persistedAttention.clear();
      for (const item of metadata) {
        if (item.provider_failed) persistedAttention.set(item.conversation_id, 'error');
        else if (item.pending_tool) persistedAttention.set(item.conversation_id, 'tool_approval');
        else if (item.question_message_id) {
          const message = await getMessage(item.question_message_id);
          if (message && assistantTurnRequiresUserReply(message.content, message.hidden_context ?? undefined)) persistedAttention.set(item.conversation_id, 'user_request');
        }
      }
      return metadata;
    },
    search: (query, conversationIds, offset) => searchMessages({ query, conversationIds, offset, limit: 50 }),
    message: getMessage,
    responseVersion: message => conversationResponseVersion(message.id, message.content, message.completion_reason),
    acknowledge: conversationAcknowledge,
    action: conversationAction,
    synchronize: () => ports.chat().refreshConversationMetadata(),
  };
}
