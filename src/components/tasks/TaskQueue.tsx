import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { getServiceRuntimeCapabilities } from '../../services';
import { useChatStore } from '../../stores/useChatStore';
import {
  getTaskLifecycleCapabilities,
  useTaskStore,
  type ImplementTask,
} from '../../stores/useTaskStore';
import { useFileChangesStore } from '../../stores/useFileChangesStore';
import {
  getArchitectPlanDisplayName,
  getArchitectPlanPrimaryName,
} from '../../services/architectPlanPresentation';
import { getGitFlowBaseBranch } from '../../services/architectPlanService';
import {
  isPlanFinalizationTask,
  taskMatchesProjectId,
} from '../../services/implementTaskCatalog';
import { shouldIncludeTaskInImplementationProgress } from '../../services/planFinalization';
import {
  getProjectGroupByProjectId,
  getScopedActionableProjectIds,
  getScopedProjectIds,
  getScopedReadOnlyProjectIds,
} from '../../services/globalProjects';
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
import {
  resolveRunningTaskIds,
  resolveTaskStatusIndicatorState,
} from '../../services/taskStatusPresentation';
import { Icon, IconName } from '../ui/Icon';
import { Select } from '../ui/Select';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { cn } from '../../utils/cn';
import { notify } from '../ui/toastService';
import { TaskProjectCommandsModal } from './TaskProjectCommandsModal';
import { TaskStatusIndicator } from './TaskStatusIndicator';
import type { TaskStatus } from '../../types';
import { useVirtualList } from '../../hooks/useVirtualList';

interface TaskQueueProps {
  className?: string;
}

type TaskListRow =
  | {
      kind: 'section';
      id: string;
      title: string;
      count: number;
      tone?: 'draft' | 'default' | 'success';
    }
  | {
      kind: 'task';
      id: string;
      task: ImplementTask;
      multiRepoPresentation: MultiRepoTaskPresentation | null;
    };

const ALL_PLANS_FILTER = '__all__';
const STANDALONE_FILTER = '__standalone__';

const statusConfig: Record<TaskStatus, { color: string; bgColor: string }> = {
  Pending: { color: 'text-muted-foreground', bgColor: 'bg-muted' },
  InProgress: { color: 'text-amber-500', bgColor: 'bg-amber-500/10' },
  AwaitingResponse: { color: 'text-amber-500', bgColor: 'bg-amber-500/10' },
  InReview: { color: 'text-sky-400', bgColor: 'bg-sky-500/10' },
  Completed: { color: 'text-emerald-500', bgColor: 'bg-emerald-500/10' },
  Failed: { color: 'text-red-400', bgColor: 'bg-red-500/10' },
  Blocked: { color: 'text-orange-400', bgColor: 'bg-orange-500/10' },
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

interface TaskMenuPosition {
  top: number;
  left: number;
}

const TASK_MENU_WIDTH = 176;
const TASK_MENU_GAP = 6;
const TASK_MENU_VIEWPORT_PADDING = 12;
const TASK_MENU_ITEM_HEIGHT = 34;
const TASK_MENU_VERTICAL_PADDING = 8;

const getTaskMenuPosition = (
  trigger: HTMLElement | null,
  actionCount: number
): TaskMenuPosition => {
  if (!trigger) {
    return {
      top: TASK_MENU_VIEWPORT_PADDING,
      left: TASK_MENU_VIEWPORT_PADDING,
    };
  }

  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const estimatedMenuHeight = actionCount * TASK_MENU_ITEM_HEIGHT + TASK_MENU_VERTICAL_PADDING;
  const preferredLeft = rect.right - TASK_MENU_WIDTH;
  const left = Math.min(
    Math.max(TASK_MENU_VIEWPORT_PADDING, preferredLeft),
    viewportWidth - TASK_MENU_WIDTH - TASK_MENU_VIEWPORT_PADDING
  );
  const wouldOverflowBottom =
    rect.bottom + TASK_MENU_GAP + estimatedMenuHeight >
    viewportHeight - TASK_MENU_VIEWPORT_PADDING;
  const preferredTop = wouldOverflowBottom
    ? rect.top - estimatedMenuHeight - TASK_MENU_GAP
    : rect.bottom + TASK_MENU_GAP;
  const top = Math.min(
    Math.max(TASK_MENU_VIEWPORT_PADDING, preferredTop),
    viewportHeight - estimatedMenuHeight - TASK_MENU_VIEWPORT_PADDING
  );

  return { top, left };
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

type TaskContextBadgeTone = 'default' | 'draft';

interface TaskContextBadgeDescriptor {
  key: 'plan' | 'plan_finalization' | 'standalone' | 'draft';
  label: string;
  icon?: IconName;
  tone?: TaskContextBadgeTone;
}

const taskContextBadgeToneClassName: Record<TaskContextBadgeTone, string> = {
  default: 'border-border/70 bg-background/40 text-muted-foreground',
  draft: 'border-amber-500/20 bg-amber-500/10 text-amber-500',
};

interface TaskItemProps {
  task: ImplementTask;
  isSelected: boolean;
  planLabel: string;
  isAssistantRunning: boolean;
  taskCommandRunStatus: 'running' | 'cancelling' | null;
  canRunTaskCommands: boolean;
  showRunTaskCommands: boolean;
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
  isAssistantRunning,
  taskCommandRunStatus,
  canRunTaskCommands,
  showRunTaskCommands,
  runTaskCommandsTitle,
  onSelect,
  onRunTaskCommands,
  onCancelTaskCommands,
  actions,
  onAction,
}) => {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState<TaskMenuPosition | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const trimmedPlanLabel = planLabel.trim();
  const contextBadges: TaskContextBadgeDescriptor[] = [];
  if (task.task_source === 'architect' && trimmedPlanLabel.length > 0) {
    contextBadges.push({
      key: 'plan',
      label: trimmedPlanLabel,
      icon: 'layers',
    });
  }
  if (task.task_source === 'plan_finalization') {
    contextBadges.push({
      key: 'plan_finalization',
      label: t('implement.planFinalizationBadge', 'Plan finalization'),
      icon: 'git-merge',
    });
  }
  if (task.task_source === 'standalone') {
    contextBadges.push({
      key: 'standalone',
      label: t('implement.standaloneBadge', 'Standalone'),
      icon: 'layers',
    });
  }
  if (task.draft) {
    contextBadges.push({
      key: 'draft',
      label: t('common.draft', 'Draft'),
      tone: 'draft',
    });
  }
  const isCompactDraftFeatureCard =
    task.draft &&
    task.standalone_kind === 'manual_feature' &&
    task.description.trim().length === 0;
  const status = isAssistantRunning
    ? { color: 'text-amber-500', bgColor: 'bg-amber-500/10' }
    : statusConfig[task.status] || statusConfig.Pending;
  const indicatorState = resolveTaskStatusIndicatorState(task.status, isAssistantRunning, task.task_source);
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

  useEffect(() => {
    if (!showMenu) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (
        taskMenuRef.current?.contains(target) ||
        menuButtonRef.current?.contains(target)
      ) {
        return;
      }

      setShowMenu(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showMenu]);

  useEffect(() => {
    if (!showMenu) {
      setMenuPosition(null);
      return;
    }

    const updatePosition = () => {
      setMenuPosition(getTaskMenuPosition(menuButtonRef.current, actions.length));
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [actions.length, showMenu]);

  return (
    <div
      role="button"
      tabIndex={0}
      data-task-card-variant={isCompactDraftFeatureCard ? 'compact-draft' : 'default'}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'relative w-full overflow-visible rounded-xl border text-left transition-all duration-200 group cursor-pointer',
        isCompactDraftFeatureCard ? 'h-[96px]' : 'h-[112px]',
        isSelected
          ? 'border-primary/30 bg-primary/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
          : 'border-border/70 bg-card/70 hover:border-primary/20 hover:bg-accent/30'
      )}
    >
      <div className="grid h-full grid-rows-[auto,1fr,auto] px-4 py-2">
        {actions.length > 0 && (
          <button
            ref={menuButtonRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              const nextValue = !showMenu;
              setMenuPosition(
                nextValue
                  ? getTaskMenuPosition(event.currentTarget, actions.length)
                  : null
              );
              setShowMenu(nextValue);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            className="absolute right-2 top-2.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t('implement.taskActions', 'Task actions')}
          >
            <Icon name="more-vertical" size={13} />
          </button>
        )}

        <div className="flex items-center gap-2.5">
          <div className="relative shrink-0 group/lock">
            <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', status.bgColor)}>
              <TaskStatusIndicator
                state={indicatorState}
                layout="card"
                size={14}
                dotSize={8}
                className={status.color}
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
          {!isCompactDraftFeatureCard && task.description && (
            <p className="line-clamp-2 text-[13px] leading-[1.15rem] text-muted-foreground">
              {task.description}
            </p>
          )}
        </div>

        <div className="min-w-0 self-end pr-10">
          {contextBadges.length > 0 && (
            <div
              data-task-card-footer="true"
              className="flex min-w-0 items-center gap-1.5 overflow-hidden"
            >
              {contextBadges.map((badge) => (
                <span
                  key={badge.key}
                  data-task-context-badge={badge.key}
                  className={cn(
                    'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                    taskContextBadgeToneClassName[badge.tone ?? 'default']
                  )}
                >
                  {badge.icon && <Icon name={badge.icon} size={10} className="shrink-0" />}
                  <span className="truncate">{badge.label}</span>
                </span>
              ))}
            </div>
          )}
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
        ) : showRunTaskCommands ? (
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
        ) : null}
      </div>

      {showMenu && menuPosition && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={taskMenuRef}
            role="menu"
            aria-label={t('implement.taskActions', 'Task actions')}
            style={{
              position: 'fixed',
              top: `${menuPosition.top}px`,
              left: `${menuPosition.left}px`,
              width: `${TASK_MENU_WIDTH}px`,
            }}
            className="z-[12010] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
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
                    : 'text-popover-foreground hover:bg-accent',
                  action.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
                )}
              >
                <Icon name={action.icon} size={12} />
                <span>{action.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )
        : null}
    </div>
  );
};

const MemoizedTaskItem = React.memo(TaskItem);

const TaskQueueBase: React.FC<TaskQueueProps> = ({ className }) => {
  const { t } = useTranslation();
  const runtimeCapabilities = getServiceRuntimeCapabilities();
  const {
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    projectGroups,
    openProjectGitFlowModal,
    setSelectedProject,
    setSelectedTask,
  } = useAppStore(useShallow((state) => ({
    selectedGroupId: state.selectedGroupId,
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    projectGroups: state.projectGroups,
    openProjectGitFlowModal: state.openProjectGitFlowModal,
    setSelectedProject: state.setSelectedProject,
    setSelectedTask: state.setSelectedTask,
  })));
  const getProjectById = useAppStore((state) => state.getProjectById);
  const {
    createConversation,
    conversations,
    conversationRuntimeById,
    selectConversation,
  } = useChatStore(useShallow((state) => ({
    createConversation: state.createConversation,
    conversations: state.conversations,
    conversationRuntimeById: state.conversationRuntimeById,
    selectConversation: state.selectConversation,
  })));
  const {
    tasks,
    planSummaries,
    hasStandaloneTasks,
    publishedStandaloneTasks,
    activateTask,
    createManualFeatureDraft,
    renameTask,
    archiveTask,
    restoreTask,
    deleteTask,
    reopenTask,
    taskCommandRuns,
    runTaskCommands,
    cancelTaskCommands,
    missingBaseBranchIssue,
    clearMissingBaseBranchIssue,
    createMissingBaseBranch,
    taskError,
  } = useTaskStore(useShallow((state) => ({
    tasks: state.tasks,
    planSummaries: state.planSummaries,
    hasStandaloneTasks: state.hasStandaloneTasks,
    publishedStandaloneTasks: state.publishedStandaloneTasks,
    activateTask: state.activateTask,
    createManualFeatureDraft: state.createManualFeatureDraft,
    renameTask: state.renameTask,
    archiveTask: state.archiveTask,
    restoreTask: state.restoreTask,
    deleteTask: state.deleteTask,
    reopenTask: state.reopenTask,
    taskCommandRuns: state.taskCommandRuns,
    runTaskCommands: state.runTaskCommands,
    cancelTaskCommands: state.cancelTaskCommands,
    missingBaseBranchIssue: state.missingBaseBranchIssue,
    clearMissingBaseBranchIssue: state.clearMissingBaseBranchIssue,
    createMissingBaseBranch: state.createMissingBaseBranch,
    taskError: state.lastError,
  })));
  const reviewCurrentTaskId = useFileChangesStore((state) => state.currentTaskId);
  const liveReviewSummary = useFileChangesStore((state) => state.reviewSummary);
  const lastErrorToastRef = useRef<string | null>(null);
  const missingBaseBranchToastRef = useRef<string | number | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [planFilter, setPlanFilter] = useState<string>(ALL_PLANS_FILTER);
  const [showArchived, setShowArchived] = useState(false);
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
  const projectManagementDisabled = !runtimeCapabilities.projectMutation;
  const taskMutationDisabled = !runtimeCapabilities.taskMutation;
  const taskExecutionDisabled = !runtimeCapabilities.implementExecution;
  const taskCommandsDisabled = !runtimeCapabilities.taskProjectCommands;
  const projectManagementDisabledTitle = t(
    'projects.remoteProjectManagementUnavailable',
    'Project creation and editing are unavailable in remote mode.'
  );
  const taskMutationDisabledTitle = t(
    'implement.remoteTaskMutationUnavailable',
    'Task management actions are unavailable in remote mode.'
  );
  const taskExecutionDisabledTitle = t(
    'implement.remoteExecutionUnavailable',
    'Implementation actions are unavailable in remote mode.'
  );
  const taskCommandsDisabledTitle = t(
    'implement.remoteTaskCommandsUnavailable',
    'Project commands are unavailable in remote mode.'
  );

  useEffect(() => {
    if (!taskError || taskError === lastErrorToastRef.current) return;
    lastErrorToastRef.current = taskError;
    notify.error(taskError);
  }, [taskError]);

  useEffect(() => {
    if (!missingBaseBranchIssue) {
      if (missingBaseBranchToastRef.current !== null) {
        notify.dismiss(missingBaseBranchToastRef.current);
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
      notify.dismiss(missingBaseBranchToastRef.current);
    }

    missingBaseBranchToastRef.current = toastId;
    notify.actionRequired(
      t(
        'implement.missingBaseBranchToastTitle',
        'Branche {{baseBranch}} introuvable',
        { baseBranch: missingBaseBranchIssue.missingRef }
      ),
      {
        notificationKey: toastId,
        category: 'task_attention_required',
        duration: 12000,
        closeButton: true,
        tone: 'warning',
        actions: [
          {
            label: t('implement.missingBaseBranchCreateAction', 'Créer'),
            variant: 'primary',
            onClick: async () => {
              setPendingTaskId(missingBaseBranchIssue.taskId);
              try {
                await createMissingBaseBranch(missingBaseBranchIssue);
                notify.success(
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
    if (taskMutationDisabled || taskExecutionDisabled) {
      notify.error(taskExecutionDisabled ? taskExecutionDisabledTitle : taskMutationDisabledTitle);
      return;
    }

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
      notify.error(
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
      notify.error(message);
    } finally {
      setPendingTaskId((current) => (current === taskId ? null : current));
    }
  };

  const standalonePlanLabel = t('implement.planFilterStandalone', 'No plan / standalone');

  const buildMultiRepoPresentation = useCallback((
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
      } else if (reviewSummary.nextAction === 'validate_repository' && nextRepositoryDescriptor) {
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
  }, [getProjectById, t]);

  const scopedProjectIds = useMemo(
    () => getScopedProjectIds(projectGroups, selectedGroupId, selectedProjectId),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const scopedActionableProjectIds = useMemo(
    () => getScopedActionableProjectIds(projectGroups, selectedGroupId, selectedProjectId),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const scopedReadOnlyProjectIds = useMemo(
    () => getScopedReadOnlyProjectIds(projectGroups, selectedGroupId, selectedProjectId),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const scopedReadOnlyProjects = useMemo(
    () =>
      scopedReadOnlyProjectIds
        .map((projectId) => getProjectById(projectId))
        .filter((project): project is NonNullable<typeof project> => Boolean(project)),
    [getProjectById, scopedReadOnlyProjectIds]
  );
  const firstReadOnlyProject = scopedReadOnlyProjects[0] ?? null;
  const isReadOnlyOnlyScope =
    scopedProjectIds.length > 0 && scopedActionableProjectIds.length === 0;
  const readOnlyCtaLabel = firstReadOnlyProject?.readOnlyReason === 'missing_git'
    ? t('projects.initializeGitAction', 'Initialize Git')
    : firstReadOnlyProject?.readOnlyReason === 'missing_initial_commit'
      ? t('projects.createInitialCommitAction', 'Create initial commit')
      : t('projects.projectSettings', 'Project settings');

  const openReadOnlyProjectSettings = () => {
    if (!firstReadOnlyProject || projectManagementDisabled) {
      return;
    }
    setSelectedProject(firstReadOnlyProject.id);
    openProjectGitFlowModal(firstReadOnlyProject.id);
  };

  const scopedTasks = useMemo(() => {
    if (scopedProjectIds.length === 0) return [];

    return tasks.filter((task) =>
      scopedProjectIds.some((projectId) => taskMatchesProjectId(task, projectId))
    );
  }, [scopedProjectIds, tasks]);

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
  const planPrimaryNamesById = useMemo(() => {
    return new Map(
      availablePlanSummaries.map((plan) => [
        plan.id,
        getArchitectPlanPrimaryName(plan),
      ])
    );
  }, [availablePlanSummaries]);

  const hasScopedStandaloneTasks = useMemo(() => {
    if (!hasStandaloneTasks) return false;
    return scopedTasks.some((task) => task.task_source === 'standalone');
  }, [hasStandaloneTasks, scopedTasks]);

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

    return planPrimaryNamesById.get(task.plan_id) || task.plan_title || standalonePlanLabel;
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
    !isPlanFinalizationTask(task) &&
    !taskCommandsDisabled &&
    !isManualDraftPendingInitialization(task) &&
    !task.draft &&
    !task.archived_at &&
    getTaskCommandProjectIds(task).length > 0;

  const getRunTaskCommandsTitle = (task: ImplementTask): string => {
    if (taskCommandsDisabled) {
      return taskCommandsDisabledTitle;
    }

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
    if (taskCommandsDisabled) {
      notify.error(taskCommandsDisabledTitle);
      return;
    }

    try {
      const modalState = await buildTaskCommandModalState(task);
      if (modalState.projects.length === 0) {
        notify.error(
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
      notify.error(message);
    }
  };

  const handleRunTaskCommands = async (task: ImplementTask) => {
    if (taskCommandsDisabled) {
      notify.error(taskCommandsDisabledTitle);
      return;
    }

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
        notify.success(
          t('implement.taskCommandRunSuccess', 'Commands completed'),
          {
            description: t(
              'implement.taskCommandRunSuccessDescription',
              '{{count}} subprojects executed successfully.',
              { count: result.completedCount }
            ),
            category: 'task_run_completed',
          }
        );
        return;
      }

      notify.info(
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
      notify.error(message);
    }
  };

  const buildTaskActions = (task: ImplementTask): TaskActionDescriptor[] => {
    if (isPlanFinalizationTask(task)) {
      return [];
    }

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
        disabled: taskCommandsDisabled,
        title: taskCommandsDisabled ? taskCommandsDisabledTitle : undefined,
      },
      {
        key: 'rename',
        label: t('common.rename', 'Rename'),
        icon: 'edit',
        disabled: taskMutationDisabled,
        title: taskMutationDisabled ? taskMutationDisabledTitle : undefined,
      },
    ];

    if (capabilities.canReopen) {
      actions.push({
        key: 'reopen',
        label: t('implement.reopenTask', 'Reopen'),
        icon: 'rotate-ccw',
        disabled: taskMutationDisabled,
        title: taskMutationDisabled ? taskMutationDisabledTitle : undefined,
      });
    }

    if (archived && capabilities.canRestore) {
      actions.push({
        key: 'restore',
        label: t('implement.restoreTask', 'Restore'),
        icon: 'rotate-ccw',
        disabled: taskMutationDisabled,
        title: taskMutationDisabled ? taskMutationDisabledTitle : undefined,
      });
    }

    if (!archived && capabilities.canArchive) {
      actions.push({
        key: 'archive',
        label: t('common.archive', 'Archive'),
        icon: 'archive',
        disabled: taskMutationDisabled,
        title: taskMutationDisabled ? taskMutationDisabledTitle : undefined,
      });
    }

    if (task.task_source === 'standalone') {
      actions.push({
        key: 'delete',
        label: t('common.delete', 'Delete'),
        icon: 'trash',
        destructive: true,
        disabled: taskMutationDisabled || !capabilities.canDelete,
        title:
          taskMutationDisabled
            ? taskMutationDisabledTitle
            : capabilities.deleteBlockReason || undefined,
      });
    }

    return actions;
  };

  const handleTaskAction = async (task: ImplementTask, action: TaskActionKey) => {
    if (action === 'project_settings' && taskCommandsDisabled) {
      notify.error(taskCommandsDisabledTitle);
      return;
    }

    if (action !== 'project_settings' && taskMutationDisabled) {
      notify.error(taskMutationDisabledTitle);
      return;
    }

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
  const multiRepoPresentationByTaskId = useMemo(() => {
    const map = new Map<string, MultiRepoTaskPresentation | null>();
    visibleTasks.forEach((task) => {
      map.set(
        task.id,
        buildMultiRepoPresentation(
          task,
          reviewCurrentTaskId === task.id ? liveReviewSummary : null
        )
      );
    });
    return map;
  }, [buildMultiRepoPresentation, liveReviewSummary, reviewCurrentTaskId, visibleTasks]);
  const taskListRows = useMemo<TaskListRow[]>(() => {
    const rows: TaskListRow[] = [];

    if (draftTasks.length > 0) {
      rows.push({
        kind: 'section',
        id: 'section:drafts',
        title: t('implement.manualFeatureDrafts', 'Draft features'),
        count: draftTasks.length,
        tone: 'draft',
      });
      draftTasks.forEach((task) => {
        rows.push({
          kind: 'task',
          id: `task:${task.id}`,
          task,
          multiRepoPresentation: null,
        });
      });
    }

    rows.push({
      kind: 'section',
      id: 'section:ready',
      title: t('implement.readyTasks', 'Ready tasks'),
      count: readyTasks.length,
      tone: 'default',
    });
    readyTasks.forEach((task) => {
      rows.push({
        kind: 'task',
        id: `task:${task.id}`,
        task,
        multiRepoPresentation: multiRepoPresentationByTaskId.get(task.id) ?? null,
      });
    });

    if (blockedTasks.length > 0) {
      rows.push({
        kind: 'section',
        id: 'section:blocked',
        title: t('implement.blockedTasks', 'Blocked tasks'),
        count: blockedTasks.length,
        tone: 'default',
      });
      blockedTasks.forEach((task) => {
        rows.push({
          kind: 'task',
          id: `task:${task.id}`,
          task,
          multiRepoPresentation: multiRepoPresentationByTaskId.get(task.id) ?? null,
        });
      });
    }

    if (completedTasks.length > 0) {
      rows.push({
        kind: 'section',
        id: 'section:completed',
        title: t('implement.completedTasks', 'Completed tasks'),
        count: completedTasks.length,
        tone: 'success',
      });
      completedTasks.forEach((task) => {
        rows.push({
          kind: 'task',
          id: `task:${task.id}`,
          task,
          multiRepoPresentation: multiRepoPresentationByTaskId.get(task.id) ?? null,
        });
      });
    }

    if (showArchived && archivedTasks.length > 0) {
      rows.push({
        kind: 'section',
        id: 'section:archived',
        title: t('common.archive', 'Archive'),
        count: archivedTasks.length,
        tone: 'default',
      });
      archivedTasks.forEach((task) => {
        rows.push({
          kind: 'task',
          id: `task:${task.id}`,
          task,
          multiRepoPresentation: multiRepoPresentationByTaskId.get(task.id) ?? null,
        });
      });
    }

    return rows;
  }, [
    archivedTasks,
    blockedTasks,
    completedTasks,
    draftTasks,
    multiRepoPresentationByTaskId,
    readyTasks,
    showArchived,
    t,
  ]);
  const getTaskListRowKey = useCallback((row: TaskListRow) => row.id, []);
  const {
    parentRef: taskListRef,
    virtualItems: virtualTaskRows,
    totalSize: taskListTotalSize,
    measureElement: measureTaskRow,
  } = useVirtualList({
    items: taskListRows,
    getItemKey: getTaskListRowKey,
    estimateSize: 112,
    overscan: 8,
    dynamicHeight: true,
    gap: 8,
  });

  const progressTasks = useMemo(
    () => filteredTasks.filter((task) => shouldIncludeTaskInImplementationProgress(task)),
    [filteredTasks]
  );
  const completedCount = progressTasks.filter((task) => task.status === 'Completed').length;
  const totalCount = progressTasks.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  const runningTaskIds = useMemo(
    () =>
      resolveRunningTaskIds({
        conversations,
        conversationRuntimeById,
      }),
    [conversationRuntimeById, conversations]
  );

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
            disabled={
              Boolean(pendingTaskId) ||
              isReadOnlyOnlyScope ||
              taskMutationDisabled ||
              taskExecutionDisabled
            }
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
              pendingTaskId || isReadOnlyOnlyScope || taskMutationDisabled || taskExecutionDisabled
                ? 'border-border bg-muted text-muted-foreground cursor-not-allowed'
                : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            title={
              taskMutationDisabled
                ? taskMutationDisabledTitle
                : taskExecutionDisabled
                  ? taskExecutionDisabledTitle
                  : isReadOnlyOnlyScope
                    ? t(
                        'implement.readOnlyOnlyAction',
                        'At least one editable repository is required to create a standalone feature.'
                      )
                    : t('implement.createStandaloneTask', 'Créer une tâche indépendante')
            }
          >
            <Icon name={pendingTaskId ? 'loader' : 'plus'} size={12} className={pendingTaskId ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      {isReadOnlyOnlyScope && (
        <div className="border-b border-border px-4 py-4">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-4">
            <div className="text-sm font-medium text-amber-100">
              {t(
                'projects.readOnlyWorkspaceTitle',
                'This scope is currently read-only.'
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-amber-50/80">
              {t(
                'projects.readOnlyWorkspaceImplementBody',
                'Implementation needs at least one editable repository. Read-only subprojects stay available for navigation, search, and context.'
              )}
            </p>
            {firstReadOnlyProject && (
              <button
                type="button"
                onClick={openReadOnlyProjectSettings}
                disabled={projectManagementDisabled}
                title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-100/10 px-2.5 py-1.5 text-xs font-medium text-amber-50 transition-colors hover:bg-amber-100/15"
              >
                <Icon name="settings" size={12} />
                {readOnlyCtaLabel}
              </button>
            )}
          </div>
        </div>
      )}

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
      </div>

      <div ref={taskListRef} className="flex-1 overflow-y-auto">
        {visibleTasks.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-2 text-center">
            <Icon name="check-circle" size={32} className="text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              {planFilter === ALL_PLANS_FILTER
                ? t('implement.noTasks', 'No tasks yet')
                : t('implement.noTasksForFilter', 'No task matches this filter.')}
            </p>
          </div>
        )}

        {visibleTasks.length > 0 && (
          <div className="p-2">
            <div className="relative" style={{ height: taskListTotalSize }}>
              {virtualTaskRows.map((virtualRow) => {
                const row = virtualRow.item;
                return (
                  <div
                    key={virtualRow.key}
                    ref={measureTaskRow}
                    data-index={virtualRow.index}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {row.kind === 'section' ? (
                      <div className="flex h-7 items-center justify-between gap-3 px-1">
                        <h2
                          className={cn(
                            'truncate whitespace-nowrap text-xs font-semibold uppercase tracking-wide',
                            row.tone === 'draft'
                              ? 'text-sky-400'
                              : row.tone === 'success'
                                ? 'text-emerald-500'
                                : 'text-foreground/80'
                          )}
                        >
                          {row.title}
                        </h2>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {row.count}
                        </span>
                      </div>
                    ) : (
                      <MemoizedTaskItem
                        task={row.task}
                        isSelected={selectedTaskId === row.task.id}
                        planLabel={getTaskPlanLabel(row.task)}
                        isAssistantRunning={runningTaskIds.has(row.task.id)}
                        taskCommandRunStatus={taskCommandRuns[row.task.id]?.status ?? null}
                        canRunTaskCommands={canRunTaskCommandsForTask(row.task)}
                        showRunTaskCommands={!isPlanFinalizationTask(row.task)}
                        runTaskCommandsTitle={getRunTaskCommandsTitle(row.task)}
                        onSelect={() => void activateTask(row.task.id)}
                        onRunTaskCommands={() => void handleRunTaskCommands(row.task)}
                        onCancelTaskCommands={() => void cancelTaskCommands(row.task.id)}
                        actions={buildTaskActions(row.task)}
                        onAction={(action) => void handleTaskAction(row.task, action)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

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
                notify.success(
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
                notify.error(message);
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
