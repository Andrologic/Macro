import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import {
  getTaskLifecycleCapabilities,
  useTaskStore,
  type ImplementTask,
} from '../../stores/useTaskStore';
import { useFileChangesStore } from '../../stores/useFileChangesStore';
import { getArchitectPlanDisplayName } from '../../services/architectPlanPresentation';
import { getGitFlowBaseBranch } from '../../services/architectPlanService';
import { taskMatchesProjectId } from '../../services/implementTaskCatalog';
import { getProjectGroupByProjectId, getScopedProjectIds } from '../../services/globalProjects';
import {
  getTaskRepositoryDescriptors,
  type ReviewRepositoryUiState,
  type ReviewTaskSummary,
  type TaskRepositoryDescriptor,
} from '../../services/implementMultiRepoSummary';
import {
  getTaskProjectCommand,
  loadTaskProjectCommandRegistry,
  saveTaskProjectCommandDrafts,
} from '../../services/taskProjectCommands';
import { isManualDraftPendingInitialization } from '../../services/manualDraftInitialization';
import { Icon, IconName } from '../ui/Icon';
import { Select } from '../ui/Select';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { cn } from '../../utils/cn';
import { toast } from '../ui/Toaster';
import { PlanReviewModal } from '../plan/PlanReviewModal';
import { TaskProjectCommandsModal } from './TaskProjectCommandsModal';
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

type TaskActionKey =
  | 'project_settings'
  | 'rename'
  | 'delete'
  | 'archive'
  | 'restore'
  | 'reopen';

interface TaskActionDescriptor {
  key: TaskActionKey;
  label: string;
  icon: IconName;
  disabled?: boolean;
  title?: string;
  destructive?: boolean;
}

interface TaskItemProps {
  task: ImplementTask;
  isSelected: boolean;
  planLabel: string;
  multiRepoPresentation: MultiRepoTaskPresentation | null;
  isAssistantRunning: boolean;
  taskCommandRunStatus: 'running' | 'cancelling' | null;
  canRunTaskCommands: boolean;
  runTaskCommandsTitle?: string;
  onSelect: () => void;
  onRunTaskCommands: () => void;
  onCancelTaskCommands: () => void;
  actions: TaskActionDescriptor[];
  onAction: (action: TaskActionKey) => void;
}

const TaskItem: React.FC<TaskItemProps> = ({
  task,
  isSelected,
  planLabel,
  multiRepoPresentation,
  isAssistantRunning,
  taskCommandRunStatus,
  canRunTaskCommands,
  runTaskCommandsTitle,
  onSelect,
  onRunTaskCommands,
  onCancelTaskCommands,
  actions,
  onAction,
}) => {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
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
  useEffect(() => {
    if (!showMenu) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowMenu(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showMenu]);

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
        'relative h-[112px] w-full overflow-hidden rounded-xl border text-left transition-all duration-200 group cursor-pointer',
        isSelected
          ? 'border-primary/30 bg-primary/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
          : isAssistantRunning
            ? 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10'
          : isAwaitingUserReply
              ? 'border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10'
              : 'border-border/70 bg-card/70 hover:border-primary/20 hover:bg-accent/30'
      )}
    >
      <div className="grid h-full grid-rows-[auto,1fr,auto] px-4 py-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setShowMenu((current) => !current);
          }}
          onMouseDown={(event) => event.stopPropagation()}
          className="absolute right-2 top-2.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t('implement.taskActions', 'Task actions')}
        >
          <Icon name="more-vertical" size={13} />
        </button>

        <div className="flex items-center gap-2.5">
          <div className="relative shrink-0 group/lock">
            <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', status.bgColor)}>
              <Icon
                name={status.icon}
                size={14}
                className={cn(status.color, isAssistantRunning && 'animate-spin')}
              />
            </div>
            {task.is_blocked && task.blocked_by.length > 0 && (
              <div className="pointer-events-none absolute left-0 top-9 z-20 hidden min-w-56 max-w-72 rounded-md border border-orange-500/30 bg-popover px-2 py-1.5 text-xs text-orange-300 shadow-lg group-hover/lock:block">
                {lockTooltip}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="pr-7 text-sm font-semibold leading-[1.1rem] text-foreground line-clamp-2">
              {task.title}
            </h3>
          </div>
        </div>

        <div className="min-h-0 space-y-1">
          {task.description && (
            <p className="line-clamp-2 text-[13px] leading-[1.15rem] text-muted-foreground">
              {task.description}
            </p>
          )}

          {showPlanLabel && (
            <div className="inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
              <Icon name="layers" size={10} />
              <span className="truncate">{planLabel}</span>
            </div>
          )}
        </div>

        <div className="mt-1 flex min-h-[28px] items-end justify-between gap-2">
          <div className="min-w-0 flex flex-1 flex-col justify-center gap-1 pb-0.5 pr-7">
            {!isDraft && task.branch_name && (
              <div className="inline-flex h-[18px] items-center gap-1.5 text-xs leading-none text-muted-foreground">
                <Icon name="git-branch" size={10} />
                <span className="truncate leading-none">{task.branch_name}</span>
              </div>
            )}

            {multiRepoPresentation && (
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Icon name="folder" size={10} />
                  {t('implement.multiProjectTask', '{{count}} repositories', {
                    count: multiRepoPresentation.repositories.length,
                  })}
                </span>
                <div className="flex min-w-0 flex-wrap gap-1">
                  {multiRepoPresentation.repositories.slice(0, 2).map((repository) => (
                    <span
                      key={repository.id}
                      title={repository.title}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                        repository.state
                          ? REPOSITORY_CHIP_STATE_CLASSES[repository.state]
                          : 'border-border bg-muted/40 text-muted-foreground'
                      )}
                    >
                      <span>{repository.label}</span>
                      {repository.isCurrent && (
                        <span className="text-primary">{t('implement.currentRepository', 'Current')}</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {taskCommandRunStatus ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCancelTaskCommands();
            }}
            onMouseDown={(event) => event.stopPropagation()}
            disabled={taskCommandRunStatus === 'cancelling'}
            className={cn(
              'absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              taskCommandRunStatus === 'cancelling'
                ? 'cursor-not-allowed text-muted-foreground'
                : 'text-amber-500 hover:bg-accent/70'
            )}
            title={
              taskCommandRunStatus === 'cancelling'
                ? t('implement.taskCommandCancelling', 'Cancelling...')
                : t('implement.cancelTaskCommands', 'Cancel run')
            }
          >
            <Icon
              name={taskCommandRunStatus === 'cancelling' ? 'loader' : 'x'}
              size={13}
              className={taskCommandRunStatus === 'cancelling' ? 'animate-spin' : undefined}
            />
          </button>
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRunTaskCommands();
            }}
            onMouseDown={(event) => event.stopPropagation()}
            disabled={!canRunTaskCommands}
            className={cn(
              'absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              canRunTaskCommands
                ? 'text-emerald-500 hover:bg-accent/70'
                : 'cursor-not-allowed text-muted-foreground/50'
            )}
            title={runTaskCommandsTitle || t('implement.runTaskCommands', 'Run commands')}
          >
            <Icon name="play" size={13} />
          </button>
        )}
      </div>

      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowMenu(false)}
          />
          <div
            className="absolute right-2 top-10 z-50 min-w-40 rounded-lg border border-border bg-card py-1 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (action.disabled) {
                    return;
                  }
                  setShowMenu(false);
                  onAction(action.key);
                }}
                disabled={action.disabled}
                title={action.title}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                  action.destructive
                    ? 'text-red-500 hover:bg-red-500/10'
                    : 'text-foreground hover:bg-accent',
                  action.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
                )}
              >
                <Icon name={action.icon} size={12} />
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
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
    openProjectGitFlowModal,
    setSelectedProject,
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
  const publishedStandaloneTasks = useTaskStore((state) => state.publishedStandaloneTasks);
  const finalizingPlanId = useTaskStore((state) => state.finalizingPlanId);
  const activateTask = useTaskStore((state) => state.activateTask);
  const createManualFeatureDraft = useTaskStore((state) => state.createManualFeatureDraft);
  const renameTask = useTaskStore((state) => state.renameTask);
  const archiveTask = useTaskStore((state) => state.archiveTask);
  const restoreTask = useTaskStore((state) => state.restoreTask);
  const deleteTask = useTaskStore((state) => state.deleteTask);
  const reopenTask = useTaskStore((state) => state.reopenTask);
  const taskCommandRuns = useTaskStore((state) => state.taskCommandRuns);
  const runTaskCommands = useTaskStore((state) => state.runTaskCommands);
  const cancelTaskCommands = useTaskStore((state) => state.cancelTaskCommands);
  const missingBaseBranchIssue = useTaskStore((state) => state.missingBaseBranchIssue);
  const clearMissingBaseBranchIssue = useTaskStore((state) => state.clearMissingBaseBranchIssue);
  const createMissingBaseBranch = useTaskStore((state) => state.createMissingBaseBranch);
  const taskError = useTaskStore((state) => state.lastError);
  const reviewCurrentTaskId = useFileChangesStore((state) => state.currentTaskId);
  const liveReviewSummary = useFileChangesStore((state) => state.reviewSummary);
  const lastErrorToastRef = useRef<string | null>(null);
  const missingBaseBranchToastRef = useRef<string | number | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [planFilter, setPlanFilter] = useState<string>(ALL_PLANS_FILTER);
  const [showArchived, setShowArchived] = useState(false);
  const [planReviewTarget, setPlanReviewTarget] = useState<{ planId: string; branchName: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<ImplementTask | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{ task: ImplementTask; action: 'archive' | 'delete' } | null>(null);
  const [taskCommandModal, setTaskCommandModal] = useState<{
    taskId: string;
    groupName: string;
    autoRunAfterSave: boolean;
    projects: Array<{
      projectId: string;
      projectName: string;
      projectPath: string;
      command: string;
      openTerminalOnRun: boolean;
    }>;
  } | null>(null);
  const [isSavingTaskCommands, setIsSavingTaskCommands] = useState(false);

  useEffect(() => {
    if (!taskError || taskError === lastErrorToastRef.current) return;
    lastErrorToastRef.current = taskError;
    toast.error(taskError);
  }, [taskError]);

  useEffect(() => {
    if (!missingBaseBranchIssue) {
      if (missingBaseBranchToastRef.current !== null) {
        toast.dismiss(missingBaseBranchToastRef.current);
      }
      missingBaseBranchToastRef.current = null;
      return;
    }

    const toastId = [
      'missing-base-branch',
      missingBaseBranchIssue.taskId,
      missingBaseBranchIssue.projectId,
      missingBaseBranchIssue.missingRef,
    ].join(':');
    if (toastId === missingBaseBranchToastRef.current) {
      return;
    }

    if (missingBaseBranchToastRef.current !== null) {
      toast.dismiss(missingBaseBranchToastRef.current);
    }

    missingBaseBranchToastRef.current = toastId;
    toast.warning(
      t(
        'implement.missingBaseBranchToastTitle',
        'Branche {{baseBranch}} introuvable',
        { baseBranch: missingBaseBranchIssue.missingRef }
      ),
      {
        notificationKey: toastId,
        notification: {
          category: 'task_attention_required',
        },
        duration: 12000,
        closeButton: true,
        actions: [
          {
            label: t('implement.missingBaseBranchCreateAction', 'Créer'),
            variant: 'primary',
            onClick: async () => {
              setPendingTaskId(missingBaseBranchIssue.taskId);
              try {
                await createMissingBaseBranch(missingBaseBranchIssue);
                toast.success(
                  t('implement.missingBaseBranchCreated', '{{baseBranch}} créée', {
                    baseBranch: missingBaseBranchIssue.missingRef,
                  })
                );
              } catch (error) {
                lastErrorToastRef.current =
                  error instanceof Error
                    ? error.message
                    : t('common.error', 'An error occurred');
                throw error;
              } finally {
                setPendingTaskId((current) =>
                  current === missingBaseBranchIssue.taskId ? null : current
                );
              }
            },
          },
          {
            label: t('implement.missingBaseBranchEditAction', 'Paramètres'),
            variant: 'secondary',
            onClick: () => {
              setSelectedTask(missingBaseBranchIssue.taskId);
              setSelectedProject(missingBaseBranchIssue.projectId);
              openProjectGitFlowModal(missingBaseBranchIssue.projectId);
              clearMissingBaseBranchIssue();
            },
          },
        ],
      }
    );
  }, [
    clearMissingBaseBranchIssue,
    createMissingBaseBranch,
    missingBaseBranchIssue,
    openProjectGitFlowModal,
    setSelectedProject,
    setSelectedTask,
    t,
  ]);

  const handleCreateManualFeature = async () => {
    if (pendingTaskId || !selectedGroupId) return;
    const selectedGroup = projectGroups.find((group) => group.id === selectedGroupId);
    const actionableProjectIds =
      selectedGroup?.projects
        .filter((project) => !project.isReadOnly)
        .map((project) => project.id) ?? [];
    const contextProjectIds =
      selectedGroup?.projects
        .filter((project) => project.isReadOnly)
        .map((project) => project.id) ?? [];
    const conversationProjectId =
      (selectedProjectId && actionableProjectIds.includes(selectedProjectId) ? selectedProjectId : null) ||
      actionableProjectIds[0] ||
      null;

    if (actionableProjectIds.length === 0) {
      toast.error(
        t(
          'implement.manualFeatureMissingProjects',
          'No editable repository is available for this global project.'
        )
      );
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
        projectIds: actionableProjectIds,
        contextProjectIds,
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
      progressLabel = t('implement.taskValidationProgress', '{{resolved}}/{{total}} subprojects resolved', {
        resolved: resolvedCount,
        total: reviewSummary.repositoryCount,
      });

      if (reviewSummary.nextAction === 'commit_repository' && nextRepositoryDescriptor) {
        nextActionLabel = t('implement.taskNextActionCommitRepository', 'Next: commit {{repository}}', {
          repository: repositoryLabelForSummary(nextRepositoryDescriptor),
        });
      } else if (reviewSummary.nextAction === 'review_repository' && nextRepositoryDescriptor) {
        nextActionLabel = t('implement.taskNextActionValidateRepository', 'Next: validate {{repository}}', {
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
          'implement.taskNextActionValidateAllRepositories',
          'Next: validate and resolve the remaining subprojects'
        );
      }
    } else if (task.status === 'InProgress') {
      nextActionLabel = t('implement.taskNextActionContinueImplementation', 'Next: continue implementation');
    } else if (task.status === 'AwaitingResponse') {
      nextActionLabel = t('implement.taskNextActionAwaitingResponse', 'Next: answer the pending request');
    } else if (task.status === 'InReview') {
      nextActionLabel = t(
        'implement.taskNextActionValidateRepositories',
        'Next: validate and commit each subproject'
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

  const getTaskPlanLabel = (task: ImplementTask): string => {
    if (task.task_source === 'standalone') {
      return standalonePlanLabel;
    }

    return planLabelsById.get(task.plan_id) || task.plan_title || standalonePlanLabel;
  };

  const getTaskCommandProjectIds = (task: ImplementTask): string[] => {
    const ids = [
      ...(task.execution_targets?.map((target) => target.projectId) || []),
      ...(task.project_ids || []),
      task.project_id,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return Array.from(new Set(ids));
  };

  const canRunTaskCommandsForTask = (task: ImplementTask): boolean =>
    !isManualDraftPendingInitialization(task) &&
    !task.draft &&
    !task.archived_at &&
    getTaskCommandProjectIds(task).length > 0;

  const getRunTaskCommandsTitle = (task: ImplementTask): string => {
    if (isManualDraftPendingInitialization(task)) {
      return t(
        'implement.taskCommandsManualDraftUnsupported',
        'No worktree is available until this feature is initialized from the first message.'
      );
    }

    if (task.draft) {
      return t(
        'implement.taskCommandsDraftUnsupported',
        'Commands are unavailable while this task is still a draft.'
      );
    }

    if (task.archived_at) {
      return t(
        'implement.taskCommandsArchivedUnsupported',
        'Commands are unavailable for archived tasks.'
      );
    }

    if (!canRunTaskCommandsForTask(task)) {
      return t('implement.taskCommandNoProjects', 'No repository is available for this task.');
    }

    return t('implement.runTaskCommands', 'Run commands');
  };

  const buildTaskCommandModalState = async (task: ImplementTask) => {
    const registry = await loadTaskProjectCommandRegistry();
    const taskProjectIds = getTaskCommandProjectIds(task);
    const taskGroup =
      getProjectGroupByProjectId(projectGroups, task.project_id) ||
      getProjectGroupByProjectId(projectGroups, taskProjectIds[0] || null);
    const modalProjectsSource =
      taskGroup?.projects ||
      taskProjectIds
        .map((projectId) => getProjectById(projectId))
        .filter((project): project is NonNullable<ReturnType<typeof getProjectById>> => Boolean(project));

    return {
      taskId: task.id,
      groupName: taskGroup?.name || t('project.projectSettings', 'Paramètres du projet'),
      requiredProjectIds: taskProjectIds,
      projects: modalProjectsSource.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        command: getTaskProjectCommand(registry, project.path)?.command || '',
        openTerminalOnRun:
          getTaskProjectCommand(registry, project.path)?.openTerminalOnRun ?? true,
      })),
    };
  };

  const openTaskCommandModal = async (task: ImplementTask) => {
    try {
      const modalState = await buildTaskCommandModalState(task);
      if (modalState.projects.length === 0) {
        toast.error(
          t(
            'implement.taskCommandNoProjects',
            'No repository is available for this task.'
          )
        );
        return;
      }

      setTaskCommandModal({
        taskId: modalState.taskId,
        groupName: modalState.groupName,
        autoRunAfterSave: false,
        projects: modalState.projects,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('common.error', 'An error occurred');
      toast.error(message);
    }
  };

  const handleRunTaskCommands = async (task: ImplementTask) => {
    try {
      const modalState = await buildTaskCommandModalState(task);
      const requiredProjects = modalState.projects.filter((project) =>
        modalState.requiredProjectIds.includes(project.projectId)
      );
      if (requiredProjects.some((project) => !project.command.trim())) {
        setTaskCommandModal({
          taskId: modalState.taskId,
          groupName: modalState.groupName,
          autoRunAfterSave: true,
          projects: modalState.projects,
        });
        return;
      }

      const result = await runTaskCommands(task.id);
      if (!result) {
        return;
      }

      if (result.status === 'completed') {
        toast.success(
          t('implement.taskCommandRunSuccess', 'Commands completed'),
          {
            description: t(
              'implement.taskCommandRunSuccessDescription',
              '{{count}} subprojects executed successfully.',
              { count: result.completedCount }
            ),
            notification: {
              category: 'task_run_completed',
            },
          }
        );
        return;
      }

      toast.info(
        t('implement.taskCommandRunCancelled', 'Run cancelled'),
        {
          description: result.currentProjectName
            ? t(
                'implement.taskCommandRunCancelledDescription',
                'Execution stopped while processing {{project}}.',
                { project: result.currentProjectName }
              )
            : t(
                'implement.taskCommandRunCancelledGeneric',
                'Execution was cancelled.'
              ),
        }
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('common.error', 'An error occurred');
      toast.error(message);
    }
  };

  const buildTaskActions = (task: ImplementTask): TaskActionDescriptor[] => {
    const capabilities = getTaskLifecycleCapabilities(
      task,
      publishedStandaloneTasks[task.id] ?? false
    );
    const archived = Boolean(task.archived_at);
    const actions: TaskActionDescriptor[] = [
      {
        key: 'project_settings',
        label: t('project.projectSettings', 'Paramètres du projet'),
        icon: 'settings',
      },
      {
        key: 'rename',
        label: t('common.rename', 'Rename'),
        icon: 'edit',
      },
    ];

    if (capabilities.canReopen) {
      actions.push({
        key: 'reopen',
        label: t('implement.reopenTask', 'Reopen'),
        icon: 'rotate-ccw',
      });
    }

    if (archived && capabilities.canRestore) {
      actions.push({
        key: 'restore',
        label: t('implement.restoreTask', 'Restore'),
        icon: 'rotate-ccw',
      });
    }

    if (!archived && capabilities.canArchive) {
      actions.push({
        key: 'archive',
        label: t('common.archive', 'Archive'),
        icon: 'archive',
      });
    }

    if (task.task_source === 'standalone') {
      actions.push({
        key: 'delete',
        label: t('common.delete', 'Delete'),
        icon: 'trash',
        destructive: true,
        disabled: !capabilities.canDelete,
        title: capabilities.deleteBlockReason || undefined,
      });
    }

    return actions;
  };

  const handleTaskAction = async (task: ImplementTask, action: TaskActionKey) => {
    if (action === 'project_settings') {
      await openTaskCommandModal(task);
      return;
    }
    if (action === 'rename') {
      setRenameTarget(task);
      return;
    }
    if (action === 'archive' || action === 'delete') {
      setConfirmTarget({ task, action });
      return;
    }

    setPendingTaskId(task.id);
    try {
      if (action === 'restore') {
        await restoreTask(task.id);
      } else if (action === 'reopen') {
        await reopenTask(task.id);
      }
    } finally {
      setPendingTaskId((current) => (current === task.id ? null : current));
    }
  };

  const visibleTasks = useMemo(() => {
    if (showArchived) {
      return filteredTasks;
    }
    return filteredTasks.filter((task) => !task.archived_at);
  }, [filteredTasks, showArchived]);

  const draftTasks = useMemo(
    () => visibleTasks.filter((task) => task.draft),
    [visibleTasks]
  );

  const readyTasks = useMemo(() => {
    return [...visibleTasks]
      .filter((task) => !task.draft && !task.archived_at && !task.is_blocked && task.status !== 'Completed')
      .sort((a, b) => {
        const byStatus = readyStatusOrder[a.status] - readyStatusOrder[b.status];
        if (byStatus !== 0) return byStatus;
        return a.sequence_index - b.sequence_index;
      });
  }, [visibleTasks]);

  const blockedTasks = useMemo(() => {
    return [...visibleTasks]
      .filter((task) => !task.draft && !task.archived_at && task.is_blocked)
      .sort((a, b) => a.sequence_index - b.sequence_index);
  }, [visibleTasks]);

  const completedTasks = useMemo(() => {
    return [...visibleTasks]
      .filter((task) => !task.draft && !task.archived_at && task.status === 'Completed')
      .sort((a, b) => a.sequence_index - b.sequence_index);
  }, [visibleTasks]);

  const archivedTasks = useMemo(() => {
    if (!showArchived) return [];
    return [...filteredTasks]
      .filter((task) => Boolean(task.archived_at))
      .sort((a, b) => a.sequence_index - b.sequence_index);
  }, [filteredTasks, showArchived]);

  const progressTasks = useMemo(
    () => filteredTasks.filter((task) => !task.draft && !task.archived_at),
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
        </div>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => setShowArchived((current) => !current)}
            className={cn(
              'mr-2 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
              showArchived
                ? 'border-border bg-accent text-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            title={
              showArchived
                ? t('implement.hideArchived', 'Hide archived')
                : t('implement.showArchived', 'Show archived')
            }
          >
            <Icon name="archive" size={12} />
            <span className="hidden xl:inline">
              {showArchived
                ? t('implement.hideArchived', 'Hide archived')
                : t('implement.showArchived', 'Show archived')}
            </span>
          </button>
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
            title={t('implement.createStandaloneTask', 'Créer une tâche indépendante')}
          >
            <Icon name={pendingTaskId ? 'loader' : 'plus'} size={12} className={pendingTaskId ? 'animate-spin' : undefined} />
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
                {(() => {
                  const effectiveTargetBranch =
                    (selectedProjectId && plan.targetBranchesByProjectId?.[selectedProjectId]) || plan.targetBranch;
                  const targetSummary = plan.hasMixedTargetBranches
                    ? selectedProjectId && plan.targetBranchesByProjectId?.[selectedProjectId]
                      ? t('implement.mixedTargetsForProject', 'Mixed targets · this repo: {{branchName}}', {
                        branchName: effectiveTargetBranch,
                      })
                      : t('implement.mixedTargets', 'Mixed targets')
                    : t('implement.singleTarget', 'Target: {{branchName}}', {
                      branchName: effectiveTargetBranch,
                    });
                  return (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-emerald-500">
                      {t('implement.planReadyForValidation', 'Plan ready for validation')}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {planLabelsById.get(plan.id) || plan.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-emerald-200/80 truncate">
                      {targetSummary}
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
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {visibleTasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Icon name="check-circle" size={32} className="text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              {planFilter === ALL_PLANS_FILTER
                ? t('implement.noTasks', 'No tasks yet')
                : t('implement.noTasksForFilter', 'No task matches this filter.')}
            </p>
          </div>
        )}

        {visibleTasks.length > 0 && (
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
                  multiRepoPresentation={null}
                  isAssistantRunning={streamingTaskId === task.id}
                  taskCommandRunStatus={taskCommandRuns[task.id]?.status ?? null}
                  canRunTaskCommands={canRunTaskCommandsForTask(task)}
                  runTaskCommandsTitle={getRunTaskCommandsTitle(task)}
                  onSelect={() => void activateTask(task.id)}
                  onRunTaskCommands={() => void handleRunTaskCommands(task)}
                  onCancelTaskCommands={() => void cancelTaskCommands(task.id)}
                  actions={buildTaskActions(task)}
                  onAction={(action) => void handleTaskAction(task, action)}
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
                  multiRepoPresentation={buildMultiRepoPresentation(
                    task,
                    reviewCurrentTaskId === task.id && liveReviewSummary.repositoryCount > 0
                      ? liveReviewSummary
                      : null
                  )}
                  isAssistantRunning={streamingTaskId === task.id}
                  taskCommandRunStatus={taskCommandRuns[task.id]?.status ?? null}
                  canRunTaskCommands={canRunTaskCommandsForTask(task)}
                  runTaskCommandsTitle={getRunTaskCommandsTitle(task)}
                  onSelect={() => void activateTask(task.id)}
                  onRunTaskCommands={() => void handleRunTaskCommands(task)}
                  onCancelTaskCommands={() => void cancelTaskCommands(task.id)}
                  actions={buildTaskActions(task)}
                  onAction={(action) => void handleTaskAction(task, action)}
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
                  multiRepoPresentation={buildMultiRepoPresentation(
                    task,
                    reviewCurrentTaskId === task.id && liveReviewSummary.repositoryCount > 0
                      ? liveReviewSummary
                      : null
                  )}
                  isAssistantRunning={streamingTaskId === task.id}
                  taskCommandRunStatus={taskCommandRuns[task.id]?.status ?? null}
                  canRunTaskCommands={canRunTaskCommandsForTask(task)}
                  runTaskCommandsTitle={getRunTaskCommandsTitle(task)}
                  onSelect={() => void activateTask(task.id)}
                  onRunTaskCommands={() => void handleRunTaskCommands(task)}
                  onCancelTaskCommands={() => void cancelTaskCommands(task.id)}
                  actions={buildTaskActions(task)}
                  onAction={(action) => void handleTaskAction(task, action)}
                />
              ))}
            </section>

            <section className="space-y-1 pt-1 border-t border-border/60">
              <div className="px-1 pb-1 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-emerald-500">
                  {t('implement.completedTasks', 'Completed tasks')}
                </h2>
                <span className="text-xs text-muted-foreground">{completedTasks.length}</span>
              </div>

              {completedTasks.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground rounded border border-dashed border-border">
                  {t('implement.noCompletedTasks', 'No completed task in the active queue.')}
                </div>
              )}

              {completedTasks.map((task) => (
                <MemoizedTaskItem
                  key={task.id}
                  task={task}
                  isSelected={selectedTaskId === task.id}
                  planLabel={getTaskPlanLabel(task)}
                  multiRepoPresentation={buildMultiRepoPresentation(
                    task,
                    reviewCurrentTaskId === task.id && liveReviewSummary.repositoryCount > 0
                      ? liveReviewSummary
                      : null
                  )}
                  isAssistantRunning={streamingTaskId === task.id}
                  taskCommandRunStatus={taskCommandRuns[task.id]?.status ?? null}
                  canRunTaskCommands={canRunTaskCommandsForTask(task)}
                  runTaskCommandsTitle={getRunTaskCommandsTitle(task)}
                  onSelect={() => void activateTask(task.id)}
                  onRunTaskCommands={() => void handleRunTaskCommands(task)}
                  onCancelTaskCommands={() => void cancelTaskCommands(task.id)}
                  actions={buildTaskActions(task)}
                  onAction={(action) => void handleTaskAction(task, action)}
                />
              ))}
            </section>

            {showArchived && (
              <section className="space-y-1 pt-1 border-t border-border/60">
                <div className="px-1 pb-1 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('implement.archivedTasks', 'Archived tasks')}
                  </h2>
                  <span className="text-xs text-muted-foreground">{archivedTasks.length}</span>
                </div>

                {archivedTasks.length === 0 && (
                  <div className="px-2 py-3 text-xs text-muted-foreground rounded border border-dashed border-border">
                    {t('implement.noArchivedTasks', 'No archived task for this filter.')}
                  </div>
                )}

                {archivedTasks.map((task) => (
                  <MemoizedTaskItem
                    key={task.id}
                    task={task}
                    isSelected={selectedTaskId === task.id}
                    planLabel={getTaskPlanLabel(task)}
                    multiRepoPresentation={buildMultiRepoPresentation(
                      task,
                      reviewCurrentTaskId === task.id && liveReviewSummary.repositoryCount > 0
                        ? liveReviewSummary
                        : null
                    )}
                    isAssistantRunning={streamingTaskId === task.id}
                    taskCommandRunStatus={taskCommandRuns[task.id]?.status ?? null}
                    canRunTaskCommands={canRunTaskCommandsForTask(task)}
                    runTaskCommandsTitle={getRunTaskCommandsTitle(task)}
                    onSelect={() => void activateTask(task.id)}
                    onRunTaskCommands={() => void handleRunTaskCommands(task)}
                    onCancelTaskCommands={() => void cancelTaskCommands(task.id)}
                    actions={buildTaskActions(task)}
                    onAction={(action) => void handleTaskAction(task, action)}
                  />
                ))}
              </section>
            )}
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

      {taskCommandModal && (
        <TaskProjectCommandsModal
          isOpen
          projectGroupName={taskCommandModal.groupName}
          projects={taskCommandModal.projects}
          isSubmitting={isSavingTaskCommands}
          onClose={() => {
            if (!isSavingTaskCommands) {
              setTaskCommandModal(null);
            }
          }}
          onSave={(projects) => {
            void (async () => {
              setIsSavingTaskCommands(true);
              try {
                await saveTaskProjectCommandDrafts(projects);
                const autoRunTaskId = taskCommandModal.autoRunAfterSave
                  ? taskCommandModal.taskId
                  : null;
                setTaskCommandModal(null);
                toast.success(
                  t('project.projectSettings', 'Paramètres du projet'),
                  {
                    description: t(
                      'implement.taskCommandsSaved',
                      'Commands saved successfully.'
                    ),
                  }
                );

                if (autoRunTaskId) {
                  const nextTask = tasks.find((task) => task.id === autoRunTaskId);
                  if (nextTask) {
                    await handleRunTaskCommands(nextTask);
                  }
                }
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : t('common.error', 'An error occurred');
                toast.error(message);
              } finally {
                setIsSavingTaskCommands(false);
              }
            })();
          }}
        />
      )}

      <ConfirmPromptModal
        isOpen={Boolean(renameTarget)}
        title={t('implement.renameTaskTitle', 'Rename task')}
        description={t('implement.renameTaskDescription', 'Choose a new title for this task.')}
        confirmLabel={t('common.rename', 'Rename')}
        cancelLabel={t('common.cancel', 'Cancel')}
        initialValue={renameTarget?.title || ''}
        inputPlaceholder={t('implement.taskTitle', 'Task title')}
        requireInput
        isSubmitting={pendingTaskId === renameTarget?.id}
        onCancel={() => {
          if (!pendingTaskId) {
            setRenameTarget(null);
          }
        }}
        onConfirm={(value) => {
          if (!renameTarget) return;
          void (async () => {
            setPendingTaskId(renameTarget.id);
            try {
              await renameTask(renameTarget.id, value || '');
              setRenameTarget(null);
            } finally {
              setPendingTaskId((current) => (current === renameTarget.id ? null : current));
            }
          })();
        }}
      />

      <ConfirmPromptModal
        isOpen={Boolean(confirmTarget)}
        title={
          confirmTarget?.action === 'archive'
            ? t('implement.archiveTaskTitle', 'Archive task')
            : t('implement.deleteTaskTitle', 'Delete task')
        }
        description={
          confirmTarget?.action === 'archive'
            ? t(
              'implement.archiveTaskDescription',
              'Archive this task, remove its worktree and local branch, and keep its conversation history.'
            )
            : t(
              'implement.deleteTaskDescription',
              'Delete this standalone feature, discard local changes, remove its worktree and local branch, and delete its conversation.'
            )
        }
        confirmLabel={
          confirmTarget?.action === 'archive'
            ? t('common.archive', 'Archive')
            : t('common.delete', 'Delete')
        }
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant={confirmTarget?.action === 'delete' ? 'error' : 'primary'}
        isSubmitting={pendingTaskId === confirmTarget?.task.id}
        onCancel={() => {
          if (!pendingTaskId) {
            setConfirmTarget(null);
          }
        }}
        onConfirm={() => {
          if (!confirmTarget) return;
          void (async () => {
            setPendingTaskId(confirmTarget.task.id);
            try {
              if (confirmTarget.action === 'archive') {
                await archiveTask(confirmTarget.task.id);
              } else {
                await deleteTask(confirmTarget.task.id);
              }
              setConfirmTarget(null);
            } finally {
              setPendingTaskId((current) => (current === confirmTarget.task.id ? null : current));
            }
          })();
        }}
      />
    </aside>
  );
};

export const TaskQueue = React.memo(TaskQueueBase);

export default TaskQueue;
