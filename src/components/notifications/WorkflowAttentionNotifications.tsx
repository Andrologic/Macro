import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useNotificationCenterStore } from '../../stores/useNotificationCenterStore';
import { resolveTaskReference } from '../../services/durableIdentity';
import { useTaskStore } from '../../stores/useTaskStore';
import {
  detectNewChatAttentionEvents,
  getActiveChatAttentionKeys,
  detectNewReviewAttentionEvents,
  type WorkflowAttentionEvent,
} from '../../services/workflowAttentionEvents';
import { getScopedProjectIds } from '../../services/globalProjects';
import { initializeDesktopNotifications, isAppForeground } from '../../services/desktopNotifications';
import { openWorkflowNotificationContext } from '../../services/openWorkflowNotificationContext';
import type { WorkflowNotificationNavigation } from '../../services/workflowNotificationNavigation';
import { notify } from '../ui/toastService';

const getAttentionContext = () => {
  const appState = useAppStore.getState();
  return {
    appForeground: isAppForeground(),
    mode: appState.mode,
    selectedTaskId: appState.selectedTaskId,
    selectedConversationId: useChatStore.getState().selectedConversationId,
    selectedGroupId: appState.selectedGroupId,
    selectedProjectId: appState.selectedProjectId,
    scopedProjectIds: getScopedProjectIds(
      {
        standaloneProjects: appState.standaloneProjects,
        projectGroups: appState.projectGroups,
      },
      appState.selectedGroupId,
      appState.selectedProjectId,
    ),
    tasks: useTaskStore.getState().tasks,
  };
};

export const emitWorkflowAttentionNotification = (
  event: WorkflowAttentionEvent,
  t: TFunction,
): void => {
  const workflowNavigation: WorkflowNotificationNavigation = event.kind === 'review'
    ? { kind: 'review', taskId: event.taskId }
    : { kind: 'conversation', requestKind: event.kind, conversationId: event.conversationId };
  const action = {
    label: t('notifications.workflow.openAction', 'Open'),
    onClick: () => openWorkflowNotificationContext(workflowNavigation),
  };

  if (event.kind === 'questionnaire') {
    notify.actionRequired(
      t('notifications.workflow.questionnaireTitle', 'Question waiting'),
      {
        description: t(
          'notifications.workflow.questionnaireBody',
          '{{conversation}} is waiting for your answer: {{prompt}}',
          { conversation: event.conversationTitle, prompt: event.prompt },
        ),
        category: 'task_attention_required',
        notificationKey: event.key,
        tone: 'info',
        actions: [action],
        workflowNavigation,
      },
    );
    return;
  }

  if (event.kind === 'approval') {
    notify.actionRequired(
      t('notifications.workflow.approvalTitle', 'Approval required'),
      {
        description: t(
          'notifications.workflow.approvalBody',
          '{{conversation}} needs your approval: {{summary}}',
          { conversation: event.conversationTitle, summary: event.summary },
        ),
        category: 'task_attention_required',
        notificationKey: event.key,
        tone: event.isDestructive ? 'warning' : 'info',
        actions: [action],
        workflowNavigation,
      },
    );
    return;
  }

  notify.actionRequired(t('notifications.workflow.reviewTitle', 'Review ready'), {
    description: t(
      'notifications.workflow.reviewBody',
      '{{task}} is ready for your review.',
      { task: event.taskTitle },
    ),
    category: 'task_attention_required',
    notificationKey: event.key,
    tone: 'info',
    actions: [action],
    workflowNavigation,
  });
};

// Resolution removes the obsolete call to action. Loading an old request never emits it again.
export const reconcileWorkflowAttentionNotifications = (): void => {
  const chat = useChatStore.getState();
  const tasks = useTaskStore.getState().tasks;
  const center = useNotificationCenterStore.getState();
  const activeKeys = getActiveChatAttentionKeys(chat);
  const remove = (item: (typeof center.items)[number]) => {
    if (item.sessionToastId != null) notify.dismiss(item.sessionToastId);
    center.removeItem(item.id);
  };
  for (const item of center.items) {
    const navigation = item.workflowNavigation;
    if (!navigation) continue;
    if (navigation.kind === 'review') {
      const task = resolveTaskReference(tasks, navigation.taskId);
      if (task && task.status !== 'InReview') remove(item);
      continue;
    }
    if (chat.hydrationStatus !== 'ready') continue;
    const conversation = chat.conversations.find((candidate) => candidate.id === navigation.conversationId);
    if (!conversation) {
      remove(item);
    } else if ((navigation.requestKind === 'approval' ||
        chat.messageLoadStatusByConversationId[conversation.id] === 'ready') && !activeKeys.has(item.id)) {
      remove(item);
    }
  }
};

export const subscribeToWorkflowAttentionNotifications = (t: TFunction) => {
  void initializeDesktopNotifications();
  reconcileWorkflowAttentionNotifications();
  const unsubscribeChat = useChatStore.subscribe((nextState, previousState) => {
    const events = detectNewChatAttentionEvents(
      previousState,
      nextState,
      getAttentionContext(),
    );
    events.forEach((event) => emitWorkflowAttentionNotification(event, t));
    reconcileWorkflowAttentionNotifications();
  });
  const unsubscribeTasks = useTaskStore.subscribe((nextState, previousState) => {
    const events = detectNewReviewAttentionEvents(
      previousState.tasks,
      nextState.tasks,
      getAttentionContext(),
      useChatStore.getState().conversations,
    );
    events.forEach((event) => emitWorkflowAttentionNotification(event, t));
    reconcileWorkflowAttentionNotifications();
  });

  return () => {
    unsubscribeChat();
    unsubscribeTasks();
  };
};

export const WorkflowAttentionNotifications = () => {
  const { t } = useTranslation();

  useEffect(() => subscribeToWorkflowAttentionNotifications(t), [t]);

  return null;
};
