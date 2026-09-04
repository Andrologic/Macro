import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import {
  detectNewChatAttentionEvents,
  detectNewReviewAttentionEvents,
  type WorkflowAttentionEvent,
} from '../../services/workflowAttentionEvents';
import { getScopedProjectIds } from '../../services/globalProjects';
import { notify } from '../ui/toastService';

const getAttentionContext = () => {
  const appState = useAppStore.getState();
  return {
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

export const openAttentionContext = async (
  event: WorkflowAttentionEvent,
): Promise<void> => {
  const appState = useAppStore.getState();
  const chatState = useChatStore.getState();

  if (event.kind === 'review') {
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

  if (event.mode === 'Architect') {
    if (event.groupId) {
      if (event.groupId !== appState.selectedGroupId) {
        appState.setSelectedGroup(event.groupId, {
          restoreProjectContext: false,
          ensureAutoPlan: false,
        });
      }
    } else if (event.projectId) {
      await appState.switchProjectContext(event.projectId, {
        restoreProjectContext: false,
        ensureAutoPlan: false,
      });
    }
  }

  appState.setMode(event.mode, {
    ensureAutoPlan: event.mode !== 'Architect',
  });
  if (event.mode === 'Architect') {
    const metadata = await useAppStore
      .getState()
      .loadMacroProjectMetadataForSelection({
        hydrateActivePlan: false,
        reason: 'manual',
      });
    const ownerPlan = metadata?.snapshot.visiblePlans.find(
      (plan) => plan.conversationId === event.conversationId,
    );
    if (ownerPlan) {
      await useAppStore.getState().activateArchitectPlan(ownerPlan.id, {
        targetBranch: ownerPlan.targetBranch,
        allowScopeSwitch: false,
        consolidateBlankPlans: false,
        planSummaryHint: ownerPlan,
        scopedProjectIdsHint: metadata?.snapshot.scopedProjectIds,
      });
    } else {
      await useAppStore.getState().loadMacroProjectMetadataForSelection({
        hydrateActivePlan: true,
        reason: 'manual',
      });
    }
  }
  if (event.mode === 'Implement') {
    appState.setSelectedTask(event.taskId);
  }
  await chatState.ensureConversationForCurrentMode();
  const selected = await chatState.selectConversation(event.conversationId);
  if (!selected) {
    await chatState.ensureConversationForCurrentMode();
  }
};

export const emitWorkflowAttentionNotification = (
  event: WorkflowAttentionEvent,
  t: TFunction,
): void => {
  const action = {
    label: t('notifications.workflow.openAction', 'Open'),
    onClick: () => openAttentionContext(event),
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
  });
};

export const subscribeToWorkflowAttentionNotifications = (t: TFunction) => {
  const unsubscribeChat = useChatStore.subscribe((nextState, previousState) => {
    const events = detectNewChatAttentionEvents(
      previousState,
      nextState,
      getAttentionContext(),
    );
    events.forEach((event) => emitWorkflowAttentionNotification(event, t));
  });
  const unsubscribeTasks = useTaskStore.subscribe((nextState, previousState) => {
    const events = detectNewReviewAttentionEvents(
      previousState.tasks,
      nextState.tasks,
      getAttentionContext(),
      useChatStore.getState().conversations,
    );
    events.forEach((event) => emitWorkflowAttentionNotification(event, t));
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
