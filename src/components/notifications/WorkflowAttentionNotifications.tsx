import { claimHumanAttention030, notifiedHumanRequests030, subscribeRunHumanRequests030 } from '../../services/agsdl/humanAttention030';
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
import { WorkflowRunView030 } from '../agsdl/WorkflowRunView030';
import { Dialog } from '../ui/Dialog';
import { getWorkflowRunAccess030, subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030,
  subscribeWorkflowRunTarget030, workflowRunTargetSnapshot030, workflowRunOpenSequence030, openWorkflowRun030, type WorkflowRunRegistration030 } from '../../services/workflowAgentTasks';
import { humanRequestKey030, sameHumanScope030 } from '../../services/agsdl/humanRequests030';
import { isOperateRequestSnoozed } from '../../services/operateInboxModel';
import { retainedRunValue030 } from '../../services/agsdl/runtimeProjection030';
import type { RunHumanRequest030 } from '../../types/agsdlRunUi030';

export function emitRunAttentionNotification030(request: RunHumanRequest030, t: TFunction, conversationId?: string): void {
  if (!claimHumanAttention030(request)) return;
  const target = { scope: request.scope, requestId: request.id, ...(conversationId ? { conversationId } : {}) };
  notify.actionRequired(t('agsdl.shell030.attention', { ns: 'agsdl' }), {
    description: t('agsdl.shell030.attentionBody', { ns: 'agsdl' }),
    notificationKey: `human030:${humanRequestKey030(request)}`,
    category: 'task_attention_required',
    actions: [{ label: t('agsdl.shell030.openRequest', { ns: 'agsdl' }), onClick: () => { useNotificationCenterStore.getState().setCenterOpen(false); openWorkflowRun030(target); } }],
  });
}
export function subscribeRunAttention030(registrations: readonly WorkflowRunRegistration030[], t: TFunction) {
  return subscribeRunHumanRequests030(registrations, (request, conversationId, inspection) => {
    const snoozed = isOperateRequestSnoozed(inspection, request);
    if (request.state.kind === 'open' && !snoozed) {
      emitRunAttentionNotification030(request, t, conversationId);
      return;
    }
    if (snoozed) notifiedHumanRequests030.delete(humanRequestKey030(request));
    const center = useNotificationCenterStore.getState();
    const item = center.items.find(item => item.id === `human030:${humanRequestKey030(request)}`);
    if (item?.sessionToastId != null) notify.dismiss(item.sessionToastId);
    if (item) center.removeItem(item.id);
  });
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
  const opening = useSyncExternalStore(subscribeWorkflowRunTarget030, workflowRunOpenSequence030, workflowRunOpenSequence030);
  const target = workflowRunTargetSnapshot030();
  useEffect(() => subscribeToWorkflowAttentionNotifications(t), [t]);
  useEffect(() => subscribeRunAttention030(registrations, runT), [registrations, runT]);
  const owner = target?.scope.source.owner;
  const candidates = target && owner ? registrations.filter(({ scope }) => scope.owner.projectId === owner.projectId &&
    scope.owner.planId === owner.planId && scope.owner.branch === owner.branch &&
    (target.conversationId === undefined || scope.conversationId === target.conversationId)) : [];
  const bundle = target ? candidates.find(({ access }) => {
    const read = access.getSnapshot().runs[target.scope.systemStartId];
    const run = read && retainedRunValue030(read);
    return run && sameHumanScope030(run.capture, target.scope) && sameHumanScope030(run.state.scope, target.scope);
  }) ?? candidates.find(({ scope }) => scope.conversationId === target.conversationId) : undefined;
  useEffect(() => { if (target && !bundle) { try { getWorkflowRunAccess030({ owner: target.scope.source.owner, conversationId: target.conversationId }); } catch { /* The dedicated view reports unavailable access. */ } } }, [target, bundle]);
  return target ? <Dialog title={runT('agsdl.shell030.executions')} onClose={() => openWorkflowRun030(null)} closeOnBackdropClick
    panelClassName="flex h-[min(90vh,960px)] w-[min(94vw,1000px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
    <header className="flex items-center justify-between border-b border-border p-3 text-sm"><h2>{runT('agsdl.shell030.executions')}</h2><button type="button" onClick={() => openWorkflowRun030(null)}>{runT('agsdl.shell030.close')}</button></header>
    {bundle ? <WorkflowRunView030 key={opening} bundle={bundle} target={target} initialInstanceId={target.instanceId} /> : <p role="status" className="p-3 text-xs">{runT('agsdl.shell030.unavailable')}</p>}
  </Dialog> : null;
};
