import { claimHumanAttention030 } from '../../services/agsdl/humanAttention030';
import { useEffect, useSyncExternalStore } from 'react';
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
  hasChatAttentionStateChanged,
  hasReviewAttentionStateChanged,
  type WorkflowAttentionEvent,
} from '../../services/workflowAttentionEvents';
import { getScopedProjectIds } from '../../services/globalProjects';
import { initializeDesktopNotifications, isAppForeground } from '../../services/desktopNotifications';
import { openWorkflowNotificationContext } from '../../services/openWorkflowNotificationContext';
import type { WorkflowNotificationNavigation } from '../../services/workflowNotificationNavigation';
import { notify } from '../ui/toastService';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';
import { WorkflowRunView030 } from '../architect/ArchitectStrategyPanel';
import { Dialog } from '../ui/Dialog';
import { getWorkflowRunAccess030, subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030,
  subscribeWorkflowRunTarget030, workflowRunTargetSnapshot030, openWorkflowRun030, type WorkflowRunRegistration030 } from '../../services/workflowAgentTasks';
import { humanRequestKey030 } from '../../services/agsdl/humanRequests030';
import type { RunHumanRequest030 } from '../../types/agsdlRunUi030';
import { sameWorkflowSource030 as sameSource } from '../../services/workflowAgentTasks';

export function emitRunAttentionNotification030(request: RunHumanRequest030, t: TFunction, conversationId?: string): void {
  if (request.state.kind !== 'open' || request.content.kind === 'unclassified' ||
      request.content.kind === 'question' && request.content.answerContract.kind !== 'available' || !claimHumanAttention030(request)) return;
  const target = { scope: request.scope, requestId: request.id, ...(conversationId ? { conversationId } : {}) };
  notify.actionRequired(t('agsdl.shell030.attention', { ns: 'agsdl' }), {
    description: t('agsdl.shell030.attentionBody', { ns: 'agsdl' }),
    notificationKey: `human030:${humanRequestKey030(request)}`,
    category: 'task_attention_required',
    actions: [{ label: t('agsdl.shell030.openRequest', { ns: 'agsdl' }), onClick: () => { useNotificationCenterStore.getState().setCenterOpen(false); openWorkflowRun030(target); } }],
  });
}
export function subscribeRunAttention030(registrations: readonly WorkflowRunRegistration030[], t: TFunction) {
  const subscriptions = registrations.map(({ access, scope }) => {
    const check = () => {
      const snapshot = access.getSnapshot();
      if (snapshot.history.kind === 'stale' || snapshot.history.kind === 'loading') return;
      for (const read of Object.values(snapshot.runs)) {
        if (read.kind !== 'ready' || read.value.state.humans.kind !== 'ready') continue;
        const { capture } = read.value;
        const humans = read.value.state.humans;
        if (humans.kind !== 'ready') continue;
        if (capture.source.owner.projectId !== scope.owner.projectId || capture.source.owner.planId !== scope.owner.planId ||
            capture.source.owner.branch !== scope.owner.branch) continue;
        for (const request of humans.value) {
          if (request.scope.systemStartId !== capture.systemStartId || !sameSource(request.scope.source, capture.source)) continue;
          const key = humanRequestKey030(request);
          if (request.state.kind !== 'open') {
            const center = useNotificationCenterStore.getState();
            const item = center.items.find(item => item.id === `human030:${key}`);
            if (item?.sessionToastId != null) notify.dismiss(item.sessionToastId);
            if (item) center.removeItem(item.id);
            continue;
          }
          if (request.content.kind === 'unclassified') continue;
          emitRunAttentionNotification030(request, t, scope.conversationId);
        }
      }
    };
    const unsubscribe = access.subscribe(check); check(); return unsubscribe;
  });
  return () => subscriptions.forEach(unsubscribe => unsubscribe());
}

const getAttentionContext = () => {
  const appState = useAppStore.getState();
  const taskState = useTaskStore.getState();
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
    tasks: taskState.tasks,
    taskCatalogLoadId: taskState.lastSuccessfulCatalogLoad?.loadId ?? null,
  };
};

export const emitWorkflowAttentionNotification = (
  event: WorkflowAttentionEvent,
  t: TFunction,
): void => {
  const workflowNavigation: WorkflowNotificationNavigation = event.kind === 'review'
    ? {
        kind: 'review',
        taskId: event.taskId,
        catalogScope: event.catalogScope,
        ...(event.catalogLoadId ? { catalogLoadId: event.catalogLoadId } : {}),
      }
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
  const taskState = useTaskStore.getState();
  const tasks = taskState.tasks;
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
      const successfulLoad = taskState.lastSuccessfulCatalogLoad;
      const taskAbsenceIsConfirmed = Boolean(
        navigation.catalogScope &&
        successfulLoad &&
        navigation.catalogLoadId !== successfulLoad.loadId &&
        navigation.catalogScope.selectedGroupId === successfulLoad.selectedGroupId &&
        navigation.catalogScope.selectedProjectId === successfulLoad.selectedProjectId &&
        !successfulLoad.taskIds.includes(navigation.taskId),
      );
      if (
        (task && task.status !== 'InReview') ||
        (!task && taskAbsenceIsConfirmed)
      ) {
        remove(item);
      }
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

export interface WorkflowAttentionSubscriptionDiagnostics {
  onChatRecalculation?: () => void;
  onTaskRecalculation?: () => void;
}

export const subscribeToWorkflowAttentionNotifications = (
  t: TFunction,
  diagnostics?: WorkflowAttentionSubscriptionDiagnostics,
) => {
  void initializeDesktopNotifications();
  reconcileWorkflowAttentionNotifications();
  const unsubscribeChat = useChatStore.subscribe((nextState, previousState) => {
    if (!hasChatAttentionStateChanged(previousState, nextState)) {
      return;
    }
    diagnostics?.onChatRecalculation?.();
    const events = detectNewChatAttentionEvents(
      previousState,
      nextState,
      getAttentionContext(),
    );
    events.forEach((event) => emitWorkflowAttentionNotification(event, t));
    reconcileWorkflowAttentionNotifications();
  });
  const unsubscribeTasks = useTaskStore.subscribe((nextState, previousState) => {
    if (
      previousState.isLoading === nextState.isLoading &&
      previousState.lastSuccessfulCatalogLoad === nextState.lastSuccessfulCatalogLoad &&
      !hasReviewAttentionStateChanged(previousState.tasks, nextState.tasks)
    ) {
      return;
    }
    diagnostics?.onTaskRecalculation?.();
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
  const { t: runT } = useAgsdlTranslation();
  const registrations = useSyncExternalStore(subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030, workflowRunAccessSnapshot030);
  const target = useSyncExternalStore(subscribeWorkflowRunTarget030, workflowRunTargetSnapshot030, workflowRunTargetSnapshot030);
  useEffect(() => subscribeToWorkflowAttentionNotifications(t), [t]);
  useEffect(() => subscribeRunAttention030(registrations, runT), [registrations, runT]);
  const bundle = target ? (registrations.find(item => Object.values(item.access.getSnapshot().runs).some(read =>
    read.kind === 'ready' && read.value.capture.systemStartId === target.scope.systemStartId && sameSource(read.value.capture.source, target.scope.source)))
    ?? registrations.find(item => item.scope.owner.projectId === target?.scope.source.owner.projectId && item.scope.owner.planId === target.scope.source.owner.planId &&
      item.scope.owner.branch === target.scope.source.owner.branch && item.scope.conversationId === target.conversationId)) : undefined;
  useEffect(() => { if (target && !bundle) { try { getWorkflowRunAccess030({ owner: target.scope.source.owner, conversationId: target.conversationId }); } catch { /* The dedicated view reports unavailable access. */ } } }, [target, bundle]);
  return target ? <Dialog title={runT('agsdl.shell030.executions')} onClose={() => openWorkflowRun030(null)} closeOnBackdropClick
    panelClassName="flex h-[min(90vh,960px)] w-[min(94vw,1000px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
    <header className="flex items-center justify-between border-b border-border p-3 text-sm"><h2>{runT('agsdl.shell030.executions')}</h2><button type="button" onClick={() => openWorkflowRun030(null)}>{runT('agsdl.shell030.close')}</button></header>
    {bundle ? <WorkflowRunView030 bundle={bundle} target={target} /> : <p role="status" className="p-3 text-xs">{runT('agsdl.shell030.unavailable')}</p>}
  </Dialog> : null;
};
