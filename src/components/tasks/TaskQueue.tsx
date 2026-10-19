import { visibleTaskQueueTasks } from '../../services/taskQueueVisibility';
import { groupTaskQueueLanes, TASK_QUEUE_LANES, type TaskQueueLane } from '../../services/taskQueueLanes';
import { getPlanFinalizationTaskDisplayTitle } from '../../services/planFinalization';
import { getWorktreeDiagnosticTargets, type WorktreeDiagnosticTarget } from '../../services/worktreeDiagnostics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { getServiceRuntimeCapabilities } from '../../services';
import { buildFileChangesRepositoryId, getFileChangesExecutionTargets } from '../../services/fileChangesReviewScope';
import { useChatStore } from '../../stores/useChatStore';
import {
  getTaskLifecycleCapabilities,
  useTaskStore,
  type ImplementTask,
} from '../../stores/useTaskStore';
import { useFileChangesStore } from '../../stores/useFileChangesStore';
import {
  ALL_PROJECTS_FILTER,
  resolveAvailableProjectFilter,
} from '../../services/viewFilterPreferences';
import { useViewFilterStore } from '../../stores/useViewFilterStore';
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
  resolveTaskQueueStatusGroup,
  resolveTaskStatusIndicatorState,
} from '../../services/taskStatusPresentation';
import type { MergeWorkflowRuntimeState } from '../../services/mergeWorkflow';
import {
  resolveTaskMergeWorkflowNextActionLabel,
  resolveTaskMergeWorkflowPresentationState,
  resolveTaskMergeWorkflowProgressLabel,
} from '../../services/taskMergeWorkflowPresentation';
import { SidebarMenu, sidebarMenuPosition, isSidebarTextInput, type SidebarMenuPosition } from '../ui/SidebarMenu';
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
import { localizeTaskErrorMessage } from '../../services/taskErrorPresentation';
import { toServiceError } from '../../services/contracts/errors';
import { SearchBar } from '../ui/SearchBar';
import { filterTasksByQuery } from './taskQueueSearch';
import { resolveTaskQueueSupervision, selectTaskQueueRequestSignature, type TaskQueueAttention } from '../../services/taskQueueAttention';
import type { ArchivedTaskCleanupSaga } from '../../services/archivedTaskCleanup';
import {
  getLinkedDeletionSagaGeneration,
  findPersistedTaskConversationId,
  loadLinkedTaskDeletionSagas,
  removeLinkedTaskDeletionSaga,
  startLinkedTaskDeletionSaga,
  upsertLinkedTaskDeletionSaga,
  type LinkedTaskDeletionSaga,
} from '../../services/linkedTaskDeletionSaga';
import { withTaskLifecycleLock } from '../../services/taskLifecycleLease';

// Keep diagnostics out of the task-list startup chunk now that the legacy graph is removed.
const WorktreeDiagnosticsDialog = React.lazy(() => import('./WorktreeDiagnosticsDialog').then(module => ({ default: module.WorktreeDiagnosticsDialog })));

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
const DemoBlueprintLaunchDialog = React.lazy(() => import('../../demo/DemoBlueprintLaunchDialog'));
const CreateImplementTaskDialog = React.lazy(() =>
  import('./CreateImplementTaskDialog').then((module) => ({
    default: module.CreateImplementTaskDialog,
  })),
);

interface TaskQueueProps {
  className?: string;
  excludedProjectIds?: readonly string[];
}

type TaskListRow = {
  id: string;
  task: ImplementTask;
  multiRepoPresentation: MultiRepoTaskPresentation | null;
};

const statusConfig: Record<TaskStatus, { color: string; bgColor: string }> = {
  Pending: { color: 'text-muted-foreground', bgColor: 'bg-muted' },
  InProgress: { color: 'text-sky-400', bgColor: 'bg-sky-400/10' },
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

const TASK_MENU_WIDTH = 208;
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

const TaskExecutionGraphDialog = React.lazy(() => import('./TaskExecutionGraphDialog'));

type TaskActionKey =
  | 'execution_graph'
  | 'start_review'
  | 'worktree_diagnostic'
  | 'project_settings'
  | 'rename'
  | 'delete'
  | 'archive'
  | 'cleanup_worktree'
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
  key: 'project' | 'plan' | 'plan_finalization' | 'standalone' | 'draft' | 'archived';
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
  attention?: TaskQueueAttention;
  hasResolvedUserRequest?: boolean;
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
  attention,
  hasResolvedUserRequest,
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
  if (task.archived_at) {
    contextBadges.push({ key: 'archived', label: t('implement.archives', 'Archives'), icon: 'archive' });
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
    ? { color: 'text-sky-400', bgColor: 'bg-sky-400/10' }
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
    mergeWorkflowPresentation,
    task.is_blocked,
    Boolean(attention && attention.kind !== 'review'),
    hasResolvedUserRequest
  );
  const resolvedStatus =
    indicatorState === 'blocked' ||
    indicatorState === 'merge_blocked' ||
    indicatorState === 'merge_partial'
      ? statusConfig.Blocked
      : indicatorState === 'failed' || indicatorState === 'merge_failed'
        ? statusConfig.Failed
        : indicatorState === 'awaiting_response'
          ? statusConfig.AwaitingResponse
          : status;
  const showMergeWorkflowPresentation = Boolean(
    multiRepoPresentation &&
      mergeWorkflowPresentation &&
      (indicatorState === 'blocked' ||
        indicatorState === 'merging' ||
        indicatorState === 'merge_partial' ||
        indicatorState === 'merge_blocked' ||
        indicatorState === 'merge_failed')
  );
  const pendingRequestLabel = attention && attention.kind !== 'review'
    ? attention.kind === 'approval'
      ? t('implement.taskNextActionOpenApproval', 'Next: open the approval request')
      : t('implement.taskNextActionAwaitingResponse', 'Next: answer the pending request')
    : null;
  const showReviewPresentation = Boolean(multiRepoPresentation && !isAssistantRunning &&
    (task.status === 'InReview' || isPlanFinalizationTask(task)) &&
    !task.is_blocked && task.status !== 'Completed' && !task.archived_at
  );
  const lockTooltip = getDependencyBlockedMessage(task, t) ?? '';
  const waitingReason = indicatorState === 'blocked' ? lockTooltip || t('implement.statusBlocked', 'Blocked')
    : indicatorState === 'failed' ? t('implement.failed', 'Failed')
    : indicatorState === 'awaiting_response' ? t('implement.statusWaiting', 'Needs reply') : null;
  const reviewNextAction = showMergeWorkflowPresentation || showReviewPresentation
    ? multiRepoPresentation?.nextActionLabel
    : null;
  const nextAction = pendingRequestLabel || reviewNextAction;
  const instruction = nextAction || waitingReason;
  const secondaryText = instruction || task.description;

  return (
    <div
      role="button"
      tabIndex={0}
      data-task-card-variant={isCompactDraftFeatureCard ? 'compact-draft' : 'default'}
      data-tour-id="implement-task-card"
      onClick={onSelect}
      onContextMenu={event => {
        if (!actions.length) return;
        event.preventDefault(); event.stopPropagation();
        setMenuPosition(sidebarMenuPosition(event)); setShowMenu(true);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'relative w-full overflow-visible rounded-xl border text-left transition-all duration-200 group cursor-pointer',
        isCompactDraftFeatureCard ? 'h-[76px]' : 'h-[96px]',
        isSelected
          ? 'border-primary/30 bg-primary/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
          : 'border-border/70 bg-card/70 hover:border-primary/20 hover:bg-accent/30'
      )}
    >
      <div className={cn('grid h-full min-w-0 grid-cols-1 gap-y-1 p-1.5', isCompactDraftFeatureCard ? 'grid-rows-[auto,auto]' : 'grid-rows-[auto,1fr,auto]')}>
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
            aria-label={t('implement.taskActions', 'Task actions')} aria-haspopup="menu" aria-expanded={showMenu}
          >
            <Icon name="more-vertical" size={13} />
          </button>
        )}

        <div className="flex items-center gap-2.5">
          <div className="relative shrink-0 group/lock">
            <div className={cn('flex h-7 w-7 items-center justify-center rounded-lg', resolvedStatus.bgColor)}>
              <TaskStatusIndicator
                state={indicatorState}
                layout="card"
                size={14}
                dotSize={8}
                className={resolvedStatus.color}
              />
            </div>
            {task.is_blocked && lockTooltip && (
              <div className="pointer-events-none absolute left-0 top-9 z-20 hidden min-w-56 max-w-72 rounded-md border border-orange-500/30 bg-popover px-2 py-1.5 text-xs text-orange-300 shadow-lg group-hover/lock:block">
                {lockTooltip}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h3 title={getPlanFinalizationTaskDisplayTitle(task, t)} className="truncate pr-7 text-sm font-semibold leading-[1.1rem] text-foreground">
              {getPlanFinalizationTaskDisplayTitle(task, t)}
            </h3>
          </div>
        </div>

        {!isCompactDraftFeatureCard && (
          <div className="flex min-h-0 items-center overflow-hidden">
            {secondaryText && (
              <p
                data-task-card-next-action={nextAction ? 'true' : undefined}
                data-task-card-waiting-reason={!nextAction && waitingReason ? 'true' : undefined}
                title={secondaryText}
                className={cn('min-w-0 flex-1 truncate text-xs leading-4', instruction ? 'text-amber-500' : 'text-muted-foreground')}
              >
                {secondaryText}
              </p>
            )}
          </div>
        )}

        <div data-task-card-footer="true" className="flex h-7 min-w-0 items-center gap-1.5">
          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
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
                'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
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
                'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
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
      </div>

      {showMenu && menuPosition && (
          <SidebarMenu position={menuPosition} onClose={() => setShowMenu(false)} triggerRef={menuButtonRef}
            aria-label={t('implement.taskActions', 'Task actions')} className="w-52">

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
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs',
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
          </SidebarMenu>
        )}
    </div>
  );
};

const MemoizedTaskItem = React.memo(TaskItem);

const EMPTY_PROJECT_IDS: readonly string[] = [];
const TaskQueueBase: React.FC<TaskQueueProps> = ({ className, excludedProjectIds = EMPTY_PROJECT_IDS }) => {
  const [executionGraphTask, setExecutionGraphTask] = useState<ImplementTask | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const [filterMenuPosition, setFilterMenuPosition] = useState<SidebarMenuPosition | null>(null);
  const [panelMenuPosition, setPanelMenuPosition] = useState<SidebarMenuPosition | null>(null);
  const { t } = useTranslation();
  const runtimeCapabilities = getServiceRuntimeCapabilities();
  const {
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    isAppLoading,
    appLoadError,
    standaloneProjects,
    projectGroups,
    openProjectNavigator,
    openProjectGitFlowModal,
    setSelectedProject,
    setSelectedTask,
  } = useAppStore(useShallow((state) => ({
    selectedGroupId: state.selectedGroupId,
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    isAppLoading: state.isLoading,
    appLoadError: state.lastError,
    standaloneProjects: state.standaloneProjects ?? [],
    projectGroups: state.projectGroups,
    openProjectNavigator: state.openProjectNavigator,
    openProjectGitFlowModal: state.openProjectGitFlowModal,
    setSelectedProject: state.setSelectedProject,
    setSelectedTask: state.setSelectedTask,
  })));
  const [diagnostic, setDiagnostic] = useState<{ task: ImplementTask; entries: WorktreeDiagnosticTarget[] } | null>(null);
  const getProjectById = useAppStore((state) => state.getProjectById);
  const {
    createConversation,
    conversations,
    selectedConversationId,
    conversationRuntimeById,
    conversationCompactionStatusById,
    pendingToolApprovalByConversationId,
    selectConversation,
    deleteConversation,
  } = useChatStore(useShallow((state) => ({
    createConversation: state.createConversation,
    conversations: state.conversations,
    selectedConversationId: state.selectedConversationId,
    conversationRuntimeById: state.conversationRuntimeById,
    conversationCompactionStatusById: state.conversationCompactionStatusById,
    pendingToolApprovalByConversationId: state.pendingToolApprovalByConversationId,
    selectConversation: state.selectConversation,
    deleteConversation: state.deleteConversation,
  })));
  const {
    tasks,
    planSummaries,
    publishedStandaloneTasks,
    activateTask,
    createManualFeatureDraft,
    deleteManualFeatureDraft,
    reserveManualFeatureCreation,
    releaseManualFeatureCreation,
    renameTask,
    archiveTask,
    restoreTask,
    deleteTask,
    reopenTask,
    taskCommandRuns,
    mergeWorkflowRuntimeByTaskId,
    archivedTaskCleanupByTaskId,
    cleanupArchivedTask,
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
    deleteManualFeatureDraft: state.deleteManualFeatureDraft,
    reserveManualFeatureCreation: state.reserveManualFeatureCreation,
    releaseManualFeatureCreation: state.releaseManualFeatureCreation,
    renameTask: state.renameTask,
    archiveTask: state.archiveTask,
    restoreTask: state.restoreTask,
    deleteTask: state.deleteTask,
    reopenTask: state.reopenTask,
    taskCommandRuns: state.taskCommandRuns,
    mergeWorkflowRuntimeByTaskId: state.mergeWorkflowRuntimeByTaskId,
    archivedTaskCleanupByTaskId: state.archivedTaskCleanupByTaskId,
    cleanupArchivedTask: state.cleanupArchivedTask,
    runTaskCommands: state.runTaskCommands,
    cancelTaskCommands: state.cancelTaskCommands,
    refreshFromPlan: state.refreshFromPlan,
    missingBaseBranchIssue: state.missingBaseBranchIssue,
    clearMissingBaseBranchIssue: state.clearMissingBaseBranchIssue,
    createMissingBaseBranch: state.createMissingBaseBranch,
    taskError: state.lastError,
  })));
  const requestSignature = useChatStore(selectTaskQueueRequestSignature);
  const reviewRepositoryModes = useFileChangesStore(useShallow((state) => Object.fromEntries(state.repositories.map((repository) => [repository.id, repository.executionMode]))));
  const reviewCurrentTaskId = useFileChangesStore((state) => state.currentTaskId);
  const reviewLoadState = useFileChangesStore((state) => state.currentTaskLoadState);
  const reviewIsLoading = useFileChangesStore((state) => state.isLoading);
  const liveReviewSummary = useFileChangesStore((state) => state.reviewSummary);
  const lastErrorToastRef = useRef<string | null>(null);
  const readOnlyScopeToastRef = useRef<string | null>(null);
  const missingBaseBranchToastRef = useRef<string | number | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const startingReviewsRef = useRef(new Set<string>());
  const {
    implement: { projectId: projectFilter, status: statusFilter, showArchived, showBlockedTasks, showWithoutInteraction },
    setImplementProjectFilter,
    setImplementStatusFilter,
    setImplementShowArchived,
    setImplementShowBlockedTasks,
    setImplementShowWithoutInteraction,
    filtersHydrated,
  } = useViewFilterStore(useShallow((state) => ({
    implement: state.implement,
    setImplementProjectFilter: state.setImplementProjectFilter,
    setImplementStatusFilter: state.setImplementStatusFilter,
    setImplementShowArchived: state.setImplementShowArchived,
    setImplementShowBlockedTasks: state.setImplementShowBlockedTasks,
    setImplementShowWithoutInteraction: state.setImplementShowWithoutInteraction,
    filtersHydrated: state.isHydrated,
  })));
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [createTaskError, setCreateTaskError] = useState<string | null>(null);
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
    startPoint,
  }: {
    projectId: string;
    taskKind: StandaloneTaskKind;
    startPoint:
      | { kind: 'new' }
      | { kind: 'direct'; branchName: string; baseCommitHash: string | null }
      | { kind: 'worktree'; worktree: import('../../services/tauriIpc').GitAvailableWorktreeDto }
      | { kind: 'branch'; branch: import('../../services/tauriIpc').GitAvailableTaskBranchDto };
  }) => {
    setCreateTaskError(null);
    const reportCreationError = (message: string, description?: string) => {
      const localizedMessage = localizeTaskErrorMessage(message, (key, options) => String(t(key, options)));
      setCreateTaskError([localizedMessage, description].filter(Boolean).join(' '));
      lastErrorToastRef.current = `no-task:${message}`;
      notify.error(localizedMessage, description ? { description } : undefined);
    };
    if (taskMutationDisabled || taskExecutionDisabled) {
      reportCreationError(taskExecutionDisabled ? taskExecutionDisabledTitle : taskMutationDisabledTitle);
      return;
    }

    if (isWorkspaceMissing) {
      reportCreationError(
        workspaceState.kind === 'noProjectAvailable'
          ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
          : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')
      );
      return;
    }

    if (pendingTaskId) return;
    const targetProject = getProjectById(projectId) ?? null;
    if (!targetProject || targetProject.isReadOnly) {
      reportCreationError(
        t(
          'implement.manualFeatureMissingProjects',
          'The selected project is not available for implementation.'
        )
      );
      return;
    }
    if (!isStandaloneTaskKindCreatable(taskKind, targetProject.gitFlowSettings)) {
      reportCreationError(
        t(
          'implement.taskKindUnavailableForProject',
          'This task type is not available for the selected project workflow.',
        ),
      );
      return;
    }
    const targetGroupId = getProjectGroupByProjectId(projectGroups, projectId)?.id ?? null;

    const taskId = `manual-feature-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!reserveManualFeatureCreation(taskId)) return;
    const provisionalTitle = taskKind === 'bugfix'
      ? t('implement.manualBugfixUntitled', 'New bugfix')
      : taskKind === 'hotfix'
        ? t('implement.manualHotfixUntitled', 'New hotfix')
        : taskKind === 'direct'
          ? t('implement.manualDirectUntitled', 'New direct task')
        : t('implement.manualFeatureUntitled', 'New feature');
    setPendingTaskId(taskId);
    let conversationId: string | null = null;
    let draftCreationStarted = false;
    let creationCommitted = false;
    let cleanupSaga: LinkedTaskDeletionSaga | null = null;

    try {
      await withTaskLifecycleLock(taskId, async (taskLifecycleLeaseId) => {
        try {
          const now = new Date().toISOString();
          const preparedCleanupSaga: LinkedTaskDeletionSaga = {
            taskId,
            conversationId: '',
            phase: 'task_creating',
            draft: true,
            interruptedCreation: true,
            executionTargets: [],
            createdAt: now,
            updatedAt: now,
          };
          await startLinkedTaskDeletionSaga(preparedCleanupSaga);
          cleanupSaga = preparedCleanupSaga;
          setSelectedTask(taskId);
          const conversation = await createConversation(
            provisionalTitle,
            taskId,
            projectId,
            targetGroupId
          );
          conversationId = conversation.id;
          preparedCleanupSaga.conversationId = conversation.id;
          preparedCleanupSaga.updatedAt = new Date().toISOString();
          await upsertLinkedTaskDeletionSaga(preparedCleanupSaga);
          draftCreationStarted = true;
          await createManualFeatureDraft({
            taskId,
            conversationId: conversation.id,
            groupId: targetGroupId,
            projectIds: [projectId],
            contextProjectIds: [],
            baseBranch: taskKind === 'direct'
              ? startPoint.kind === 'direct' ? startPoint.branchName : null
              : taskKind === 'hotfix'
                ? targetProject.gitFlowSettings?.mainBranch || getGitFlowMainBranch()
                : targetProject.gitFlowSettings?.baseBranch || getGitFlowBaseBranch(),
            title: provisionalTitle,
            description: '',
            taskKind,
            existingBranchName: startPoint.kind === 'worktree'
              ? startPoint.worktree.branchName
              : startPoint.kind === 'branch'
                ? startPoint.branch.name
                : startPoint.kind === 'direct'
                  ? startPoint.branchName
                  : null,
            baseCommitHash: startPoint.kind === 'direct' ? startPoint.baseCommitHash : null,
            taskLifecycleLeaseId,
          });
          setSelectedTask(taskId);
          await activateTask(taskId);
          if (!(await selectConversation(conversation.id))) {
            throw new Error('Impossible de sélectionner la nouvelle conversation.');
          }
          const committedCleanupSaga: LinkedTaskDeletionSaga = {
            ...preparedCleanupSaga,
            phase: 'prepared',
            creationCommitted: true,
            updatedAt: new Date().toISOString(),
          };
          await upsertLinkedTaskDeletionSaga(committedCleanupSaga);
          cleanupSaga = committedCleanupSaga;
          creationCommitted = true;
          await removeLinkedTaskDeletionSaga(
            taskId,
            undefined,
            getLinkedDeletionSagaGeneration({
              ...committedCleanupSaga,
              ownerType: 'task',
              ownerId: taskId,
            }),
          );
          cleanupSaga = null;
          setShowCreateTaskDialog(false);
        } catch (error) {
          if (!creationCommitted && cleanupSaga) {
            try {
              const persisted = (await loadLinkedTaskDeletionSagas()).find((candidate) =>
                candidate.taskId === taskId &&
                getLinkedDeletionSagaGeneration({ ...candidate, ownerType: 'task', ownerId: taskId }) ===
                  getLinkedDeletionSagaGeneration({ ...cleanupSaga!, ownerType: 'task', ownerId: taskId }),
              );
              if (persisted?.creationCommitted) creationCommitted = true;
            } catch (journalError) {
              setCreateTaskError(`${toServiceError(error).message} ${toServiceError(journalError).message}`);
              notify.warning(
                t('implement.manualFeatureCleanupPending', 'La tâche a été créée, mais la clôture de son journal reste en attente.'),
                { description: `${toServiceError(error).message} ${toServiceError(journalError).message}` },
              );
              return;
            }
          }
          if (creationCommitted) {
            setShowCreateTaskDialog(false);
            notify.warning(
              t('implement.manualFeatureCleanupPending', 'La tâche a été créée, mais la clôture de son journal reste en attente.'),
              { description: toServiceError(error).message },
            );
            return;
          }
          const cleanupErrors: string[] = [];
          let conversationLookupFailed = false;
          let taskAbsenceConfirmed = !draftCreationStarted;
          if (draftCreationStarted) {
            try {
              if (cleanupSaga) {
                cleanupSaga = { ...cleanupSaga, phase: 'task_deleting', updatedAt: new Date().toISOString() };
                await upsertLinkedTaskDeletionSaga(cleanupSaga);
              }
              await deleteManualFeatureDraft(taskId, taskLifecycleLeaseId);
              taskAbsenceConfirmed = true;
            } catch (cleanupFailure) {
              cleanupErrors.push(
                `La tâche créée n'a pas pu être nettoyée : ${toServiceError(cleanupFailure).message}`,
              );
            }
          }
          if (!conversationId && cleanupSaga) {
            try {
              conversationId = await findPersistedTaskConversationId(taskId);
            } catch (lookupFailure) {
              conversationLookupFailed = true;
              cleanupErrors.push(`La conversation créée n'a pas pu être recherchée : ${toServiceError(lookupFailure).message}`);
            }
          }
          if (taskAbsenceConfirmed && !conversationLookupFailed) {
            try {
              if (cleanupSaga) {
                cleanupSaga = {
                  ...cleanupSaga,
                  conversationId: conversationId ?? '',
                  phase: 'task_deleted',
                  updatedAt: new Date().toISOString(),
                  lastError: undefined,
                };
                await upsertLinkedTaskDeletionSaga(cleanupSaga);
              }
              if (conversationId) await deleteConversation(conversationId, { mode: 'implement' });
              if (cleanupSaga) {
                await removeLinkedTaskDeletionSaga(
                  taskId,
                  cleanupSaga.targetBranch,
                  getLinkedDeletionSagaGeneration({
                    ...cleanupSaga,
                    ownerType: 'task',
                    ownerId: taskId,
                  }),
                );
                cleanupSaga = null;
              }
            } catch (cleanupFailure) {
              cleanupErrors.push(
                `La conversation créée n'a pas pu être nettoyée : ${toServiceError(cleanupFailure).message}`,
              );
            }
          } else if (cleanupSaga) {
            const lastError = cleanupErrors.at(-1);
            try {
              cleanupSaga = {
                ...cleanupSaga,
                updatedAt: new Date().toISOString(),
                lastError,
              };
              await upsertLinkedTaskDeletionSaga(cleanupSaga);
            } catch (journalFailure) {
              cleanupErrors.push(
                `Le nettoyage en attente n'a pas pu être mis à jour : ${toServiceError(journalFailure).message}`,
              );
            }
          }
          setSelectedTask(null);
          const message = toServiceError(error).message
            || t('implement.manualFeatureCreateFailed', 'Failed to create manual feature.');
          reportCreationError(message, cleanupErrors.length > 0 ? cleanupErrors.join(' ') : undefined);
        }
      });
    } catch (error) {
      reportCreationError(toServiceError(error).message);
    } finally {
      releaseManualFeatureCreation(taskId);
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

    if (repositoryDescriptors.length <= 1 && !mergeWorkflowPresentation && task.status !== 'InReview' && !isPlanFinalizationTask(task)) {
      return null;
    }

    const targets = getFileChangesExecutionTargets(task);
    const repositoryId = (descriptor: TaskRepositoryDescriptor): string | undefined => {
      const target = targets.find((target) => target.projectId === descriptor.projectId && target.branchName === descriptor.branchName);
      return target ? buildFileChangesRepositoryId(target) : undefined;
    };
    const reviewSummaryByKey = new Map(
      (reviewSummary?.repositories || []).map((repository) => [
        repository.id,
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
          const repositorySummary = reviewSummaryByKey.get(repositoryId(descriptor) ?? '');
          return repositorySummary?.id === reviewSummary.nextRepositoryId;
        }) ?? null
        : null;

    const repositories = repositoryDescriptors.map((descriptor) => {
      const repositorySummary = reviewSummaryByKey.get(repositoryId(descriptor) ?? '') ?? null;
      return {
        id: descriptor.id,
        label: descriptor.label,
        title: descriptor.repoPath || descriptor.label,
        state: repositorySummary?.state ?? null,
        isNext: repositorySummary?.id === reviewSummary?.nextRepositoryId,
      };
    });

    let progressLabel = t(repositoryDescriptors.length === 1 ? 'implement.repositoryCountInlineSingle' : 'implement.repositoryCountInline', repositoryDescriptors.length === 1 ? '{{count}} project involved' : '{{count}} projects involved', {
      count: repositoryDescriptors.length,
    });
    let nextActionLabel = t('implement.taskNextActionStart', 'Next: start implementation');
    const resolvedStatusGroup = resolveTaskQueueStatusGroup(
      task.status,
      task.is_blocked,
      mergeWorkflowPresentation
    );

    if (resolvedStatusGroup === 'blocked' && task.is_blocked) {
      nextActionLabel = t('implement.taskNextActionBlocked', 'Next: unblock task dependencies');
    } else if (mergeWorkflowPresentation) {
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
    } else if (isPlanFinalizationTask(task)) {
      nextActionLabel = t('implement.taskNextActionFinalizePlan', 'Next: finalize the plan');
    } else if (reviewSummary && reviewSummary.repositoryCount > 0 && task.status === 'InReview') {
      const resolvedCount = reviewSummary.stateCounts.committed + reviewSummary.stateCounts.no_changes;
      progressLabel = t(reviewSummary.repositoryCount === 1 ? 'implement.taskValidationProgressSingle' : 'implement.taskValidationProgress', reviewSummary.repositoryCount === 1 ? '{{resolved}}/{{total}} project resolved' : '{{resolved}}/{{total}} projects resolved', {
        resolved: resolvedCount,
        total: reviewSummary.repositoryCount,
      });

      if (reviewSummary.repositories.some((repository) => repository.isCommitting)) {
        nextActionLabel = t('implement.taskNextActionOpenReview', 'Next: open the review');
      } else if (reviewSummary.nextAction === 'commit_repository' && nextRepositoryDescriptor) {
        const mode = reviewRepositoryModes[repositoryId(nextRepositoryDescriptor) ?? ''] ?? targets.find(
          (target) => buildFileChangesRepositoryId(target) === repositoryId(nextRepositoryDescriptor)
        )?.executionMode;
        const isDirect = mode === 'direct';
        nextActionLabel = isDirect
          ? t('implement.taskNextActionAcceptRepository', 'Next: accept changes in {{repository}}', {
            repository: repositoryLabelForSummary(nextRepositoryDescriptor),
          })
          : t('implement.taskNextActionCommitRepository', 'Next: commit {{repository}}', {
            repository: repositoryLabelForSummary(nextRepositoryDescriptor),
          });
      } else if (reviewSummary.nextAction === 'validate_repository' && nextRepositoryDescriptor) {
        nextActionLabel = t('implement.taskNextActionValidateRepository', 'Next: validate {{repository}}', {
          repository: repositoryLabelForSummary(nextRepositoryDescriptor),
        });
      } else if (reviewSummary.nextAction === 'complete_without_code_changes' || reviewSummary.nextAction === 'complete_task') {
        nextActionLabel = t('implement.taskNextActionOpenReview', 'Next: open the review');
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
        'implement.taskNextActionOpenReview',
        'Next: open the review'
      );
    } else if (task.status === 'Completed') {
      nextActionLabel = t('implement.taskNextActionCompleted', 'Task completed across repositories');
    } else if (task.status === 'Failed') {
      nextActionLabel = t('implement.taskNextActionRetry', 'Next: retry task');
    } else if (resolvedStatusGroup === 'blocked') {
      nextActionLabel = t('implement.taskNextActionBlocked', 'Next: unblock task dependencies');
    }

    return {
      repositories,
      progressLabel,
      nextActionLabel,
    };
  }, [getProjectById, mergeWorkflowRuntimeByTaskId, reviewRepositoryModes, t]);

  const availableProjects = useMemo(
    () => getAllProjects(projectGroups, standaloneProjects).filter(project => !excludedProjectIds.includes(project.id)),
    [projectGroups, standaloneProjects, excludedProjectIds]
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

  const { attentionByTaskId, resolvedWaitTaskIds } = useMemo(() => resolveTaskQueueSupervision({
    tasks, conversations, requestStateByConversationId: Object.fromEntries(JSON.parse(requestSignature)),
    questionnaireDraftsByConversationId: {}, pendingToolApprovalByConversationId, runningTaskIds, mergeWorkflowRuntimeByTaskId,
  }), [tasks, conversations, requestSignature, pendingToolApprovalByConversationId, runningTaskIds, mergeWorkflowRuntimeByTaskId]);

  const queueVisibleTasks = useMemo(() => visibleTaskQueueTasks(tasks, {
    showBlockedTasks, showWithoutInteraction, showArchived, runningTaskIds, attentionByTaskId, mergeWorkflowRuntimeByTaskId,
  }), [tasks, showBlockedTasks, showWithoutInteraction, showArchived, runningTaskIds, attentionByTaskId, mergeWorkflowRuntimeByTaskId]);

  const projectFilterOptions = useMemo<TaskProjectFilterOption[]>(
    () => availableProjects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      groupName: getProjectGroupByProjectId(projectGroups, project.id)?.name ?? null,
      taskCount: queueVisibleTasks.filter((task) =>
        !task.archived_at &&
        task.status !== 'Completed' &&
        taskMatchesProjectId(task, project.id)
      ).length,
      isReadOnly: Boolean(project.isReadOnly),
      directEdit: project.directEdit,
      gitSetupState: project.gitSetupState,
      gitFlowSettings: project.gitFlowSettings,
    })),
    [availableProjects, projectGroups, queueVisibleTasks]
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
    if (!filtersHydrated || isAppLoading || appLoadError) return;
    const availableFilter = resolveAvailableProjectFilter(
      projectFilter,
      availableProjects.map((project) => project.id),
    );
    if (availableFilter !== projectFilter) {
      setImplementProjectFilter(availableFilter);
    }
  }, [
    appLoadError,
    availableProjects,
    filtersHydrated,
    isAppLoading,
    projectFilter,
    setImplementProjectFilter,
  ]);

  const projectFilteredTasks = useMemo(() => {
    if (projectFilter === ALL_PROJECTS_FILTER) {
      return queueVisibleTasks;
    }
    return queueVisibleTasks.filter((task) => taskMatchesProjectId(task, projectFilter));
  }, [projectFilter, queueVisibleTasks]);
  const taskQueueStatusGroupById = useMemo(
    () => new Map(
      projectFilteredTasks.map((task) => [
        task.id,
        resolveTaskQueueStatusGroup(
          task.status,
          task.is_blocked,
          resolveTaskMergeWorkflowPresentationState(
            mergeWorkflowRuntimeByTaskId[task.id] ?? null,
            task.merge_workflow_summary ?? null,
            task.status
          ),
          runningTaskIds.has(task.id),
          Boolean(attentionByTaskId.get(task.id) && attentionByTaskId.get(task.id)?.kind !== 'review'),
          resolvedWaitTaskIds.has(task.id)
        ),
      ])
    ),
    [attentionByTaskId, resolvedWaitTaskIds, mergeWorkflowRuntimeByTaskId, projectFilteredTasks, runningTaskIds]
  );
  const totalActiveTaskCount = useMemo(
    () => queueVisibleTasks.filter((task) => !task.archived_at && task.status !== 'Completed').length,
    [queueVisibleTasks]
  );

  const taskLanes = useMemo(() => groupTaskQueueLanes(projectFilteredTasks, taskQueueStatusGroupById, true), [projectFilteredTasks, taskQueueStatusGroupById]);
  const laneByTaskId = useMemo(() => new Map(Object.entries(taskLanes).flatMap(([lane, items]) => items.map(task => [task.id, lane as TaskQueueLane] as const))), [taskLanes]);
  const statusCounts = useMemo(() => ({ ready: taskLanes.ready.length, in_progress: taskLanes.in_progress.length, waiting: taskLanes.waiting.length, completed: taskLanes.completed.length }), [taskLanes]);

  const filteredTasks = useMemo(() => {
    if (statusFilter === 'all') return projectFilteredTasks;
    return projectFilteredTasks.filter(task => laneByTaskId.get(task.id) === statusFilter);
  }, [projectFilteredTasks, statusFilter, laneByTaskId]);

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

  const getStartReviewDisabledReason = (
    task: ImplementTask,
    busy = runningTaskIds.has(task.id) || attentionByTaskId.get(task.id)?.kind === 'approval',
  ): string | undefined => {
    if (!getServiceRuntimeCapabilities().taskMutation) return taskMutationDisabledTitle;
    if (busy || pendingTaskId === task.id) {
      return t('implement.startReviewBusy', 'Finish the current turn or resolve the tool approval before starting review.');
    }
    if (task.archived_at || task.draft || task.is_blocked || isPlanFinalizationTask(task) ||
      !['InProgress', 'AwaitingResponse'].includes(task.status)) {
      return t('implement.startReviewUnavailable', 'This task cannot enter review in its current state.');
    }
    return undefined;
  };

  const buildTaskActions = (task: ImplementTask): TaskActionDescriptor[] => {
    if (isPlanFinalizationTask(task)) {
      return [{ key: 'execution_graph', label: t('implement.viewExecutionGraph', 'View workflow'), icon: 'workflow' }];
    }

    const capabilities = getTaskLifecycleCapabilities(
      task,
      publishedStandaloneTasks[task.id] ?? false
    );
    const archived = Boolean(task.archived_at);
    const actions: TaskActionDescriptor[] = [
      { key: 'execution_graph', label: t('implement.viewExecutionGraph', 'View workflow'), icon: 'workflow' },
      {
        key: 'rename',
        label: t('common.rename', 'Rename'),
        icon: 'edit',
        disabled: taskMutationDisabled,
        title: taskMutationDisabled ? taskMutationDisabledTitle : undefined,
      },
    ];

    if (!archived && !task.draft && ['InProgress', 'AwaitingResponse'].includes(task.status)) {
      const reason = getStartReviewDisabledReason(task);
      actions.push({ key: 'start_review', label: t('implement.startReview', 'Start review'), icon: 'eye', disabled: Boolean(reason), title: reason });
    }

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

    if (archived && archivedTaskCleanupByTaskId[task.id]) {
      actions.push({
        key: 'cleanup_worktree',
        label: t('implement.cleanupArchivedTaskWorktree', 'Clean up worktree'),
        icon: 'folder',
        disabled: taskMutationDisabled,
        title: taskMutationDisabled ? taskMutationDisabledTitle : undefined,
      });
    }

    actions.push({
      key: 'project_settings',
      label: t('project.projectSettings', 'Paramètres du projet'),
      icon: 'settings',
      disabled: taskCommandsDisabled,
      title: taskCommandsDisabled ? taskCommandsDisabledTitle : undefined,
    });

    if (getWorktreeDiagnosticTargets(task, getProjectById).length > 0) {
      actions.push({ key: 'worktree_diagnostic', label: t('implement.worktreeDiagnostic.title'), icon: 'folder-git-2' });
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
    if (action === 'execution_graph') { setExecutionGraphTask(task); return; }
    if (action === 'start_review') {
      if (startingReviewsRef.current.has(task.id)) return;
      const chat = useChatStore.getState();
      const currentTasks = useTaskStore.getState().tasks;
      const running = resolveRunningTaskIds({
        ...chat, tasks: currentTasks, selectedTaskId: useAppStore.getState().selectedTaskId,
      });
      const attention = resolveTaskQueueSupervision({ ...chat, tasks: currentTasks, runningTaskIds: running });
      const currentTask = useTaskStore.getState().getTaskById(task.id);
      const reason = currentTask ? getStartReviewDisabledReason(currentTask,
        running.has(task.id) || attention.attentionByTaskId.get(task.id)?.kind === 'approval')
        : t('implement.startReviewUnavailable', 'This task cannot enter review in its current state.');
      if (reason) { notify.error(reason); return; }
      startingReviewsRef.current.add(task.id);
      setPendingTaskId(task.id);
      try {
        await useTaskStore.getState().startReview(task.id);
        if (useTaskStore.getState().getTaskById(task.id)?.status !== 'InReview') {
          throw new Error(useTaskStore.getState().lastError || t('implement.startReviewUnavailable', 'This task cannot enter review in its current state.'));
        }
        notify.info(t('implement.startReviewReady', 'Task is in review. Send your next message in its conversation to start the reviewer.'));
      } catch (error) {
        notify.error(toServiceError(error).message);
      } finally {
        startingReviewsRef.current.delete(task.id);
        setPendingTaskId((current) => current === task.id ? null : current);
      }
      return;
    }
    if (action === 'worktree_diagnostic') {
      setDiagnostic({ task, entries: getWorktreeDiagnosticTargets(task, getProjectById) });
      return;
    }
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
    if (action === 'cleanup_worktree') {
      setPendingTaskId(task.id);
      try {
        const remaining = await cleanupArchivedTask(task.id);
        if (remaining) {
          showArchivedCleanupNotification(remaining);
        } else {
          notify.success(
            t('implement.archivedTaskCleanupComplete', 'Worktree cleanup completed'),
          );
        }
      } finally {
        setPendingTaskId((current) => (current === task.id ? null : current));
      }
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
    } catch (error) {
      const message = toServiceError(error).message;
      lastErrorToastRef.current = `${task.id}:${message}`;
      notify.error(localizeTaskErrorMessage(message, (key, options) => String(t(key, options))));
    } finally {
      setPendingTaskId((current) => (current === task.id ? null : current));
    }
  };

  function showArchivedCleanupNotification(saga: ArchivedTaskCleanupSaga): void {
    const target = saga.targets.find((candidate) => !candidate.worktreeRemoved || !candidate.branchRemoved)
      ?? saga.targets[0];
    if (!target) return;
    const isBranchOnly = target.worktreeRemoved && !target.branchRemoved;
    const isDirty = target.state === 'dirty' && !target.worktreeRemoved;
    const description = isBranchOnly
      ? t(
        'implement.archivedTaskBranchCleanupPendingDescription',
        'The worktree has already been removed, but Macro could not remove {{branch}}. The branch remains in {{path}}.',
        {
          branch: target.branchName,
          path: target.repoPath,
        },
      )
      : isDirty
      ? t(
        'implement.archivedTaskDirtyWorktreeDescription',
        'The task is archived, but {{branch}} still has local changes in {{path}}. Resolve them, then retry cleanup.',
        {
          branch: target.branchName,
          path: target.worktreePath || target.repoPath,
        },
      )
      : t(
        'implement.archivedTaskCleanupPendingDescription',
        'The task is archived, but Macro could not finish cleaning {{branch}}. The worktree was preserved at {{path}}.',
        {
          branch: target.branchName,
          path: target.worktreePath || target.repoPath,
        },
      );
    notify.actionRequired(
      t('implement.archivedTaskCleanupPending', 'Task archived, cleanup pending'),
      {
        notificationKey: `archived-task-cleanup:${saga.taskId}`,
        category: 'task_attention_required',
        tone: 'warning',
        duration: 12000,
        closeButton: true,
        description,
        actions: [
          ...(!target.worktreeRemoved && target.worktreePath
            ? [{
              label: t('implement.openWorktree', 'Open worktree'),
              variant: 'secondary' as const,
              onClick: () => {
                void openPath(target.worktreePath!).catch((error) => {
                  notify.error(
                    t('implement.openWorktreeFailed', 'Could not open the worktree'),
                    { description: toServiceError(error).message },
                  );
                });
              },
            }]
            : isBranchOnly
              ? [{
                label: t('implement.openRepository', 'Open repository'),
                variant: 'secondary' as const,
                onClick: () => {
                  void openPath(target.repoPath).catch((error) => {
                    notify.error(
                      t('implement.openRepositoryFailed', 'Could not open the repository'),
                      { description: toServiceError(error).message },
                    );
                  });
                },
              }]
              : []),
          {
            label: t('common.retry', 'Retry'),
            variant: 'primary' as const,
            onClick: () => {
              void cleanupArchivedTask(saga.taskId)
                .then((remaining) => {
                  if (remaining) {
                    showArchivedCleanupNotification(remaining);
                  } else {
                    notify.success(
                      t('implement.archivedTaskCleanupComplete', 'Worktree cleanup completed'),
                    );
                  }
                })
                .catch((error) => {
                  notify.error(toServiceError(error).message);
                });
            },
          },
        ],
      },
    );
  }

  const searchedTasks = useMemo(
    () => filterTasksByQuery(filteredTasks, searchQuery),
    [searchQuery, filteredTasks],
  );

  const draftTasks = useMemo(
    () => searchedTasks.filter((task) => task.draft),
    [searchedTasks]
  );

  const tasksByStatusGroup = useMemo(() => {
    const groups = groupTaskQueueLanes(searchedTasks, taskQueueStatusGroupById, true);
    Object.values(groups).forEach(group => group.sort((a, b) => {
      const byStatus = (readyStatusOrder[a.status] ?? Number.MAX_SAFE_INTEGER) - (readyStatusOrder[b.status] ?? Number.MAX_SAFE_INTEGER);
      return byStatus || a.sequence_index - b.sequence_index;
    }));
    return groups;
  }, [searchedTasks, taskQueueStatusGroupById]);

  const multiRepoPresentationByTaskId = useMemo(() => {
    const map = new Map<string, MultiRepoTaskPresentation | null>();
    searchedTasks.forEach((task) => {
      map.set(
        task.id,
        buildMultiRepoPresentation(
          task,
          reviewCurrentTaskId === task.id && reviewLoadState === 'ready' && !reviewIsLoading ? liveReviewSummary : null
        )
      );
    });
    return map;
  }, [buildMultiRepoPresentation, liveReviewSummary, reviewCurrentTaskId, reviewLoadState, reviewIsLoading, searchedTasks]);
  const taskListRows = useMemo<TaskListRow[]>(() => {
    const orderedTasks = [...draftTasks, ...TASK_QUEUE_LANES.flatMap(lane => tasksByStatusGroup[lane])];
    return orderedTasks.map(task => ({
      id: `task:${task.id}`,
      task,
      multiRepoPresentation: task.draft ? null : multiRepoPresentationByTaskId.get(task.id) ?? null,
    }));
  }, [draftTasks, multiRepoPresentationByTaskId, tasksByStatusGroup]);
  const getTaskListRowKey = useCallback((row: TaskListRow) => row.id, []);
  const {
    parentRef: taskListRef,
    virtualItems: virtualTaskRows,
    totalSize: taskListTotalSize,
    measureElement: measureTaskRow,
  } = useVirtualList({
    items: taskListRows,
    getItemKey: getTaskListRowKey,
    estimateSize: 96,
    overscan: 8,
    dynamicHeight: true,
    gap: 8,
  });

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

  const openPanelMenu = (event: React.MouseEvent<HTMLElement>) => {
    if (isSidebarTextInput(event.target)) return;
    event.preventDefault(); event.stopPropagation(); setPanelMenuPosition(sidebarMenuPosition(event));
  };
  const panelMenu = panelMenuPosition && <SidebarMenu position={panelMenuPosition} onClose={() => setPanelMenuPosition(null)} aria-label={t('implement.tasks', 'Tasks')} className="w-52">
        <button role="menuitem" type="button" disabled={Boolean(pendingTaskId) || editableProjectOptions.length === 0 || taskMutationDisabled || taskExecutionDisabled}
          onClick={() => { setPanelMenuPosition(null); setCreateTaskError(null); setShowCreateTaskDialog(true); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"><Icon name="plus" size={12} />{import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1' ? t('implement.launchWorkflow', 'Launch a workflow') : t('implement.createStandaloneTask', 'Créer une tâche indépendante')}</button>
        <button role="menuitem" type="button" onClick={() => { setPanelMenuPosition(null); openProjectNavigator(); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"><Icon name="settings" size={12} />{t('implement.manageProjects', 'Manage projects')}</button>
      </SidebarMenu>;

  const filterMenu = filterMenuPosition && <SidebarMenu position={filterMenuPosition} triggerRef={filterTriggerRef}
    onClose={() => setFilterMenuPosition(null)} aria-label={t('implement.taskFilters', 'Task filters')} className="w-64">
    {([
      ['archive', t('implement.archives', 'Archives'), showArchived, setImplementShowArchived],
      ['cpu', t('implement.tasksWithoutInteraction', 'Without interaction'), showWithoutInteraction, setImplementShowWithoutInteraction],
      ['lock', t('implement.blockedTasks', 'Blocked tasks'), showBlockedTasks, setImplementShowBlockedTasks],
    ] as const).map(([icon, label, checked, onChange]) => <button key={icon} role="menuitemcheckbox" aria-checked={checked} type="button"
      onClick={event => { onChange(!checked); event.currentTarget.focus(); }}
      className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-accent">
      <Icon name={icon} size={14} className="text-muted-foreground" /><span className="flex-1">{label}</span>
      <Icon name={checked ? 'check-square' : 'square'} size={14} className={checked ? 'text-primary' : 'text-muted-foreground'} />
    </button>)}
  </SidebarMenu>;

  if (isWorkspaceMissing) {
    return (
      <aside
        className={cn('h-full w-full bg-card border-r border-border flex items-center justify-center', className)}
        data-tour-id="implement-task-panel"
        onContextMenu={openPanelMenu}
      >
        {panelMenu}
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
      onContextMenu={openPanelMenu}
    >
      {panelMenu}
      {filterMenu}
      <div className="h-12 border-b border-border flex items-center justify-between gap-2 px-4">
        {isSearchOpen ? (
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('implement.searchTasks', 'Search tasks...')}
            className="h-8 min-w-0 flex-1 rounded-md py-1 focus-within:border-border focus-within:ring-0"
            showClear={false}
            inputAutoFocus
            data-tour-id="implement-task-search"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Icon name="list-todo" size={16} className="text-primary" />
            {t('implement.tasks', 'Tasks')}
          </h1>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <PanelHeaderIconButton
            icon={isSearchOpen ? 'x' : 'search'}
            label={isSearchOpen
              ? t('common.close', 'Close')
              : t('implement.searchTasks', 'Search tasks...')}
            pressed={isSearchOpen}
            className={isSearchOpen ? 'h-8 w-8' : undefined}
            onClick={() => {
              if (isSearchOpen) setSearchQuery('');
              setIsSearchOpen((current) => !current);
            }}
            data-tour-id="implement-search-toggle"
          />
          {!isSearchOpen && (
            <>
          <PanelHeaderIconButton
            icon="plus"
            onClick={() => { setCreateTaskError(null); setShowCreateTaskDialog(true); }}
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
                    : import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1'
                      ? t('implement.launchWorkflow', 'Launch a workflow')
                      : t('implement.createStandaloneTask', 'Créer une tâche indépendante')
            }
          />
          <PanelHeaderIconButton
            ref={filterTriggerRef}
            icon="list-filter"
            label={t('implement.taskFilters', 'Task filters')}
            pressed={showArchived || showBlockedTasks || !showWithoutInteraction}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setFilterMenuPosition(current => current ? null : { left: rect.right - 256, top: rect.bottom + 4 }); }}
            aria-haspopup="menu" aria-expanded={Boolean(filterMenuPosition)}
            data-tour-id="implement-task-filters"
          />
            </>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border">
        <TaskProjectFilter
          projects={projectFilterOptions}
          selectedProjectId={projectFilter === ALL_PROJECTS_FILTER ? null : projectFilter}
          totalTaskCount={totalActiveTaskCount}
          onSelect={(projectId) => {
            setImplementProjectFilter(projectId || ALL_PROJECTS_FILTER);
          }}
        />

        <div
            className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,6.5rem),1fr))] gap-1.5"
            aria-label={t('implement.taskStatusSummary', 'Task status summary')}
          >
            {([
              ['ready', t('implement.queueToLaunch', 'To launch'), statusCounts.ready, 'bg-muted-foreground'],
              ['waiting', t('implement.queueWaiting', 'Waiting'), statusCounts.waiting, 'bg-amber-400'],
              ['in_progress', t('implement.queueInProgress', 'In progress'), statusCounts.in_progress, 'bg-sky-400'],
              ['completed', t('implement.queueCompleted', 'Completed'), statusCounts.completed, 'bg-emerald-500'],
            ] as const).map(([filter, label, count, dotClassName]) => (
              <button
                key={filter}
                type="button"
                onClick={() => setImplementStatusFilter(statusFilter === filter ? 'all' : filter)}
                aria-pressed={statusFilter === filter}
                title={label}
                className={cn(
                  'flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
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
          </div>
      </div>

      {executionGraphTask && (
        <React.Suspense fallback={null}>
          <TaskExecutionGraphDialog
            task={executionGraphTask}
            onClose={() => setExecutionGraphTask(null)}
          />
        </React.Suspense>
      )}

      {showCreateTaskDialog && (
        <React.Suspense fallback={null}>
          {import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1' ? (
            <DemoBlueprintLaunchDialog
              projects={projectFilterOptions}
              onClose={() => setShowCreateTaskDialog(false)}
            />
          ) : (
            <CreateImplementTaskDialog
              projects={projectFilterOptions}
              initialProjectId={null}
              isCreating={Boolean(pendingTaskId)}
              creationError={createTaskError}
              onClose={() => {
                if (!pendingTaskId) setShowCreateTaskDialog(false);
              }}
              onCreate={(input) => void handleCreateManualFeature(input)}
            />
          )}
        </React.Suspense>
      )}

      <div ref={taskListRef} className="flex-1 overflow-y-auto">
        {searchedTasks.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-2 text-center">
            <Icon
              name={searchQuery.trim() ? 'search' : 'check-circle'}
              size={32}
              className="text-muted-foreground/50 mb-3"
            />
            <p className="text-sm text-muted-foreground">
              {searchQuery.trim()
                ? t('implement.noSearchResults', 'No task matches this search.')
                : projectFilter === ALL_PROJECTS_FILTER && statusFilter === 'all'
                ? t('implement.noTasks', 'No tasks yet')
                : t('implement.noTasksForFilter', 'No task matches this filter.')}
            </p>
          </div>
        )}

        {searchedTasks.length > 0 && (
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
                    <MemoizedTaskItem
                      task={row.task}
                      mergeWorkflowRuntime={mergeWorkflowRuntimeByTaskId[row.task.id] ?? null}
                      multiRepoPresentation={row.multiRepoPresentation}
                      attention={attentionByTaskId.get(row.task.id)}
                      hasResolvedUserRequest={resolvedWaitTaskIds.has(row.task.id)}
                      isSelected={selectedTaskId === row.task.id}
                      project={getProjectById(row.task.project_id) ?? null}
                      planLabel={getTaskPlanLabel(row.task)}
                      planKind={planKindsById.get(row.task.plan_id) ?? null}
                      isAssistantRunning={runningTaskIds.has(row.task.id)}
                      taskCommandRunStatus={taskCommandRuns[row.task.id]?.status ?? null}
                      canRunTaskCommands={canRunTaskCommandsForTask(row.task)}
                      showRunTaskCommands={!isPlanFinalizationTask(row.task)}
                      runTaskCommandsTitle={getRunTaskCommandsTitle(row.task)}
                      onSelect={() => {
                        const attention = attentionByTaskId.get(row.task.id);
                        void activateTask(row.task.id).then(async () => {
                          if (attention?.conversationId &&
                            useAppStore.getState().mode === 'Implement' &&
                            useAppStore.getState().selectedTaskId === row.task.id) {
                            await selectConversation(attention.conversationId);
                          }
                        });
                      }}
                      onRunTaskCommands={() => void handleRunTaskCommands(row.task)}
                      onCancelTaskCommands={() => void cancelTaskCommands(row.task.id)}
                      actions={buildTaskActions(row.task)}
                      onAction={(action) => void handleTaskAction(row.task, action)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {diagnostic && (
        <React.Suspense fallback={null}>
          <WorktreeDiagnosticsDialog
            entries={diagnostic.entries}
            repairDisabled={taskMutationDisabled || runningTaskIds.has(diagnostic.task.id) || tasks.some((task) => task.id === diagnostic.task.id && (task.status === 'InProgress' || task.status === 'AwaitingResponse')) || Boolean(diagnostic.task.archived_at)}
            onClose={() => setDiagnostic(null)}
          />
        </React.Suspense>
      )}
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
                  'Archive this task and keep its conversation history. Macro will remove a clean worktree and preserve it if cleanup needs attention.'
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
                    const pendingCleanup = useTaskStore.getState()
                      .archivedTaskCleanupByTaskId[confirmTarget.task.id];
                    if (pendingCleanup) {
                      showArchivedCleanupNotification(pendingCleanup);
                    }
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
