import { useEffect, useMemo } from "react";
import { Background, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Bot, Check, CircleHelp, GitBranch, Maximize2, Minus, Plus, ShieldCheck, X } from "lucide-react";
import { useElementSize } from "../../hooks/useElementSize";
import { layoutViewer } from "../../services/agsdl/graphLayout";
import type { ViewerCard } from "../../services/agsdl/viewer";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import "@xyflow/react/dist/style.css";

type GraphNode = Node<{
  card: ViewerCard;
  title: string;
  kindLabel: string;
  active: boolean;
  entry: boolean;
  select: (path: string) => void;
}, "workflow">;

function WorkflowNode({ data }: NodeProps<GraphNode>) {
  const { card } = data;
  const Icon = card.kind === "end" ? (card.outcome === "failure" ? X : Check)
    : card.kind === "condition" ? GitBranch : card.kind === "approval" ? ShieldCheck : Bot;
  const warning = card.unresolved || card.branches.some(branch => branch.reference.unresolved) || card.dependencies?.some(ref => ref.unresolved);
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="target" position={Position.Left} id="side-in" />
      <button
        className={`agsdl-graph-node nodrag${data.active ? " is-selected" : ""}${card.kind === "end" ? " is-terminal" : ""}${card.outcome === "failure" ? " is-failure" : ""}`}
        onClick={() => data.select(data.active ? "" : card.path)}
        aria-pressed={data.active}
        title={`${data.kindLabel} · ${data.title}`}
      >
        <span className={`agsdl-node-icon${data.entry ? " is-entry" : ""}`}><Icon size={15} /></span>
        <span className="agsdl-node-title">{data.title}</span>
        {warning && <CircleHelp size={12} className="agsdl-node-warning" aria-label="!" />}
      </button>
      <Handle type="source" position={Position.Bottom} id="out" />
      <Handle type="source" position={Position.Right} id="side-out" />
    </>
  );
}
const nodeTypes = { workflow: WorkflowNode };
const fitOptions = { padding: 0.16, minZoom: 0.5, maxZoom: 1 };

function Canvas({ cards, entry, selected, select, title }: {
  cards: ViewerCard[];
  entry?: string;
  selected: string;
  select: (path: string) => void;
  title: (card: ViewerCard) => string;
}) {
  const { t } = useAgsdlTranslation();
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const flow = useReactFlow<GraphNode>();
  const layout = useMemo(() => layoutViewer(cards), [cards]);
  const topology = JSON.stringify(layout.nodes.map(node => [node.card.path, node.position]));
  useEffect(() => {
    if (!width || !height) return;
    const timer = setTimeout(() => void flow.fitView(fitOptions), 80);
    return () => clearTimeout(timer);
  }, [width, height, topology, flow]);
  const nodes: GraphNode[] = layout.nodes.map(({ card, position }) => ({
    id: card.path, type: "workflow", position,
    style: { width: card.kind === "end" ? 110 : 180, height: 52 },
    data: { card, title: title(card), kindLabel: t(`agsdl.kind.${card.kind}`, { defaultValue: card.kind }), active: selected === card.path, entry: entry === card.path, select },
  }));
  const edges = layout.edges.map(edge => {
    const failure = edge.label === "failure";
    const failureTerminal = cards.some(card => card.path === edge.target && card.kind === "end" && card.outcome === "failure");
    const related = edge.source === selected || edge.target === selected;
    const color = failure ? "rgb(var(--muted-foreground))" : "rgb(var(--primary))";
    return {
      ...edge, type: "smoothstep",
      sourceHandle: failureTerminal ? "side-out" : "out",
      targetHandle: failureTerminal ? "side-in" : "in",
      label: ["true", "false", "approved", "denied"].includes(edge.label) ? t(`agsdl.edge.${edge.label}`) : undefined,
      ariaLabel: `${title(cards.find(card => card.path === edge.source)!)} → ${title(cards.find(card => card.path === edge.target)!)} · ${t(edge.dependency ? "agsdl.viewer.dependencies" : `agsdl.edge.${edge.label}`)}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: related ? 2 : 1.3, strokeDasharray: failure || edge.dependency ? "4 4" : undefined, opacity: selected && !related ? 0.25 : 0.8 },
      labelStyle: { fill: "rgb(var(--foreground))", fontSize: 10 },
      labelBgStyle: { fill: "rgb(var(--background))" },
    };
  });
  return (
    <div ref={ref} className="agsdl-canvas" onKeyDown={event => { if (event.key === "Escape") select(""); }}>
      <ReactFlow<GraphNode>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false}
        edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false}
        deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        onPaneClick={() => select("")} fitView fitViewOptions={fitOptions}
        minZoom={0.3} maxZoom={1.8} zoomOnDoubleClick={false}
      >
        <Background color="rgb(var(--border))" gap={20} size={1} />
        <Panel position="bottom-left" className="agsdl-graph-controls">
          <button onClick={() => void flow.zoomOut()} aria-label={t("agsdl.viewer.zoomOut")} title={t("agsdl.viewer.zoomOut")}><Minus size={14} /></button>
          <button onClick={() => void flow.zoomIn()} aria-label={t("agsdl.viewer.zoomIn")} title={t("agsdl.viewer.zoomIn")}><Plus size={14} /></button>
          <button onClick={() => void flow.fitView(fitOptions)} aria-label={t("agsdl.viewer.fit")} title={t("agsdl.viewer.fit")}><Maximize2 size={14} /></button>
        </Panel>
      </ReactFlow>
    </div>
  );
}
export function WorkflowGraph(props: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
