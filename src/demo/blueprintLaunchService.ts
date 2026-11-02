import { useChatStore } from '../stores/useChatStore';
import { mapDbConversationToConversation, mapDbMessageToChatMessage } from '../services/chatDbMappers';
import type { DbConversation, DbMessage } from '../services/tauriIpc';
import { notify } from '../components/ui/toastService';
import { invoke } from '@tauri-apps/api/core';
import { useTaskStore } from '../stores/useTaskStore';
import { useAppStore } from '../stores/useAppStore';
import { useViewFilterStore } from '../stores/useViewFilterStore';
import type { DemoBlueprintUse } from './blueprintLaunch';

/** This adapter is loaded only by the isolated demo, never the production runtime. */
export async function launchDemoBlueprint(id: string) {
  const use = await invoke<DemoBlueprintUse>('demo_blueprint_start', { id });
  const conversations = await invoke<DbConversation[]>('db_list_conversations');
  useChatStore.setState(state => ({ conversations: [...state.conversations, ...conversations.filter(conversation => !state.conversations.some(existing => existing.id === conversation.id)).map(mapDbConversationToConversation)] }));
  await useTaskStore.getState().refreshFromPlan();
  useViewFilterStore.getState().setImplementStatusFilter('all');
  useViewFilterStore.getState().setImplementProjectFilter(use.projectId);
  if (use.taskIds[0]) await useTaskStore.getState().activateTask(use.taskIds[0]);
  useAppStore.getState().setMode('Implement');
  await useChatStore.getState().ensureConversationForCurrentMode();
  void advanceDemoBlueprint(use.id).catch(error => notify.error(String(error)));
  return use;
}
const progressing = new Set<string>();
async function advanceDemoBlueprint(id: string) {
  if (progressing.has(id)) return;
  progressing.add(id);
  try {
    let running = true;
    while (running) {
      await new Promise(resolve => setTimeout(resolve, 7000));
      const use = await invoke<DemoBlueprintUse>('demo_blueprint_advance', { id });
      await useTaskStore.getState().refreshFromPlan({ restoreSelection: false, activateSelectedTask: false });
      const selected = useChatStore.getState().selectedConversationId;
      if (selected && use.taskIds.some(taskId => useTaskStore.getState().tasks.find(task => task.id === taskId)?.conversation_id === selected)) {
        const messages = await invoke<DbMessage[]>('db_list_messages', { conversationId: selected });
        for (const message of messages) {
          if (!useChatStore.getState().messages.some(existing => existing.id === message.id)) useChatStore.getState().addMessage(mapDbMessageToChatMessage(message, new Map(useChatStore.getState().conversations.map(conversation => [conversation.id, conversation]))));
        }
      }
      running = use.state === 'running';
    }
  } finally { progressing.delete(id); }
}
