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
  getArchitectPlanPrimaryName,
} from '../../services/architectPlanPresentation';
import {
  getGitFlowBaseBranch,
  getGitFlowMainBranch,
  repairArchitectPlanMetadata,
} from '../../services/architectPlanService';
import {
  getArchitectPlanKind,
  type ArchitectPlanKind,
} from '../../services/architectPlanKinds';
import { getPlanKindIconName } from '../../services/planKindPresentation';
import {
  isPlanFinalizationTask,
  taskMatchesProjectId,
} from '../../services/implementTaskCatalog';
import {
  getProjectGroupByProjectId,
  getAllProjects,
} from '../../services/globalProjects';
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from '../../services/projectWorkspaceState';
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
import type { MergeWorkflowRuntimeState } from '../../services/mergeWorkflow';
import {
  resolveTaskMergeWorkflowNextActionLabel,
  resolveTaskMergeWorkflowPresentationState,
  resolveTaskMergeWorkflowProgressLabel,
} from '../../services/taskMergeWorkflowPresentation';
import { Icon, IconName } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';
import { PanelHeaderIconButton } from '../ui/PanelHeaderIconButton';
import { ProjectIcon } from '../project/ProjectIcon';
import { cn } from '../../utils/cn';
import { notify } from '../ui/toastService';
import { TaskStatusIndicator } from './TaskStatusIndicator';
import type { Project, StandaloneTaskKind, TaskStatus } from '../../types';
import { useVirtualList } from '../../hooks/useVirtualList';
import { ProjectWorkspaceEmptyState } from '../shared/ProjectWorkspaceEmptyState';
import { getDependencyBlockedMessage } from '../implement/TaskBlockedState';
import {
  presentServiceError,
  resolveDegradedErrorPresentation,
} from '../../services/degradedErrorPresentation';
import {
  getTooManyOpenFilesNotificationKey,
  isTooManyOpenFilesMessage,
  noteTooManyOpenFilesBackoff,
} from '../../services/resourcePressureBackoff';
import { retargetTaskForProjectSelection } from '../../services/projectIdentityReconciliation';
import { isStandaloneTaskKindCreatable } from '../../services/standaloneTaskKinds';
import { TaskProjectFilter, type TaskProjectFilterOption } from './TaskProjectFilter';

const ConfirmPromptModal = React.lazy(() =>
  import('../ui/ConfirmPromptModal').then((module) => ({
    default: module.ConfirmPromptModal,
  })),
);
const TaskProjectCommandsModal = React.lazy(() =>
  import('./TaskProjectCommandsModal').then((module) => ({
    default: module.TaskProjectCommandsModal,
  })),
);
const CreateImplementTaskDialog = React.lazy(() =>
  import('./CreateImplementTaskDialog').then((module) => ({
    default: module.CreateImplementTaskDialog,
  })),
);

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

const ALL_PROJECTS_FILTER = '__all_projects__';
type TaskQueueStatusFilter = 'all' | 'ready' | 'in_progress' | 'waiting' | 'blocked';

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
  key: 'project' | 'plan' | 'plan_finalization' | 'standalone' | 'draft';
  label: string;
  icon?: IconName;
  project?: Pick<Project, 'id' | 'path'>;
  tone?: TaskContextBadgeTone;
  title?: string;
}

const taskContextBadgeToneClassName: Record<TaskContextBadgeTone, string> = {
  default: 'border-border/70 bg-background/40 text-muted-foreground',
  draft: 'border-amber-500/20 bg-amber-500/10 text-amber-500',
};

interface TaskItemProps {
  task: ImplementTask;
  mergeWorkflowRuntime?: MergeWorkflowRuntimeState | null;
  multiRepoPresentation?: MultiRepoTaskPresentation | null;
  isSelected: boolean;
  project?: Pick<Project, 'id' | 'name' | 'path'> | null;
  planLabel: string;
  planKind?: ArchitectPlanKind | null;
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
  mergeWorkflowRuntime,
  multiRepoPresentation,
  isSelected,
  project,
  planLabel,
  planKind,
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
  const trimmedProjectName = project?.name.trim() ?? '';
  if (project && trimmedProjectName.length > 0) {
    contextBadges.push({
      key: 'project',
      label: trimmedProjectName,
      project,
      title: trimmedProjectName,
    });
  }
  if (task.task_source === 'architect' && trimmedPlanLabel.length > 0) {
    contextBadges.push({
      key: 'plan',
      label: trimmedPlanLabel,
      icon: getPlanKindIconName(planKind ?? 'feature'),
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
    const taskKindLabel = task.task_kind === 'bugfix'
      ? t('implement.taskKindBugfix', 'Bugfix')
      : task.task_kind === 'hotfix'
        ? t('implement.taskKindHotfix', 'Hotfix')
        : task.task_kind === 'feature'
          ? t('implement.taskKindFeature', 'Feature')
          : task.draft
            ? t('implement.taskKindPending', 'Agent classification')
            : t('implement.standaloneBadge', 'Standalone');
    contextBadges.push({
      key: 'standalone',
      label: taskKindLabel,
      icon: task.task_kind ? getPlanKindIconName(task.task_kind) : 'sparkles',
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
  const mergeWorkflowPresentation = useMemo(
    () =>
      resolveTaskMergeWorkflowPresentationState(
        mergeWorkflowRuntime,
        task.merge_workflow_summary ?? null,
        task.status
      ),
    [mergeWorkflowRuntime, task.merge_workflow_summary, task.status]
  );
  const indicatorState = resolveTaskStatusIndicatorState(
    task.status,
    isAssistantRunning,
    task.task_source,
    mergeWorkflowPresentation
  );
  const showMergeWorkflowPresentation = Boolean(
    multiRepoPresentation &&
      mergeWorkflowPresentation &&
      (indicatorState === 'merging' ||
        indicatorState === 'merge_partial' ||
        indicatorState === 'merge_blocked' ||
        indicatorState === 'merge_failed')
  );
  const lockTooltip = getDependencyBlockedMessage(task, t) ?? '';
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
      data-tour-id="implement-task-card"
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
      <div className="grid h-full grid-rows-[auto,1fr,auto] p-1.5">
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
            className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
            {task.is_blocked && lockTooltip && (
              <div className="pointer-events-none absolute left-0 top-9 z-20 hidden min-w-56 max-w-72 rounded-md border border-orange-500/30 bg-popover px-2 py-1.5 text-xs text-orange-300 shadow-lg group-hover/lock:block">
                {lockTooltip}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="pr-3 text-sm font-semibold leading-[1.1rem] text-foreground line-clamp-2">
              {task.title}
            </h3>
          </div>
        </div>

        <div className="min-h-0 space-y-1">
          {showMergeWorkflowPresentation ? (
            <>
              <p
                data-task-card-progress-label="true"
                className="truncate text-[12px] font-medium leading-[1.05rem] text-foreground/85"
              >
                {multiRepoPresentation?.progressLabel}
              </p>
              <p
                data-task-card-next-action="true"
                className="truncate text-[11px] leading-[1rem] text-muted-foreground"
              >
                {multiRepoPresentation?.nextActionLabel}
              </p>
            </>
          ) : !isCompactDraftFeatureCard && task.description ? (
            <p className="line-clamp-2 text-[13px] leading-[1.15rem] text-muted-foreground">
              {task.description}
            </p>
          ) : null}
        </div>

        <div className="min-w-0 self-end pr-3">
          {contextBadges.length > 0 && (
            <div
              data-task-card-footer="true"
              className="flex min-w-0 items-center gap-1.5 overflow-hidden"
            >
              {contextBadges.map((badge) => (
                <span
                  key={badge.key}
                  data-task-context-badge={badge.key}
                  title={badge.title}
                  className={cn(
                    'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                    taskContextBadgeToneClassName[badge.tone ?? 'default']
                  )}
                >
                  {badge.project ? (
                    <ProjectIcon project={badge.project} size={10} className="text-current" />
                  ) : badge.icon ? (
                    <Icon name={badge.icon} size={10} className="shrink-0 text-current" />
                  ) : null}
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
              'absolute bottom-1.5 right-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
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
            {taskCommandRunStatus === 'cancelling' ? (
              <SpinnerIcon size={13} />
            ) : (
              <Icon name="x" size={13} />
            )}
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
              'absolute bottom-1.5 right-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
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
    standaloneProjects,
    projectGroups,
    openProjectGitFlowModal,
    setSelectedProject,
    setSelectedTask,
  } = useAppStore(useShallow((state) => ({
    selectedGroupId: state.selectedGroupId,
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    standaloneProjects: state.standaloneProjects ?? [],
    projectGroups: state.projectGroups,
    openProjectGitFlowModal: state.openProjectGitFlowModal,
    setSelectedProject: state.setSelectedProject,
    setSelectedTask: state.setSelectedTask,
  })));
  const getProjectById = useAppStore((state) => state.getProjectById);
  const {
    createConversation,
    conversations,
    selectedConversationId,
    conversationRuntimeById,
    conversationCompactionStatusById,
    selectConversation,
    deleteConversation,
  } = useChatStore(useShallow((state) => ({
    createConversation: state.createConversation,
    conversations: state.conversations,
    selectedConversationId: state.selectedConversationId,
    conversationRuntimeById: state.conversationRuntimeById,
    conversationCompactionStatusById: state.conversationCompactionStatusById,
    selectConversation: state.selectConversation,
    deleteConversation: state.deleteConversation,
  })));
  const {
    tasks,
    planSummaries,
    publishedStandaloneTasks,
    activateTask,
    createManualFeatureDraft,
    renameTask,
    archiveTask,
    restoreTask,
    deleteTask,
    reopenTask,
    taskCommandRuns,
    mergeWorkflowRuntimeByTaskId,
    runTaskCommands,
    cancelTaskCommands,
    refreshFromPlan,
    missingBaseBranchIssue,
    clearMissingBaseBranchIssue,
    createMissingBaseBranch,
    taskError,
  } = useTaskStore(useShallow((state) => ({
    tasks: state.tasks,
    planSummaries: state.planSummaries,
    publishedStandaloneTasks: state.publishedStandaloneTasks,
    activateTask: state.activateTask,
    createManualFeatureDraft: state.createManualFeatureDraft,
    renameTask: state.renameTask,
    archiveTask: state.archiveTask,
    restoreTask: state.restoreTask,
    deleteTask: state.deleteTask,
    reopenTask: state.reopenTask,
    taskCommandRuns: state.taskCommandRuns,
    mergeWorkflowRuntimeByTaskId: state.mergeWorkflowRuntimeByTaskId,
    runTaskCommands: state.runTaskCommands,
    cancelTaskCommands: state.cancelTaskCommands,
    refreshFromPlan: state.refreshFromPlan,
    missingBaseBranchIssue: state.missingBaseBranchIssue,
    clearMissingBaseBranchIssue: state.clearMissingBaseBranchIssue,
    createMissingBaseBranch: state.createMissingBaseBranch,
    taskError: state.lastError,
  })));
  const reviewCurrentTaskId = useFileChangesStore((state) => state.currentTaskId);
  const liveReviewSummary = useFileChangesStore((state) => state.reviewSummary);
  const lastErrorToastRef = useRef<string | null>(null);
  const readOnlyScopeToastRef = useRef<string | null>(null);
  const missingBaseBranchToastRef = useRef<string | number | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS_FILTER);
  const [statusFilter, setStatusFilter] = useState<TaskQueueStatusFilter>('all');
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
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
      worktreeSetupCommand: string;
      openTerminalOnRun: boolean;
      requiredForTask: boolean;
    }>;
  } | null>(null);
  const [isSavingTaskCommands, setIsSavingTaskCommands] = useState(false);
  const projectManagementDisabled = !runtimeCapabilities.projectMutation;
  const taskMutationDisabled = !runtimeCapabilities.taskMutation;
  const taskExecutionDisabled = !runtimeCapabilities.implementExecution;
  const taskCommandsDisabled = !runtimeCapabilities.taskProjectCommands;
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

  const handleCreateManualFeature = async ({
    projectId,
    taskKind,
    existingWorktree,
  }: {
    projectId: string;
    taskKind: StandaloneTaskKind;
    existingWorktree: import('../../services/tauriIpc').GitAvailableWorktreeDto | null;
  }) => {
    if (taskMutationDisabled || taskExecutionDisabled) {
      notify.error(taskExecutionDisabled ? taskExecutionDisabledTitle : taskMutationDisabledTitle);
      return;
    }

    if (isWorkspaceMissing) {
      notify.error(
        workspaceState.kind === 'noProjectAvailable'
          ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
          : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')
      );
      return;
    }

    if (pendingTaskId) return;
    const targetProject = getProjectById(projectId) ?? null;
    if (!targetProject || targetProject.isReadOnly) {
      notify.error(
        t(
          'implement.manualFeatureMissingProjects',
          'The selected project is not available for implementation.'
        )
      );
      return;
    }
    if (!isStandaloneTaskKindCreatable(taskKind, targetProject.gitFlowSettings)) {
      notify.error(
        t(
          'implement.taskKindUnavailableForProject',
          'This task type is not available for the selected project workflow.',
        ),
      );
      return;
    }
    const targetGroupId = getProjectGroupByProjectId(projectGroups, projectId)?.id ?? null;

    const taskId = `manual-feature-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const provisionalTitle = taskKind === 'bugfix'
      ? t('implement.manualBugfixUntitled', 'New bugfix')
      : taskKind === 'hotfix'
        ? t('implement.manualHotfixUntitled', 'New hotfix')
        : t('implement.manualFeatureUntitled', 'New feature');
    setPendingTaskId(taskId);
    let conversationId: string | null = null;

    try {
      setSelectedTask(taskId);
      const conversation = await createConversation(
        provisionalTitle,
        taskId,
        projectId,
        targetGroupId
      );
      conversationId = conversation.id;
      await createManualFeatureDraft({
        taskId,
        conversationId: conversation.id,
        groupId: targetGroupId,
        projectIds: [projectId],
        contextProjectIds: [],
        baseBranch: taskKind === 'hotfix'
          ? targetProject.gitFlowSettings?.mainBranch || getGitFlowMainBranch()
          : targetProject.gitFlowSettings?.baseBranch || getGitFlowBaseBranch(),
        title: provisionalTitle,
        description: '',
        taskKind,
        existingBranchName: existingWorktree?.branchName ?? null,
      });
      await activateTask(taskId);
      if (!(await selectConversation(conversation.id))) {
        throw new Error('Impossible de sélectionner la nouvelle conversation.');
      }
      setShowCreateTaskDialog(false);
    } catch (error) {
      let cleanupError: unknown = null;
      if (conversationId) {
        try {
          await deleteConversation(conversationId, { mode: 'implement' });
        } catch (cleanupFailure) {
          cleanupError = cleanupFailure;
        }
      }
      setSelectedTask(null);
      const message = error instanceof Error ? error.message : t('implement.manualFeatureCreateFailed', 'Failed to create manual feature.');
      notify.error(message, {
        description: cleanupError instanceof Error
          ? `La conversation créée n'a pas pu être nettoyée : ${cleanupError.message}`
          : undefined,
      });
    } finally {
      setPendingTaskId((current) => (current === taskId ? null : current));
    }
  };

  const standalonePlanLabel = t('implement.planFilterStandalone', 'No plan / standalone');

  const buildMultiRepoPresentation = useCallback((
    task: ImplementTask,
    reviewSummary: ReviewTaskSummary | null
  ): MultiRepoTaskPresentation | null => {
    const mergeWorkflowRuntime = mergeWorkflowRuntimeByTaskId[task.id] ?? null;
    const mergeWorkflowPresentation = resolveTaskMergeWorkflowPresentationState(
      mergeWorkflowRuntime,
      task.merge_workflow_summary ?? null,
      task.status
    );
    const repositoryDescriptors = getTaskRepositoryDescriptors(
      task,
      (projectId) => getProjectById(projectId) ?? null
    );

    if (repositoryDescriptors.length <= 1 && !mergeWorkflowPresentation) {
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
        isNext: repositorySummary?.id === reviewSummary?.nextRepositoryId,
      };
    });

    let progressLabel = t('implement.repositoryCountInline', '{{count}} repositories involved', {
      count: repositoryDescriptors.length,
    });
    let nextActionLabel = t('implement.taskNextActionStart', 'Next: start implementation');

    if (mergeWorkflowPresentation) {
      progressLabel = resolveTaskMergeWorkflowProgressLabel(
        mergeWorkflowPresentation,
        t
      );
      nextActionLabel = resolveTaskMergeWorkflowNextActionLabel(
        mergeWorkflowPresentation,
        t,
        {
          isPlanFinalizationTask: isPlanFinalizationTask(task),
        }
      );
    } else if (reviewSummary && task.status === 'InReview') {
      const resolvedCount = reviewSummary.stateCounts.committed + reviewSummary.stateCounts.no_changes;
      progressLabel = t('implement.taskValidationProgress', '{{resolved}}/{{total}} projects resolved', {
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
          'Next: validate and resolve the remaining projects'
        );
      }
    } else if (task.status === 'InProgress') {
      nextActionLabel = t('implement.taskNextActionContinueImplementation', 'Next: continue implementation');
    } else if (task.status === 'AwaitingResponse') {
      nextActionLabel = t('implement.taskNextActionAwaitingResponse', 'Next: answer the pending request');
    } else if (task.status === 'InReview') {
      nextActionLabel = t(
        'implement.taskNextActionValidateRepositories',
        'Next: validate and commit each project'
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
  }, [getProjectById, mergeWorkflowRuntimeByTaskId, t]);

  const availableProjects = useMemo(
    () => getAllProjects(projectGroups, standaloneProjects),
    [projectGroups, standaloneProjects]
  );

  const retargetTaskForCurrentScope = useCallback(
    (task: ImplementTask): ImplementTask =>
      retargetTaskForProjectSelection(task, {
        standaloneProjects,
        projectGroups,
        selectedGroupId,
        selectedProjectId,
      }),
    [projectGroups, selectedGroupId, selectedProjectId, standaloneProjects]
  );
  const workspaceState = resolveProjectWorkspaceState({
    standaloneProjects,
    projectGroups,
    selectedGroupId,
    selectedProjectId,
  });
  const isWorkspaceMissing = availableProjects.length === 0 && isProjectWorkspaceMissing(workspaceState);
  const scopedReadOnlyProjects = availableProjects.filter((project) => project.isReadOnly);
  const firstReadOnlyProject = scopedReadOnlyProjects[0] ?? null;
  const isReadOnlyOnlyScope =
    availableProjects.length > 0 && availableProjects.every((project) => project.isReadOnly);
  const readOnlyCtaLabel = firstReadOnlyProject?.readOnlyReason === 'missing_git'
    ? t('projects.initializeGitAction', 'Initialize Git')
    : firstReadOnlyProject?.readOnlyReason === 'missing_initial_commit'
      ? t('projects.createInitialCommitAction', 'Create initial commit')
      : t('projects.projectSettings', 'Project settings');

  useEffect(() => {
    if (!isReadOnlyOnlyScope) {
      readOnlyScopeToastRef.current = null;
      return;
    }

    const notificationKey = `implement-read-only-scope:${selectedGroupId || selectedProjectId || 'workspace'}`;
    if (readOnlyScopeToastRef.current === notificationKey) {
      return;
    }

    readOnlyScopeToastRef.current = notificationKey;
    const title = t(
      'projects.readOnlyWorkspaceTitle',
      'This scope is currently read-only.'
    );
    const description = t(
      'projects.readOnlyWorkspaceImplementBody',
      'Implementation needs at least one editable project. Read-only projects stay available for navigation, search, and context.'
    );
    const canOpenSettings = Boolean(firstReadOnlyProject) && !projectManagementDisabled;
    const openReadOnlyProjectSettings = () => {
      if (!firstReadOnlyProject || projectManagementDisabled) {
        return;
      }
      setSelectedProject(firstReadOnlyProject.id);
      openProjectGitFlowModal(firstReadOnlyProject.id);
    };

    if (canOpenSettings) {
      notify.actionRequired(title, {
        notificationKey,
        tone: 'warning',
        description,
        category: 'task_attention_required',
        actions: [
          {
            label: readOnlyCtaLabel,
            variant: 'primary',
            onClick: openReadOnlyProjectSettings,
          },
        ],
      });
      return;
    }

    notify.warning(title, {
      notificationKey,
      description,
      category: 'task_attention_required',
    });
  }, [
    firstReadOnlyProject,
    isReadOnlyOnlyScope,
    projectManagementDisabled,
    readOnlyCtaLabel,
    openProjectGitFlowModal,
    selectedGroupId,
    selectedProjectId,
    setSelectedProject,
    t,
  ]);

  const projectFilterOptions = useMemo<TaskProjectFilterOption[]>(
    () => availableProjects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      groupName: getProjectGroupByProjectId(projectGroups, project.id)?.name ?? null,
      taskCount: tasks.filter((task) =>
        !task.archived_at &&
        task.status !== 'Completed' &&
        taskMatchesProjectId(task, project.id)
      ).length,
      isReadOnly: Boolean(project.isReadOnly),
      gitFlowSettings: project.gitFlowSettings,
    })),
    [availableProjects, projectGroups, tasks]
  );
  const editableProjectOptions = useMemo(
    () => projectFilterOptions.filter((project) => !project.isReadOnly),
    [projectFilterOptions]
  );

  const availablePlanSummaries = planSummaries;

  const planPrimaryNamesById = useMemo(() => {
    return new Map(
      availablePlanSummaries.map((plan) => [
        plan.id,
        getArchitectPlanPrimaryName(plan),
      ])
    );
  }, [availablePlanSummaries]);
  const planKindsById = useMemo(() => {
    return new Map(
      availablePlanSummaries.map((plan) => [
        plan.id,
        getArchitectPlanKind(plan),
      ])
    );
  }, [availablePlanSummaries]);

  useEffect(() => {
    if (projectFilter === ALL_PROJECTS_FILTER) return;
    if (availableProjects.some((project) => project.id === projectFilter)) return;
    setProjectFilter(ALL_PROJECTS_FILTER);
  }, [availableProjects, projectFilter]);

  const projectFilteredTasks = useMemo(() => {
    if (projectFilter === ALL_PROJECTS_FILTER) {
      return tasks;
    }
    return tasks.filter((task) => taskMatchesProjectId(task, projectFilter));
  }, [projectFilter, tasks]);
  const totalActiveTaskCount = useMemo(
    () => tasks.filter((task) => !task.archived_at && task.status !== 'Completed').length,
    [tasks]
  );

  const statusCounts = useMemo(() => {
    const activeTasks = projectFilteredTasks.filter((task) => !task.archived_at && !task.draft);
    return {
      ready: activeTasks.filter((task) =>
        !task.is_blocked && task.status === 'Pending'
      ).length,
      in_progress: activeTasks.filter((task) =>
        task.status === 'InProgress' || task.status === 'InReview'
      ).length,
      waiting: activeTasks.filter((task) => task.status === 'AwaitingResponse').length,
      blocked: activeTasks.filter((task) =>
        task.is_blocked || task.status === 'Blocked' || task.status === 'Failed'
      ).length,
    };
  }, [projectFilteredTasks]);

  const filteredTasks = useMemo(() => {
    if (showArchived || statusFilter === 'all') return projectFilteredTasks;
    return projectFilteredTasks.filter((task) => {
      if (statusFilter === 'ready') {
        return !task.is_blocked && task.status === 'Pending';
      }
      if (statusFilter === 'in_progress') {
        return task.status === 'InProgress' || task.status === 'InReview';
      }
      if (statusFilter === 'waiting') {
        return task.status === 'AwaitingResponse';
      }
      return task.is_blocked || task.status === 'Blocked' || task.status === 'Failed';
    });
  }, [projectFilteredTasks, showArchived, statusFilter]);

  const getTaskPlanLabel = (task: ImplementTask): string => {
    if (task.task_source === 'standalone') {
      return standalonePlanLabel;
    }

    return planPrimaryNamesById.get(task.plan_id) || task.plan_title || standalonePlanLabel;
  };

  const getTaskCommandProjectIds = (task: ImplementTask): string[] => {
    const executionTask = retargetTaskForCurrentScope(task);
    const ids = [
      ...(executionTask.execution_targets?.map((target) => target.projectId) || []),
      ...(executionTask.project_ids || []),
      executionTask.project_id,
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
    const executionTask = retargetTaskForCurrentScope(task);
    const taskProjectIds = getTaskCommandProjectIds(executionTask);
    const taskGroup =
      getProjectGroupByProjectId(projectGroups, executionTask.project_id) ||
      getProjectGroupByProjectId(projectGroups, taskProjectIds[0] || null);
    const modalProjectsSource =
      taskGroup?.projects ||
      taskProjectIds
        .map((projectId) => getProjectById(projectId))
        .filter((project): project is NonNullable<ReturnType<typeof getProjectById>> => Boolean(project));
    const registry = await loadTaskProjectCommandRegistry(
      modalProjectsSource.map((project) => project.id),
    );

    return {
      taskId: executionTask.id,
      groupName: taskGroup?.name || t('project.projectSettings', 'Paramètres du projet'),
      requiredProjectIds: taskProjectIds,
      projects: modalProjectsSource.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        command: getTaskProjectCommand(registry, project.path)?.command || '',
        worktreeSetupCommand:
          getTaskProjectCommand(registry, project.path)?.worktreeSetupCommand || '',
        openTerminalOnRun:
          getTaskProjectCommand(registry, project.path)?.openTerminalOnRun ?? true,
        requiredForTask: taskProjectIds.includes(project.id),
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
              '{{count}} projects executed successfully.',
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
      return filteredTasks.filter((task) => Boolean(task.archived_at));
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
    return [...visibleTasks]
      .filter((task) => Boolean(task.archived_at))
      .sort((a, b) => a.sequence_index - b.sequence_index);
  }, [visibleTasks]);
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

    if (showArchived) {
      if (archivedTasks.length > 0) {
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
    }

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

  const runningTaskIds = useMemo(
    () =>
      resolveRunningTaskIds({
        conversations,
        tasks,
        selectedConversationId,
        selectedTaskId,
        conversationRuntimeById,
        conversationCompactionStatusById,
      }),
    [
      conversationCompactionStatusById,
      conversationRuntimeById,
      conversations,
      selectedConversationId,
      selectedTaskId,
      tasks,
    ]
  );
  const selectedTaskForError = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks]
  );
  const selectedTaskForErrorScope = useMemo(
    () => selectedTaskForError ? retargetTaskForCurrentScope(selectedTaskForError) : null,
    [retargetTaskForCurrentScope, selectedTaskForError]
  );
  const activeTaskMergeRuntime = selectedTaskForError
    ? mergeWorkflowRuntimeByTaskId[selectedTaskForError.id] ?? null
    : null;
  const activeMergePresentation = selectedTaskForError
    ? resolveTaskMergeWorkflowPresentationState(
        activeTaskMergeRuntime,
        selectedTaskForError.merge_workflow_summary ?? null,
        selectedTaskForError.status
      )
    : null;
  const activeMergePhase = activeMergePresentation?.phase
    ?? null;
  const hasActiveMergeFailurePresentation = activeMergePhase === 'failed'
    || activeMergePhase === 'blocked'
    || activeMergePhase === 'partial'
    || activeMergePhase === 'merging';
  const isTaskErrorRelevantForSelection = (error: string | null | undefined): {
    isConfigurationError: boolean;
    isMergeRuntimeError: boolean;
  } => {
    if (!error) {
      return { isConfigurationError: false, isMergeRuntimeError: false };
    }
    const normalized = error.toLowerCase();
    const isConfigurationError = normalized.includes('worktree')
      || normalized.includes('base branch')
      || normalized.includes('task workspace')
      || normalized.includes('branch is still checked out');
    const isMergeRuntimeError = normalized.includes('merge')
      || normalized.includes('diverged')
      || normalized.includes('non-fast-forward')
      || normalized.includes('conflict')
      || normalized.includes('uncommitted changes');
    return { isConfigurationError, isMergeRuntimeError };
  };
  const taskErrorRelevance = taskError ? isTaskErrorRelevantForSelection(taskError) : null;
  const taskErrorMatchesSelection = Boolean(
    taskError
    && taskErrorRelevance
    && selectedTaskForError
    && (
      (taskErrorRelevance.isConfigurationError
        && selectedTaskForError.status !== 'Completed'
        && !selectedTaskForError.archived_at)
      || (taskErrorRelevance.isMergeRuntimeError
        && hasActiveMergeFailurePresentation
        && !selectedTaskForError.is_blocked)
    )
  );
  const taskErrorPresentation = useMemo(
    () =>
      taskError
        ? presentServiceError(taskError, {
            projectId: selectedTaskForErrorScope?.project_id ?? selectedProjectId,
          })
        : null,
    [selectedProjectId, selectedTaskForErrorScope?.project_id, taskError]
  );
  const resolvedTaskErrorPresentation = useMemo(
    () => taskErrorPresentation
      ? resolveDegradedErrorPresentation(
          taskErrorPresentation,
          (key, options) => String(t(key, options))
        )
      : null,
    [taskErrorPresentation, t]
  );
  const taskErrorActionLabel =
    taskErrorPresentation?.primaryAction === 'open_project_settings' ||
    taskErrorPresentation?.primaryAction === 'configure_git'
      ? t('projects.projectSettings', 'Project settings')
      : taskErrorPresentation?.primaryAction === 'repair_metadata'
        ? t('architect.planSelector.repairMetadata', 'Repair metadata')
      : t('common.retry', 'Retry');
  const handleTaskErrorAction = useCallback(() => {
    if (!taskErrorPresentation) return;
    const targetProjectId = selectedTaskForErrorScope?.project_id || selectedProjectId;
    if (
      (taskErrorPresentation.primaryAction === 'open_project_settings' ||
        taskErrorPresentation.primaryAction === 'configure_git') &&
      targetProjectId
    ) {
      setSelectedProject(targetProjectId);
      openProjectGitFlowModal(targetProjectId);
      return;
    }
    if (selectedTaskForError) {
      void activateTask(selectedTaskForError.id);
    }
  }, [
    activateTask,
    openProjectGitFlowModal,
    selectedProjectId,
    selectedTaskForError,
    selectedTaskForErrorScope?.project_id,
    setSelectedProject,
    taskErrorPresentation,
  ]);

  useEffect(() => {
    if (!taskError || !taskErrorPresentation || !resolvedTaskErrorPresentation) {
      lastErrorToastRef.current = null;
      return;
    }
    if (missingBaseBranchIssue?.message === taskError) {
      lastErrorToastRef.current = taskError;
      return;
    }
    if (!taskErrorMatchesSelection) {
      lastErrorToastRef.current = null;
      return;
    }
    const dedupeKey = `${selectedTaskForError?.id ?? 'no-task'}:${taskError}`;
    if (dedupeKey === lastErrorToastRef.current) return;

    lastErrorToastRef.current = dedupeKey;
    const nextStep = resolvedTaskErrorPresentation.nextStep
      ? `${t('errors.nextStep', 'Next step')}: ${resolvedTaskErrorPresentation.nextStep}`
      : null;
    const description = [resolvedTaskErrorPresentation.body, nextStep]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n\n');
    const targetProjectId = selectedTaskForErrorScope?.project_id || selectedProjectId;
    const canOpenProjectSettings =
      (taskErrorPresentation.primaryAction === 'open_project_settings' ||
        taskErrorPresentation.primaryAction === 'configure_git') &&
      Boolean(targetProjectId);
    const canRepairMetadata =
      taskErrorPresentation.primaryAction === 'repair_metadata' &&
      selectedTaskForError?.task_source === 'architect' &&
      Boolean(selectedTaskForError.plan_id);
    const canRetry =
      !canOpenProjectSettings &&
      taskErrorPresentation.primaryAction === 'retry' &&
      Boolean(selectedTaskForError);
    const tone = taskErrorPresentation.severity === 'danger' ? 'error' : 'warning';
    const isResourcePressureError = isTooManyOpenFilesMessage(taskError);
    if (isResourcePressureError) {
      noteTooManyOpenFilesBackoff();
    }
    const notificationKey = isResourcePressureError
      ? getTooManyOpenFilesNotificationKey()
      : `implement-task-error:${selectedTaskForError?.id ?? 'no-task'}:${taskError}`;

    if (canOpenProjectSettings || canRetry || canRepairMetadata) {
      notify.actionRequired(resolvedTaskErrorPresentation.title, {
        notificationKey,
        tone,
        description,
        category: 'task_attention_required',
        actions: [
          {
            label: taskErrorActionLabel,
            variant: 'primary',
            onClick: async () => {
              if (canRepairMetadata && selectedTaskForError) {
                await repairArchitectPlanMetadata({
                  branchName:
                    selectedTaskForError.plan_storage_branch ||
                    selectedTaskForError.plan_target_branch ||
                    getGitFlowBaseBranch(),
                  planId: selectedTaskForError.plan_id,
                });
                await refreshFromPlan();
                return;
              }
              handleTaskErrorAction();
            },
          },
        ],
      });
      return;
    }

    const notifyOptions = {
      notificationKey,
      description,
      category: 'task_attention_required' as const,
    };
    if (taskErrorPresentation.severity === 'warning') {
      notify.warning(resolvedTaskErrorPresentation.title, notifyOptions);
      return;
    }

    notify.error(resolvedTaskErrorPresentation.title, notifyOptions);
  }, [
    activateTask,
    openProjectGitFlowModal,
    selectedProjectId,
    selectedTaskForError,
    selectedTaskForErrorScope?.project_id,
    setSelectedProject,
    t,
    taskError,
    taskErrorActionLabel,
    taskErrorPresentation,
    resolvedTaskErrorPresentation,
    handleTaskErrorAction,
    missingBaseBranchIssue?.message,
    refreshFromPlan,
    taskErrorMatchesSelection,
  ]);

  if (isWorkspaceMissing) {
    return (
      <aside
        className={cn('h-full w-full bg-card border-r border-border flex items-center justify-center', className)}
        data-tour-id="implement-task-panel"
      >
        <ProjectWorkspaceEmptyState
          stateKind={workspaceState.kind}
          variant="secondary"
          panelKind="tasks"
        />
      </aside>
    );
  }

  return (
    <aside
      className={cn('h-full w-full bg-card border-r border-border flex flex-col', className)}
      data-tour-id="implement-task-panel"
    >
      <div className="h-12 border-b border-border flex items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Icon name="list-todo" size={16} className="text-primary" />
            {t('implement.tasks', 'Tasks')}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <PanelHeaderIconButton
            icon="archive"
            label={t('implement.archives', 'Archives')}
            pressed={showArchived}
            onClick={() => setShowArchived((current) => !current)}
            data-tour-id="implement-archive-toggle"
          />
          <PanelHeaderIconButton
            icon="plus"
            onClick={() => setShowCreateTaskDialog(true)}
            data-tour-id="implement-create-task"
            disabled={
              Boolean(pendingTaskId) ||
              editableProjectOptions.length === 0 ||
              taskMutationDisabled ||
              taskExecutionDisabled
            }
            isLoading={Boolean(pendingTaskId)}
            label={
              taskMutationDisabled
                ? taskMutationDisabledTitle
                : taskExecutionDisabled
                  ? taskExecutionDisabledTitle
                  : editableProjectOptions.length === 0
                    ? t(
                        'implement.readOnlyOnlyAction',
                        'At least one editable repository is required to create a standalone feature.'
                      )
                    : t('implement.createStandaloneTask', 'Créer une tâche indépendante')
            }
          />
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border">
        <TaskProjectFilter
          projects={projectFilterOptions}
          selectedProjectId={projectFilter === ALL_PROJECTS_FILTER ? null : projectFilter}
          totalTaskCount={totalActiveTaskCount}
          onSelect={(projectId) => {
            setProjectFilter(projectId || ALL_PROJECTS_FILTER);
            setStatusFilter('all');
          }}
        />

        {!showArchived && (
          <div
            className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,6.5rem),1fr))] gap-1.5"
            aria-label={t('implement.taskStatusSummary', 'Task status summary')}
          >
            {([
              ['ready', t('implement.statusReady', 'Ready'), statusCounts.ready, 'bg-emerald-400'],
              ['in_progress', t('implement.statusInProgress', 'In progress'), statusCounts.in_progress, 'bg-sky-400'],
              ['waiting', t('implement.statusWaiting', 'Waiting'), statusCounts.waiting, 'bg-amber-400'],
              ['blocked', t('implement.statusBlocked', 'Blocked'), statusCounts.blocked, 'bg-red-400'],
            ] as const).map(([filter, label, count, dotClassName]) => (
              <button
                key={filter}
                type="button"
                onClick={() => setStatusFilter((current) => current === filter ? 'all' : filter)}
                aria-pressed={statusFilter === filter}
                title={label}
                className={cn(
                  'flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-left transition-colors',
                  statusFilter === filter
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border/70 bg-background/50 text-muted-foreground hover:border-primary/30 hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClassName)} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{label}</span>
                <span className="text-xs font-semibold tabular-nums">{count}</span>
              </button>
            ))}
            {statusFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setStatusFilter('all')}
                title={t('implement.clearStatusFilter', 'Show all statuses')}
                className="flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              >
                <Icon name="rotate-ccw" size={11} className="shrink-0" />
                <span className="truncate">
                  {t('implement.allStatuses', 'All statuses')}
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {showCreateTaskDialog && (
        <React.Suspense fallback={null}>
          <CreateImplementTaskDialog
            projects={projectFilterOptions}
            initialProjectId={
              projectFilter !== ALL_PROJECTS_FILTER &&
              editableProjectOptions.some((project) => project.id === projectFilter)
                ? projectFilter
                : null
            }
            isCreating={Boolean(pendingTaskId)}
            onClose={() => {
              if (!pendingTaskId) setShowCreateTaskDialog(false);
            }}
            onCreate={(input) => void handleCreateManualFeature(input)}
          />
        </React.Suspense>
      )}

      <div ref={taskListRef} className="flex-1 overflow-y-auto">
        {visibleTasks.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-2 text-center">
            <Icon name="check-circle" size={32} className="text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              {projectFilter === ALL_PROJECTS_FILTER && statusFilter === 'all'
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
                        mergeWorkflowRuntime={mergeWorkflowRuntimeByTaskId[row.task.id] ?? null}
                        multiRepoPresentation={row.multiRepoPresentation}
                        isSelected={selectedTaskId === row.task.id}
                        project={getProjectById(row.task.project_id) ?? null}
                        planLabel={getTaskPlanLabel(row.task)}
                        planKind={planKindsById.get(row.task.plan_id) ?? null}
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
        <React.Suspense fallback={null}>
          <TaskProjectCommandsModal
            isOpen
            projectGroupName={taskCommandModal.groupName}
            projects={taskCommandModal.projects}
            isSubmitting={isSavingTaskCommands}
            requireRunCommand={taskCommandModal.autoRunAfterSave}
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
        </React.Suspense>
      )}

      {renameTarget && (
        <React.Suspense fallback={null}>
          <ConfirmPromptModal
            isOpen
            title={t('implement.renameTaskTitle', 'Rename task')}
            description={t('implement.renameTaskDescription', 'Choose a new title for this task.')}
            confirmLabel={t('common.rename', 'Rename')}
            cancelLabel={t('common.cancel', 'Cancel')}
            initialValue={renameTarget.title}
            inputPlaceholder={t('implement.taskTitle', 'Task title')}
            requireInput
            isSubmitting={pendingTaskId === renameTarget.id}
            onCancel={() => {
              if (!pendingTaskId) {
                setRenameTarget(null);
              }
            }}
            onConfirm={(value) => {
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
        </React.Suspense>
      )}

      {confirmTarget && (
        <React.Suspense fallback={null}>
          <ConfirmPromptModal
            isOpen
            title={
              confirmTarget.action === 'archive'
                ? t('implement.archiveTaskTitle', 'Archive task')
                : t('implement.deleteTaskTitle', 'Delete task')
            }
            description={
              confirmTarget.action === 'archive'
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
              confirmTarget.action === 'archive'
                ? t('common.archive', 'Archive')
                : t('common.delete', 'Delete')
            }
            cancelLabel={t('common.cancel', 'Cancel')}
            confirmVariant={confirmTarget.action === 'delete' ? 'error' : 'primary'}
            isSubmitting={pendingTaskId === confirmTarget.task.id}
            onCancel={() => {
              if (!pendingTaskId) {
                setConfirmTarget(null);
              }
            }}
            onConfirm={() => {
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
                  setPendingTaskId((current) => (
                    current === confirmTarget.task.id ? null : current
                  ));
                }
              })();
            }}
          />
        </React.Suspense>
      )}
    </aside>
  );
};

export const TaskQueue = React.memo(TaskQueueBase);

export default TaskQueue;
