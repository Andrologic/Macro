import { loadPlanReview, type PlanReviewResult } from './architectGitFlowService';
import { buildMergeWorkflowConflictAssistantPrompt } from './conflictResolution';
import type {
  CatalogedImplementTask,
  ImplementTaskPlanSummary,
} from './implementTaskCatalog';
import {
  buildPlanFinalizationTaskId,
} from './planFinalization';
import {
  resolveMergeWorkflowFocusContext,
  toPlanFinalizationMergeWorkflowRuntimeState,
  type MergeWorkflowRuntimeState,
} from './mergeWorkflow';
import type { InternalAgentProfile } from './internalAgentProfile';

export const loadPlanFinalizationMergeWorkflowRuntime = async (params: {
  taskId: string;
  summary: Pick<ImplementTaskPlanSummary, 'id' | 'storageBranch'>;
  loadReview?: (params: {
    branchName: string;
    planId: string;
    syncBaseBranches?: boolean;
  }) => Promise<PlanReviewResult>;
}): Promise<MergeWorkflowRuntimeState> => {
  const reviewLoader = params.loadReview || loadPlanReview;
  const review = await reviewLoader({
    branchName: params.summary.storageBranch,
    planId: params.summary.id,
    syncBaseBranches: false,
  });

  return toPlanFinalizationMergeWorkflowRuntimeState({
    taskId: params.taskId,
    review,
  });
};

export const resolveMergeWorkflowActivationContext = (params: {
  task: Pick<
    CatalogedImplementTask,
    'execution_targets' | 'plan_target_branch' | 'assigned_branch'
  >;
  runtime?: Pick<MergeWorkflowRuntimeState, 'repositories'> | null;
  preferredProjectId?: string | null;
  resolveRepoPath: (projectId: string, explicitRepoPath?: string | null) => string | null;
}): { repoPath: string | null; branchName: string | null } => {
  const repositoryTargets =
    params.runtime?.repositories.map((repository) => ({
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      targetBranchName: repository.targetBranchName,
    })) || [];

  if (repositoryTargets.length > 0) {
    const focus = resolveMergeWorkflowFocusContext(
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
  const focus = resolveMergeWorkflowFocusContext(
    executionTargets,
    params.preferredProjectId
  );
  const focusedExecutionTarget = params.preferredProjectId
    ? params.task.execution_targets?.find((target) => target.projectId === params.preferredProjectId)
    : params.task.execution_targets?.length === 1
      ? params.task.execution_targets[0]
      : null;
  return {
    repoPath: focus.repoPath,
    branchName:
      focus.branchName || (focusedExecutionTarget?.executionMode === 'direct'
        ? null
        : params.task.plan_target_branch || params.task.assigned_branch),
  };
};

export const sendMergeWorkflowConflictPrompt = async (params: {
  task: Pick<CatalogedImplementTask, 'id' | 'title' | 'plan_id' | 'plan_title' | 'project_id'>;
  runtime: Pick<MergeWorkflowRuntimeState, 'blockedRepositories' | 'review' | 'kind'>;
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

  const prompt = buildMergeWorkflowConflictAssistantPrompt({
    kind: params.runtime.kind,
    title:
      params.runtime.review?.title ||
      params.runtime.review?.planTitle ||
      params.task.plan_title ||
      params.task.title,
    repositories: params.runtime.blockedRepositories,
  });
  const conversationId =
    (await params.ensureConversationForCurrentMode()) ||
    (
      await params.createConversation(
        `Task - ${params.task.title}`,
        params.runtime.kind === 'plan_finalization'
          ? buildPlanFinalizationTaskId(params.task.plan_id)
          : params.task.id,
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
