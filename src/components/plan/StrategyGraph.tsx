import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
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

const statusColors: Record<PlanNodeStatus, string> = {
  'pending': 'text-muted-foreground',
  'in-progress': 'text-amber-500',
  'completed': 'text-emerald-500',
  'blocked': 'text-red-500',
};

const statusBgColors: Record<PlanNodeStatus, string> = {
  'pending': 'bg-muted',
  'in-progress': 'bg-amber-500',
  'completed': 'bg-emerald-500',
  'blocked': 'bg-red-500',
};

const NODE_RADIUS = 16;
const PADDING_TOP = 60;
const LEFT_MARGIN = 40;
const ROW_HEIGHT = 70;
const MIN_COL_WIDTH = 100;
const MAX_COL_WIDTH = 250;

// Utility hook for element size
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ref = React.useRef<T>(null);

  React.useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries.length > 0) {
        setSize({
          width: entries[0].contentRect.width,
          height: entries[0].contentRect.height,
        });
      }
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return { ref, width: size.width, height: size.height };
}

// Base component - wrapped with React.memo below for performance
const StrategyGraphBase: React.FC<StrategyGraphProps> = ({ className }) => {
  const { t } = useTranslation();
  const { selectedGroupId, selectedProjectId, projectGroups, planNodes, predictedBranches } = useAppStore();
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredNodeRect, setHoveredNodeRect] = useState<DOMRect | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'branches'>('graph');
  const { ref: containerRef, width: containerWidth } = useElementSize<HTMLDivElement>();

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
    const extraSpace = Math.max(0, finalWidth - totalGraphWidth);
    const effectiveLeftPadding = LEFT_MARGIN + (extraSpace / 2); // Center graph if smaller than container

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

  const getStatusIconName = (status: PlanNodeStatus) => {
    switch (status) {
      case 'completed': return 'check';
      case 'in-progress': return 'loader';
      case 'blocked': return 'lock';
      default: return 'circle';
    }
  };

  const hoveredNodeData = layoutData.nodes.find(n => n.id === hoveredNodeId);

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
          <h3 className="text-sm font-semibold text-foreground mb-1">No strategy generated yet</h3>
          <p className="text-xs text-muted-foreground max-w-[250px] mb-6">
            Generate a strategy graph based on this plan's identified needs.
          </p>
          <button
            onClick={() => {
              const chatStore = useChatStore.getState();
              const appStore = useAppStore.getState();
              if (chatStore && appStore.mode === 'Architect') {
                const conversationId = chatStore.selectedConversationIdsByMode['Architect'];
                if (conversationId) {
                  chatStore.sendMessage({
                    conversationId,
                    content: "Please generate a structured strategy for the active plan using the `generate_plan` tool.",
                  });
                }
              }
            }}
            className="px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors rounded-lg flex items-center gap-2 text-sm font-medium shadow-sm hover:shadow"
          >
            <Icon name="sparkles" size={16} />
            {t('architect.generatePlan', 'Generate Plan')}
          </button>
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
          Graph
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
          Branches
        </button>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden bg-background/30"
      >

        {viewMode === 'graph' ? (
          <>
            <div className="h-full overflow-auto custom-scrollbar relative">
              <svg
                width={layoutData.width}
                height={layoutData.height}
                className="block"
              >
                {/* Edges */}
                {layoutData.edges.map((edge) => {
                  const dy = edge.y2 - edge.y1;
                  const controlY1 = edge.y1 + dy * 0.5;
                  const controlY2 = edge.y2 - dy * 0.5;

                  // const isHovered = hoveredNodeId === edge.source || hoveredNodeId === edge.target;
                  // Highlight incoming/outgoing edges of hovered node
                  const isRelated = hoveredNodeData && (
                    (edge.source === hoveredNodeId) || (edge.target === hoveredNodeId)
                  );

                  const strokeColor = isRelated ? "stroke-primary" : "stroke-border";
                  const opacity = isRelated || !hoveredNodeId ? 0.6 : 0.2;
                  const width = isRelated ? 2 : 1.5;

                  return (
                    <path
                      key={`${edge.source}-${edge.target}`}
                      d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${controlY1}, ${edge.x2} ${controlY2}, ${edge.x2} ${edge.y2}`}
                      fill="none"
                      className={cn("transition-all duration-300", strokeColor)}
                      strokeWidth={width}
                      strokeOpacity={opacity}
                    />
                  );
                })}

                {/* Nodes */}
                {layoutData.nodes.map((node) => {
                  const isHovered = hoveredNodeId === node.id;
                  const isRelated = hoveredNodeData && (
                    hoveredNodeData.dependencies?.includes(node.id) ||
                    node.dependencies?.includes(hoveredNodeId!)
                  );

                  const isDimmed = hoveredNodeId && !isHovered && !isRelated;

                  return (
                    <g
                      key={node.id}
                      className={cn("transition-opacity duration-300", isDimmed ? "opacity-30" : "opacity-100")}
                      onMouseEnter={(e) => {
                        setHoveredNodeId(node.id);
                        setHoveredNodeRect(e.currentTarget.getBoundingClientRect());
                      }}
                      onMouseLeave={() => {
                        setHoveredNodeId(null);
                        setHoveredNodeRect(null);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {/* Hit area */}
                      <circle cx={node.x} cy={node.y} r={NODE_RADIUS + 8} fill="transparent" />

                      {/* Main circle */}
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={isHovered ? NODE_RADIUS + 2 : NODE_RADIUS}
                        className={cn(
                          "transition-all duration-300 stroke-2",
                          isHovered ? "stroke-foreground" : "stroke-background"
                        )}
                        fill={isHovered ? "rgb(var(--background))" : "rgb(var(--card))"}
                        stroke={isHovered ? undefined : "rgb(var(--border))"}
                      />

                      {/* Inner Icon Container */}
                      <foreignObject
                        x={node.x - 10}
                        y={node.y - 10}
                        width="20"
                        height="20"
                        className="pointer-events-none"
                      >
                        <div className={cn(
                          "w-full h-full rounded-full flex items-center justify-center",
                          statusColors[node.status]
                        )}>
                          <Icon
                            name={getStatusIconName(node.status)}
                            size={14}
                            className={node.status === 'in-progress' ? 'animate-spin' : ''}
                          />
                        </div>
                      </foreignObject>

                    </g>
                  );
                })}

                {/* Hovered Label (Rendered Last for Z-Index) */}
                {hoveredNodeData && (
                  <g className="pointer-events-none">
                    <text
                      x={hoveredNodeData.x > (layoutData.width / 2) ? hoveredNodeData.x - NODE_RADIUS - 12 : hoveredNodeData.x + NODE_RADIUS + 12}
                      y={hoveredNodeData.y + 4}
                      textAnchor={hoveredNodeData.x > (layoutData.width / 2) ? "end" : "start"}
                      className="text-[11px] font-sans font-medium fill-foreground"
                      style={{
                        textShadow: '0 2px 4px rgb(var(--background)), 0 0 2px rgb(var(--background)), 0 0 2px rgb(var(--background))',
                        paintOrder: 'stroke fill'
                      }}
                    >
                      {hoveredNodeData.title}
                    </text>
                  </g>
                )}
              </svg>
            </div>

            {/* Tooltip Overlay */}
            {hoveredNodeData && hoveredNodeRect && (
              <div
                className="fixed z-[100] p-4 rounded-xl border border-border bg-popover/95 shadow-xl backdrop-blur-sm w-72 pointer-events-none animate-in fade-in zoom-in-95 duration-150"
                style={{
                  top: Math.min(hoveredNodeRect.top + 10, window.innerHeight - 150), // Prevent off-screen bottom
                  ...(hoveredNodeRect.left > window.innerWidth / 2
                    ? { left: hoveredNodeRect.left - 280 - 15 } // Render to the left of the node
                    : { left: hoveredNodeRect.right + 15 }      // Render to the right of the node
                  )
                }}
              >
                <div className="flex items-start justify-between gap-4 mb-2">
                  <h3 className="font-semibold text-sm leading-tight text-popover-foreground">
                    {hoveredNodeData.title}
                  </h3>
                  <div className={cn("shrink-0 w-2 h-2 rounded-full mt-1.5", statusBgColors[hoveredNodeData.status])} />
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
                    {t(`status.${hoveredNodeData.status}`, hoveredNodeData.status)}
                  </div>
                </div>
              </div>
            )}

            {/* Legend */}
            <div className="absolute bottom-4 left-4 p-2 rounded-lg bg-background/50 backdrop-blur-sm border border-border/50 text-[10px] text-muted-foreground pointer-events-none">
              <div className="flex items-center gap-2 mb-1">
                <Icon name="arrow-down-right" size={10} />
                <span>Dependency Flow</span>
              </div>
              <div className="flex items-center gap-2">
                <Icon name="network" size={10} />
                <span>{layoutData.nodes.length} Items</span>
              </div>
            </div>
          </>
        ) : (
          <div className="h-full overflow-y-auto p-4 space-y-3">
            {predictedBranches.map((branch) => (
              <div
                key={branch.id}
                className="rounded-lg border border-border overflow-hidden bg-card"
              >
                <div
                  className="flex items-center gap-2 px-3 py-2"
                  style={{ borderLeftWidth: 4, borderLeftColor: branch.color }}
                >
                  <Icon
                    name={branch.status === 'merged' ? 'git-merge' : 'git-branch'}
                    size={14}
                    style={{ color: branch.color }}
                  />
                  <span className="text-sm font-medium text-foreground flex-1 truncate">
                    {branch.name}
                  </span>
                  <span
                    className={cn(
                      'px-1.5 py-0.5 rounded text-xs',
                      branch.status === 'merged'
                        ? 'bg-emerald-500/10 text-emerald-500'
                        : branch.status === 'active'
                          ? 'bg-amber-500/10 text-amber-500'
                          : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {branch.status}
                  </span>
                </div>

                {/* Branch Tasks List */}
                <div className="bg-muted/10 border-t border-border/50 divide-y divide-border/50">
                  {branch.taskIds.map(taskId => {
                    const task = planNodes.find((n: PlanNode) => n.id === taskId);
                    if (!task) return null;
                    return (
                      <div key={taskId} className="px-3 py-2 flex items-center justify-between group hover:bg-muted/20 transition-colors">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={cn(
                            "w-1.5 h-1.5 rounded-full shrink-0",
                            statusColors[task.status].replace('text-', 'bg-')
                          )} />
                          <span className="text-xs text-muted-foreground group-hover:text-foreground truncate transition-colors">
                            {task.title}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          {task.estimatedTime && (
                            <span className="text-[10px] text-muted-foreground bg-background border border-border px-1 rounded">
                              {task.estimatedTime}
                            </span>
                          )}
                          <Icon name={getStatusIconName(task.status)} size={12} className="text-muted-foreground" />
                        </div>
                      </div>
                    );
                  })}

                  {branch.taskIds.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground italic">
                      No tasks assigned
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
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
