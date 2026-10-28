import { groupNativeState, type NativeCardActivation } from "../../services/agsdl/executionView";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Background, getViewportForBounds, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps, type NodeChange } from "@xyflow/react";
import { Bot, Boxes, ChevronDown, ChevronRight, ChevronUp, CircleHelp, Info, Layers, List, MessageSquare, MessageSquarePlus, LocateFixed, Minus, Plus, Terminal, UserCheck } from "lucide-react";
import { useElementSize } from "../../hooks/useElementSize";
import { layoutViewer, routeViewerEdge, VIEWER_CARD_WIDTH, VIEWER_FRAME, viewerLayoutBounds, type ViewerEdge } from "../../services/agsdl/graphLayout";
import { graphBlockPerformer, graphBlockShape, graphNeighborhood, presentFocusedGraph, presentGraph } from "../../services/agsdl/graphPresentation";
import { blockDetails, type BlockDetail } from "../../services/agsdl/blockDetails";
import "./graphPresentation.css";
import type { ViewerCard } from "../../services/agsdl/viewer";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import "@xyflow/react/dist/style.css";
import { WorkflowEdge, type GraphEdge } from "./WorkflowEdge";
import { WorkflowBlockOverlay } from "./WorkflowBlockOverlay";
import { WorkflowGraphPopup } from "./WorkflowGraphPopup";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";
import { groupTaskState, type TrackedTask } from "../../services/agsdl/taskTracking";
import { expandCompositions, originalStepPath } from "../../services/agsdl/compositionExpansion";
import type { ViewerGraph } from "../../services/agsdl/viewer";

type GraphNode = Node<{
  card: ViewerCard;
  title: string;
  kindLabel: string;
  active: boolean;
  subtitle: string;
  /** Who performs the step, shown as the block's heading above the action. */
  performer?: string;
  /** Lit or faded while another block of the same agent is hovered. */
  related?: "lit" | "faded";
  /** The step that receives the entry Message. */
  entry: boolean;
  select: (path: string) => void;
  focus: (path: string) => void;
  inspect: (path: string) => void;
  members?: string[];
  expand?: () => void;
  /** A composition step opens in place, showing its steps. */
  unfold?: () => void;
  changed: boolean;
  pending: boolean;
  task?: TrackedTask;
  native?: NativeCardActivation;
  incoming: string[];
  outgoing: string[];
  details: BlockDetail[];
  attach?: () => void;
  openTask?: () => void;
  dismissSignal: number;
}, "workflow">;

function WorkflowNode({ data }: NodeProps<GraphNode>) {
  const { card } = data;
  const { t } = useAgsdlTranslation();
  const shape = data.members ? "card" : graphBlockShape(card);
  const Icon = data.members ? Layers : card.kind === "System" ? Boxes : card.kind === "approval" ? UserCheck : card.kind === "call" ? Terminal : card.kind === "compose" ? Layers : Bot;
  const warning = Boolean(card.issueCount) || card.unresolved || card.branches.some(branch => branch.reference.unresolved) || card.dependencies?.some(ref => ref.unresolved);
  const heading = data.performer ?? data.title;
  const subtitle = data.performer ? data.title : data.subtitle;
  // A join either waits for all of its members or keeps the first acceptable result.
  const joinMode = card.kind === "join" ? card.details.mode === "first" ? "first" : "all" : undefined;
  const label = [data.entry ? t("agsdl.viewer.legendEntry") : "", data.kindLabel, heading !== data.kindLabel ? heading : "", subtitle,
    joinMode ? t(`agsdl.viewer.${joinMode === "first" ? "joinFirstHint" : "joinAllHint"}`) : "", warning ? t("agsdl.viewer.unresolved") : ""].filter(Boolean).join(" · ");
  const status = data.task || data.native ? <WorkflowStatusBadge task={data.task} native={data.native} /> : null;
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" />
      {data.entry && <span className="agsdl-node-entry" aria-hidden="true">
        <svg width="12" height="30" viewBox="0 0 12 30"><circle cx="6" cy="6" r="4.5" /><path d="M6 10.5V24" /><path className="is-head" d="M2.5 23.5L6 30l3.5-6.5z" /></svg>
        <span>{t("agsdl.viewer.entry")}</span>
      </span>}
      <WorkflowBlockOverlay card={card} title={data.title} kindLabel={data.kindLabel} task={data.task} native={data.native}
        incoming={data.incoming} outgoing={data.outgoing} details={data.details} dismissSignal={data.dismissSignal} actions={[
          { label: data.members ? t("agsdl.graphInteraction.expand") : t("agsdl.viewer.componentDetails"), icon: data.members ? <Layers size={14} /> : <Info size={14} />, run: () => data.expand ? data.expand() : data.inspect(card.path) },
          ...(data.unfold ? [{ label: t("agsdl.graphInteraction.unfold"), icon: <ChevronDown size={14} />, run: data.unfold }] : []),
          ...(data.attach ? [{ label: t("agsdl.attachToChat"), icon: <MessageSquarePlus size={14} />, run: data.attach }] : []),
          ...(data.openTask ? [{ label: t("agsdl.graphInteraction.openTask"), icon: <MessageSquare size={14} />, run: data.openTask }] : []),
        ]}>
      <button
        type="button"
        className={`agsdl-graph-node is-${shape} nodrag nopan${data.active ? " is-selected" : ""}${data.related ? ` is-${data.related}` : ""}`}
        onClick={event => {
          event.stopPropagation();
          if (data.expand) data.expand();
          else if (data.unfold) data.unfold();
          else data.select(data.active ? "" : card.path);
        }}
        onDoubleClick={event => { event.stopPropagation(); if (!data.members) data.inspect(card.path); }}
        onMouseEnter={() => data.focus(card.path)} onMouseLeave={() => data.focus("")}
        onFocus={() => data.focus(card.path)} onBlur={() => data.focus("")}
        aria-pressed={data.members ? undefined : data.active}
        aria-expanded={data.members ? false : undefined}
        aria-label={data.task || data.native ? undefined : label}
      >
        {shape === "routing" ? <>
          {status}
          {joinMode && <span className={`agsdl-node-mode is-${joinMode}`} title={t(`agsdl.viewer.${joinMode === "first" ? "joinFirstHint" : "joinAllHint"}`)}>
            {t(`agsdl.viewer.${joinMode === "first" ? "joinFirst" : "joinAll"}`)}
          </span>}
          <span className="agsdl-node-title">{data.title}</span>
        </> : <>
          <span className="agsdl-node-tile">{status ?? <Icon size={shape === "execution" ? 15 : 14} aria-hidden="true" />}</span>
          <span className="agsdl-node-text">
            <span className="agsdl-node-title">{heading}</span>
            {subtitle && <span className="agsdl-node-subtitle">{subtitle}</span>}
          </span>
          {shape === "subprocess" && <ChevronRight size={15} className="agsdl-node-chevron" aria-hidden="true" />}
          {data.members && <ChevronDown size={14} className="agsdl-node-chevron" aria-hidden="true" />}
        </>}
        {data.changed && <span className="agsdl-graph-change-dot" title={t("agsdl.designGraph.changed", { defaultValue: "Modified" })} />}
        {data.pending && <span className="agsdl-graph-pending" title={t("agsdl.designGraph.instructionsMissing", { defaultValue: "Instructions to complete" })}><CircleHelp size={12} aria-hidden="true" /></span>}
        {warning && <CircleHelp size={12} className="agsdl-node-warning" aria-hidden="true" />}
        {/* Failures leave through the block's own edge, on the right. */}
        <Handle type="source" position={Position.Right} id="error" />
      </button>
      </WorkflowBlockOverlay>
      <Handle type="source" position={Position.Bottom} id="out" />
    </>
  );
}
type FrameNode = Node<{ performer?: string; title: string; fold: () => void }, "frame" | "frameHeading">;
/** The border around the steps of an unfolded composition, drawn behind the connections. */
function CompositionFrame() {
  return <div className="agsdl-composition-frame" />;
}
/** The frame's heading sits above the connections and folds the composition back. */
function CompositionFrameHeading({ data }: NodeProps<FrameNode>) {
  const { t } = useAgsdlTranslation();
  return <div className="agsdl-composition-heading-anchor">
    <button type="button" className="agsdl-composition-heading nodrag nopan" onClick={event => { event.stopPropagation(); data.fold(); }}
      aria-label={`${t("agsdl.graphInteraction.fold")} · ${data.title}`} title={t("agsdl.graphInteraction.fold")}>
      <Layers size={12} aria-hidden="true" />
      <span>{data.performer && <strong>{data.performer}</strong>}{data.performer && " · "}{data.title}</span>
      <ChevronUp size={12} aria-hidden="true" />
    </button>
  </div>;
}
/** A legend sample: a connection arriving on a block border, in the flow colour. */
function LegendSample({ children }: { children: ReactNode }) {
  return <svg className="agsdl-legend-sample" width="44" height="18" viewBox="0 0 44 18" aria-hidden="true">{children}<path className="is-border" d="M40 2v14" /></svg>;
}
const nodeTypes = { workflow: WorkflowNode, frame: CompositionFrame, frameHeading: CompositionFrameHeading };
const edgeTypes = { workflow: WorkflowEdge };
const fitOptions = { padding: 0.16, minZoom: 0.5, maxZoom: 1 };

function Canvas({ cards: declaredCards, edges: declaredEdges, entry: declaredEntry, compositions = [], declarations = [], selected, select, title, changedPaths = [], trackedTasks = {}, nativeActivations = {}, selectionMode = "inspect", onAttach, onOpenTask, onInspect }: {
  cards: ViewerCard[];
  edges: ViewerEdge[];
  /** The step that receives the entry Message. */
  entry?: string;
  /** Composition graphs, unfolded in place from their composition steps. */
  compositions?: ViewerGraph[];
  /** Document declarations, read by the hover previews. */
  declarations?: ViewerCard[];
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
  const [legend, setLegend] = useState(false);
  const focusEdge = useCallback((id: string, open: boolean) => {
    setInspectedEdge(current => open ? id : current === id ? "" : current);
  }, []);
  const [highlighted, setHighlighted] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [hovered, setHovered] = useState("");
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const toggleComposition = (path: string) => { setHovered(""); setUnfolded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; }); };
  const expansion = useMemo(() => expandCompositions(declaredCards, declaredEdges, compositions, unfolded, declarations), [declaredCards, declaredEdges, compositions, unfolded, declarations]);
  const { cards, edges: connections } = expansion;
  const entry = expansion.frames.find(frame => frame.path === declaredEntry)?.entry ?? declaredEntry;
  const active = selected || (cards.some(card => card.path === highlighted) ? highlighted : "");
  const presentation = useMemo(() => presentFocusedGraph(cards, connections, collapsed, active), [cards, connections, collapsed, active]);
  // Revealing exchanges must not move the process cards.
  const overview = useMemo(() => presentGraph(cards, connections, collapsed, "overview"), [cards, connections, collapsed]);
  const framed = useMemo(() => expansion.frames.map(frame => frame.members), [expansion.frames]);
  const layout = useMemo(() => layoutViewer(overview.cards, overview.edges, heights, framed), [overview.cards, overview.edges, heights, framed]);
  const focus = inspectedEdge || active || hovered;
  const neighborhood = graphNeighborhood(focus, presentation.edges);
  const hasFocus = Boolean(focus) && (presentation.cards.some(card => card.path === focus) || presentation.edges.some(edge => edge.id === focus));
  // Fit the blocks and their side rails, within the same zoom limits as the initial view.
  const fit = useCallback(() => {
    if (!width || !height || !layout.nodes.length) return;
    void flow.setViewport(getViewportForBounds(viewerLayoutBounds(layout), width, height, fitOptions.minZoom, fitOptions.maxZoom, fitOptions.padding));
  }, [flow, layout, width, height]);
  const fitted = useRef(false);
  useEffect(() => {
    if (!width || !height || !layout.nodes.length || fitted.current || layout.nodes.some(node => heights[node.card.path] === undefined)) return;
    const timer = setTimeout(() => { fitted.current = true; fit(); }, 80);
    return () => clearTimeout(timer);
  }, [width, height, layout.nodes, heights, fit]);
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
  // Steps naming one agent in one graph address the same agent instance, steering included.
  const agentKey = (card: ViewerCard) => card.kind === "agent" && typeof card.details.agent === "string"
    ? `${card.path.slice(0, card.path.lastIndexOf("/"))}\u0000${card.details.agent}` : undefined;
  const agentSizes = new Map<string, number>();
  for (const card of presentation.cards) { const key = agentKey(card); if (key) agentSizes.set(key, (agentSizes.get(key) ?? 0) + 1); }
  const sharedSize = (card: ViewerCard) => { const key = agentKey(card); const size = key ? agentSizes.get(key)! : 0; return size > 1 ? size : undefined; };
  // Hovering a shared agent lights all of its blocks and fades the rest of the graph.
  const hoveredCard = presentation.cards.find(card => card.path === hovered);
  const hoveredAgent = hoveredCard && sharedSize(hoveredCard) ? agentKey(hoveredCard) : undefined;
  const nodes: GraphNode[] = layout.nodes.map(({ card, position }) => {
    const group = presentation.groups.find(group => group.id === card.path);
    const performer = group ? undefined : graphBlockPerformer(card, displayTitle(card));
    return {
      id: card.path, type: "workflow", position,
      // Preserve measured dimensions on focus updates without fixing CSS height.
      measured: heights[card.path] === undefined ? undefined : { width: VIEWER_CARD_WIDTH, height: heights[card.path] },
      style: { width: VIEWER_CARD_WIDTH },
      data: { card, title: displayTitle(card), kindLabel: group ? t("agsdl.designGraph.group", { defaultValue: "Group" }) : t(`agsdl.kind.${card.kind === "agent" ? "Agent" : card.kind}`, { defaultValue: card.kind }), active: active === card.path,
        // Blocks lead with who performs the step, then the action; routing steps have no performer.
        performer,
        related: hoveredAgent ? agentKey(card) === hoveredAgent ? "lit" : "faded" : undefined,
        entry: card.path === entry || Boolean(group?.members.some(member => member.path === entry)),
        subtitle: group ? t("agsdl.designGraph.members", { count: group.members.length, defaultValue: "{{count}} components" })
          : performer ? "" : card.kind === "approval" && !card.approvalBinding && !card.approvers?.length ? t("agsdl.viewer.approverMissing") : "",
        select: path => { setHighlighted(path); if (selectionMode === "select") select(originalStepPath(path)); }, inspect: path => { setHighlighted(path); (onInspect ?? select)(originalStepPath(path)); }, expand: group ? () => expandGroup(group.id) : undefined, focus: setHovered,
        unfold: card.kind === "compose" && compositions.some(graph => graph.path === card.composition?.target) ? () => toggleComposition(card.path) : undefined,
        incoming: [...new Set(presentation.edges.filter(edge => edge.target === card.path).map(edge => displayTitle(presentation.cards.find(item => item.path === edge.source)!)))],
        outgoing: [...new Set(presentation.edges.filter(edge => edge.source === card.path).map(edge => displayTitle(presentation.cards.find(item => item.path === edge.target)!)))],
        details: group ? [] : blockDetails(card, declarations, presentation.cards),
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
  // Frames sit behind the steps they surround, in the space the layout kept for them.
  const frames: FrameNode[] = expansion.frames.flatMap(frame => {
    const members = layout.nodes.filter(node => frame.members.includes(node.card.path));
    const start = members.find(node => node.card.path === frame.entry);
    if (!members.length || !start) return [];
    const left = Math.min(...members.map(node => node.position.x)) - VIEWER_FRAME.padding;
    const top = Math.min(...members.map(node => node.position.y)) - VIEWER_FRAME.top;
    const right = Math.max(...members.map(node => node.position.x + VIEWER_CARD_WIDTH)) + VIEWER_FRAME.padding;
    const bottom = Math.max(...members.map(node => node.position.y + node.height)) + VIEWER_FRAME.padding;
    const step = declaredCards.find(card => card.path === frame.path)!;
    const data = { performer: graphBlockPerformer(step, displayTitle(step)), title: displayTitle(step), fold: () => toggleComposition(frame.path) };
    // The heading sits on the incoming connection, where it enters the frame; a long one overhangs the border in the free band above the row.
    const center = start.position.x + VIEWER_CARD_WIDTH / 2, half = Math.min(center - left, right - center);
    return [
      { id: `frame:${frame.path}`, type: "frame", position: { x: left, y: top }, zIndex: -1, selectable: false, focusable: false, style: { width: right - left, height: bottom - top }, data },
      { id: `frame-heading:${frame.path}`, type: "frameHeading", position: { x: center - half, y: top }, selectable: false, focusable: false, style: { width: half * 2 }, data },
    ];
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
  // Ordinary steps sharing one agent in one graph queue their messages; steering never queues.
  const queueKey = (card: ViewerCard) => card.details.delivery === "steering" ? undefined : agentKey(card);
  const queueSizes = new Map<string, number>();
  for (const card of presentation.cards) { const key = queueKey(card); if (key) queueSizes.set(key, (queueSizes.get(key) ?? 0) + 1); }
  const queued = (path: string) => { const card = presentation.cards.find(item => item.path === path); const key = card && queueKey(card); return Boolean(key && queueSizes.get(key)! > 1); };
  const litPaths = new Set(hoveredAgent ? presentation.cards.filter(card => agentKey(card) === hoveredAgent).map(card => card.path) : []);
  const edges: GraphEdge[] = presentation.edges.map(edge => {
    // The theme accent carries the flow, the theme's destructive colour the failures.
    const failure = edge.label === "onError";
    const focused = hasFocus && neighborhood.edges.has(edge.id);
    // Opaque mixes keep overlapping lines at the same intensity.
    const color = `color-mix(in srgb, rgb(var(--${failure ? "destructive" : "primary"})) ${focused ? 100 : 60}%, rgb(var(--background)))`;
    return {
      ...edge, type: "workflow", data: { route: layout.routes.get(edge.id) ?? routeViewerEdge(layout.nodes, edge), connection: edge, queued: !failure && queued(edge.target),
        sourceTitle: displayTitle(presentation.cards.find(card => card.path === edge.source)!),
        targetTitle: displayTitle(presentation.cards.find(card => card.path === edge.target)!),
        sourcePerformer: (() => { const source = presentation.cards.find(card => card.path === edge.source)!; return graphBlockPerformer(source, displayTitle(source)); })(),
        dismissSignal, focusEdge,
        inspect: selectionMode === "inspect" ? () => activateEdge(edge.id) : undefined,
        inspectSource: () => presentation.groups.some(group => group.id === edge.source) ? expandGroup(edge.source) : (onInspect ?? select)(originalStepPath(edge.source)),
        inspectTarget: () => presentation.groups.some(group => group.id === edge.target) ? expandGroup(edge.target) : (onInspect ?? select)(originalStepPath(edge.target)),
      }, sourceHandle: failure ? "error" : "out", targetHandle: "in", label: undefined,
      ariaRole: "group" as const,
      ariaLabel: `${displayTitle(presentation.cards.find(card => card.path === edge.source)!)} → ${displayTitle(presentation.cards.find(card => card.path === edge.target)!)}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: focused ? 2 : 1.3, strokeDasharray: edge.exchangeOnly ? "3 4" : edge.dependency ? "7 4" : undefined,
        opacity: hoveredAgent && !litPaths.has(edge.source) && !litPaths.has(edge.target) ? 0.3 : undefined },
    };
  });
  const queues = edges.some(edge => edge.data?.queued);
  const clearSelection = () => { setHighlighted(""); setHovered(""); select(""); };
  return (
    <div ref={ref} className="agsdl-canvas" onKeyDown={event => { if (event.key === "Escape") clearSelection(); }}>
      <div ref={setCanvasAnchor} className="agsdl-canvas-content">
      <ReactFlow<GraphNode, GraphEdge>
        nodes={[...frames, ...nodes] as GraphNode[]} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={measureNodes}
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
          {legend && <div className="agsdl-graph-legend" role="note">
            {/* Each sample ends on a block border, drawn as the short bar on the right. */}
            {nodes.some(node => node.data.entry) && <div><LegendSample><circle className="is-head" cx="7" cy="9" r="4.5" /><path d="M11.5 9H30" /><path className="is-head" d="M28 5.5l6 3.5-6 3.5z" /></LegendSample>{t("agsdl.viewer.legendEntry")}</div>}
            <div><LegendSample><path d="M2 9H30" /><path className="is-head" d="M28 5.5l6 3.5-6 3.5z" /></LegendSample>{t("agsdl.viewer.legendFlow")}</div>
            {queues && <div><LegendSample><path d="M2 9H24" /><path className="is-head" d="M22 5.5l6 3.5-6 3.5z" /><path d="M31 3v12M34 3v12" strokeLinecap="round" /></LegendSample>{t("agsdl.viewer.legendQueue")}</div>}
            <div><svg width="44" height="18" aria-hidden="true"><path d="M9 9H39" stroke="color-mix(in srgb, rgb(var(--destructive)) 60%, rgb(var(--background)))" strokeWidth="1.4" /><circle cx="9" cy="9" r="7.5" fill="rgb(var(--background))" stroke="rgb(var(--destructive) / 0.4)" /><path d="M9 5.5v4M9 12.4v.1" stroke="rgb(var(--destructive))" strokeWidth="1.6" strokeLinecap="round" /></svg>{t("agsdl.viewer.legendError")}</div>
          </div>}
          <button onClick={() => void flow.zoomOut()} aria-label={t("agsdl.viewer.zoomOut")} title={t("agsdl.viewer.zoomOut")}><Minus size={14} /></button>
          <button onClick={() => void flow.zoomIn()} aria-label={t("agsdl.viewer.zoomIn")} title={t("agsdl.viewer.zoomIn")}><Plus size={14} /></button>
          <button onClick={fit} aria-label={t("agsdl.viewer.fit")} title={t("agsdl.viewer.fit")}><LocateFixed size={14} /></button>
          <button onClick={() => setLegend(value => !value)} aria-pressed={legend} aria-label={t("agsdl.viewer.legend")} title={t("agsdl.viewer.legend")}><List size={14} /></button>
        </Panel>
      </ReactFlow>
      </div>
      {paneMenu && canvasAnchor && <WorkflowGraphPopup anchor={canvasAnchor} position={paneMenu}
        label={t("agsdl.graphInteraction.canvasMenu")} onClose={() => setPaneMenu(undefined)} actions={[
          { label: t("agsdl.viewer.fit"), icon: <LocateFixed size={14} />, run: fit },
        ]} />}
    </div>
  );
}
export function WorkflowGraph(props: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
