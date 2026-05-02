import { buildPlanFinalizationConflictAssistantPrompt } from './conflictResolution';
import { loadPlanReview, type PlanReviewResult } from './architectGitFlowService';
import type {
  CatalogedImplementTask,
  ImplementTaskPlanSummary,
} from './implementTaskCatalog';
import {
  buildPlanFinalizationTaskId,
  canPlanFinalizationTaskReceiveMessages,
  resolvePlanFinalizationFocusContext,
  toPlanFinalizationRuntimeStateFromReview,
  type PlanFinalizationRuntimeState,
} from './planFinalization';
import type { InternalAgentProfile } from './internalAgentProfile';
import type { TaskStatus } from '../types';

export const loadPlanFinalizationReviewRuntime = async (params: {
  summary: Pick<ImplementTaskPlanSummary, 'id' | 'storageBranch'>;
  loadReview?: (params: {
    branchName: string;
    planId: string;
    syncBaseBranches?: boolean;
  }) => Promise<PlanReviewResult>;
}): Promise<PlanFinalizationRuntimeState> => {
  const reviewLoader = params.loadReview || loadPlanReview;
  const review = await reviewLoader({
    branchName: params.summary.storageBranch,
    planId: params.summary.id,
    syncBaseBranches: true,
  });

  return toPlanFinalizationRuntimeStateFromReview(review);
};

export const resolvePlanFinalizationActivationContext = (params: {
  task: Pick<
    CatalogedImplementTask,
    'execution_targets' | 'plan_target_branch' | 'assigned_branch'
  >;
  runtime?: Pick<PlanFinalizationRuntimeState, 'repositories'> | null;
  preferredProjectId?: string | null;
  resolveRepoPath: (projectId: string, explicitRepoPath?: string | null) => string | null;
}): { repoPath: string | null; branchName: string | null } => {
  const repositoryTargets =
    params.runtime?.repositories.map((repository) => ({
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      baseBranchName: repository.baseBranchName,
    })) || [];
  if (repositoryTargets.length > 0) {
    const focus = resolvePlanFinalizationFocusContext(
      repositoryTargets,
      params.preferredProjectId
    );
    return {
      repoPath: focus.repoPath,
      branchName: focus.branchName,
    };
  }

  const executionTargets =
    params.task.execution_targets?.map((target) => ({
      projectId: target.projectId,
      repoPath: params.resolveRepoPath(target.projectId, target.repoPath),
      targetBranchName: target.targetBranchName,
      branchName: target.branchName,
    })) || [];
  const focus = resolvePlanFinalizationFocusContext(
    executionTargets,
    params.preferredProjectId
  );
  return {
    repoPath: focus.repoPath,
    branchName:
      focus.branchName || params.task.plan_target_branch || params.task.assigned_branch,
  };
};

export const sendPlanFinalizationConflictPrompt = async (params: {
  task: Pick<CatalogedImplementTask, 'id' | 'title' | 'plan_id' | 'plan_title' | 'project_id'>;
  runtime: Pick<PlanFinalizationRuntimeState, 'blockedRepositories' | 'review'>;
  selectedGroupId: string | null;
  selectedTaskId: string | null;
  ensureConversationForCurrentMode: () => Promise<string | null>;
  createConversation: (
    title: string,
    taskId: string | null,
    projectId: string | null,
    groupId?: string | null
  ) => Promise<{ id: string } | null>;
  sendMessage: (params: {
    conversationId: string;
    taskId: string;
    content: string;
    internalAgentProfile?: InternalAgentProfile | null;
  }) => Promise<unknown>;
  activateTask: (taskId: string) => Promise<void>;
  setMode: (mode: 'Implement') => void;
  setSelectedTask: (taskId: string) => void;
  internalAgentProfile?: InternalAgentProfile | null;
}): Promise<string | null> => {
  if (params.runtime.blockedRepositories.length === 0) {
    return null;
  }

  params.setMode('Implement');
  if (params.selectedTaskId !== params.task.id) {
    params.setSelectedTask(params.task.id);
    await params.activateTask(params.task.id);
  }

  const prompt = buildPlanFinalizationConflictAssistantPrompt({
    planTitle:
      params.runtime.review?.plan.title ||
      params.task.plan_title ||
      params.task.title,
    repositories: params.runtime.blockedRepositories,
  });
  const conversationId =
    (await params.ensureConversationForCurrentMode()) ||
    (
      await params.createConversation(
        `Task - ${params.task.title}`,
        buildPlanFinalizationTaskId(params.task.plan_id),
        params.task.project_id || null,
        params.selectedGroupId
      )
    )?.id ||
    null;

  if (!conversationId) {
    return null;
  }

  await params.sendMessage({
    conversationId,
    taskId: params.task.id,
    content: prompt,
    internalAgentProfile: params.internalAgentProfile ?? 'repo_auditor',
  });

  return conversationId;
};

export const assertPlanFinalizationTaskCanReceiveMessages = (
  status: TaskStatus
): boolean => canPlanFinalizationTaskReceiveMessages(status);
