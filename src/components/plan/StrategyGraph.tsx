import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { getGitFlowBaseBranch, resolveTargetBranch } from '../../services/architectPlanService';
import { validatePlanAndProvisionBranches } from '../../services/architectGitFlowService';
import { toast } from '../ui/Toaster';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import type { PlanNode, PlanNodeStatus } from '../../types';

interface StrategyGraphProps {
  className?: string;
}

/**
 * StrategyGraph - Visualizes project strategy as a graph or branch view
 * 
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Architect mode is active
 * Contains complex SVG rendering that benefits from code splitting
 */

type VisualNodeStatus = PlanNodeStatus | 'ai-running';

const statusColors: Record<VisualNodeStatus, string> = {
  'pending': 'text-muted-foreground',
  'in-progress': 'text-amber-500',
  'ai-running': 'text-blue-500',
  'completed': 'text-emerald-500',
  'blocked': 'text-red-500',
};

const statusBgColors: Record<VisualNodeStatus, string> = {
  'pending': 'bg-muted',
  'in-progress': 'bg-amber-500',
  'ai-running': 'bg-blue-500',
  'completed': 'bg-emerald-500',
  'blocked': 'bg-red-500',
};

const resolveVisualStatus = (status: PlanNodeStatus, isAiStreaming: boolean): VisualNodeStatus => {
  if (status === 'in-progress' && isAiStreaming) return 'ai-running';
  return status;
};

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

interface BranchTaskView extends PlanNode {
  rank?: number;
}

interface BranchCardView {
  id: string;
  name: string;
  color: string;
  status: 'pending' | 'active' | 'merged';
  progressDone: number;
  progressTotal: number;
  tasks: BranchTaskView[];
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

// Utility hook for element size
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [node, setNode] = useState<T | null>(null);

  const ref = useCallback((element: T | null) => {
    setNode(element);
  }, []);

  useEffect(() => {
    if (!node) {
      setSize({ width: 0, height: 0 });
      return;
    }

    const updateSize = () => {
      setSize({
        width: node.clientWidth,
        height: node.clientHeight,
      });
    };

    updateSize();

    const observer = new ResizeObserver((entries) => {
      if (entries.length === 0) return;

      setSize({
        width: entries[0].contentRect.width,
        height: entries[0].contentRect.height,
      });
    });

    observer.observe(node);

    return () => observer.disconnect();
  }, [node]);

  return { ref, width: size.width, height: size.height };
}

// Base component - wrapped with React.memo below for performance
const StrategyGraphBase: React.FC<StrategyGraphProps> = ({ className }) => {
  const { t } = useTranslation();
  const {
    selectedGroupId,
    selectedProjectId,
    projectGroups,
    planNodes,
    predictedBranches,
    activePlanContext,
    setActivePlanContext,
    setPlanNodes,
    setPredictedBranches,
  } = useAppStore();
  const isAiStreaming = useChatStore((state) => state.isStreaming);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredNodeRect, setHoveredNodeRect] = useState<DOMRect | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'branches'>('graph');
  const [branchSearch, setBranchSearch] = useState('');
  const [branchStatusFilter, setBranchStatusFilter] = useState<'all' | PlanNodeStatus>('all');
  const [isValidating, setIsValidating] = useState(false);
  const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
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

  const targetBranch = useMemo(() => {
    if (activePlanContext?.targetBranch) {
      try {
        return resolveTargetBranch(activePlanContext.targetBranch);
      } catch {
        return getGitFlowBaseBranch();
      }
    }

    return getGitFlowBaseBranch();
  }, [activePlanContext?.targetBranch]);

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

      const createdCount = (provision.createdPlanBranch ? 1 : 0) + provision.createdFeatureBranches.length;
      toast.success(
        createdCount > 0
          ? `Plan validated — ${createdCount} branch${createdCount > 1 ? 'es' : ''} provisioned.`
          : 'Plan validated — branches already up to date.'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to validate plan.');
    } finally {
      setIsValidating(false);
    }
  };

  // 1. Calculate Layout
  const layoutData = useMemo(() => {
    let nodes: PlanNode[] = [];

    if (selectedProjectId) {
      nodes = planNodes.filter((n: PlanNode) => n.projectId === selectedProjectId);
    } else if (selectedGroupId) {
      // Find all project IDs in this group
      const group = projectGroups.find(g => g.id === selectedGroupId);
      if (group && group.projects) {
        const projectIds = group.projects.map(p => p.id);
        nodes = planNodes.filter((n: PlanNode) => n.projectId && projectIds.includes(n.projectId));
      }
    } else {
      nodes = planNodes;
    }

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
    // If nodes share the same branch AND the same rank, they perfectly overlap.
    // We sort them roughly by ID to be deterministic, then progressively bump ranks.
    const nodesByBranch = new Map<string, PlanNode[]>();
    nodes.forEach(n => {
      const b = n.assignedBranch || 'main';
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
    const uniqueBranchNames = Array.from(new Set(nodes.map(n => n.assignedBranch || 'main')));
    const branches = uniqueBranchNames.map(name => {
      const branchNodes = nodes.filter(n => (n.assignedBranch || 'main') === name);
      const nodeRanks = branchNodes.map(n => ranks.get(n.id) || 0);
      return {
        name,
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

      branchToLaneMap.set(branch.name, assignedLane);
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
      const laneIndex = branchToLaneMap.get(n.assignedBranch || 'main') ?? 0;
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
        .filter(b => branchToLaneMap.get(b.name) === i)
        .sort((a, b) => a.minRank - b.minRank)
        .map(b => b.name);
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
  }, [selectedGroupId, selectedProjectId, projectGroups, planNodes, containerWidth]);

  const getStatusIconName = (status: VisualNodeStatus) => {
    switch (status) {
      case 'completed': return 'check';
      case 'in-progress': return 'loader';
      case 'ai-running': return 'loader';
      case 'blocked': return 'lock';
      default: return 'circle';
    }
  };

  const hoveredNodeData = layoutData.nodes.find(n => n.id === hoveredNodeId);
  const hoveredVisualStatus = hoveredNodeData ? resolveVisualStatus(hoveredNodeData.status, isAiStreaming) : null;
  const scopedNodeIdSet = useMemo(() => new Set(layoutData.nodes.map((node) => node.id)), [layoutData.nodes]);
  const scopedNodeById = useMemo(
    () => new Map(layoutData.nodes.map((node) => [node.id, node])),
    [layoutData.nodes]
  );
  const filteredPredictedBranches = useMemo(
    () => predictedBranches
      .map((branch) => ({
        ...branch,
        taskIds: branch.taskIds.filter((taskId) => scopedNodeIdSet.has(taskId)),
      }))
      .filter((branch) => branch.taskIds.length > 0),
    [predictedBranches, scopedNodeIdSet]
  );
  const branchCards = useMemo<BranchCardView[]>(() => {
    const normalizedSearch = branchSearch.trim().toLowerCase();
    const statusOrder: Record<PlanNodeStatus, number> = {
      'in-progress': 0,
      pending: 1,
      blocked: 2,
      completed: 3,
    };

    return filteredPredictedBranches
      .map((branch) => {
        const allTasks: BranchTaskView[] = branch.taskIds.reduce<BranchTaskView[]>((acc, taskId) => {
          const task = scopedNodeById.get(taskId);
          if (!task) return acc;
          acc.push({ ...task });
          return acc;
        }, []);

        const progressDone = allTasks.filter((task) => task.status === 'completed').length;
        const progressTotal = allTasks.length;

        const filteredTasks = allTasks
          .filter((task) => {
            if (branchStatusFilter !== 'all' && task.status !== branchStatusFilter) return false;
            if (!normalizedSearch) return true;
            const haystack = `${task.title} ${task.description || ''}`.toLowerCase();
            return haystack.includes(normalizedSearch);
          })
          .sort((a, b) => {
            if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
            if ((a.rank ?? 0) !== (b.rank ?? 0)) return (a.rank ?? 0) - (b.rank ?? 0);
            return a.title.localeCompare(b.title);
          });

        return {
          id: branch.id,
          name: branch.name,
          color: branch.color,
          status: branch.status,
          progressDone,
          progressTotal,
          tasks: filteredTasks,
        };
      })
      .filter((branch) => branch.tasks.length > 0 || branchSearch.trim().length === 0);
  }, [
    branchSearch,
    branchStatusFilter,
    filteredPredictedBranches,
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
            d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${controlY1}, ${edge.x2} ${controlY2}, ${edge.x2} ${edge.y2}`}
            fill="none"
            className={cn('transition-all duration-300', strokeColor)}
            strokeWidth={width}
            strokeOpacity={opacity}
          />
        );
      })}

      {layoutData.nodes.map((node) => {
        const visualStatus = resolveVisualStatus(node.status, isAiStreaming);
        const isHovered = hoveredNodeId === node.id;
        const isRelated = hoveredNodeData && (
          hoveredNodeData.dependencies?.includes(node.id) ||
          node.dependencies?.includes(hoveredNodeId!)
        );

        const isDimmed = hoveredNodeId && !isHovered && !isRelated;

        return (
          <g
            key={node.id}
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
              x={node.x - 10}
              y={node.y - 10}
              width="20"
              height="20"
              className="pointer-events-none"
            >
              <div className={cn(
                'w-full h-full rounded-full flex items-center justify-center',
                statusColors[visualStatus]
              )}>
                <Icon
                  name={getStatusIconName(visualStatus)}
                  size={14}
                  className={visualStatus === 'in-progress' || visualStatus === 'ai-running' ? 'animate-spin' : ''}
                />
              </div>
            </foreignObject>
          </g>
        );
      })}

    </svg>
  );

  // If no mock data at all, show empty state (should only happen if filter removes everything and we don't want to show empty graph)
  // But we have a check inside layoutData.nodes.length === 0 returning empty objects
  // We need to handle that here
  if (layoutData.nodes.length === 0) {
    if (!selectedProjectId && !selectedGroupId) {
      return (
        <aside
          className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}
        >
          <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-card z-10">
            <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Icon name="git-branch" size={16} className="text-primary" />
              {t('architect.strategy', 'Strategy')}
            </h1>
          </div>
          <div className="flex-1 text-center px-6 flex items-center justify-center">
            <div>
              <Icon name="git-branch" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
              <p className="text-muted-foreground text-sm">
                {t('architect.selectProject', 'Select a project to view the strategy')}
              </p>
            </div>
          </div>
        </aside>
      );
    }

    return (
      <aside className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}>
        <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-card z-10">
          <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Icon name="git-branch" size={16} className="text-primary" />
            {t('architect.strategy', 'Strategy')}
          </h1>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
          <Icon name="git-merge" size={48} className="text-muted-foreground/30 mb-4" />
          <h3 className="text-sm font-semibold text-foreground mb-1">
            {t('architect.noStrategyTitle', 'No strategy generated yet')}
          </h3>
          <p className="text-xs text-muted-foreground max-w-[250px] mb-6">
            {t('architect.noStrategyDescription', 'Discuss needs in Architect chat, then use Generate Strategy to create this graph.')}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn("h-full w-full bg-card border-l border-border flex flex-col", className)}
    >
      {/* Header */}
      <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-card z-10">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="git-branch" size={16} className="text-primary" />
          {t('architect.strategy', 'Strategy')}
        </h1>
        {viewMode === 'graph' && (
          <button
            type="button"
            onClick={openGraphModal}
            className="w-8 h-8 flex items-center justify-center rounded-md border border-border bg-background/40 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title={t('architect.openGraphExplorer', 'Open graph explorer')}
            aria-label={t('architect.openGraphExplorer', 'Open graph explorer')}
          >
            <Icon name="expand" size={14} />
          </button>
        )}
      </div>

      {/* View Toggle */}
      <div className="h-10 border-b border-border flex items-center px-4 gap-2 bg-card shrink-0">
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
                className="fixed z-[110] p-4 rounded-xl border border-border bg-popover/95 shadow-xl backdrop-blur-sm w-72 pointer-events-none animate-in fade-in zoom-in-95 duration-150"
                style={{
                  top: Math.min(hoveredNodeRect.top + 10, window.innerHeight - 150),
                  ...(hoveredNodeRect.left > window.innerWidth / 2
                    ? { left: hoveredNodeRect.left - 295 }
                    : { left: hoveredNodeRect.right + 15 }
                  ),
                }}
              >
                <div className="flex items-start justify-between gap-4 mb-2">
                  <h3 className="font-semibold text-sm leading-tight text-popover-foreground">
                    {hoveredNodeData.title}
                  </h3>
                  <div className={cn('shrink-0 w-2 h-2 rounded-full mt-1.5', hoveredVisualStatus ? statusBgColors[hoveredVisualStatus] : 'bg-muted')} />
                </div>

                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  {hoveredNodeData.description}
                </p>

                <div className="space-y-2 pt-2 border-t border-border/50">
                  <div className="flex items-center text-[10px] text-muted-foreground">
                    <Icon name="git-branch" size={10} className="mr-2 opacity-70" />
                    <span className="font-mono">{hoveredNodeData.assignedBranch}</span>
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

            <div className="absolute bottom-4 left-4 p-2 rounded-lg bg-background/50 backdrop-blur-sm border border-border/50 text-[10px] text-muted-foreground pointer-events-none">
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
            <div className="rounded-lg border border-border bg-card p-2.5 flex items-center gap-2">
              <input
                value={branchSearch}
                onChange={(event) => setBranchSearch(event.target.value)}
                placeholder={t('architect.branchSearch', 'Search tasks...')}
                className="flex-1 h-8 px-2.5 rounded-md border border-border bg-background text-xs"
              />
              <select
                value={branchStatusFilter}
                onChange={(event) => setBranchStatusFilter(event.target.value as 'all' | PlanNodeStatus)}
                className="h-8 px-2 rounded-md border border-border bg-background text-xs"
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

              return (
                <div
                  key={branch.id}
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
                        className={cn(
                          'px-1.5 py-0.5 rounded text-[10px] uppercase',
                          branch.status === 'merged'
                            ? 'bg-emerald-500/10 text-emerald-500'
                            : branch.status === 'active'
                              ? 'bg-amber-500/10 text-amber-500'
                              : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {t(`architect.branchStatus.${branch.status}`, branch.status)}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${progressPercent}%` }} />
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {t('architect.progress', 'Progress')}: {branch.progressDone}/{branch.progressTotal}
                      </div>
                    </div>
                  </div>

                  <div className="bg-muted/10 border-t border-border/50 divide-y divide-border/50">
                    {branch.tasks.map((task, taskIndex) => {
                      const visualStatus = resolveVisualStatus(task.status, isAiStreaming);
                      return (
                        <div key={task.id} className="px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex items-center gap-2">
                              <span className="text-[11px] text-muted-foreground w-5 text-right shrink-0">
                                {taskIndex + 1}.
                              </span>
                              <span className="text-xs text-foreground truncate">{task.title}</span>
                            </div>

                            <div className="shrink-0 flex items-center gap-2">
                              {task.estimatedTime && (
                                <div className="text-right text-[10px] text-muted-foreground">{task.estimatedTime}</div>
                              )}
                              <div className={cn(
                                'w-4 h-4 rounded-full flex items-center justify-center',
                                visualStatus === 'pending' && 'bg-muted/80 text-muted-foreground',
                                visualStatus === 'in-progress' && 'bg-amber-500/20 text-amber-500',
                                visualStatus === 'ai-running' && 'bg-blue-500/20 text-blue-500',
                                visualStatus === 'completed' && 'bg-emerald-500 text-white',
                                visualStatus === 'blocked' && 'bg-red-500/20 text-red-500'
                              )}>
                                <Icon
                                  name={getStatusIconName(visualStatus)}
                                  size={9}
                                  className={visualStatus === 'in-progress' || visualStatus === 'ai-running' ? 'animate-spin' : ''}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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

      {isGraphModalOpen && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200"
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
  );
};

// Performance: Wrap with React.memo to prevent unnecessary re-renders
// This component is heavy due to SVG rendering and graph calculations
export const StrategyGraph = React.memo(StrategyGraphBase);

// Export default for lazy loading compatibility
export default StrategyGraph;
