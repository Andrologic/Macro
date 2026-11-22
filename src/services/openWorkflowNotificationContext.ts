import i18n from '../i18n';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useTaskStore } from '../stores/useTaskStore';
import { resolveTaskReference, taskReferenceMatches } from './durableIdentity';
import type { WorkflowNotificationNavigation } from './workflowNotificationNavigation';

export const openWorkflowNotificationContext = async (
  navigation: WorkflowNotificationNavigation,
): Promise<void> => {
  const appState = useAppStore.getState();
  const chatState = useChatStore.getState();

  const taskState = useTaskStore.getState();
  if (chatState.hydrationStatus === 'idle' || chatState.hydrationStatus === 'hydrating' || taskState.isLoading) {
    throw new Error(i18n.t('common.loading', 'Loading...'));
  }
  const tasks = taskState.tasks;
  if (navigation.kind === 'review') {
    const task = resolveTaskReference(tasks, navigation.taskId);
    if (!task) return;
    const conversationId = chatState.conversations.find((conversation) =>
      conversation.id === task.conversation_id && conversation.scope_mode === 'Implement' &&
      taskReferenceMatches(tasks, task, conversation.task_id),
    )?.id ?? chatState.conversations.find((conversation) =>
      conversation.scope_mode === 'Implement' && taskReferenceMatches(tasks, task, conversation.task_id),
    )?.id;
    const event = { taskId: task.id, conversationId };
    appState.setMode('Implement');
    appState.setSelectedTask(event.taskId);
    await chatState.ensureConversationForCurrentMode();
    if (event.conversationId) {
      const selected = await chatState.selectConversation(event.conversationId);
      if (!selected) {
        await chatState.ensureConversationForCurrentMode();
      }
    } else {
      await chatState.ensureConversationForCurrentMode();
    }
    return;
  }

  const conversation = chatState.conversations.find((candidate) => candidate.id === navigation.conversationId);
  if (!conversation) return;
  if (conversation.scope_mode === 'Architect') {
    await appState.openArchitectPlanNotification(conversation.id);
    return;
  }
  const task = conversation.task_id ? resolveTaskReference(tasks, conversation.task_id) : undefined;
  if (conversation.task_id && !task) return;
  const event = {
    mode: conversation.scope_mode,
    taskId: task?.id ?? null,
    conversationId: conversation.id,
  };
  appState.setMode(event.mode, { ensureAutoPlan: true });
  if (event.mode === 'Implement') {
    appState.setSelectedTask(event.taskId);
  }
  await chatState.ensureConversationForCurrentMode();
  const selected = await chatState.selectConversation(event.conversationId);
  if (!selected) {
    await chatState.ensureConversationForCurrentMode();
  }
};
