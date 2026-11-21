import i18n from '../i18n';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useTaskStore } from '../stores/useTaskStore';
import type { Conversation } from '../types';
import { getArchitectPlanActivationPayload } from './architectPlanService';
import { isActiveArchitectAgsdlPlan, isExactArchitectAgsdlActivation } from './architectPlanSelection';
import { getAllProjects, getScopedProjectIds } from './globalProjects';
import { resolveTaskReference, taskReferenceMatches } from './durableIdentity';
import { loadMacroProjectMetadataForSelection } from './macroProjectMetadataLoader';
import type { WorkflowNotificationNavigation } from './workflowNotificationNavigation';

const openArchitectNotification = async (conversation: Conversation): Promise<void> => {
  if (conversation.task_id) return;
  const appState = useAppStore.getState();
  const { group_id: groupId, project_id: projectId, id: conversationId } = conversation;
  const projects = getAllProjects(appState);
  if (groupId ? !appState.projectGroups.some((group) => group.id === groupId) :
    !projectId || !projects.some((project) => project.id === projectId)) return;
  const scopedProjectIds = getScopedProjectIds(appState, groupId, groupId ? null : projectId);
  if (scopedProjectIds.length === 0) return;
  const scopedProjects = projects.filter((project) => scopedProjectIds.includes(project.id));
  const { snapshot } = await loadMacroProjectMetadataForSelection({
    selectedGroupId: groupId,
    selectedProjectId: projectId,
    scopedProjectIds,
    candidateBranches: scopedProjects.flatMap((project) => [
      project.gitFlowSettings?.baseBranch,
      project.gitFlowSettings?.mainBranch,
    ]),
  });
  const owners = snapshot.branches.flatMap(({ branchName, plans }) => plans
    .filter((plan) => plan.conversationId === conversationId && snapshot.visiblePlans.includes(plan))
    .map((plan) => ({ branchName, plan })));
  const owner = owners[0];
  if (owners.length !== 1 || !owner || !isActiveArchitectAgsdlPlan(owner.plan)) return;
  const { branchName, plan } = owner;
  const payload = await getArchitectPlanActivationPayload(branchName, plan.id, {
    summaryHint: plan,
    scopedProjectIdsHint: scopedProjectIds,
    requireStoredConversation: true,
  });
  if (!isExactArchitectAgsdlActivation(payload, plan.id, branchName, conversationId)) return;

  const latest = useAppStore.getState();
  if (latest.mode !== appState.mode ||
      latest.selectedGroupId !== appState.selectedGroupId ||
      latest.selectedProjectId !== appState.selectedProjectId ||
      latest.activePlanContext !== appState.activePlanContext ||
      !useChatStore.getState().conversations.some((candidate) =>
        candidate.id === conversationId && candidate.scope_mode === 'Architect' &&
        !candidate.task_id && candidate.group_id === groupId && candidate.project_id === projectId)) return;

  const switchOptions = { restoreProjectContext: false, ensureAutoPlan: false };
  if (groupId && latest.selectedGroupId !== groupId) {
    latest.setSelectedGroup(groupId, switchOptions);
  } else if (!groupId && projectId) {
    await latest.switchProjectContext(projectId, switchOptions);
  }
  const target = useAppStore.getState();
  if (target.mode !== latest.mode ||
      (groupId ? target.selectedGroupId !== groupId : target.selectedProjectId !== projectId)) return;

  target.setMode('Architect', { ensureAutoPlan: false });
  const options = {
    targetBranch: branchName,
    allowScopeSwitch: false,
    persistActiveSelection: false,
    consolidateBlankPlans: false,
    planSummaryHint: plan,
    scopedProjectIdsHint: scopedProjectIds,
    expectedAgsdlConversationId: conversationId,
  };
  if (!await target.activateArchitectPlan(plan.id, options)) return;
  const activated = useAppStore.getState();
  if (activated.mode !== 'Architect' || activated.activeArchitectPlanId !== plan.id ||
      activated.activePlanContext?.targetBranch !== branchName) return;
  await useChatStore.getState().selectConversation(conversationId);
};

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
    await openArchitectNotification(conversation);
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
