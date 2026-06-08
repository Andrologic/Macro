import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { getPlanActivationCandidateTask, useTaskStore } from '../../stores/useTaskStore';
import {
  getGitFlowBaseBranch,
  resolveTargetBranch,
  type ArchitectPlanRecord,
} from '../../services/architectPlanService';
import {
  listPlanArtifactOverview,
  type PlanArtifactOverview,
} from '../../services/architectPlanArtifactService';
import { persistArchitectPlanStrategyPreview } from '../../services/architectPlanRuntimeService';
import { validatePlanAndProvisionBranches } from '../../services/architectGitFlowService';
import { getScopedProjectIds } from '../../services/globalProjects';
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from '../../services/projectWorkspaceState';
import { normalizeNodeProjectIds } from '../../services/implementTaskDerivation';
import {
  applyStrategyMutationPreview,
  buildFrozenPlanNodeMap,
  type FrozenPlanNode,
} from '../../services/architectStrategyMutationGuard';
import {
  getPlanNodeLogicalBranchIdentity,
  getPredictedBranchLogicalIdentity,
} from '../../services/architectBranchIdentity';
import {
  mapPlanNodeStatusToTaskStatus,
  resolvePlanNodeStatusIndicatorState,
  resolveRunningTaskIds,
  type TaskStatusIndicatorState,
} from '../../services/taskStatusPresentation';
import {
  resolvePlanNodeTodoPresentation,
} from '../../services/planNodeTodos';
import {
  buildPlanFinalizationTaskId,
  buildPlanFinalizationTaskTitle,
  derivePlanFinalizationDependencyState,
  isPlanFinalizationTaskId,
  PLAN_FINALIZATION_TASK_DESCRIPTION,
} from '../../services/planFinalization';
import { notify } from '../ui/toastService';
import { Icon } from '../ui/Icon';
import { TaskStatusIndicator } from '../tasks/TaskStatusIndicator';
import { TodoStatusIcon } from '../tasks/TodoStatusIcon';
import { Skeleton } from '../shared/Skeleton';
import { ProjectWorkspaceEmptyState } from '../shared/ProjectWorkspaceEmptyState';
import { ArtifactDiffModal } from '../modals/ArtifactDiffModal';
import { cn } from '../../utils/cn';
import { useElementSize } from '../../hooks/useElementSize';
import type { PlanNode, PlanNodeStatus, PredictedBranch, ProjectGroup, TaskStatus } from '../../types';
import {
  isCanonicalArchitectPlan,
  isDefaultNewPlanFamilyLabel,
} from '../../services/architectPlanPresentation';

interface StrategyGraphProps {
  className?: string;
}

/**
 * StrategyGraph - Visualizes project strategy as a graph or branch view
 * 
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Architect mode is active
 * Contains complex SVG rendering that benefits from code splitting
 */

const taskStatusColors: Record<TaskStatus, string> = {
  Pending: 'text-muted-foreground',
  InProgress: 'text-amber-500',
  AwaitingResponse: 'text-amber-500',
  InReview: 'text-sky-500',
  Completed: 'text-white',
  Failed: 'text-red-500',
  Blocked: 'text-red-500',
};

const taskStatusBgColors: Record<TaskStatus, string> = {
  Pending: 'bg-muted',
  InProgress: 'bg-amber-500/20',
  AwaitingResponse: 'bg-amber-500/20',
  InReview: 'bg-sky-500/20',
  Completed: 'bg-emerald-500',
  Failed: 'bg-red-500/20',
  Blocked: 'bg-red-500/20',
};

const frozenReasonTone: Record<
  FrozenPlanNode['reason'],
  { pill: string }
> = {
  started: {
    pill: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  },
  completed: {
    pill: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  },
  dependency_locked: {
    pill: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  },
};

const lockedBadgeTone =
  'border-border bg-background/80 text-foreground';

const NODE_RADIUS = 16;
const PADDING_TOP = 60;
const LEFT_MARGIN = 40;
const ROW_HEIGHT = 70;
const MIN_COL_WIDTH = 100;
const MAX_COL_WIDTH = 250;
const INLINE_HORIZONTAL_PADDING = 20;
const MIN_MODAL_ZOOM = 0.25;
const MAX_MODAL_ZOOM = 3;
const MODAL_PAN_PADDING = 96;

type GraphTransform = {
  x: number;
  y: number;
  scale: number;
};

type FrozenBadgeTooltipState = {
  reason: FrozenPlanNode['reason'];
  rect: DOMRect;
};

type BranchCardStatus = 'pending' | 'active' | 'merged' | 'mixed';

interface BranchTaskView extends PlanNode {
  rank?: number;
}

interface BranchTodoView {
  id: string;
  taskId: string;
  taskTitle: string;
  title: string;
  description?: string;
  status: 'pending' | 'in-progress' | 'done';
}

const IDLE_ARCHITECT_PLAN_SWITCH = {
  requestId: 0,
  targetPlanId: null,
  targetBranch: null,
  status: 'idle' as const,
  startedAt: null,
  summaryHint: null,
  errorMessage: null,
};

interface BranchCardView {
  id: string;
  name: string;
  color: string;
  status: BranchCardStatus;
  progressDone: number;
  progressTotal: number;
  tasks: BranchTaskView[];
  todos: BranchTodoView[];
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const mixedBranchCardColor = 'rgb(var(--muted-foreground))';
const branchCardTaskStatusOrder: Record<PlanNodeStatus, number> = {
  'in-progress': 0,
  pending: 1,
  blocked: 2,
  completed: 3,
};
const branchCardStatusTone: Record<BranchCardStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  active: 'bg-amber-500/10 text-amber-500',
  merged: 'bg-emerald-500/10 text-emerald-500',
  mixed: 'bg-muted text-muted-foreground',
};

type GroupedBranchCardSource = PredictedBranch & {
  logicalLabel: string;
};

const getBranchCardLabel = (
  branch: Pick<PredictedBranch, 'name' | 'branchSlug'>
): string => {
  const explicitSlug = branch.branchSlug?.trim();
  if (explicitSlug) {
    return explicitSlug;
  }

  const segments = branch.name
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments[segments.length - 1] ?? branch.name;
};

const getLogicalBranchLabel = (params: {
  planSlug?: string | null;
  node?: Pick<PlanNode, 'id' | 'assignedBranch' | 'branchSlug' | 'title'>;
  branch?: Pick<PredictedBranch, 'name' | 'branchSlug'>;
}): string => {
  if (params.node && isPlanFinalizationTaskId(params.node.id)) {
    return params.node.assignedBranch?.trim() || 'target';
  }

  if (params.node && params.planSlug?.trim()) {
    const identity = getPlanNodeLogicalBranchIdentity({
      planSlug: params.planSlug,
      node: params.node,
    });
    return identity.kind === 'plan_feature'
      ? identity.featureSlug
      : params.node.branchSlug?.trim() || params.node.assignedBranch?.trim() || 'work';
  }

  if (params.branch) {
    const identity = getPredictedBranchLogicalIdentity({
      planSlug: params.planSlug,
      branch: params.branch,
    });
    if (identity.kind === 'plan_feature') {
      return identity.featureSlug;
    }
    if (identity.kind === 'standalone_feature') {
      return identity.featureSlug;
    }
  }

  if (params.branch) {
    return getBranchCardLabel(params.branch);
  }

  if (params.node?.branchSlug?.trim()) {
    return params.node.branchSlug.trim();
  }

  return params.node?.assignedBranch?.trim() || 'work';
};

const nodeMatchesProjectId = (node: Pick<PlanNode, 'projectId' | 'projectIds'>, projectId: string): boolean => {
  const projectIds = normalizeNodeProjectIds(node);
  return projectIds.length === 0 || projectIds.includes(projectId);
};

const buildSyntheticPlanFinalizationNode = (params: {
  activePlanContext: {
    id: string;
    title: string;
    label?: string | null;
    status: string;
    targetBranch: string;
  } | null;
  nodes: PlanNode[];
}): PlanNode | null => {
  if (!params.activePlanContext || params.nodes.length === 0) {
    return null;
  }

  const dependencyState = derivePlanFinalizationDependencyState(params.nodes);
  if (dependencyState.terminalNodeIds.length === 0) {
    return null;
  }

  const projectIds = Array.from(
    new Set(params.nodes.flatMap((node) => normalizeNodeProjectIds(node))),
  );
  const isCompletedPlan = params.activePlanContext.status === 'completed';

  return {
    id: buildPlanFinalizationTaskId(params.activePlanContext.id),
    title: buildPlanFinalizationTaskTitle(params.activePlanContext),
    description: PLAN_FINALIZATION_TASK_DESCRIPTION,
    type: 'milestone',
    status: isCompletedPlan ? 'completed' : dependencyState.isComplete ? 'pending' : 'blocked',
    dependencies: dependencyState.terminalNodeIds,
    assignedBranch: params.activePlanContext.targetBranch,
    projectId: projectIds[0],
    projectIds,
  };
};

const getProjectGitFlowSettingsFromGroups = (
  projectGroups: ProjectGroup[],
  projectId: string,
) =>
  projectGroups
    .flatMap((group) => group.projects)
    .find((project) => project.id === projectId)?.gitFlowSettings;

const filterPredictedBranchesForScopedNodes = (
  branches: PredictedBranch[],
  scopedNodeIds: Set<string>,
): PredictedBranch[] =>
  branches
    .map((branch) => ({
      ...branch,
      taskIds: branch.taskIds.filter((taskId) => scopedNodeIds.has(taskId)),
    }))
    .filter((branch) => branch.taskIds.length > 0);

const getBranchCardGroupIdentity = (params: {
  activePlanSlug?: string | null;
  branch: PredictedBranch;
  projectGroups: ProjectGroup[];
}): {
  key: string;
  logicalLabel: string;
} => {
  if (params.branch.taskIds.length !== 1) {
    return {
      key: `legacy::${params.branch.projectId}::${params.branch.id}`,
      logicalLabel: getBranchCardLabel(params.branch),
    };
  }

  const projectSettings = params.branch.projectId
    ? getProjectGitFlowSettingsFromGroups(params.projectGroups, params.branch.projectId)
    : undefined;
  const logicalIdentity = getPredictedBranchLogicalIdentity({
    planSlug: params.activePlanSlug,
    branch: params.branch,
    settings: projectSettings,
  });

  if (logicalIdentity.kind === 'plan_feature') {
    return {
      key: logicalIdentity.key,
      logicalLabel: logicalIdentity.featureSlug,
    };
  }

  if (logicalIdentity.kind === 'standalone_feature') {
    return {
      key: logicalIdentity.key,
      logicalLabel: logicalIdentity.featureSlug,
    };
  }

  return {
    key: `git::${params.branch.name}`,
    logicalLabel: getBranchCardLabel(params.branch),
  };
};

const buildBranchCards = (params: {
  activePlanSlug?: string | null;
  branchSearch: string;
  branchStatusFilter: 'all' | PlanNodeStatus;
  predictedBranches: PredictedBranch[];
  projectGroups: ProjectGroup[];
  scopedNodeById: Map<string, BranchTaskView>;
}): BranchCardView[] => {
  const normalizedSearch = params.branchSearch.trim().toLowerCase();
  const groupedBranches = new Map<string, GroupedBranchCardSource[]>();

  params.predictedBranches.forEach((branch) => {
    const identity = getBranchCardGroupIdentity({
      activePlanSlug: params.activePlanSlug,
      branch,
      projectGroups: params.projectGroups,
    });
    const groupedBranch: GroupedBranchCardSource = {
      ...branch,
      logicalLabel: identity.logicalLabel,
    };
    const existing = groupedBranches.get(identity.key);
    if (existing) {
      existing.push(groupedBranch);
      return;
    }
    groupedBranches.set(identity.key, [groupedBranch]);
  });

  return Array.from(groupedBranches.entries())
    .map(([branchKey, branches]) => {
      const mergedTaskIds = Array.from(
        new Set(branches.flatMap((branch) => branch.taskIds)),
      );
      const allTasks = mergedTaskIds.reduce<BranchTaskView[]>((acc, taskId) => {
        const task = params.scopedNodeById.get(taskId);
        if (!task) return acc;
        acc.push({ ...task });
        return acc;
      }, []);
      const branchStatuses = Array.from(
        new Set(branches.map((branch) => branch.status)),
      );
      const cardStatus: BranchCardStatus =
        branchStatuses.length === 1 ? branchStatuses[0] : 'mixed';
      const filteredTasks = allTasks
        .filter((task) => {
          if (
            params.branchStatusFilter !== 'all' &&
            task.status !== params.branchStatusFilter
          ) {
            return false;
          }
          if (!normalizedSearch) {
            return true;
          }
          const haystack = `${task.title} ${task.description || ''}`.toLowerCase();
          return haystack.includes(normalizedSearch);
        })
        .sort((a, b) => {
          if (branchCardTaskStatusOrder[a.status] !== branchCardTaskStatusOrder[b.status]) {
            return branchCardTaskStatusOrder[a.status] - branchCardTaskStatusOrder[b.status];
          }
          if ((a.rank ?? 0) !== (b.rank ?? 0)) {
            return (a.rank ?? 0) - (b.rank ?? 0);
          }
          return a.title.localeCompare(b.title);
        });
      const todos = filteredTasks.flatMap<BranchTodoView>((task) =>
        resolvePlanNodeTodoPresentation(task).todos.map((todo) => ({
          ...todo,
          id: `${task.id}:${todo.id}`,
          taskId: task.id,
          taskTitle: task.title,
        }))
      );
      const progress = resolvePlanNodeTodoPresentation(todos).progress;
      const singleTask = allTasks.length === 1 ? allTasks[0] : null;

      return {
        id: `branch-card::${branchKey}`,
        name:
          singleTask?.title ||
          branches[0]?.logicalLabel ||
          getBranchCardLabel(branches[0] || { name: branchKey }),
        color:
          cardStatus === 'mixed'
            ? mixedBranchCardColor
            : branches[0]?.color || mixedBranchCardColor,
        status: cardStatus,
        progressDone: progress.done,
        progressTotal: progress.total,
        tasks: filteredTasks,
        todos,
      };
    })
    .filter(
      (branch) => branch.tasks.length > 0 || params.branchSearch.trim().length === 0,
    );
};

const getArtifactContractItems = (
  node: Pick<PlanNode, 'artifactContracts'> | null | undefined,
) =>
  (node?.artifactContracts || []).filter(
    (contract) => contract.title.trim().length > 0,
  );

// Base component - wrapped with React.memo below for performance
const StrategyGraphBase: React.FC<StrategyGraphProps> = ({ className }) => {
  const { t } = useTranslation();
  const {
    selectedGroupId,
    selectedProjectId,
    selectedTaskId,
    standaloneProjects,
    projectGroups,
    planNodes,
    predictedBranches,
    activePlanContext,
    strategyMutationPreview,
    setActivePlanContext,
    setPlanNodes,
    setPredictedBranches,
    setStrategyMutationPreview,
    setMode,
    architectPlanSwitch,
  } = useAppStore(
    useShallow((state) => ({
      selectedGroupId: state.selectedGroupId,
      selectedProjectId: state.selectedProjectId,
      selectedTaskId: state.selectedTaskId,
      standaloneProjects: state.standaloneProjects ?? [],
      projectGroups: state.projectGroups,
      planNodes: state.planNodes,
      predictedBranches: state.predictedBranches,
      activePlanContext: state.activePlanContext,
      strategyMutationPreview: state.strategyMutationPreview,
      setActivePlanContext: state.setActivePlanContext,
      setPlanNodes: state.setPlanNodes,
      setPredictedBranches: state.setPredictedBranches,
      setStrategyMutationPreview: state.setStrategyMutationPreview,
      setMode: state.setMode,
      architectPlanSwitch:
        state.architectPlanSwitch ?? IDLE_ARCHITECT_PLAN_SWITCH,
    }))
  );
  const {
    conversations,
    selectedConversationId,
    conversationRuntimeById,
    conversationCompactionStatusById,
  } = useChatStore(
    useShallow((state) => ({
      conversations: state.conversations,
      selectedConversationId: state.selectedConversationId,
      conversationRuntimeById: state.conversationRuntimeById,
      conversationCompactionStatusById: state.conversationCompactionStatusById,
    }))
  );
  const tasks = useTaskStore((state) => state.tasks);
  const needs = useNeedsStore((state) => state.needs);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredNodeRect, setHoveredNodeRect] = useState<DOMRect | null>(null);
  const [hoveredFrozenBadge, setHoveredFrozenBadge] = useState<FrozenBadgeTooltipState | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'branches'>('graph');
  const [branchSearch, setBranchSearch] = useState('');
  const [branchStatusFilter, setBranchStatusFilter] = useState<'all' | PlanNodeStatus>('all');
  const workspaceState = useMemo(
    () =>
      resolveProjectWorkspaceState({
        standaloneProjects,
        projectGroups,
        selectedGroupId,
        selectedProjectId,
      }),
    [projectGroups, selectedGroupId, selectedProjectId, standaloneProjects]
  );
  const projectRegistry = useMemo(
    () => ({ standaloneProjects, projectGroups }),
    [projectGroups, standaloneProjects]
  );
  const isWorkspaceMissing = isProjectWorkspaceMissing(workspaceState);
  const activePlanNeeds = useMemo(() => {
    if (!activePlanContext?.id) return [];
    return needs.filter((need) => need.planId === activePlanContext.id);
  }, [activePlanContext?.id, needs]);
  const emptyStrategyDescription = useMemo(() => {
    if (activePlanNeeds.length === 0) {
      return t(
        'architect.noStrategyNeedsMissingDescription',
        'Identify and validate needs before generating the strategy.'
      );
    }
    if (activePlanNeeds.some((need) => need.status !== 'validated')) {
      return t(
        'architect.noStrategyNeedsUnvalidatedDescription',
        'Clarify needs if useful, or generate the strategy now.'
      );
    }
    return t(
      'architect.noStrategyReadyDescription',
      'The needs are ready. Generate the strategy when you want Macro to create the task graph.'
    );
  }, [activePlanNeeds, t]);
  const [isValidating, setIsValidating] = useState(false);
  const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
  const [isPlanArtifactsOpen, setIsPlanArtifactsOpen] = useState(false);
  const [selectedPlanArtifactId, setSelectedPlanArtifactId] = useState<string | null>(null);
  const [planArtifactOverview, setPlanArtifactOverview] = useState<PlanArtifactOverview | null>(null);
  const [isModalPanning, setIsModalPanning] = useState(false);
  const [hasInitializedModalView, setHasInitializedModalView] = useState(false);
  const [modalTransform, setModalTransform] = useState<GraphTransform>({ x: 0, y: 0, scale: 1 });
  const { ref: containerRef, width: containerWidth, height: containerHeight } = useElementSize<HTMLDivElement>();
  const { ref: modalViewportRef, width: modalViewportWidth, height: modalViewportHeight } = useElementSize<HTMLDivElement>();
  const modalOpenedAtRef = useRef(0);
  const modalPanStateRef = useRef<{ pointerId: number | null; startX: number; startY: number; originX: number; originY: number }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  });
  const isResolvingActivePlan =
    architectPlanSwitch.status === 'resolving' &&
    architectPlanSwitch.targetPlanId === activePlanContext?.id;
  const isResolvingBlankPlan = Boolean(
    architectPlanSwitch.summaryHint &&
      isCanonicalArchitectPlan(architectPlanSwitch.summaryHint) &&
      isDefaultNewPlanFamilyLabel(architectPlanSwitch.summaryHint.label) &&
      architectPlanSwitch.summaryHint.nodeCount === 0 &&
      (architectPlanSwitch.summaryHint.predictedBranchCount ?? 0) === 0 &&
      (architectPlanSwitch.summaryHint.needCount ?? 0) === 0 &&
      (architectPlanSwitch.summaryHint.chatMessageCount ?? 0) === 0 &&
      !architectPlanSwitch.summaryHint.conversationId
  );
  const showResolvingSkeleton = isResolvingActivePlan && !isResolvingBlankPlan;
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
  const taskStatusById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task.status])),
    [tasks]
  );
  const activeStrategyMutationPreview = useMemo(
    () =>
      strategyMutationPreview &&
      activePlanContext &&
      strategyMutationPreview.planId === activePlanContext.id
        ? strategyMutationPreview
        : null,
    [activePlanContext, strategyMutationPreview]
  );
  const activePlanId = activePlanContext?.id ?? null;
  const activePlanTargetBranch = activePlanContext?.targetBranch ?? null;
  const frozenNodeById = useMemo<Map<string, FrozenPlanNode>>(() => {
    if (!activePlanId) {
      return new Map<string, FrozenPlanNode>();
    }
    return buildFrozenPlanNodeMap({
      plan: {
        id: activePlanId,
        nodes: planNodes,
      },
      tasks: tasks.map((task) => ({
        id: task.id,
        plan_id: task.plan_id,
        status: task.status,
      })),
    });
  }, [activePlanId, planNodes, tasks]);

  const targetBranch = useMemo(() => {
    if (activePlanTargetBranch) {
      try {
        return resolveTargetBranch(activePlanTargetBranch);
      } catch {
        return getGitFlowBaseBranch();
      }
    }

    return getGitFlowBaseBranch();
  }, [activePlanTargetBranch]);

  const activePlanArtifactRecord = useMemo<ArchitectPlanRecord | null>(() => {
    if (!activePlanContext) {
      return null;
    }

    const scopedProjectIds = getScopedProjectIds(projectRegistry, selectedGroupId, selectedProjectId);
    const nodeProjectIds = planNodes.flatMap((node) => normalizeNodeProjectIds(node));
    const branchProjectIds = predictedBranches
      .map((branch) => branch.projectId)
      .filter((projectId): projectId is string => typeof projectId === 'string' && projectId.trim().length > 0);
    const projectIds = Array.from(new Set([
      ...(scopedProjectIds.length > 0 ? scopedProjectIds : []),
      ...nodeProjectIds,
      ...branchProjectIds,
    ]));

    return {
      id: activePlanContext.id,
      slug: activePlanContext.slug?.trim() || activePlanContext.title?.trim() || activePlanContext.id,
      title: activePlanContext.title || activePlanContext.id,
      label: activePlanContext.label,
      description: activePlanContext.description || '',
      status: activePlanContext.status as ArchitectPlanRecord['status'],
      targetBranch,
      targetBranchesByProjectId: activePlanContext.targetBranchesByProjectId,
      projectIds,
      createdAt: '',
      updatedAt: '',
      nodes: planNodes,
      predictedBranches,
    };
  }, [
    activePlanContext,
    planNodes,
    predictedBranches,
    projectRegistry,
    selectedGroupId,
    selectedProjectId,
    targetBranch,
  ]);

  useEffect(() => {
    let disposed = false;
    setIsPlanArtifactsOpen(false);
    setSelectedPlanArtifactId(null);
    setPlanArtifactOverview(null);

    if (!activePlanArtifactRecord) {
      return () => {
        disposed = true;
      };
    }

    void listPlanArtifactOverview({
      branchName: targetBranch,
      plan: activePlanArtifactRecord,
    })
      .then((overview) => {
        if (!disposed) {
          setPlanArtifactOverview(overview);
        }
      })
      .catch(() => {
        if (!disposed) {
          setPlanArtifactOverview(null);
        }
      });

    return () => {
      disposed = true;
    };
  }, [activePlanArtifactRecord, targetBranch]);

  const producedPlanArtifactCount = planArtifactOverview?.entries.length ?? 0;
  const hasPlanArtifactPlaceholders = (planArtifactOverview?.expected.length ?? 0) > 0;
  const canOpenPlanArtifacts = Boolean(
    activePlanArtifactRecord &&
      planArtifactOverview &&
      (producedPlanArtifactCount > 0 || hasPlanArtifactPlaceholders)
  );
  const openPlanArtifacts = useCallback(() => {
    if (!planArtifactOverview || !activePlanArtifactRecord) {
      return;
    }
    setSelectedPlanArtifactId(planArtifactOverview.entries[0]?.artifact.id ?? null);
    setIsPlanArtifactsOpen(true);
  }, [activePlanArtifactRecord, planArtifactOverview]);

  const planArtifactsButton = canOpenPlanArtifacts ? (
    <button
      type="button"
      onClick={openPlanArtifacts}
      className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={t('architect.openArtifacts', 'Open artifacts')}
      aria-label={t('architect.openArtifacts', 'Open artifacts')}
    >
      <Icon name="file-text" size={14} className="text-primary" />
      <span>{t('architect.artifacts', 'Artifacts')}</span>
      {producedPlanArtifactCount > 0 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          {producedPlanArtifactCount}
        </span>
      )}
    </button>
  ) : null;

  const getFrozenReasonLabel = useCallback(
    (reason: FrozenPlanNode['reason']): string => {
      switch (reason) {
        case 'completed':
          return t('architect.frozenReasonCompleted', 'Completed work');
        case 'dependency_locked':
          return t('architect.frozenReasonDependencyLocked', 'Locked dependency');
        default:
          return t('architect.frozenReasonStarted', 'Started work');
      }
    },
    [t]
  );

  const getFrozenReasonTooltipDescription = useCallback(
    (reason: FrozenPlanNode['reason']): string => {
      switch (reason) {
        case 'completed':
          return t(
            'architect.frozenReasonCompletedTooltip',
            'This task is already completed and can no longer be modified automatically.'
          );
        case 'dependency_locked':
          return t(
            'architect.frozenReasonDependencyLockedTooltip',
            'This dependency is locked because started or completed work already depends on it.'
          );
        default:
          return t(
            'architect.frozenReasonStartedTooltip',
            'This task has already been started and can no longer be modified automatically.'
          );
      }
    },
    [t]
  );

  const showFrozenBadgeTooltip = useCallback(
    (reason: FrozenPlanNode['reason'], element: HTMLElement) => {
      setHoveredFrozenBadge({
        reason,
        rect: element.getBoundingClientRect(),
      });
    },
    []
  );

  const hideFrozenBadgeTooltip = useCallback(() => {
    setHoveredFrozenBadge(null);
  }, []);

  const renderArtifactContractsSection = useCallback(
    (
      node: Pick<PlanNode, 'artifactContracts'> | null | undefined,
      options: { withTopBorder?: boolean } = {},
    ) => {
      const contracts = getArtifactContractItems(node);
      if (contracts.length === 0) {
        return null;
      }

      return (
        <div
          className={cn(
            'space-y-1.5',
            options.withTopBorder && 'mt-3 border-t border-border/50 pt-2'
          )}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('architect.expectedArtifacts', 'Expected artifacts')}
          </div>
          <ul className="space-y-1">
            {contracts.map((contract) => (
              <li
                key={contract.id}
                className="grid grid-cols-[4px_minmax(0,1fr)] gap-x-1.5 text-[11px] leading-relaxed text-foreground"
              >
                <span
                  aria-hidden="true"
                  className="mt-[0.6em] h-1 w-1 rounded-full bg-muted-foreground/70"
                />
                <span>{contract.title}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    },
    [t]
  );

  useEffect(() => {
    if (viewMode !== 'branches' && hoveredFrozenBadge) {
      setHoveredFrozenBadge(null);
    }
  }, [hoveredFrozenBadge, viewMode]);

  const handleDiscardStrategyPreview = useCallback(() => {
    setStrategyMutationPreview(null);
    if (activePlanContext?.id) {
      const projectIds = Array.from(
        new Set([
          ...planNodes.flatMap((node) => normalizeNodeProjectIds(node)),
          ...predictedBranches.map((branch) => branch.projectId),
        ])
      );
      void persistArchitectPlanStrategyPreview({
        branchName: targetBranch,
        plan: {
          id: activePlanContext.id,
          projectId: projectIds[0],
          projectIds,
        },
        preview: null,
      });
    }
  }, [
    activePlanContext,
    planNodes,
    predictedBranches,
    setStrategyMutationPreview,
    targetBranch,
  ]);

  const handleApplyStrategyPreview = useCallback(async () => {
    if (!activeStrategyMutationPreview || !activePlanContext) return;
    try {
      const updatedPlan = await applyStrategyMutationPreview({
        preview: activeStrategyMutationPreview,
        setActive: true,
      });
      setPlanNodes(updatedPlan.nodes || []);
      setPredictedBranches(updatedPlan.predictedBranches || []);
      setActivePlanContext({
        id: updatedPlan.id,
        slug: updatedPlan.slug,
        title: updatedPlan.title,
        label: updatedPlan.label,
        description: updatedPlan.description,
        status: updatedPlan.status,
        targetBranch: updatedPlan.targetBranch,
        targetBranchesByProjectId: updatedPlan.targetBranchesByProjectId,
        hasMixedTargetBranches:
          Boolean(updatedPlan.targetBranchesByProjectId) &&
          new Set(Object.values(updatedPlan.targetBranchesByProjectId || {})).size > 1,
      });
      setStrategyMutationPreview(null);
      await persistArchitectPlanStrategyPreview({
        branchName: targetBranch,
        plan: updatedPlan,
        preview: null,
      });
      await useTaskStore.getState().refreshFromPlan();
      notify.success(
        activeStrategyMutationPreview.autoProvisionBranches
          ? 'Strategy applied and plan branches synced.'
          : 'Strategy applied successfully.'
      );
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Failed to apply strategy preview.');
    }
  }, [
    activePlanContext,
    activeStrategyMutationPreview,
    setActivePlanContext,
    setPlanNodes,
    setPredictedBranches,
    setStrategyMutationPreview,
    targetBranch,
  ]);

  const handleValidatePlan = async () => {
    if (!activePlanContext || isValidating) return;
    setIsValidating(true);
    try {
      const { plan, provision } = await validatePlanAndProvisionBranches({
        branchName: targetBranch,
        planId: activePlanContext.id,
      });
      setPlanNodes(plan.nodes || []);
      setPredictedBranches(plan.predictedBranches || []);
      setActivePlanContext({ ...activePlanContext, status: 'validated' });
      await useTaskStore.getState().refreshFromPlan();

      const scopedProjectIds = getScopedProjectIds(projectRegistry, selectedGroupId, selectedProjectId);
      const activationCandidateTask = getPlanActivationCandidateTask(
        useTaskStore.getState().tasks,
        plan.id,
        scopedProjectIds
      );

      setMode('Implement');
      if (activationCandidateTask) {
        await useTaskStore.getState().activateTask(activationCandidateTask.id);
      }

      const createdCount = (provision.createdPlanBranch ? 1 : 0) + provision.createdFeatureBranches.length;
      notify.success(
        createdCount > 0
          ? `Plan validated — ${createdCount} branch${createdCount > 1 ? 'es' : ''} provisioned.`
          : 'Plan validated — branches already up to date.'
      );
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Failed to validate plan.');
    } finally {
      setIsValidating(false);
    }
  };

  const activePlanSlug =
    activePlanContext?.slug?.trim() ||
    activePlanContext?.title?.trim() ||
    null;

  // 1. Calculate Layout
  const layoutData = useMemo(() => {
    if (showResolvingSkeleton) {
      return { nodes: [], edges: [], width: 0, height: 0, branches: [], laneHeaders: [], colWidth: 140, effectiveLeftPadding: 0 };
    }

    const scopedProjectIds = getScopedProjectIds(projectRegistry, selectedGroupId, selectedProjectId);
    const scopedNodes =
      scopedProjectIds.length > 0
        ? planNodes.filter((node: PlanNode) =>
            scopedProjectIds.some((projectId) => nodeMatchesProjectId(node, projectId))
          )
        : planNodes;
    const syntheticFinalizationNode = buildSyntheticPlanFinalizationNode({
      activePlanContext,
      nodes: scopedNodes,
    });
    const nodes = syntheticFinalizationNode
      ? [...scopedNodes, syntheticFinalizationNode]
      : scopedNodes;

    if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0, branches: [], laneHeaders: [], colWidth: 140, effectiveLeftPadding: 0 };

    // Calculate Ranks (Y-axis) based on dependency depth
    const ranks = new Map<string, number>();
    const getRank = (id: string, visited = new Set<string>()): number => {
      if (visited.has(id)) return 0; // Cycle detection
      if (ranks.has(id)) return ranks.get(id)!;

      const node = nodes.find(n => n.id === id);
      if (!node || !node.dependencies || node.dependencies.length === 0) {
        ranks.set(id, 0);
        return 0;
      }

      visited.add(id);
      const validDeps = node.dependencies.filter(dId => nodes.some(n => n.id === dId));
      if (validDeps.length === 0) {
        ranks.set(id, 0);
        return 0;
      }

      const depRanks = validDeps.map(d => getRank(d, new Set(visited)));
      const rank = Math.max(...depRanks) + 1;
      ranks.set(id, rank);
      return rank;
    };

    nodes.forEach(n => getRank(n.id));

    // --- Disambiguate Overlaps ---
    // Task-scoped lanes can still overlap when multi-project cards for one task
    // land on the same rank. Keep the layout deterministic by bumping ranks.
    const getNodeLaneKey = (node: PlanNode): string =>
      isPlanFinalizationTaskId(node.id)
        ? `plan-finalization::${node.id}`
        : activePlanSlug
        ? getPlanNodeLogicalBranchIdentity({
            planSlug: activePlanSlug,
            node,
          }).key
        : node.assignedBranch || 'main';

    const nodesByBranch = new Map<string, PlanNode[]>();
    nodes.forEach(n => {
      const b = getNodeLaneKey(n);
      if (!nodesByBranch.has(b)) nodesByBranch.set(b, []);
      nodesByBranch.get(b)!.push(n);
    });

    nodesByBranch.forEach(branchNodes => {
      // Sort primarily by current computed rank, then by ID as stable fallback
      branchNodes.sort((a, b) => (ranks.get(a.id)! - ranks.get(b.id)!) || a.id.localeCompare(b.id));

      let lastRank = -1;
      branchNodes.forEach(n => {
        let r = ranks.get(n.id)!;
        if (r <= lastRank) {
          r = lastRank + 1; // force sequential
          ranks.set(n.id, r);
        }
        lastRank = r;
      });
    });

    // --- Lane Packing Algorithm ---
    const uniqueBranchKeys = Array.from(new Set(nodes.map((node) => getNodeLaneKey(node))));
    const branches = uniqueBranchKeys.map((key) => {
      const branchNodes = nodes.filter((node) => getNodeLaneKey(node) === key);
      const nodeRanks = branchNodes.map(n => ranks.get(n.id) || 0);
      return {
        key,
        minRank: Math.min(...nodeRanks),
        maxRank: Math.max(...nodeRanks),
      };
    }).sort((a, b) => a.minRank - b.minRank);

    const lanes: number[] = []; // stores 'freeFromRank' for each lane
    const branchToLaneMap = new Map<string, number>();

    branches.forEach(branch => {
      let assignedLane = -1;
      // Try to find an existing lane that is free
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i] < branch.minRank) {
          assignedLane = i;
          lanes[i] = branch.maxRank + 1;
          break;
        }
      }

      if (assignedLane === -1) {
        lanes.push(branch.maxRank + 1);
        assignedLane = lanes.length - 1;
      }

      branchToLaneMap.set(branch.key, assignedLane);
    });

    const activeLanesCount = Math.max(1, lanes.length);

    // Dynamic Column Width with Clamping
    // Only force MIN_COL_WIDTH if we have so many lanes that they would be unreadable otherwise.
    // If we have few lanes, let them take up comfortable space up to MAX_COL_WIDTH.
    const availableWidth = Math.max(0, containerWidth - (LEFT_MARGIN * 2));
    const dynamicColWidth = activeLanesCount > 0 ? availableWidth / activeLanesCount : availableWidth;

    // Allow COL_WIDTH to be smaller if the container is tiny, but enforce MIN_COL_WIDTH if we have many lanes
    const COL_WIDTH = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, dynamicColWidth));

    const totalGraphWidth = COL_WIDTH * activeLanesCount;
    const finalWidth = Math.max(containerWidth, totalGraphWidth + LEFT_MARGIN * 2);
    const effectiveLeftPadding = (finalWidth - totalGraphWidth) / 2; // Keep baseline margin and center remaining space

    const positionedNodes = nodes.map(n => {
      const laneIndex = branchToLaneMap.get(getNodeLaneKey(n)) ?? 0;
      return {
        ...n,
        x: effectiveLeftPadding + (laneIndex * COL_WIDTH) + (COL_WIDTH / 2),
        y: PADDING_TOP + (ranks.get(n.id) || 0) * ROW_HEIGHT,
        rank: ranks.get(n.id) || 0,
        colIndex: laneIndex,
      };
    });

    const laneHeaders: { index: number; branches: string[] }[] = [];
    for (let i = 0; i < lanes.length; i++) {
      const branchesInLane = branches
        .filter(b => branchToLaneMap.get(b.key) === i)
        .sort((a, b) => a.minRank - b.minRank)
        .map((branch) => branch.key);
      laneHeaders.push({ index: i, branches: branchesInLane });
    }

    // Calculate Edges
    const edges: { x1: number; y1: number; x2: number; y2: number; source: string; target: string }[] = [];
    positionedNodes.forEach(target => {
      target.dependencies?.forEach(sourceId => {
        const source = positionedNodes.find(n => n.id === sourceId);
        if (source) {
          edges.push({
            x1: source.x,
            y1: source.y,
            x2: target.x,
            y2: target.y,
            source: source.id,
            target: target.id
          });
        }
      });
    });

    const height = Math.max(600, PADDING_TOP * 2 + (Math.max(...ranks.values()) + 1) * ROW_HEIGHT);

    return {
      nodes: positionedNodes,
      edges,
      width: finalWidth,
      height,
      laneHeaders,
      colWidth: COL_WIDTH,
      effectiveLeftPadding
    };
  }, [activePlanContext, activePlanSlug, containerWidth, planNodes, projectRegistry, selectedGroupId, selectedProjectId, showResolvingSkeleton]);

  const getNodeTaskStatus = useCallback(
    (nodeId: string, nodeStatus: PlanNodeStatus): TaskStatus =>
      taskStatusById.get(nodeId) ?? mapPlanNodeStatusToTaskStatus(nodeStatus),
    [taskStatusById]
  );
  const getNodeIndicatorState = useCallback(
    (node: Pick<PlanNode, 'id' | 'status'>): TaskStatusIndicatorState => {
      const isAssistantRunning = runningTaskIds.has(node.id);
      const taskStatus = taskStatusById.get(node.id) ?? null;
      if (isPlanFinalizationTaskId(node.id)) {
        if (isAssistantRunning) return 'running';
        const resolvedStatus = taskStatus ?? mapPlanNodeStatusToTaskStatus(node.status);
        if (resolvedStatus === 'Completed') return 'completed';
        if (resolvedStatus === 'Failed') return 'failed';
        return 'plan_finalization';
      }

      return resolvePlanNodeStatusIndicatorState({
        nodeStatus: node.status,
        taskStatus,
        isAssistantRunning,
      });
    },
    [runningTaskIds, taskStatusById]
  );
  const getNodeStatusTone = useCallback(
    (node: Pick<PlanNode, 'id' | 'status'>) => {
      if (runningTaskIds.has(node.id)) {
        return {
          color: 'text-amber-500',
          bgColor: 'bg-amber-500/20',
        };
      }

      const taskStatus = getNodeTaskStatus(node.id, node.status);
      return {
        color: taskStatusColors[taskStatus],
        bgColor: taskStatusBgColors[taskStatus],
      };
    },
    [getNodeTaskStatus, runningTaskIds]
  );
  const hoveredNodeData = layoutData.nodes.find(n => n.id === hoveredNodeId);
  const hoveredNodeTone = hoveredNodeData ? getNodeStatusTone(hoveredNodeData) : null;
  const hoveredFrozenNode = hoveredNodeData ? frozenNodeById.get(hoveredNodeData.id) ?? null : null;
  const scopedNodeIdSet = useMemo(() => new Set(layoutData.nodes.map((node) => node.id)), [layoutData.nodes]);
  const scopedNodeById = useMemo(
    () => new Map<string, BranchTaskView>(layoutData.nodes.map((node) => [node.id, node])),
    [layoutData.nodes]
  );
  const filteredPredictedBranches = useMemo(
    () => filterPredictedBranchesForScopedNodes(predictedBranches, scopedNodeIdSet),
    [predictedBranches, scopedNodeIdSet]
  );
  const branchCards = useMemo<BranchCardView[]>(() => {
    return buildBranchCards({
      activePlanSlug,
      branchSearch,
      branchStatusFilter,
      predictedBranches: filteredPredictedBranches,
      projectGroups,
      scopedNodeById,
    });
  }, [
    activePlanSlug,
    branchSearch,
    branchStatusFilter,
    filteredPredictedBranches,
    projectGroups,
    scopedNodeById,
  ]);

  const inlineScale = useMemo(() => {
    if (layoutData.width <= 0 || containerWidth <= 0) return 1;
    const availableWidth = Math.max(120, containerWidth - INLINE_HORIZONTAL_PADDING);
    return clamp(Math.min(1, availableWidth / layoutData.width), 0.2, 1);
  }, [containerWidth, layoutData.width]);

  const inlineScaledWidth = layoutData.width * inlineScale;
  const inlineScaledHeight = layoutData.height * inlineScale;
  const shouldCenterInlineVertically = containerHeight > 0 && inlineScaledHeight < containerHeight;

  const getModalFitTransform = useCallback((): GraphTransform | null => {
    if (layoutData.width <= 0 || layoutData.height <= 0 || modalViewportWidth <= 0 || modalViewportHeight <= 0) {
      return null;
    }

    const viewportPadding = 24;
    const availableWidth = Math.max(80, modalViewportWidth - viewportPadding * 2);
    const availableHeight = Math.max(80, modalViewportHeight - viewportPadding * 2);
    const scale = clamp(
      Math.min(availableWidth / layoutData.width, availableHeight / layoutData.height),
      MIN_MODAL_ZOOM,
      MAX_MODAL_ZOOM
    );

    const scaledWidth = layoutData.width * scale;
    const scaledHeight = layoutData.height * scale;

    return {
      scale,
      x: (modalViewportWidth - scaledWidth) / 2,
      y: (modalViewportHeight - scaledHeight) / 2,
    };
  }, [layoutData.height, layoutData.width, modalViewportHeight, modalViewportWidth]);

  const clampModalTransform = useCallback((transform: GraphTransform): GraphTransform => {
    if (modalViewportWidth <= 0 || modalViewportHeight <= 0 || layoutData.width <= 0 || layoutData.height <= 0) {
      return transform;
    }

    const clampedScale = clamp(transform.scale, MIN_MODAL_ZOOM, MAX_MODAL_ZOOM);
    const scaledWidth = layoutData.width * clampedScale;
    const scaledHeight = layoutData.height * clampedScale;

    let minX = modalViewportWidth - scaledWidth - MODAL_PAN_PADDING;
    let maxX = MODAL_PAN_PADDING;
    let minY = modalViewportHeight - scaledHeight - MODAL_PAN_PADDING;
    let maxY = MODAL_PAN_PADDING;

    if (scaledWidth <= modalViewportWidth) {
      const centeredX = (modalViewportWidth - scaledWidth) / 2;
      minX = centeredX - MODAL_PAN_PADDING * 0.25;
      maxX = centeredX + MODAL_PAN_PADDING * 0.25;
    }

    if (scaledHeight <= modalViewportHeight) {
      const centeredY = (modalViewportHeight - scaledHeight) / 2;
      minY = centeredY - MODAL_PAN_PADDING * 0.25;
      maxY = centeredY + MODAL_PAN_PADDING * 0.25;
    }

    return {
      scale: clampedScale,
      x: clamp(transform.x, minX, maxX),
      y: clamp(transform.y, minY, maxY),
    };
  }, [layoutData.height, layoutData.width, modalViewportHeight, modalViewportWidth]);

  const zoomModalAtPoint = useCallback((factor: number, anchorX: number, anchorY: number) => {
    setModalTransform((prev) => {
      const nextScale = clamp(prev.scale * factor, MIN_MODAL_ZOOM, MAX_MODAL_ZOOM);

      if (Math.abs(nextScale - prev.scale) < 0.0001) return prev;

      const graphX = (anchorX - prev.x) / prev.scale;
      const graphY = (anchorY - prev.y) / prev.scale;

      return clampModalTransform({
        scale: nextScale,
        x: anchorX - graphX * nextScale,
        y: anchorY - graphY * nextScale,
      });
    });
  }, [clampModalTransform]);

  const closeGraphModal = useCallback(() => {
    setIsGraphModalOpen(false);
    setIsModalPanning(false);
    setHasInitializedModalView(false);
  }, []);

  const openGraphModal = useCallback(() => {
    modalOpenedAtRef.current = Date.now();
    setHoveredNodeRect(null);
    setHasInitializedModalView(false);
    setIsGraphModalOpen(true);
  }, []);

  const fitGraphInModal = useCallback(() => {
    const fitTransform = getModalFitTransform();
    if (!fitTransform) return;
    setModalTransform(clampModalTransform(fitTransform));
  }, [clampModalTransform, getModalFitTransform]);

  const zoomModalBy = useCallback((factor: number) => {
    if (modalViewportWidth <= 0 || modalViewportHeight <= 0) return;

    zoomModalAtPoint(factor, modalViewportWidth / 2, modalViewportHeight / 2);
  }, [modalViewportHeight, modalViewportWidth, zoomModalAtPoint]);

  const resetModalView = useCallback(() => {
    if (modalViewportWidth <= 0 || modalViewportHeight <= 0) return;

    setModalTransform(clampModalTransform({
      scale: 1,
      x: (modalViewportWidth - layoutData.width) / 2,
      y: (modalViewportHeight - layoutData.height) / 2,
    }));
  }, [clampModalTransform, layoutData.height, layoutData.width, modalViewportHeight, modalViewportWidth]);

  const handleModalWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (modalViewportWidth <= 0 || modalViewportHeight <= 0) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const zoomFactor = event.deltaY < 0 ? 1.12 : 0.9;

    zoomModalAtPoint(zoomFactor, anchorX, anchorY);
  }, [modalViewportHeight, modalViewportWidth, zoomModalAtPoint]);

  const handleModalPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    modalPanStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: modalTransform.x,
      originY: modalTransform.y,
    };

    setHoveredNodeRect(null);
    setIsModalPanning(true);
  }, [modalTransform.x, modalTransform.y]);

  const handleModalPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isModalPanning || modalPanStateRef.current.pointerId !== event.pointerId) return;

    const dx = event.clientX - modalPanStateRef.current.startX;
    const dy = event.clientY - modalPanStateRef.current.startY;

    setModalTransform((prev) => clampModalTransform({
      ...prev,
      x: modalPanStateRef.current.originX + dx,
      y: modalPanStateRef.current.originY + dy,
    }));
  }, [clampModalTransform, isModalPanning]);

  const handleModalPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (modalPanStateRef.current.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    modalPanStateRef.current.pointerId = null;
    setIsModalPanning(false);
  }, []);

  const handleModalBackdropClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (Date.now() - modalOpenedAtRef.current < 160) return;
    closeGraphModal();
  }, [closeGraphModal]);

  useEffect(() => {
    if (!isGraphModalOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeGraphModal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeGraphModal, isGraphModalOpen]);

  useEffect(() => {
    if (!isGraphModalOpen || hasInitializedModalView) return;
    if (modalViewportWidth <= 0 || modalViewportHeight <= 0) return;
    fitGraphInModal();
    setHasInitializedModalView(true);
  }, [fitGraphInModal, hasInitializedModalView, isGraphModalOpen, modalViewportHeight, modalViewportWidth]);

  useEffect(() => {
    if (!isGraphModalOpen || modalViewportWidth <= 0 || modalViewportHeight <= 0) return;
    setModalTransform((prev) => clampModalTransform(prev));
  }, [clampModalTransform, isGraphModalOpen, modalViewportHeight, modalViewportWidth]);

  useEffect(() => {
    if (viewMode !== 'graph' && isGraphModalOpen) {
      closeGraphModal();
    }
  }, [closeGraphModal, isGraphModalOpen, viewMode]);

  useEffect(() => {
    if (!isGraphModalOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomModalBy(1.15);
      } else if (event.key === '-') {
        event.preventDefault();
        zoomModalBy(1 / 1.15);
      } else if (event.key === '0') {
        event.preventDefault();
        resetModalView();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fitGraphInModal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fitGraphInModal, isGraphModalOpen, resetModalView, zoomModalBy]);

  const isModalViewportReady = modalViewportWidth > 0 && modalViewportHeight > 0;
  const canZoomIn = isModalViewportReady && modalTransform.scale < MAX_MODAL_ZOOM - 0.001;
  const canZoomOut = isModalViewportReady && modalTransform.scale > MIN_MODAL_ZOOM + 0.001;

  const renderGraphSvg = ({
    captureNodeRect,
  }: {
    captureNodeRect: boolean;
  }) => (
    <svg
      width={layoutData.width}
      height={layoutData.height}
      className="block select-none"
    >
      {layoutData.edges.map((edge) => {
        const dy = edge.y2 - edge.y1;
        const controlY1 = edge.y1 + dy * 0.5;
        const controlY2 = edge.y2 - dy * 0.5;

        const isRelated = hoveredNodeData && (
          edge.source === hoveredNodeId || edge.target === hoveredNodeId
        );

        const strokeColor = isRelated ? 'stroke-primary' : 'stroke-border';
        const opacity = isRelated || !hoveredNodeId ? 0.6 : 0.2;
        const width = isRelated ? 2 : 1.5;

        return (
          <path
            key={`${edge.source}-${edge.target}`}
            data-graph-edge-source={edge.source}
            data-graph-edge-target={edge.target}
            d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${controlY1}, ${edge.x2} ${controlY2}, ${edge.x2} ${edge.y2}`}
            fill="none"
            className={cn('transition-all duration-300', strokeColor)}
            strokeWidth={width}
            strokeOpacity={opacity}
          />
        );
      })}

      {layoutData.nodes.map((node) => {
        const visualStatus = getNodeIndicatorState(node);
        const visualTone = getNodeStatusTone(node);
        const isHovered = hoveredNodeId === node.id;
        const isRelated = hoveredNodeData && (
          hoveredNodeData.dependencies?.includes(node.id) ||
          node.dependencies?.includes(hoveredNodeId!)
        );

        const isDimmed = hoveredNodeId && !isHovered && !isRelated;

        return (
          <g
            key={node.id}
            data-graph-node-id={node.id}
            className={cn('transition-opacity duration-300', isDimmed ? 'opacity-30' : 'opacity-100')}
            onMouseEnter={(event) => {
              if (isModalPanning) return;
              setHoveredNodeId(node.id);
              setHoveredNodeRect(captureNodeRect ? event.currentTarget.getBoundingClientRect() : null);
            }}
            onMouseLeave={() => {
              setHoveredNodeId(null);
              if (captureNodeRect) setHoveredNodeRect(null);
            }}
            style={{ cursor: 'pointer' }}
          >
            <circle cx={node.x} cy={node.y} r={NODE_RADIUS + 8} fill="transparent" />

            <circle
              cx={node.x}
              cy={node.y}
              r={isHovered ? NODE_RADIUS + 2 : NODE_RADIUS}
              className={cn(
                'transition-all duration-300 stroke-2',
                isHovered ? 'stroke-foreground' : 'stroke-background'
              )}
              fill={isHovered ? 'rgb(var(--background))' : 'rgb(var(--card))'}
              stroke={isHovered ? undefined : 'rgb(var(--border))'}
            />

            <foreignObject
              x={node.x - 13}
              y={node.y - 13}
              width="26"
              height="26"
              className="pointer-events-none"
            >
              <div className={cn(
                'w-full h-full rounded-full flex items-center justify-center',
                visualTone.color
              )}>
                <TaskStatusIndicator
                  state={visualStatus}
                  layout="graph"
                  size={14}
                  dotSize={8}
                />
              </div>
            </foreignObject>

          </g>
        );
      })}

    </svg>
  );

  const planArtifactsModal =
    isPlanArtifactsOpen && planArtifactOverview && activePlanArtifactRecord ? (
      <ArtifactDiffModal
        branchName={targetBranch}
        plan={activePlanArtifactRecord}
        task={null}
        entries={planArtifactOverview.entries}
        expectedItems={planArtifactOverview.expected}
        artifactId={selectedPlanArtifactId ?? planArtifactOverview.entries[0]?.artifact.id ?? null}
        context="readOnly"
        onSelectArtifact={setSelectedPlanArtifactId}
        onClose={() => setIsPlanArtifactsOpen(false)}
      />
    ) : null;

  if (isWorkspaceMissing) {
    return (
      <aside
        className={cn("h-full w-full bg-card border-l border-border flex items-center justify-center", className)}
        data-tour-id="architect-strategy-panel"
      >
        <ProjectWorkspaceEmptyState
          stateKind={workspaceState.kind}
          variant="secondary"
          panelKind="strategy"
        />
      </aside>
    );
  }

  if (showResolvingSkeleton) {
    return (
      <aside
        className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}
        data-tour-id="architect-strategy-panel"
      >
        <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-card z-10">
          <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Icon name="strategy" size={16} className="text-primary" />
            {t('architect.strategy', 'Strategy')}
          </h1>
        </div>
        <div className="flex-1 p-4 space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </aside>
    );
  }

  // If no strategy data is available, show an empty state.
  // But we have a check inside layoutData.nodes.length === 0 returning empty objects
  // We need to handle that here
  if (layoutData.nodes.length === 0) {
    return (
      <>
        <aside
          className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}
          data-tour-id="architect-strategy-panel"
        >
          <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-card z-10">
            <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Icon name="strategy" size={16} className="text-primary" />
              {t('architect.strategy', 'Strategy')}
            </h1>
            {planArtifactsButton}
          </div>
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
            <Icon name="strategy" size={48} className="text-muted-foreground/30 mb-4" />
            <h3 className="text-sm font-semibold text-foreground mb-1">
              {t('architect.noStrategyTitle', 'No strategy generated yet')}
            </h3>
            <p className="text-xs text-muted-foreground max-w-[250px] mb-6">
              {emptyStrategyDescription}
            </p>
          </div>
        </aside>
        {planArtifactsModal}
      </>
    );
  }

  return (
    <>
    <aside
      className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}
      data-tour-id="architect-strategy-panel"
    >
      {/* Header */}
      <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-card z-10">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="strategy" size={16} className="text-primary" />
          {t('architect.strategy', 'Strategy')}
        </h1>
        <div className="flex items-center gap-2">
          {planArtifactsButton}
          {viewMode === 'graph' && (
            <button
              type="button"
              onClick={openGraphModal}
              data-tour-id="architect-graph-expand"
              className="w-8 h-8 flex items-center justify-center rounded-md border border-border bg-background/40 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title={t('architect.openGraphExplorer', 'Open graph explorer')}
              aria-label={t('architect.openGraphExplorer', 'Open graph explorer')}
            >
              <Icon name="expand" size={14} />
            </button>
          )}
        </div>
      </div>

      {/* View Toggle */}
      <div
        className="h-10 border-b border-border flex items-center px-4 gap-2 bg-card shrink-0"
        data-tour-id="architect-strategy-view-switch"
      >
        <button
          onClick={() => setViewMode('graph')}
          className={cn(
            'flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200',
            viewMode === 'graph'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon name="network" size={12} className="inline mr-1.5" />
          {t('architect.graphView', 'Graph')}
        </button>
        <button
          onClick={() => setViewMode('branches')}
          className={cn(
            'flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200',
            viewMode === 'branches'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon name="git-branch" size={12} className="inline mr-1.5" />
          {t('architect.branchesView', 'Branches')}
        </button>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden bg-background/30"
      >
        {viewMode === 'graph' ? (
          <>
            <div className="h-full overflow-y-auto overflow-x-hidden custom-scrollbar relative">
              <div
                className={cn(
                  'w-full min-h-full flex justify-center px-2 py-3',
                  shouldCenterInlineVertically ? 'items-center' : 'items-start'
                )}
              >
                <div
                  className="relative shrink-0"
                  style={{
                    width: inlineScaledWidth,
                    height: inlineScaledHeight,
                  }}
                >
                  <div
                    style={{
                      width: layoutData.width,
                      height: layoutData.height,
                      transform: `scale(${inlineScale})`,
                      transformOrigin: 'top left',
                    }}
                  >
                    {renderGraphSvg({ captureNodeRect: true })}
                  </div>
                </div>
              </div>
            </div>

            {hoveredNodeData && hoveredNodeRect && !isModalPanning && (
              <div
                className="fixed z-[110] p-4 rounded-xl border border-border bg-popover/95 shadow-xl w-72 pointer-events-none animate-in fade-in zoom-in-95 duration-150"
                style={{
                  top: Math.min(hoveredNodeRect.top + 10, window.innerHeight - 150),
                  ...(hoveredNodeRect.left > window.innerWidth / 2
                    ? { left: hoveredNodeRect.left - 295 }
                    : { left: hoveredNodeRect.right + 15 }
                  ),
                }}
              >
                <div className="flex items-start justify-between gap-4 mb-2">
                  <div className="min-w-0 space-y-2">
                    <h3 className="font-semibold text-sm leading-tight text-popover-foreground">
                      {hoveredNodeData.title}
                    </h3>
                    {hoveredFrozenNode && (
                      <div className="space-y-1.5">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                            lockedBadgeTone
                          )}
                        >
                          <Icon name="lock" size={10} />
                          {t('architect.frozenNodeLocked', 'Locked')}
                        </span>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {getFrozenReasonTooltipDescription(hoveredFrozenNode.reason)}
                        </p>
                      </div>
                    )}
                  </div>
                  <div
                    className={cn(
                      'shrink-0 w-2 h-2 rounded-full mt-1.5',
                      hoveredNodeTone?.bgColor || 'bg-muted'
                    )}
                  />
                </div>

                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  {hoveredNodeData.description}
                </p>

                {renderArtifactContractsSection(hoveredNodeData, { withTopBorder: true })}

                <div className="space-y-2 pt-2 border-t border-border/50">
                  <div className="flex items-center text-[10px] text-muted-foreground">
                    <Icon name="git-branch" size={10} className="mr-2 opacity-70" />
                    <span className="font-mono">
                      {getLogicalBranchLabel({
                        planSlug: activePlanSlug,
                        node: hoveredNodeData,
                      })}
                    </span>
                  </div>

                  {hoveredNodeData.estimatedTime && (
                    <div className="flex items-center text-[10px] text-muted-foreground">
                      <Icon name="clock" size={10} className="mr-2 opacity-70" />
                      <span>{hoveredNodeData.estimatedTime}</span>
                    </div>
                  )}

                  <div className="flex items-center text-[10px] text-muted-foreground uppercase tracking-wider font-semibold opacity-70 mt-1">
                    {t(`architect.nodeStatus.${hoveredNodeData.status}`, hoveredNodeData.status)}
                  </div>
                </div>
              </div>
            )}

            <div className="absolute bottom-4 left-4 p-2 rounded-lg bg-background/50 border border-border/50 text-[10px] text-muted-foreground pointer-events-none">
              <div className="flex items-center gap-2 mb-1">
                <Icon name="arrow-down-right" size={10} />
                <span>{t('architect.dependencyFlow', 'Dependency Flow')}</span>
              </div>
              <div className="flex items-center gap-2">
                <Icon name="network" size={10} />
                <span>{t('architect.itemsCount', { count: layoutData.nodes.length, defaultValue: `${layoutData.nodes.length} items` })}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="h-full overflow-y-auto p-4 space-y-3">
            <div className="rounded-lg border border-border bg-card p-2.5 flex min-w-0 items-center gap-2">
              <input
                value={branchSearch}
                onChange={(event) => setBranchSearch(event.target.value)}
                placeholder={t('architect.branchSearch', 'Search tasks...')}
                className="min-w-0 flex-1 h-8 px-2.5 rounded-md border border-border bg-background text-xs"
              />
              <select
                value={branchStatusFilter}
                onChange={(event) => setBranchStatusFilter(event.target.value as 'all' | PlanNodeStatus)}
                className="h-8 w-fit max-w-[45%] shrink-0 rounded-md border border-border bg-background py-0 pl-2.5 pr-8 text-xs truncate"
              >
                <option value="all">{t('architect.filterStatusAll', 'All statuses')}</option>
                <option value="pending">{t('architect.nodeStatus.pending', 'Pending')}</option>
                <option value="in-progress">{t('architect.nodeStatus.in-progress', 'In Progress')}</option>
                <option value="blocked">{t('architect.nodeStatus.blocked', 'Blocked')}</option>
                <option value="completed">{t('architect.nodeStatus.completed', 'Completed')}</option>
              </select>
            </div>

            {branchCards.map((branch) => {
              const progressPercent = branch.progressTotal > 0
                ? Math.round((branch.progressDone / branch.progressTotal) * 100)
                : 0;
              const visibleBranchTasks = branch.tasks.filter(
                (task) =>
                  branch.todos.some((todo) => todo.taskId === task.id) ||
                  getArtifactContractItems(task).length > 0
              );

              return (
                <div
                  key={branch.id}
                  data-branch-card="true"
                  data-branch-card-status={branch.status}
                  className="rounded-lg border border-border overflow-hidden bg-card"
                >
                  <div
                    className="px-3 py-2.5 space-y-2"
                    style={{ borderLeftWidth: 4, borderLeftColor: branch.color }}
                  >
                    <div className="flex items-center gap-2">
                      <Icon
                        name={branch.status === 'merged' ? 'git-merge' : 'git-branch'}
                        size={14}
                        style={{ color: branch.color }}
                      />
                      <span className="text-sm font-medium text-foreground flex-1 truncate">{branch.name}</span>
                      <span
                        data-branch-card-status-badge={branch.status}
                        className={cn(
                          'px-1.5 py-0.5 rounded text-[10px] uppercase',
                          branchCardStatusTone[branch.status]
                        )}
                      >
                        {branch.status === 'mixed'
                          ? t('architect.branchStatus.mixed', 'Mixed')
                          : t(`architect.branchStatus.${branch.status}`, branch.status)}
                      </span>
                    </div>

                    {branch.progressTotal > 0 && (
                      <div className="space-y-1.5">
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full bg-primary" style={{ width: `${progressPercent}%` }} />
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {t('architect.progress', 'Progress')}: {branch.progressDone}/{branch.progressTotal}
                        </div>
                      </div>
                    )}
                  </div>

                  {visibleBranchTasks.length > 0 && (
                    <div className="bg-muted/10 border-t border-border/50 divide-y divide-border/50">
                      {visibleBranchTasks.map((task) => {
                        const taskTodos = branch.todos.filter((todo) => todo.taskId === task.id);
                        const frozenTask = frozenNodeById.get(task.id) || null;
                        const artifactContracts = getArtifactContractItems(task);
                        return (
                          <div
                            key={task.id}
                            className="py-2"
                            data-branch-task={task.id}
                          >
                            {branch.tasks.length > 1 && (
                              <div className="px-3 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground truncate">
                                {task.title}
                              </div>
                            )}
                            {taskTodos.length > 0 && (
                              <div>
                                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {t('architect.taskTodos', 'TODO attaché')}
                                </div>
                                <div className="divide-y divide-border/40">
                                  {taskTodos.map((todo, todoIndex) => (
                                    <div key={todo.id} className="px-3 py-2" data-branch-todo={todo.id}>
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="min-w-0 flex items-center gap-2">
                                          <span className="text-[11px] text-muted-foreground w-5 text-right shrink-0">
                                            {todoIndex + 1}.
                                          </span>
                                          <div className="min-w-0">
                                            <div className="text-xs text-foreground truncate">{todo.title}</div>
                                            {branch.tasks.length > 1 && (
                                              <div className="text-[10px] text-muted-foreground truncate">{todo.taskTitle}</div>
                                            )}
                                          </div>
                                          {frozenTask && (
                                            <span
                                              className={cn(
                                                'inline-flex shrink-0 cursor-help items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                                lockedBadgeTone
                                              )}
                                              tabIndex={0}
                                              onMouseEnter={(event) =>
                                                showFrozenBadgeTooltip(
                                                  frozenTask.reason,
                                                  event.currentTarget
                                                )
                                              }
                                              onMouseLeave={hideFrozenBadgeTooltip}
                                              onFocus={(event) =>
                                                showFrozenBadgeTooltip(
                                                  frozenTask.reason,
                                                  event.currentTarget
                                                )
                                              }
                                              onBlur={hideFrozenBadgeTooltip}
                                              aria-label={`${t('architect.frozenNodeLocked', 'Locked')}. ${getFrozenReasonTooltipDescription(frozenTask.reason)}`}
                                              data-frozen-lock-badge={task.id}
                                            >
                                              {t('architect.frozenNodeLocked', 'Locked')}
                                            </span>
                                          )}
                                        </div>

                                        <div className="shrink-0 flex items-center gap-2">
                                          {task.estimatedTime && (
                                            <div className="text-right text-[10px] text-muted-foreground">{task.estimatedTime}</div>
                                          )}
                                          <TodoStatusIcon status={todo.status} />
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {artifactContracts.length > 0 && (
                              <div className={cn('px-3', taskTodos.length > 0 && 'pt-2')}>
                                {renderArtifactContractsSection(task)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {branchCards.length === 0 && (
              <div className="h-full flex items-center justify-center text-center text-muted-foreground text-xs">
                {t('architect.noBranchesMatchingFilters', 'No branches match the current filters.')}
              </div>
            )}
          </div>
        )}
      </div>

      {hoveredFrozenBadge && viewMode === 'branches' && (
        <div
          className="fixed z-[115] w-72 rounded-xl border border-border bg-popover/95 p-3 shadow-xl pointer-events-none animate-in fade-in zoom-in-95 duration-150"
          style={{
            top: Math.min(
              hoveredFrozenBadge.rect.bottom + 10,
              window.innerHeight - 120
            ),
            ...(hoveredFrozenBadge.rect.left > window.innerWidth / 2
              ? { left: Math.max(16, hoveredFrozenBadge.rect.right - 288) }
              : {
                  left: Math.min(
                    hoveredFrozenBadge.rect.left,
                    window.innerWidth - 304
                  ),
                }),
          }}
        >
          <div className="space-y-2">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                lockedBadgeTone
              )}
            >
              <Icon name="lock" size={10} />
              {t('architect.frozenNodeLocked', 'Locked')}
            </span>
            <p className="text-[11px] font-medium text-popover-foreground">
              {getFrozenReasonLabel(hoveredFrozenBadge.reason)}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {getFrozenReasonTooltipDescription(hoveredFrozenBadge.reason)}
            </p>
          </div>
        </div>
      )}

      {isGraphModalOpen && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-background/80 animate-in fade-in duration-200"
          onClick={handleModalBackdropClick}
        >
          <div
            className="w-[96vw] h-[92vh] max-w-[1500px] bg-card border border-border shadow-2xl rounded-xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="h-12 shrink-0 border-b border-border px-4 bg-muted/20 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                  <Icon name="network" size={13} className="text-primary" />
                </div>
                <span className="text-sm font-medium text-foreground truncate">
                  {t('architect.graphExplorer', 'Strategy graph explorer')}
                </span>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => zoomModalBy(1.15)}
                  disabled={!canZoomIn}
                  className="w-8 h-8 rounded-md border border-border bg-card hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card"
                  title={t('chat.zoomIn', 'Zoom in')}
                  aria-label={t('chat.zoomIn', 'Zoom in')}
                >
                  <Icon name="plus" size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => zoomModalBy(1 / 1.15)}
                  disabled={!canZoomOut}
                  className="w-8 h-8 rounded-md border border-border bg-card hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card"
                  title={t('chat.zoomOut', 'Zoom out')}
                  aria-label={t('chat.zoomOut', 'Zoom out')}
                >
                  <Icon name="minus" size={14} />
                </button>
                <button
                  type="button"
                  onClick={resetModalView}
                  disabled={!isModalViewportReady}
                  className="h-8 px-2 rounded-md border border-border bg-card hover:bg-accent text-muted-foreground hover:text-foreground transition-colors text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card"
                  title={t('chat.resetZoom', 'Reset zoom')}
                  aria-label={t('chat.resetZoom', 'Reset zoom')}
                >
                  <Icon name="rotate-ccw" size={13} className="inline mr-1" />
                  100%
                </button>
                <button
                  type="button"
                  onClick={fitGraphInModal}
                  disabled={!isModalViewportReady}
                  className="h-8 px-2 rounded-md border border-border bg-card hover:bg-accent text-muted-foreground hover:text-foreground transition-colors text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card"
                  title={t('architect.fitToScreen', 'Fit to screen')}
                  aria-label={t('architect.fitToScreen', 'Fit to screen')}
                >
                  <Icon name="layout-grid" size={13} className="inline mr-1" />
                  {t('architect.fitToScreen', 'Fit')}
                </button>
                <button
                  type="button"
                  onClick={closeGraphModal}
                  className="w-8 h-8 rounded-md border border-border bg-card hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
                  title={t('common.close', 'Close')}
                  aria-label={t('common.close', 'Close')}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>

            <div
              ref={modalViewportRef}
              className={cn(
                'relative flex-1 overflow-hidden bg-background/40 touch-none',
                isModalPanning ? 'cursor-grabbing' : 'cursor-grab'
              )}
              onWheel={handleModalWheel}
              onPointerDown={handleModalPointerDown}
              onPointerMove={handleModalPointerMove}
              onPointerUp={handleModalPointerUp}
              onPointerCancel={handleModalPointerUp}
            >
              <div
                className="absolute top-0 left-0 will-change-transform"
                style={{
                  width: layoutData.width,
                  height: layoutData.height,
                  transform: `translate3d(${modalTransform.x}px, ${modalTransform.y}px, 0) scale(${modalTransform.scale})`,
                  transformOrigin: 'top left',
                }}
              >
                {renderGraphSvg({ captureNodeRect: true })}
              </div>

              <div className="absolute bottom-4 right-4 px-2 py-1 rounded-md border border-border bg-card/90 text-xs text-muted-foreground pointer-events-none">
                {Math.round(modalTransform.scale * 100)}%
              </div>
            </div>
          </div>
        </div>
      )}

      {activeStrategyMutationPreview && (
        <div className="border-t border-border bg-card/80 px-4 py-3 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                {activeStrategyMutationPreview.status === 'valid'
                  ? t('architect.strategyPreviewTitle', 'Regeneration preview')
                  : t('architect.strategyPreviewBlockedTitle', 'Regeneration blocked')}
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                {activeStrategyMutationPreview.status === 'valid'
                  ? t(
                      'architect.strategyPreviewDescription',
                      'Frozen work is preserved. Review the pending rewrites before applying the updated strategy.'
                    )
                  : t(
                      'architect.strategyPreviewBlockedDescription',
                      'This mutation would break frozen work or create an inconsistent plan.'
                    )}
              </p>
            </div>
            <span
              className={cn(
                'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                activeStrategyMutationPreview.status === 'valid'
                  ? 'border-sky-500/20 bg-sky-500/10 text-sky-500'
                  : 'border-red-500/20 bg-red-500/10 text-red-500'
              )}
            >
              {activeStrategyMutationPreview.status}
            </span>
          </div>

          {activeStrategyMutationPreview.frozenNodes.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                {t('architect.strategyPreviewFrozen', 'Frozen nodes kept')}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {activeStrategyMutationPreview.frozenNodes.map((node) => (
                  <span
                    key={node.id}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]',
                      frozenReasonTone[node.reason].pill
                    )}
                  >
                    <Icon name="lock" size={10} />
                    {node.title}
                    <span className="opacity-80">{getFrozenReasonLabel(node.reason)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                {t('architect.strategyPreviewRewrites', 'Pending rewrites')}
              </div>
              <div className="space-y-1">
                {activeStrategyMutationPreview.rewrittenPendingNodes.length > 0 ? (
                  activeStrategyMutationPreview.rewrittenPendingNodes.map((node) => (
                    <div key={node.id} className="rounded-md border border-border bg-background/50 px-2.5 py-1.5 text-xs text-foreground">
                      {node.title}
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
                    {t('architect.strategyPreviewNone', 'None')}
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                {t('architect.strategyPreviewNew', 'New tasks')}
              </div>
              <div className="space-y-1">
                {activeStrategyMutationPreview.newNodes.length > 0 ? (
                  activeStrategyMutationPreview.newNodes.map((node) => (
                    <div key={node.id} className="rounded-md border border-border bg-background/50 px-2.5 py-1.5 text-xs text-foreground">
                      {node.title}
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
                    {t('architect.strategyPreviewNone', 'None')}
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                {t('architect.strategyPreviewRemoved', 'Pending removals')}
              </div>
              <div className="space-y-1">
                {activeStrategyMutationPreview.removedPendingNodes.length > 0 ? (
                  activeStrategyMutationPreview.removedPendingNodes.map((node) => (
                    <div key={node.id} className="rounded-md border border-border bg-background/50 px-2.5 py-1.5 text-xs text-foreground">
                      {node.title}
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
                    {t('architect.strategyPreviewNone', 'None')}
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                {t('architect.strategyPreviewConflicts', 'Conflicts')}
              </div>
              <div className="space-y-1">
                {activeStrategyMutationPreview.conflicts.length > 0 ? (
                  activeStrategyMutationPreview.conflicts.map((conflict, index) => (
                    <div key={`${index}-${conflict}`} className="rounded-md border border-red-500/20 bg-red-500/5 px-2.5 py-1.5 text-xs text-red-500">
                      {conflict}
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
                    {t('architect.strategyPreviewNone', 'None')}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleDiscardStrategyPreview}
              className="h-8 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              {t('common.discard', 'Discard')}
            </button>
            {activeStrategyMutationPreview.status === 'valid' && (
              <button
                type="button"
                onClick={() => void handleApplyStrategyPreview()}
                className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {t('architect.applyStrategyPreview', 'Apply regeneration')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Validate Plan footer ── */}
      <div className="h-14 shrink-0 border-t border-border flex items-center gap-3 px-4 bg-card">
        {activePlanContext ? (
          activePlanContext.status === 'validated' ? (
            <div className="flex items-center gap-2.5 text-emerald-500 text-sm font-medium">
              <div className="p-1.5 bg-emerald-500/10 rounded-md shrink-0">
                <Icon name="check-circle" size={14} className="text-emerald-500" />
              </div>
              {t('architect.planValidated', 'Plan validated')}
            </div>
          ) : activePlanContext.status === 'completed' ? (
            <div className="flex items-center gap-2.5 text-emerald-500 text-sm font-medium">
              <div className="p-1.5 bg-emerald-500/10 rounded-md shrink-0">
                <Icon name="check-circle" size={14} className="text-emerald-500" />
              </div>
              {t('architect.planCompleted', 'Plan completed')}
            </div>
          ) : (
            <>
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded border uppercase font-medium shrink-0',
                  activePlanContext.status === 'in_progress'
                    ? 'text-blue-500 bg-blue-500/10 border-blue-500/20'
                    : 'text-amber-500 bg-amber-500/10 border-amber-500/20'
                )}
              >
                {activePlanContext.status}
              </span>
              <button
                onClick={() => void handleValidatePlan()}
                data-tour-id="architect-validate-plan"
                disabled={planNodes.length === 0 || isValidating}
                className="ml-auto flex items-center gap-2 px-4 h-8 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isValidating ? (
                    <><Icon name="loader" size={13} className="animate-spin" />{t('architect.validatingPlan', 'Validating...')}</>
                  ) : (
                    <><Icon name="shield" size={13} />{t('architect.validate', 'Validate Plan')}</>
                  )}
                </button>
              </>
            )
        ) : (
          <span className="text-xs text-muted-foreground">{t('architect.noActivePlan', 'No active plan')}</span>
        )}
      </div>
    </aside>
    {planArtifactsModal}
    </>
  );
};

// Performance: Wrap with React.memo to prevent unnecessary re-renders
// This component is heavy due to SVG rendering and graph calculations
export const StrategyGraph = React.memo(StrategyGraphBase);

// Export default for lazy loading compatibility
export default StrategyGraph;
