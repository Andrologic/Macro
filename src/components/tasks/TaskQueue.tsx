import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore, type ImplementTask } from '../../stores/useTaskStore';
import { useFileChangesStore } from '../../stores/useFileChangesStore';
import { getArchitectPlanDisplayName } from '../../services/architectPlanPresentation';
import { getGitFlowBaseBranch } from '../../services/architectPlanService';
import { taskMatchesProjectId } from '../../services/implementTaskCatalog';
import { getScopedProjectIds } from '../../services/globalProjects';
import {
  getTaskRepositoryDescriptors,
  type ReviewRepositoryUiState,
  type ReviewTaskSummary,
  type TaskRepositoryDescriptor,
} from '../../services/implementMultiRepoSummary';
import { Icon, IconName } from '../ui/Icon';
import { Select } from '../ui/Select';
import { cn } from '../../utils/cn';
import { toast } from '../ui/Toaster';
import { PlanReviewModal } from '../plan/PlanReviewModal';
import type { TaskStatus } from '../../types';

interface TaskQueueProps {
  className?: string;
}

const ALL_PLANS_FILTER = '__all__';
const STANDALONE_FILTER = '__standalone__';

const statusConfig: Record<TaskStatus, { icon: IconName; color: string; bgColor: string }> = {
  Pending: { icon: 'circle', color: 'text-muted-foreground', bgColor: 'bg-muted' },
  InProgress: { icon: 'loader', color: 'text-amber-500', bgColor: 'bg-amber-500/10' },
  AwaitingResponse: { icon: 'message-circle', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  InReview: { icon: 'search', color: 'text-sky-400', bgColor: 'bg-sky-500/10' },
  Completed: { icon: 'check-circle', color: 'text-emerald-500', bgColor: 'bg-emerald-500/10' },
  Failed: { icon: 'alert-circle', color: 'text-red-400', bgColor: 'bg-red-500/10' },
  Blocked: { icon: 'lock', color: 'text-orange-400', bgColor: 'bg-orange-500/10' },
};

const readyStatusOrder: Record<TaskStatus, number> = {
  InProgress: 0,
  AwaitingResponse: 1,
  InReview: 2,
  Pending: 3,
  Blocked: 4,
  Failed: 5,
  Completed: 6,
};

const REPOSITORY_CHIP_STATE_CLASSES: Record<ReviewRepositoryUiState, string> = {
  pending_review: 'border-amber-500/20 bg-amber-500/10 text-amber-500',
  ready_to_commit: 'border-sky-500/20 bg-sky-500/10 text-sky-400',
  committed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500',
  no_changes: 'border-border bg-muted/60 text-muted-foreground',
};

interface MultiRepoTaskPresentation {
  repositories: Array<{
    id: string;
    label: string;
    title: string;
    state: ReviewRepositoryUiState | null;
    isCurrent: boolean;
    isNext: boolean;
  }>;
  progressLabel: string;
  nextActionLabel: string;
}

interface TaskItemProps {
  task: ImplementTask;
  isSelected: boolean;
  planLabel: string;
  statusLabel: string;
  multiRepoPresentation: MultiRepoTaskPresentation | null;
  isAssistantRunning: boolean;
  onSelect: () => void;
}

const TaskItem: React.FC<TaskItemProps> = ({
  task,
  isSelected,
  planLabel,
  statusLabel,
  multiRepoPresentation,
  isAssistantRunning,
  onSelect,
}) => {
  const { t } = useTranslation();
  const isDraft = task.draft === true;
  const showPlanLabel = task.task_source === 'architect' && planLabel.trim().length > 0;
  const isAwaitingUserReply = !isDraft && !isAssistantRunning && task.status === 'AwaitingResponse';
  const status = isAssistantRunning
    ? { icon: 'loader' as IconName, color: 'text-amber-500', bgColor: 'bg-amber-500/10' }
    : statusConfig[task.status] || statusConfig.Pending;
  const lockTooltip = task.is_blocked
    ? t('implement.blockedBy', 'Blocked by: {{tasks}}', {
      tasks: task.blocked_by.join(', '),
    })
    : '';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'w-full text-left px-3 py-3 rounded-lg border transition-all duration-200 group cursor-pointer',
        isSelected
          ? 'bg-primary/10 border-primary/30'
          : isAssistantRunning
            ? 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10'
            : isAwaitingUserReply
              ? 'border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10'
              : 'border-transparent hover:bg-accent'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="relative shrink-0 group/lock">
          <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center', status.bgColor)}>
            <Icon
              name={status.icon}
              size={14}
              className={cn(status.color, isAssistantRunning && 'animate-spin')}
            />
          </div>
          {task.is_blocked && task.blocked_by.length > 0 && (
            <div className="pointer-events-none absolute left-0 top-8 z-20 hidden min-w-56 max-w-72 rounded-md border border-orange-500/30 bg-popover px-2 py-1.5 text-xs text-orange-300 shadow-lg group-hover/lock:block">
              {lockTooltip}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground leading-tight">{task.title}</h3>

          {task.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.description}</p>
          )}

          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {isDraft ? (
              <span className="text-xs px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400">
                {t('implement.manualFeatureDraft', 'Draft')}
              </span>
            ) : isAssistantRunning ? (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500">
                <Icon name="loader" size={10} className="animate-spin" />
                {t('implement.aiRunning', 'AI running')}
              </span>
            ) : isAwaitingUserReply ? (
              <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-500">
                <Icon name="message-circle" size={10} />
                {t('implement.awaitingYourReply', 'Awaiting your reply')}
              </span>
            ) : task.status !== 'Blocked' && (
              <span className={cn('text-xs px-1.5 py-0.5 rounded', status.bgColor, status.color)}>
                {statusLabel}
              </span>
            )}

            {showPlanLabel && (
              <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground">
                <Icon name="layers" size={10} />
                {planLabel}
              </span>
            )}

            {!isDraft && task.branch_name && (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1 leading-none">
                <Icon name="git-branch" size={10} />
                {task.branch_name}
              </span>
            )}

            {multiRepoPresentation && (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1 leading-none">
                <Icon name="folder" size={10} />
                {t('implement.multiProjectTask', '{{count}} repositories', {
                  count: multiRepoPresentation.repositories.length,
                })}
              </span>
            )}
          </div>

          {multiRepoPresentation && (
            <div className="mt-2 space-y-1.5">
              <div className="flex flex-wrap gap-1">
                {multiRepoPresentation.repositories.map((repository) => (
                  <span
                    key={repository.id}
                    title={repository.title}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                      repository.state ? REPOSITORY_CHIP_STATE_CLASSES[repository.state] : 'border-border bg-muted/40 text-muted-foreground'
                    )}
                  >
                    <span>{repository.label}</span>
                    {repository.isCurrent && (
                      <span className="text-primary">{t('implement.currentRepository', 'Current')}</span>
                    )}
                    {repository.isNext && !repository.isCurrent && (
                      <span className="text-sky-400">{t('implement.nextRepository', 'Next')}</span>
                    )}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{multiRepoPresentation.progressLabel}</p>
              <p className="text-[11px] text-muted-foreground">{multiRepoPresentation.nextActionLabel}</p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

const MemoizedTaskItem = React.memo(TaskItem);

const TaskQueueBase: React.FC<TaskQueueProps> = ({ className }) => {
  const { t } = useTranslation();
  const {
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    projectGroups,
    implementExecutionMode,
    setImplementExecutionMode,
    setSelectedTask,
  } = useAppStore();
  const getProjectById = useAppStore((state) => state.getProjectById);
  const createConversation = useChatStore((state) => state.createConversation);
  const conversations = useChatStore((state) => state.conversations);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const selectedConversationId = useChatStore((state) => state.selectedConversationId);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const tasks = useTaskStore((state) => state.tasks);
  const planSummaries = useTaskStore((state) => state.planSummaries);
  const hasStandaloneTasks = useTaskStore((state) => state.hasStandaloneTasks);
  const finalizingPlanId = useTaskStore((state) => state.finalizingPlanId);
  const activateTask = useTaskStore((state) => state.activateTask);
  const createManualFeatureDraft = useTaskStore((state) => state.createManualFeatureDraft);
  const taskError = useTaskStore((state) => state.lastError);
  const reviewCurrentTaskId = useFileChangesStore((state) => state.currentTaskId);
  const liveReviewSummary = useFileChangesStore((state) => state.reviewSummary);
  const lastErrorToastRef = useRef<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [planFilter, setPlanFilter] = useState<string>(ALL_PLANS_FILTER);
  const [planReviewTarget, setPlanReviewTarget] = useState<{ planId: string; branchName: string } | null>(null);

  useEffect(() => {
    if (!taskError || taskError === lastErrorToastRef.current) return;
    lastErrorToastRef.current = taskError;
    toast.error(taskError);
  }, [taskError]);

  const handleCreateManualFeature = async () => {
    if (pendingTaskId || !selectedGroupId) return;
    const selectedGroup = projectGroups.find((group) => group.id === selectedGroupId);
    const projectIds = selectedGroup?.projects.map((project) => project.id) ?? [];
    const conversationProjectId =
      (selectedProjectId && projectIds.includes(selectedProjectId) ? selectedProjectId : null) ||
      selectedGroup?.projects[0]?.id ||
      null;

    if (projectIds.length === 0) {
      toast.error(t('implement.manualFeatureMissingProjects', 'No repository is available for this global project.'));
      return;
    }

    const taskId = `manual-feature-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPendingTaskId(taskId);

    try {
      setSelectedTask(taskId);
      const conversation = await createConversation(
        t('implement.manualFeatureUntitled', 'New feature'),
        taskId,
        conversationProjectId,
        selectedGroupId
      );
      await createManualFeatureDraft({
        taskId,
        conversationId: conversation.id,
        groupId: selectedGroupId,
        projectIds,
        baseBranch: getGitFlowBaseBranch(),
        title: t('implement.manualFeatureUntitled', 'New feature'),
        description: '',
      });
      await activateTask(taskId);
      selectConversation(conversation.id);
    } catch (error) {
      setSelectedTask(null);
      const message = error instanceof Error ? error.message : t('implement.manualFeatureCreateFailed', 'Failed to create manual feature.');
      toast.error(message);
    } finally {
      setPendingTaskId((current) => (current === taskId ? null : current));
    }
  };

  const statusLabels: Record<TaskStatus, string> = {
    Pending: t('tasks.pending', 'Pending'),
    InProgress: t('tasks.inProgress', 'In Progress'),
    AwaitingResponse: t('implement.awaitingResponse', 'Awaiting response'),
    InReview: t('implement.inReview', 'In Review'),
    Completed: t('tasks.completed', 'Completed'),
    Failed: t('implement.failed', 'Failed'),
    Blocked: t('tasks.blocked', 'Blocked'),
  };
  const standalonePlanLabel = t('implement.planFilterStandalone', 'No plan / standalone');

  const buildMultiRepoPresentation = (
    task: ImplementTask,
    reviewSummary: ReviewTaskSummary | null
  ): MultiRepoTaskPresentation | null => {
    const repositoryDescriptors = getTaskRepositoryDescriptors(
      task,
      (projectId) => getProjectById(projectId) ?? null
    );

    if (repositoryDescriptors.length <= 1) {
      return null;
    }

    const reviewSummaryByKey = new Map(
      (reviewSummary?.repositories || []).map((repository) => [
        `${repository.projectId}:${repository.branchName}`,
        repository,
      ])
    );
    const repositoryLabelForSummary = (descriptor: TaskRepositoryDescriptor): string =>
      descriptor.projectName ||
      descriptor.repoPath?.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
      descriptor.projectId;
    const nextRepositoryDescriptor =
      reviewSummary?.nextRepositoryId
        ? repositoryDescriptors.find((descriptor) => {
          const repositorySummary = reviewSummaryByKey.get(`${descriptor.projectId}:${descriptor.branchName}`);
          return repositorySummary?.id === reviewSummary.nextRepositoryId;
        }) ?? null
        : null;

    const repositories = repositoryDescriptors.map((descriptor) => {
      const repositorySummary = reviewSummaryByKey.get(`${descriptor.projectId}:${descriptor.branchName}`) ?? null;
      return {
        id: descriptor.id,
        label: descriptor.label,
        title: descriptor.repoPath || descriptor.label,
        state: repositorySummary?.state ?? null,
        isCurrent: repositorySummary?.id === reviewSummary?.currentRepositoryId,
        isNext: repositorySummary?.id === reviewSummary?.nextRepositoryId,
      };
    });

    let progressLabel = t('implement.repositoryCountInline', '{{count}} repositories involved', {
      count: repositoryDescriptors.length,
    });
    let nextActionLabel = t('implement.taskNextActionStart', 'Next: start implementation');

    if (reviewSummary && task.status === 'InReview') {
      const resolvedCount = reviewSummary.stateCounts.committed + reviewSummary.stateCounts.no_changes;
      progressLabel = t('implement.taskReviewProgress', '{{resolved}}/{{total}} repositories resolved', {
        resolved: resolvedCount,
        total: reviewSummary.repositoryCount,
      });

      if (reviewSummary.nextAction === 'commit_repository' && nextRepositoryDescriptor) {
        nextActionLabel = t('implement.taskNextActionCommitRepository', 'Next: commit {{repository}}', {
          repository: repositoryLabelForSummary(nextRepositoryDescriptor),
        });
      } else if (reviewSummary.nextAction === 'review_repository' && nextRepositoryDescriptor) {
        nextActionLabel = t('implement.taskNextActionReviewRepository', 'Next: review {{repository}}', {
          repository: repositoryLabelForSummary(nextRepositoryDescriptor),
        });
      } else if (reviewSummary.nextAction === 'complete_without_code_changes') {
        nextActionLabel = t(
          'implement.taskNextActionCompleteWithoutCodeChanges',
          'Next: complete without code changes'
        );
      } else if (reviewSummary.nextAction === 'complete_task') {
        nextActionLabel = t('implement.taskNextActionCompleteTask', 'Next: task completion');
      } else {
        nextActionLabel = t(
          'implement.taskNextActionReviewAllRepositories',
          'Next: review and resolve the remaining repositories'
        );
      }
    } else if (task.status === 'InProgress') {
      nextActionLabel = t('implement.taskNextActionContinueImplementation', 'Next: continue implementation');
    } else if (task.status === 'AwaitingResponse') {
      nextActionLabel = t('implement.taskNextActionAwaitingResponse', 'Next: answer the pending request');
    } else if (task.status === 'InReview') {
      nextActionLabel = t(
        'implement.taskNextActionReviewRepositories',
        'Next: review and commit each repository'
      );
    } else if (task.status === 'Completed') {
      nextActionLabel = t('implement.taskNextActionCompleted', 'Task completed across repositories');
    } else if (task.status === 'Failed') {
      nextActionLabel = t('implement.taskNextActionRetry', 'Next: retry task');
    } else if (task.status === 'Blocked') {
      nextActionLabel = t('implement.taskNextActionBlocked', 'Next: unblock task dependencies');
    }

    return {
      repositories,
      progressLabel,
      nextActionLabel,
    };
  };

  const scopedTasks = useMemo(() => {
    const scopedProjectIds = getScopedProjectIds(projectGroups, selectedGroupId, selectedProjectId);
    if (scopedProjectIds.length === 0) return [];

    return tasks.filter((task) =>
      scopedProjectIds.some((projectId) => taskMatchesProjectId(task, projectId))
    );
  }, [tasks, selectedProjectId, selectedGroupId, projectGroups]);

  const availablePlanSummaries = useMemo(() => {
    const scopedPlanIds = new Set(
      scopedTasks
        .filter((task) => task.task_source === 'architect')
        .map((task) => task.plan_id)
    );
    return planSummaries.filter((plan) => scopedPlanIds.has(plan.id));
  }, [planSummaries, scopedTasks]);

  const planLabelsById = useMemo(() => {
    return new Map(
      availablePlanSummaries.map((plan) => [
        plan.id,
        getArchitectPlanDisplayName(plan),
      ])
    );
  }, [availablePlanSummaries]);

  const hasScopedStandaloneTasks = useMemo(() => {
    if (!hasStandaloneTasks) return false;
    return scopedTasks.some((task) => task.task_source === 'standalone');
  }, [hasStandaloneTasks, scopedTasks]);
  const readyPlanSummaries = useMemo(
    () => availablePlanSummaries.filter((plan) => plan.readyForValidation),
    [availablePlanSummaries]
  );
  const visibleReadyPlans = useMemo(() => {
    if (planFilter !== ALL_PLANS_FILTER && planFilter !== STANDALONE_FILTER) {
      return readyPlanSummaries.filter((plan) => plan.id === planFilter);
    }
    return readyPlanSummaries;
  }, [planFilter, readyPlanSummaries]);

  useEffect(() => {
    if (planFilter === ALL_PLANS_FILTER) return;
    if (planFilter === STANDALONE_FILTER && hasScopedStandaloneTasks) return;
    if (availablePlanSummaries.some((plan) => plan.id === planFilter)) return;
    setPlanFilter(ALL_PLANS_FILTER);
  }, [availablePlanSummaries, hasScopedStandaloneTasks, planFilter]);

  const filteredTasks = useMemo(() => {
    if (planFilter === ALL_PLANS_FILTER) {
      return scopedTasks;
    }
    if (planFilter === STANDALONE_FILTER) {
      return scopedTasks.filter((task) => task.task_source === 'standalone');
    }
    return scopedTasks.filter((task) => task.plan_id === planFilter);
  }, [planFilter, scopedTasks]);

  const draftTasks = useMemo(
    () => filteredTasks.filter((task) => task.draft),
    [filteredTasks]
  );

  const getTaskPlanLabel = (task: ImplementTask): string => {
    if (task.task_source === 'standalone') {
      return standalonePlanLabel;
    }

    return planLabelsById.get(task.plan_id) || task.plan_title || standalonePlanLabel;
  };

  const readyTasks = useMemo(() => {
    return [...filteredTasks]
      .filter((task) => !task.draft && !task.is_blocked && task.status !== 'Completed')
      .sort((a, b) => {
        const byStatus = readyStatusOrder[a.status] - readyStatusOrder[b.status];
        if (byStatus !== 0) return byStatus;
        return a.sequence_index - b.sequence_index;
      });
  }, [filteredTasks]);

  const blockedTasks = useMemo(() => {
    return [...filteredTasks]
      .filter((task) => !task.draft && task.is_blocked)
      .sort((a, b) => a.sequence_index - b.sequence_index);
  }, [filteredTasks]);

  const progressTasks = useMemo(
    () => filteredTasks.filter((task) => !task.draft),
    [filteredTasks]
  );
  const completedCount = progressTasks.filter((task) => task.status === 'Completed').length;
  const totalCount = progressTasks.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  const streamingTaskId = useMemo(() => {
    if (!isStreaming || !selectedConversationId) {
      return null;
    }

    return (
      conversations.find((conversation) => conversation.id === selectedConversationId)?.task_id ??
      null
    );
  }, [conversations, isStreaming, selectedConversationId]);

  if (!selectedGroupId) {
    return (
      <aside className={cn('h-full w-full bg-card border-r border-border flex items-center justify-center', className)}>
        <div className="text-center px-6">
          <Icon name="list-todo" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">
            {t('implement.selectProject', 'Select a project to view tasks')}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn('h-full w-full bg-card border-r border-border flex flex-col', className)}>
      <div className="h-12 border-b border-border flex items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Icon name="list-todo" size={16} className="text-primary" />
            {t('implement.tasks', 'Tasks')}
          </h1>
          <button
            type="button"
            onClick={() => void handleCreateManualFeature()}
            disabled={Boolean(pendingTaskId)}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
              pendingTaskId
                ? 'border-border bg-muted text-muted-foreground cursor-not-allowed'
                : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            title={t('implement.createManualFeature', 'Create manual feature')}
          >
            <Icon name={pendingTaskId ? 'loader' : 'plus'} size={12} className={pendingTaskId ? 'animate-spin' : undefined} />
          </button>
        </div>
        <div className="inline-flex shrink-0 items-center rounded-lg border border-border bg-muted/60 p-0.5">
          <button
            type="button"
            onClick={() => setImplementExecutionMode('semi_auto')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              implementExecutionMode === 'semi_auto'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            title={t('implement.executionModeSemiAuto', 'Semi-auto')}
          >
            <Icon name="pause" size={11} />
            {t('implement.executionModeSemiAuto', 'Semi-auto')}
          </button>
          <button
            type="button"
            onClick={() => setImplementExecutionMode('full_auto')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              implementExecutionMode === 'full_auto'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            title={t('implement.executionModeFullAuto', 'Full-auto')}
          >
            <Icon name="play" size={11} />
            {t('implement.executionModeFullAuto', 'Full-auto')}
          </button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border">
        <div className="mb-3">
          <Select
            value={planFilter}
            onChange={(event) => setPlanFilter(event.target.value)}
            className="h-9 py-1.5 text-xs"
          >
            <option value={ALL_PLANS_FILTER}>
              {t('implement.planFilterAll', 'All plans')}
            </option>
            {availablePlanSummaries.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {planLabelsById.get(plan.id) || plan.title}
              </option>
            ))}
            {hasScopedStandaloneTasks && (
              <option value={STANDALONE_FILTER}>
                {t('implement.planFilterStandalone', 'No plan / standalone')}
              </option>
            )}
          </Select>
        </div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{t('architect.progress', 'Progress')}</span>
          <span className="text-xs font-medium text-foreground">
            {completedCount}/{totalCount}
          </span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        {visibleReadyPlans.length > 0 && (
          <div className="mt-3 space-y-2">
            {visibleReadyPlans.map((plan) => (
              <div
                key={plan.id}
                className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-emerald-500">
                      {t('implement.planReadyForValidation', 'Plan ready for validation')}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {planLabelsById.get(plan.id) || plan.title}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPlanReviewTarget({
                      planId: plan.id,
                      branchName: plan.targetBranch,
                    })}
                    disabled={Boolean(finalizingPlanId)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      finalizingPlanId
                        ? 'bg-muted text-muted-foreground cursor-not-allowed'
                        : 'bg-emerald-500 text-white hover:bg-emerald-600'
                    )}
                  >
                    <Icon name={finalizingPlanId === plan.id ? 'loader' : 'git-merge'} size={12} className={finalizingPlanId === plan.id ? 'animate-spin' : undefined} />
                    {finalizingPlanId === plan.id
                      ? t('implement.finalizingPlan', 'Finalizing...')
                      : t('implement.finalizePlan', 'Finalize plan')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {filteredTasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Icon name="check-circle" size={32} className="text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              {planFilter === ALL_PLANS_FILTER
                ? t('implement.noTasks', 'No tasks yet')
                : t('implement.noTasksForFilter', 'No task matches this filter.')}
            </p>
          </div>
        )}

        {filteredTasks.length > 0 && (
          <>
            {draftTasks.length > 0 && (
              <section className="space-y-1">
                <div className="px-1 pb-1 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-sky-400">
                    {t('implement.manualFeatureDrafts', 'Draft features')}
                  </h2>
                  <span className="text-xs text-muted-foreground">{draftTasks.length}</span>
                </div>

                {draftTasks.map((task) => (
                  <MemoizedTaskItem
                    key={task.id}
                    task={task}
                    isSelected={selectedTaskId === task.id}
                    planLabel={getTaskPlanLabel(task)}
                    statusLabel={statusLabels[task.status]}
                    multiRepoPresentation={null}
                    isAssistantRunning={streamingTaskId === task.id}
                    onSelect={() => void activateTask(task.id)}
                  />
                ))}
              </section>
            )}

            <section className="space-y-1">
              <div className="px-1 pb-1 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/80">
                  {t('implement.readyTasks', 'Ready tasks')}
                </h2>
                <span className="text-xs text-muted-foreground">{readyTasks.length}</span>
              </div>

              {readyTasks.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground rounded border border-dashed border-border">
                  {t('implement.noReadyTasks', 'No task is currently runnable.')}
                </div>
              )}

              {readyTasks.map((task) => (
                <MemoizedTaskItem
                  key={task.id}
                  task={task}
                  isSelected={selectedTaskId === task.id}
                  planLabel={getTaskPlanLabel(task)}
                  statusLabel={statusLabels[task.status]}
                  multiRepoPresentation={buildMultiRepoPresentation(
                    task,
                    reviewCurrentTaskId === task.id && liveReviewSummary.repositoryCount > 0
                      ? liveReviewSummary
                      : null
                  )}
                  isAssistantRunning={streamingTaskId === task.id}
                  onSelect={() => void activateTask(task.id)}
                />
              ))}
            </section>

            <section className="space-y-1 pt-1 border-t border-border/60">
              <div className="px-1 pb-1 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-orange-400">
                  {t('implement.blockedTasks', 'Blocked tasks')}
                </h2>
                <span className="text-xs text-muted-foreground">{blockedTasks.length}</span>
              </div>

              {blockedTasks.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground rounded border border-dashed border-border">
                  {t('implement.noBlockedTasks', 'No dependency-blocked task.')}
                </div>
              )}

              {blockedTasks.map((task) => (
                <MemoizedTaskItem
                  key={task.id}
                  task={task}
                  isSelected={selectedTaskId === task.id}
                  planLabel={getTaskPlanLabel(task)}
                  statusLabel={statusLabels[task.status]}
                  multiRepoPresentation={buildMultiRepoPresentation(
                    task,
                    reviewCurrentTaskId === task.id && liveReviewSummary.repositoryCount > 0
                      ? liveReviewSummary
                      : null
                  )}
                  isAssistantRunning={streamingTaskId === task.id}
                  onSelect={() => void activateTask(task.id)}
                />
              ))}
            </section>
          </>
        )}
      </div>

      {planReviewTarget && (
        <PlanReviewModal
          isOpen
          branchName={planReviewTarget.branchName}
          planId={planReviewTarget.planId}
          onClose={() => setPlanReviewTarget(null)}
        />
      )}
    </aside>
  );
};

export const TaskQueue = React.memo(TaskQueueBase);

export default TaskQueue;
