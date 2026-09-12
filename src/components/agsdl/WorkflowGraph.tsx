import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Background, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Bot, Boxes, ChevronDown, CircleHelp, GitBranch, Hand, Layers, LocateFixed, Minus, Plus } from "lucide-react";
import { useElementSize } from "../../hooks/useElementSize";
import { layoutViewer, type ViewerEdge } from "../../services/agsdl/graphLayout";
import { graphNeighborhood, presentGraph, type GraphReadingMode } from "../../services/agsdl/graphPresentation";
import "./graphPresentation.css";
import type { ViewerCard } from "../../services/agsdl/viewer";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import "@xyflow/react/dist/style.css";

type GraphNode = Node<{
  card: ViewerCard;
  title: string;
  kindLabel: string;
  active: boolean;
  subtitle: string;
  select: (path: string) => void;
  focus: (path: string) => void;
  members?: string[];
  expand?: () => void;
  changed: boolean;
  pending: boolean;
}, "workflow">;

function WorkflowNode({ data }: NodeProps<GraphNode>) {
  const { card } = data;
  const { t } = useAgsdlTranslation();
  const Icon = data.members ? Layers : card.kind === "System" ? Boxes : card.kind === "condition" ? GitBranch : card.kind === "approval" ? Hand : Bot;
  const warning = Boolean(card.issueCount) || card.unresolved || card.branches.some(branch => branch.reference.unresolved) || card.dependencies?.some(ref => ref.unresolved);
  const label = [data.kindLabel, data.title !== data.kindLabel ? data.title : "", data.subtitle, warning ? t("agsdl.viewer.unresolved") : ""].filter(Boolean).join(" · ");
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" />
      <button
        className={`agsdl-graph-node nodrag nopan${data.active ? " is-selected" : ""}${card.kind === "approval" ? " is-interaction" : ""}`}
        onClick={event => {
          event.stopPropagation();
          if (data.expand) data.expand();
          else data.select(data.active ? "" : card.path);
        }}
        onMouseEnter={() => data.focus(card.path)} onMouseLeave={() => data.focus("")}
        onFocus={() => data.focus(card.path)} onBlur={() => data.focus("")}
        aria-pressed={data.members ? undefined : data.active}
        aria-expanded={data.members ? false : undefined}
        title={data.members ? `${data.title} · ${data.members.join(", ")}` : label}
      >
        <span className="agsdl-node-icon"><Icon size={15} aria-hidden="true" /></span>
        <span className="agsdl-node-text">
          <span className="agsdl-node-title">{data.title}</span>
          {data.subtitle && <span className="agsdl-node-subtitle">{data.subtitle}</span>}
        </span>
        {data.members && <ChevronDown size={14} aria-hidden="true" />}
        {data.changed && <span className="agsdl-graph-change-dot" title={t("agsdl.designGraph.changed", { defaultValue: "Modified" })} />}
        {data.pending && <span className="agsdl-graph-pending" title={t("agsdl.designGraph.instructionsMissing", { defaultValue: "Instructions to complete" })}><CircleHelp size={12} aria-hidden="true" /></span>}
        {warning && <CircleHelp size={12} className="agsdl-node-warning" aria-hidden="true" />}
      </button>
      <Handle type="source" position={Position.Bottom} id="out" />
    </>
  );
}
const nodeTypes = { workflow: WorkflowNode };
const fitOptions = { padding: 0.16, minZoom: 0.5, maxZoom: 1 };

function Canvas({ cards, edges: connections, selected, select, title, changedPaths = [] }: {
  cards: ViewerCard[];
  edges: ViewerEdge[];
  selected: string;
  select: (path: string) => void;
  title: (card: ViewerCard) => string;
  source?: string;
  changedPaths?: string[];
}) {
  const { t } = useAgsdlTranslation();
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const flow = useReactFlow<GraphNode>();
  const backgroundId = useId();
  const [mode, setMode] = useState<GraphReadingMode>("overview");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [hovered, setHovered] = useState("");
  const presentation = useMemo(() => presentGraph(cards, connections, collapsed, mode), [cards, connections, collapsed, mode]);
  // Layout always uses process relations, so changing the reading lens does not move cards.
  const overview = useMemo(() => presentGraph(cards, connections, collapsed, "overview"), [cards, connections, collapsed]);
  const layout = useMemo(() => layoutViewer(presentation.cards, overview.edges), [presentation.cards, overview.edges]);
  const neighborhood = graphNeighborhood(hovered || selected, presentation.edges);
  const hasFocus = Boolean(hovered || selected) && (presentation.cards.some(card => card.path === (hovered || selected)) || presentation.edges.some(edge => edge.id === (hovered || selected)));
  const fitted = useRef(false);
  useEffect(() => {
    if (!width || !height || !layout.nodes.length || fitted.current) return;
    const timer = setTimeout(() => { fitted.current = true; void flow.fitView(fitOptions); }, 80);
    return () => clearTimeout(timer);
  }, [width, height, layout.nodes.length, flow]);
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
      // Keep dimensions known when focus updates node data, so a pointer-down
      // cannot hide the card before pointer-up reaches its button.
      width: 210, height: card.kind === "approval" ? 68 : 52,
      style: { width: 210, height: card.kind === "approval" ? 68 : 52, opacity: hasFocus && !neighborhood.nodes.has(card.path) ? 0.25 : 1, transition: "opacity 140ms" },
      data: { card, title: displayTitle(card), kindLabel: group ? t("agsdl.designGraph.group", { defaultValue: "Group" }) : t(`agsdl.kind.${card.kind}`, { defaultValue: card.kind }), active: selected === card.path,
        subtitle: group ? t("agsdl.designGraph.members", { count: group.members.length, defaultValue: "{{count}} components" }) : card.kind === "approval" ? card.approvers?.length ? card.approvers.map(ref => ref.label).join(" · ") : t("agsdl.viewer.approverMissing") : "",
        select, expand: group ? () => expandGroup(group.id) : undefined, focus: setHovered,
        members: group?.members.map(title),
        changed: changedPaths.some(path => path === card.path || (group?.members.some(member => member.path === path))),
        pending: (card.kind === "Agent" || card.kind === "invoke") && !card.mission.trim(),
      },
    };
  });
  const activateEdge = (id: string) => {
    const edge = presentation.edges.find(edge => edge.id === id);
    if (!edge) return;
    if (presentation.groups.some(group => group.id === edge.source || group.id === edge.target)) {
      setCollapsed(previous => { const next = new Set(previous); next.delete(edge.source); next.delete(edge.target); return next; });
      return;
    }
    select(selected === edge.originals[0].id ? "" : edge.originals[0].id);
  };
  const edges = presentation.edges.map(edge => {
    const transfer = edge.transfers?.join(", ");
    const condition = edge.label === "true" ? t("agsdl.edge.true") : edge.label === "false" ? t("agsdl.edge.false") : undefined;
    const color = mode === "exchanges" ? "rgb(var(--primary))" : edge.dependency ? "rgb(var(--muted-foreground))" : "rgb(var(--primary))";
    const semantic = mode === "exchanges" ? t("agsdl.designGraph.transfer", { defaultValue: "Data exchange" }) : edge.dependency ? t("agsdl.designGraph.dependency", { defaultValue: "Dependency" }) : t("agsdl.designGraph.sequence", { defaultValue: "Process sequence" });
    return {
      ...edge, type: "smoothstep", sourceHandle: "out", targetHandle: "in", label: undefined,
      ariaRole: "button" as const,
      domAttributes: {
        onFocus: () => setHovered(edge.id), onBlur: () => setHovered(""),
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activateEdge(edge.id); }
        },
      },
      ariaLabel: `${semantic} · ${displayTitle(presentation.cards.find(card => card.path === edge.source)!)} → ${displayTitle(presentation.cards.find(card => card.path === edge.target)!)}${transfer ? ` · ${transfer}` : ""}${condition ? ` · ${condition}` : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: selected === edge.id || hovered === edge.id ? 2.5 : 1.3, strokeDasharray: mode === "exchanges" ? "3 4" : edge.dependency ? "7 4" : undefined, opacity: hasFocus && !neighborhood.edges.has(edge.id) ? 0.12 : 0.85 },
    };
  });
  return (
    <div ref={ref} className="agsdl-canvas" onKeyDown={event => { if (event.key === "Escape") select(""); }}>
      <ReactFlow<GraphNode>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false}
        edgesFocusable={true} edgesReconnectable={false} elementsSelectable={false}
        deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        onEdgeClick={(_, edge) => activateEdge(edge.id)}
        onEdgeMouseEnter={(_, edge) => setHovered(edge.id)} onEdgeMouseLeave={() => setHovered("")}
        onPaneClick={() => select("")} fitView fitViewOptions={fitOptions}
        minZoom={0.3} maxZoom={1.8} zoomOnDoubleClick={false}
      >
        <Panel position="top-left" className="agsdl-reading-tools">
          <div className="agsdl-reading-modes" role="group" aria-label={t("agsdl.designGraph.readingMode", { defaultValue: "Graph view" })}>
            <button aria-pressed={mode === "overview"} onClick={() => setMode("overview")}>{t("agsdl.designGraph.overview", { defaultValue: "Overview" })}</button>
            <button aria-pressed={mode === "exchanges"} onClick={() => setMode("exchanges")}>{t("agsdl.designGraph.exchanges", { defaultValue: "Exchanges" })}</button>
          </div>
          {presentation.groups.length > 0 && <details ref={groupMenu} className="agsdl-reading-groups">
            <summary title={t("agsdl.designGraph.groups", { defaultValue: "Groups" })}><Layers size={14} /><span className="sr-only">{t("agsdl.designGraph.groups", { defaultValue: "Groups" })}</span></summary>
            <div>{presentation.groups.map(group => <button key={group.id} onClick={() => { toggleGroup(group.id); if (groupMenu.current) groupMenu.current.open = false; }} aria-expanded={!collapsed.has(group.id)}>{group.title}<span>{collapsed.has(group.id) ? <Plus size={12} /> : <Minus size={12} />}</span></button>)}</div>
          </details>}
        </Panel>
        {mode === "exchanges" && !edges.length && <Panel position="bottom-center" className="agsdl-reading-empty">{t("agsdl.designGraph.noExchanges", { defaultValue: "No exchanges declared between these components" })}</Panel>}
        <Background id={backgroundId} color="rgb(var(--muted-foreground) / 0.3)" gap={20} size={1.5} />
        <Panel position="bottom-left" className="agsdl-graph-controls">
          <button onClick={() => void flow.zoomOut()} aria-label={t("agsdl.viewer.zoomOut")} title={t("agsdl.viewer.zoomOut")}><Minus size={14} /></button>
          <button onClick={() => void flow.zoomIn()} aria-label={t("agsdl.viewer.zoomIn")} title={t("agsdl.viewer.zoomIn")}><Plus size={14} /></button>
          <button onClick={() => void flow.fitView(fitOptions)} aria-label={t("agsdl.viewer.fit")} title={t("agsdl.viewer.fit")}><LocateFixed size={14} /></button>
        </Panel>
      </ReactFlow>
    </div>
  );
}
export function WorkflowGraph(props: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
