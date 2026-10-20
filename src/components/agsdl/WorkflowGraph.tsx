import { groupNativeState, type NativeCardActivation } from "../../services/agsdl/executionView";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Background, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps, type NodeChange } from "@xyflow/react";
import { ArrowRightLeft, Bot, Box, Boxes, Braces, ChevronDown, CircleHelp, GitBranch, GitMerge, Hand, Info, Layers, MessageSquare, MessageSquarePlus, LocateFixed, Minus, Plus, Plug, Shuffle, Sparkles, Trophy, Zap } from "lucide-react";
import { useElementSize } from "../../hooks/useElementSize";
import { layoutViewer, routeViewerEdge, type ViewerEdge } from "../../services/agsdl/graphLayout";
import { graphNeighborhood, presentFocusedGraph, presentGraph } from "../../services/agsdl/graphPresentation";
import "./graphPresentation.css";
import type { ViewerCard } from "../../services/agsdl/viewer";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import "@xyflow/react/dist/style.css";
import { WorkflowEdge, type GraphEdge } from "./WorkflowEdge";
import { WorkflowBlockOverlay } from "./WorkflowBlockOverlay";
import { WorkflowGraphPopup } from "./WorkflowGraphPopup";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";
import { groupTaskState, type TrackedTask } from "../../services/agsdl/taskTracking";

type GraphNode = Node<{
  card: ViewerCard;
  title: string;
  kindLabel: string;
  active: boolean;
  subtitle: string;
  select: (path: string) => void;
  focus: (path: string) => void;
  inspect: (path: string) => void;
  members?: string[];
  expand?: () => void;
  changed: boolean;
  pending: boolean;
  task?: TrackedTask;
  native?: NativeCardActivation;
  incoming: string[];
  outgoing: string[];
  attach?: () => void;
  openTask?: () => void;
  dismissSignal: number;
}, "workflow">;

function WorkflowNode({ data }: NodeProps<GraphNode>) {
  const { card } = data;
  const { t } = useAgsdlTranslation();
  const Icon = data.members ? Layers : card.kind === "System" ? Boxes : card.kind === "condition" ? GitBranch : card.kind === "approval" ? Hand : card.kind === "join" ? card.details.mode === "first" ? Trophy : GitMerge : card.kind === "compose" ? Boxes : card.kind === "call" ? Plug : card.kind === "prepare" ? ArrowRightLeft : ["Agent", "invoke", "agent"].includes(card.kind) ? Bot : Box;
  const warning = Boolean(card.issueCount) || card.unresolved || card.branches.some(branch => branch.reference.unresolved) || card.dependencies?.some(ref => ref.unresolved);
  const label = [data.kindLabel, data.title !== data.kindLabel ? data.title : "", data.subtitle, warning ? t("agsdl.viewer.unresolved") : ""].filter(Boolean).join(" · ");
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" />
      <WorkflowBlockOverlay card={card} title={data.title} kindLabel={data.kindLabel} task={data.task} native={data.native}
        incoming={data.incoming} outgoing={data.outgoing} dismissSignal={data.dismissSignal} actions={[
          { label: data.members ? t("agsdl.graphInteraction.expand") : t("agsdl.viewer.componentDetails"), icon: data.members ? <Layers size={14} /> : <Info size={14} />, run: () => data.expand ? data.expand() : data.inspect(card.path) },
          ...(data.attach ? [{ label: t("agsdl.attachToChat"), icon: <MessageSquarePlus size={14} />, run: data.attach }] : []),
          ...(data.openTask ? [{ label: t("agsdl.graphInteraction.openTask"), icon: <MessageSquare size={14} />, run: data.openTask }] : []),
        ]}>
      <button
        type="button"
        className={`agsdl-graph-node nodrag nopan${data.active ? " is-selected" : ""}${card.kind === "approval" ? " is-interaction" : ""}`}
        onClick={event => {
          event.stopPropagation();
          if (data.expand) data.expand();
          else data.select(data.active ? "" : card.path);
        }}
        onDoubleClick={event => { event.stopPropagation(); if (!data.members) data.inspect(card.path); }}
        onMouseEnter={() => data.focus(card.path)} onMouseLeave={() => data.focus("")}
        onFocus={() => data.focus(card.path)} onBlur={() => data.focus("")}
        aria-pressed={data.members ? undefined : data.active}
        aria-expanded={data.members ? false : undefined}
        aria-label={data.task || data.native ? undefined : label}
      >
        {data.task || data.native ? <WorkflowStatusBadge task={data.task} native={data.native} />
          : <span className="agsdl-node-icon"><Icon size={15} aria-hidden="true" /></span>}
        <span className="agsdl-node-text">
          <span className="agsdl-node-title">{data.title}</span>
          {data.subtitle && <span className="agsdl-node-subtitle">{data.subtitle}</span>}
          {!data.members && card.capabilities && <span className="agsdl-node-capabilities">
            {card.capabilities.skills.length > 0 && <span title={`${t("agsdl.graphHints.skills")}: ${card.capabilities.skills.join(", ")}`} aria-label={`${t("agsdl.graphHints.skills")}: ${card.capabilities.skills.join(", ")}`}><Sparkles size={11} aria-hidden="true" /><span className="agsdl-node-skill-name">{card.capabilities.skills.at(-1)}</span></span>}
            {card.capabilities.structuredResults && <span title={t("agsdl.graphHints.structured")} aria-label={t("agsdl.graphHints.structured")}><Braces size={12} aria-hidden="true" /></span>}
            {card.capabilities.dynamicConfiguration && <span title={t("agsdl.graphHints.dynamic")} aria-label={t("agsdl.graphHints.dynamic")}><Shuffle size={12} aria-hidden="true" /></span>}
            {card.capabilities.externalEffects && <span title={t("agsdl.graphHints.external")} aria-label={t("agsdl.graphHints.external")}><Zap size={12} aria-hidden="true" /><span>{t("agsdl.graphHints.externalShort")}</span></span>}
          </span>}

        </span>
        {data.members && <ChevronDown size={14} aria-hidden="true" />}
        {data.changed && <span className="agsdl-graph-change-dot" title={t("agsdl.designGraph.changed", { defaultValue: "Modified" })} />}
        {data.pending && <span className="agsdl-graph-pending" title={t("agsdl.designGraph.instructionsMissing", { defaultValue: "Instructions to complete" })}><CircleHelp size={12} aria-hidden="true" /></span>}
        {warning && <CircleHelp size={12} className="agsdl-node-warning" aria-hidden="true" />}
      </button>
      </WorkflowBlockOverlay>
      <Handle type="source" position={Position.Bottom} id="out" />
    </>
  );
}
const nodeTypes = { workflow: WorkflowNode };
const edgeTypes = { workflow: WorkflowEdge };
const fitOptions = { padding: 0.16, minZoom: 0.5, maxZoom: 1 };

function Canvas({ cards, edges: connections, selected, select, title, changedPaths = [], trackedTasks = {}, nativeActivations = {}, selectionMode = "inspect", onAttach, onOpenTask, onInspect }: {
  cards: ViewerCard[];
  edges: ViewerEdge[];
  selected: string;
  select: (path: string) => void;
  title: (card: ViewerCard) => string;
  source?: string;
  changedPaths?: string[];
  trackedTasks?: Record<string, TrackedTask>;
  nativeActivations?: Record<string, NativeCardActivation>;
  selectionMode?: "inspect" | "select";
  onAttach?: (path: string) => void;
  onOpenTask?: (path: string) => void;
  onInspect?: (path: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const flow = useReactFlow<GraphNode>();
  const backgroundId = useId();
  const [canvasAnchor, setCanvasAnchor] = useState<HTMLDivElement | null>(null);
  const [paneMenu, setPaneMenu] = useState<{ left: number; top: number }>();
  const [dismissSignal, setDismissSignal] = useState(0);
  const [inspectedEdge, setInspectedEdge] = useState("");
  const focusEdge = useCallback((id: string, open: boolean) => {
    setInspectedEdge(current => open ? id : current === id ? "" : current);
  }, []);
  const [highlighted, setHighlighted] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [hovered, setHovered] = useState("");
  const [heights, setHeights] = useState<Record<string, number>>({});
  const active = selected || (cards.some(card => card.path === highlighted) ? highlighted : "");
  const presentation = useMemo(() => presentFocusedGraph(cards, connections, collapsed, active), [cards, connections, collapsed, active]);
  // Revealing exchanges must not move the process cards.
  const overview = useMemo(() => presentGraph(cards, connections, collapsed, "overview"), [cards, connections, collapsed]);
  const layout = useMemo(() => layoutViewer(overview.cards, overview.edges, heights), [overview.cards, overview.edges, heights]);
  const focus = inspectedEdge || active || hovered;
  const neighborhood = graphNeighborhood(focus, presentation.edges);
  const hasFocus = Boolean(focus) && (presentation.cards.some(card => card.path === focus) || presentation.edges.some(edge => edge.id === focus));
  const fitted = useRef(false);
  useEffect(() => {
    if (!width || !height || !layout.nodes.length || fitted.current || layout.nodes.some(node => heights[node.card.path] === undefined)) return;
    const timer = setTimeout(() => { fitted.current = true; void flow.fitView(fitOptions); }, 80);
    return () => clearTimeout(timer);
  }, [width, height, layout.nodes, heights, flow]);
  const groupMenu = useRef<HTMLDetailsElement>(null);
  const expandGroup = (id: string) => {
    if (groupMenu.current) groupMenu.current.open = false;
    setHovered("");
    setCollapsed(previous => { const next = new Set(previous); next.delete(id); return next; });
  };
  const toggleGroup = (id: string) => setCollapsed(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const displayTitle = (card: ViewerCard) => card.kind === "displayGroup" ? card.title : title(card);
  const nodes: GraphNode[] = layout.nodes.map(({ card, position }) => {
    const group = presentation.groups.find(group => group.id === card.path);
    return {
      id: card.path, type: "workflow", position,
      // Preserve measured dimensions on focus updates without fixing CSS height.
      measured: heights[card.path] === undefined ? undefined : { width: 210, height: heights[card.path] },
      style: { width: 210, opacity: hasFocus && !neighborhood.nodes.has(card.path) ? 0.65 : 1, transition: "opacity 140ms" },
      data: { card, title: displayTitle(card), kindLabel: group ? t("agsdl.designGraph.group", { defaultValue: "Group" }) : t(`agsdl.kind.${card.kind === "agent" ? "Agent" : card.kind}`, { defaultValue: card.kind }), active: active === card.path,
        subtitle: group ? t("agsdl.designGraph.members", { count: group.members.length, defaultValue: "{{count}} components" }) : card.kind === "join" ? t(card.details.mode === "first" ? "agsdl.graphHints.first" : "agsdl.graphHints.all") : card.kind === "compose" ? card.composition?.label ?? "" : card.kind === "agent" && card.details.delivery === "steering" ? t("agsdl.graphHints.steering") : card.kind === "approval" ? card.approvalBinding ? card.approvalBinding.label : card.approvers?.length ? card.approvers.map(ref => ref.label).join(" · ") : t("agsdl.viewer.approverMissing") : "",
        select: path => { setHighlighted(path); if (selectionMode === "select") select(path); }, inspect: path => { setHighlighted(path); (onInspect ?? select)(path); }, expand: group ? () => expandGroup(group.id) : undefined, focus: setHovered,
        incoming: [...new Set(presentation.edges.filter(edge => edge.target === card.path).map(edge => displayTitle(presentation.cards.find(item => item.path === edge.source)!)))],
        outgoing: [...new Set(presentation.edges.filter(edge => edge.source === card.path).map(edge => displayTitle(presentation.cards.find(item => item.path === edge.target)!)))],
        attach: !group && onAttach ? () => onAttach(card.path) : undefined,
        openTask: !group && trackedTasks[card.path] && onOpenTask ? () => onOpenTask(card.path) : undefined,
        dismissSignal,
        members: group?.members.map(title),
        changed: changedPaths.some(path => path === card.path || (group?.members.some(member => member.path === path))),
        pending: card.details.contract !== "agsdl-0.2.0" && (card.kind === "Agent" || card.kind === "invoke") && !card.mission.trim(),
        native: group ? groupNativeState(group.members.flatMap(member => nativeActivations[member.path] ? [nativeActivations[member.path]] : []), group.members.length) : nativeActivations[card.path],
        task: group ? groupTaskState(group.members.flatMap(member => trackedTasks[member.path] ? [trackedTasks[member.path]] : []), group.members.length) : trackedTasks[card.path],
      },
    };
  });
  const measureNodes = (changes: NodeChange<GraphNode>[]) => {
    setHeights(previous => {
      let next = previous;
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions || change.dimensions.height <= 0 ||
            previous[change.id] === change.dimensions.height) continue;
        if (next === previous) next = { ...previous };
        next[change.id] = change.dimensions.height;
      }
      return next;
    });
  };
  const activateEdge = (id: string) => {
    const edge = presentation.edges.find(edge => edge.id === id);
    if (!edge) return;
    if (presentation.groups.some(group => group.id === edge.source || group.id === edge.target)) {
      setCollapsed(previous => { const next = new Set(previous); next.delete(edge.source); next.delete(edge.target); return next; });
      return;
    }
    select(selected === edge.originals[0].id ? "" : edge.originals[0].id);
  };
  const edges: GraphEdge[] = presentation.edges.map(edge => {
    const color = edge.transfers?.length && neighborhood.edges.has(edge.id) ? "rgb(var(--primary))" : edge.dependency ? "rgb(var(--muted-foreground))" : "rgb(var(--primary))";
    return {
      ...edge, type: "workflow", data: { route: routeViewerEdge(layout.nodes, edge), connection: edge,
        sourceTitle: displayTitle(presentation.cards.find(card => card.path === edge.source)!),
        targetTitle: displayTitle(presentation.cards.find(card => card.path === edge.target)!),
        focused: neighborhood.edges.has(edge.id) && hasFocus, dismissSignal, focusEdge,
        inspect: selectionMode === "inspect" ? () => activateEdge(edge.id) : undefined,
        inspectSource: () => presentation.groups.some(group => group.id === edge.source) ? expandGroup(edge.source) : (onInspect ?? select)(edge.source),
        inspectTarget: () => presentation.groups.some(group => group.id === edge.target) ? expandGroup(edge.target) : (onInspect ?? select)(edge.target),
      }, sourceHandle: "out", targetHandle: "in", label: undefined,
      ariaRole: "group" as const,
      ariaLabel: `${displayTitle(presentation.cards.find(card => card.path === edge.source)!)} → ${displayTitle(presentation.cards.find(card => card.path === edge.target)!)}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: hasFocus && neighborhood.edges.has(edge.id) ? 2.5 : 1.3, strokeDasharray: edge.exchangeOnly ? "3 4" : edge.dependency ? "7 4" : undefined, opacity: hasFocus && !neighborhood.edges.has(edge.id) ? 0.3 : 0.85 },
    };
  });
  const clearSelection = () => { setHighlighted(""); setHovered(""); select(""); };
  return (
    <div ref={ref} className="agsdl-canvas" onKeyDown={event => { if (event.key === "Escape") clearSelection(); }}>
      <div ref={setCanvasAnchor} className="agsdl-canvas-content">
      <ReactFlow<GraphNode, GraphEdge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={measureNodes}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false}
        edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false}
        deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        onEdgeMouseEnter={(_, edge) => setHovered(edge.id)} onEdgeMouseLeave={() => setHovered("")}
        onPaneContextMenu={event => { event.preventDefault(); setDismissSignal(value => value + 1); setPaneMenu({ left: event.clientX, top: event.clientY }); }}
        onMoveStart={() => { setDismissSignal(value => value + 1); setPaneMenu(undefined); }}
        onPaneClick={() => { setPaneMenu(undefined); clearSelection(); }} fitView fitViewOptions={fitOptions}
        minZoom={0.3} maxZoom={1.8} zoomOnDoubleClick={false}
      >
        <Panel position="top-left" className="agsdl-reading-tools">
          {presentation.groups.length > 0 && <details ref={groupMenu} className="agsdl-reading-groups">
            <summary title={t("agsdl.designGraph.groups", { defaultValue: "Groups" })}><Layers size={14} /><span className="sr-only">{t("agsdl.designGraph.groups", { defaultValue: "Groups" })}</span></summary>
            <div>{presentation.groups.map(group => <button key={group.id} onClick={() => { toggleGroup(group.id); if (groupMenu.current) groupMenu.current.open = false; }} aria-expanded={!collapsed.has(group.id)}>{group.title}<span>{collapsed.has(group.id) ? <Plus size={12} /> : <Minus size={12} />}</span></button>)}</div>
          </details>}
        </Panel>
        {selectionMode === "inspect" && presentation.cards.some(card => card.path === active) && <Panel position="top-right" className="agsdl-graph-controls">
          <button onClick={() => select(active)} aria-label={t("agsdl.viewer.componentDetails")} title={t("agsdl.viewer.componentDetails")}><Info size={14} /></button>
        </Panel>}
        <Background id={backgroundId} color="rgb(var(--muted-foreground) / 0.3)" gap={20} size={1.5} />
        <Panel position="bottom-left" className="agsdl-graph-controls">
          <button onClick={() => void flow.zoomOut()} aria-label={t("agsdl.viewer.zoomOut")} title={t("agsdl.viewer.zoomOut")}><Minus size={14} /></button>
          <button onClick={() => void flow.zoomIn()} aria-label={t("agsdl.viewer.zoomIn")} title={t("agsdl.viewer.zoomIn")}><Plus size={14} /></button>
          <button onClick={() => void flow.fitView(fitOptions)} aria-label={t("agsdl.viewer.fit")} title={t("agsdl.viewer.fit")}><LocateFixed size={14} /></button>
        </Panel>
      </ReactFlow>
      </div>
      {paneMenu && canvasAnchor && <WorkflowGraphPopup anchor={canvasAnchor} position={paneMenu}
        label={t("agsdl.graphInteraction.canvasMenu")} onClose={() => setPaneMenu(undefined)} actions={[
          { label: t("agsdl.viewer.fit"), icon: <LocateFixed size={14} />, run: () => { void flow.fitView(fitOptions); } },
        ]} />}
    </div>
  );
}
export function WorkflowGraph(props: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
